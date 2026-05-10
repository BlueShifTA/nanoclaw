/**
 * Host-side session command handlers. These run on the host without
 * waking the container; they manipulate session state (continuation
 * pointer, container lifecycle) and write replies directly to
 * outbound.db so the normal delivery loop picks them up.
 *
 * Dispatched from router.ts when gateCommand returns `action: 'handle'`.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from './config.js';
import { isContainerRunning, killContainer, wakeContainer } from './container-runner.js';
import { getAgentGroup } from './db/agent-groups.js';
import { log } from './log.js';

const SESSIONS_ROOT = path.join(DATA_DIR, 'v2-sessions');
import {
  openInboundDb,
  openOutboundDb,
  openOutboundDbRw,
  writeOutboundDirect,
  writeSessionMessage,
} from './session-manager.js';
import type { Session } from './types.js';

export interface SessionCommandContext {
  session: Session;
  deliveryAddr: { channelType: string; platformId: string; threadId: string | null };
}

const HANDLERS: Record<string, (args: string, ctx: SessionCommandContext) => Promise<void>> = {
  '/ping': handlePing,
  '/reset': handleReset,
  '/kill': handleKill,
  '/last': handleLast,
  '/btw': handleBtw,
};

export function isSessionCommand(command: string): boolean {
  return command in HANDLERS;
}

export async function handleSessionCommand(command: string, args: string, ctx: SessionCommandContext): Promise<void> {
  const handler = HANDLERS[command];
  if (!handler) {
    log.warn('Unknown session command dispatched', { command });
    return;
  }
  try {
    await handler(args, ctx);
  } catch (err) {
    log.error('Session command handler threw', { command, error: (err as Error).message });
    writeReply(ctx, `Error: ${command} failed — ${(err as Error).message}`);
  }
}

function generateReplyId(): string {
  return `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function writeReply(ctx: SessionCommandContext, text: string): void {
  writeOutboundDirect(ctx.session.agent_group_id, ctx.session.id, {
    id: generateReplyId(),
    kind: 'chat',
    platformId: ctx.deliveryAddr.platformId,
    channelType: ctx.deliveryAddr.channelType,
    threadId: ctx.deliveryAddr.threadId,
    content: JSON.stringify({ text }),
  });
}

/**
 * Wrap a multi-line report body in a fenced code block so the Discord
 * chat adapter — which round-trips outgoing markdown through an AST and
 * collapses single newlines to spaces — renders it verbatim with
 * column alignment preserved. The optional header line goes outside the
 * fence so it can use bold/italic.
 */
function renderReport(header: string | undefined, body: string[]): string {
  const fence = ['```', ...body, '```'].join('\n');
  return header ? `${header}\n${fence}` : fence;
}

async function handlePing(_args: string, ctx: SessionCommandContext): Promise<void> {
  // v1 contract (nanoclaw-v1/src/index.ts:661-731): the operator types /ping
  // and expects "NanoClaw alive" + an Agent: line + a Session: line + a
  // Last activity: line, optionally with a drift warning.
  const lines: string[] = ['NanoClaw alive'];

  const running = isContainerRunning(ctx.session.id);
  lines.push(`Container : ${running ? 'running' : 'idle'}`);

  // Activity — distinct from "is the docker container alive". A session is
  // "processing" when an inbound row is in status='processing' (the
  // container has claimed it and is mid-turn).
  const inDb = openInboundDb(ctx.session.agent_group_id, ctx.session.id);
  let inCount = 0;
  let processingCount = 0;
  let scheduledFuture = 0;
  let scheduledDue = 0;
  try {
    inCount = (inDb.prepare('SELECT COUNT(*) AS c FROM messages_in').get() as { c: number }).c;
    processingCount = (
      inDb.prepare("SELECT COUNT(*) AS c FROM messages_in WHERE status = 'processing'").get() as { c: number }
    ).c;
    scheduledFuture = (
      inDb
        .prepare(
          `SELECT COUNT(*) AS c FROM messages_in
           WHERE kind = 'task' AND status = 'pending'
             AND process_after IS NOT NULL
             AND datetime(process_after) > datetime('now')`,
        )
        .get() as { c: number }
    ).c;
    scheduledDue = (
      inDb
        .prepare(
          `SELECT COUNT(*) AS c FROM messages_in
           WHERE kind = 'task' AND status = 'pending'
             AND process_after IS NOT NULL
             AND datetime(process_after) <= datetime('now')`,
        )
        .get() as { c: number }
    ).c;
  } finally {
    inDb.close();
  }

  // Drift detection — v1 lines 685-699. When the container is running we
  // look at the timestamp of the last outbound chat (proxy for v1's
  // `lastAgentOutput.time`). If silentFor > DRIFT_THRESHOLD_MS emit the v1
  // warning string; otherwise append "last output Xm ago" to the Agent: line.
  const driftThresholdMs = parseInt(process.env.NANOCLAW_DRIFT_THRESHOLD_MS ?? '300000', 10); // 5 min
  let silentForMs: number | null = null;
  if (running) {
    const outDb2 = openOutboundDb(ctx.session.agent_group_id, ctx.session.id);
    try {
      const row = outDb2
        .prepare("SELECT timestamp FROM messages_out WHERE kind = 'chat' ORDER BY seq DESC LIMIT 1")
        .get() as { timestamp: string } | undefined;
      if (row?.timestamp) {
        const t = Date.parse(row.timestamp);
        if (Number.isFinite(t)) silentForMs = Date.now() - t;
      }
    } finally {
      outDb2.close();
    }
  }
  const drifted = running && silentForMs !== null && silentForMs > driftThresholdMs;

  // Agent: state line — v1 has four mutually-exclusive states. We can
  // distinguish "no active container" vs "processing" via isContainerRunning,
  // and "processing N msgs" vs "container alive, no inbound being processed"
  // via the processing count.
  let agentLine: string;
  if (!running) {
    agentLine = 'Agent: idle (no active container)';
  } else if (processingCount > 0) {
    agentLine = `Agent: processing (${processingCount} message${processingCount === 1 ? '' : 's'} in flight)`;
  } else {
    agentLine = 'Agent: idle (container alive, waiting for input)';
  }
  if (running && !drifted && silentForMs !== null) {
    agentLine += `, last output ${formatAge(silentForMs)} ago`;
  }
  lines.push(agentLine);

  // Session: full id (v1 truncated to 8 chars but the operator finds the
  // full hash more useful — easier to grep logs/DB files by it).
  lines.push(`Session: ${ctx.session.id}`);

  if (scheduledFuture === 0 && scheduledDue === 0) {
    lines.push('Scheduled : none');
  } else {
    const parts: string[] = [];
    if (scheduledFuture > 0) parts.push(`${scheduledFuture} task${scheduledFuture === 1 ? '' : 's'} pending`);
    if (scheduledDue > 0) parts.push(`${scheduledDue} due`);
    lines.push(`Scheduled : ${parts.join(', ')}`);
  }

  if (ctx.session.last_active) {
    lines.push(`Last activity: ${ctx.session.last_active}`);
  } else {
    lines.push('Last activity: none');
  }

  // Heartbeat freshness — file-mtime read, fast.
  const hbPath = path.join(SESSIONS_ROOT, ctx.session.agent_group_id, ctx.session.id, '.heartbeat');
  try {
    const st = fs.statSync(hbPath);
    const ageMs = Date.now() - st.mtimeMs;
    lines.push(`Heartbeat  : ${formatAge(ageMs)} ago`);
  } catch {
    lines.push('Heartbeat  : (none)');
  }

  // Continuation pointer per provider + message counts.
  const outDb = openOutboundDb(ctx.session.agent_group_id, ctx.session.id);
  let conts: Array<{ key: string }> = [];
  let outCount = 0;
  try {
    conts = outDb.prepare("SELECT key FROM session_state WHERE key LIKE 'continuation:%' ORDER BY key").all() as Array<{
      key: string;
    }>;
    outCount = (outDb.prepare('SELECT COUNT(*) AS c FROM messages_out').get() as { c: number }).c;
  } finally {
    outDb.close();
  }

  if (conts.length === 0) {
    lines.push('Continuation: none (next message starts fresh)');
  } else {
    lines.push(`Continuation: ${conts.map((c) => c.key.replace('continuation:', '')).join(', ')}`);
  }
  lines.push(`Messages   : ${inCount} in, ${outCount} out`);

  // v1 drift warning — separate line, visually distinct so the operator can't
  // miss it. References both /kill and /reset as recovery paths.
  if (drifted && silentForMs !== null) {
    lines.push('');
    lines.push(
      `⚠️ Possible drift — silent for ${formatAge(silentForMs)}. Use /kill to force-stop or /reset to recover.`,
    );
  }

  writeReply(ctx, renderReport('**Session status**', lines));
}

function formatAge(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  return `${h}h`;
}

/**
 * Sentinel the agent must echo so the host knows the summary turn finished.
 * Fixed string (vs per-request UUID) keeps the protocol simple: the agent
 * can be taught it once in the prompt. False positives in normal chat are
 * extremely unlikely given the token's specificity.
 */
const RESET_SENTINEL = '__SESSION_RESET_SUMMARY_COMPLETE__';

async function handleReset(args: string, ctx: SessionCommandContext): Promise<void> {
  const trimmed = args.trim();
  const quick = /^(--quick|--no-summary|--force|quick|force)$/i.test(trimmed);

  // Gather pre-clear stats — both for the snapshot file and the reply.
  const stats = readResetStats(ctx);

  // Empty sessions: nothing to summarise — short-circuit to quick clear so
  // the user isn't waiting 60s for an agent turn that has no content.
  if (quick || stats.inCount === 0) {
    return doClear(ctx, stats);
  }

  // Agent-driven flow: write a summary-request inbound, wake the container,
  // poll outbound for the sentinel, then clear.
  await runAgentDrivenReset(ctx, stats);
}

interface ResetStats {
  inCount: number;
  outCount: number;
  firstTs?: string;
  lastTs?: string;
  recentInbound: Array<{ timestamp: string; content: string }>;
  recentOutbound: Array<{ timestamp: string; content: string }>;
  providers: string[];
}

function readResetStats(ctx: SessionCommandContext): ResetStats {
  const inDb = openInboundDb(ctx.session.agent_group_id, ctx.session.id);
  let inCount = 0;
  let firstTs: string | undefined;
  let lastTs: string | undefined;
  let recentInbound: Array<{ timestamp: string; content: string }> = [];
  try {
    inCount = (inDb.prepare('SELECT COUNT(*) AS c FROM messages_in').get() as { c: number }).c;
    const span = inDb
      .prepare(
        "SELECT MIN(timestamp) AS first, MAX(timestamp) AS last FROM messages_in WHERE kind IN ('chat', 'chat-sdk')",
      )
      .get() as { first: string | null; last: string | null } | undefined;
    firstTs = span?.first ?? undefined;
    lastTs = span?.last ?? undefined;
    recentInbound = inDb
      .prepare(
        "SELECT timestamp, content FROM messages_in WHERE kind IN ('chat', 'chat-sdk') ORDER BY seq DESC LIMIT 5",
      )
      .all() as Array<{ timestamp: string; content: string }>;
  } finally {
    inDb.close();
  }

  const outDb = openOutboundDb(ctx.session.agent_group_id, ctx.session.id);
  let outCount = 0;
  let recentOutbound: Array<{ timestamp: string; content: string }> = [];
  let providers: string[] = [];
  try {
    outCount = (outDb.prepare('SELECT COUNT(*) AS c FROM messages_out').get() as { c: number }).c;
    recentOutbound = outDb
      .prepare("SELECT timestamp, content FROM messages_out WHERE kind = 'chat' ORDER BY seq DESC LIMIT 5")
      .all() as Array<{ timestamp: string; content: string }>;
    providers = (
      outDb.prepare("SELECT key FROM session_state WHERE key LIKE 'continuation:%' ORDER BY key").all() as Array<{
        key: string;
      }>
    ).map((r) => r.key.replace('continuation:', ''));
  } finally {
    outDb.close();
  }
  return {
    inCount,
    outCount,
    firstTs,
    lastTs,
    recentInbound: recentInbound.slice().reverse(),
    recentOutbound: recentOutbound.slice().reverse(),
    providers,
  };
}

async function runAgentDrivenReset(ctx: SessionCommandContext, stats: ResetStats): Promise<void> {
  const journalPath = `/workspace/extra/armlab/journal/${new Date().toISOString().replace(/[:.]/g, '-')}-reset.md`;

  // Capture max outbound seq BEFORE writing the request so the poll only
  // sees NEW rows the agent wrote in response. Without this, a sentinel
  // reply from a PREVIOUS /reset still sitting in outbound.db would match
  // immediately and we'd surface a stale summary.
  let startSeq = 0;
  {
    const seqDb = openOutboundDb(ctx.session.agent_group_id, ctx.session.id);
    try {
      startSeq = (seqDb.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM messages_out').get() as { s: number }).s;
    } finally {
      seqDb.close();
    }
  }

  // Write the summary-request inbound. trigger=1 wakes the agent.
  writeSessionMessage(ctx.session.agent_group_id, ctx.session.id, {
    id: `reset-req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: ctx.deliveryAddr.platformId,
    channelType: ctx.deliveryAddr.channelType,
    threadId: ctx.deliveryAddr.threadId,
    content: JSON.stringify({
      text:
        '[SESSION RESET REQUEST] This conversation is about to be cleared. Before that, do ALL of:\n\n' +
        `1. Write a session journal at \`${journalPath}\` — 5–10 bullets covering: what we worked on, decisions made, files touched, unfinished work, important learnings. Be specific (file paths, decision points), not vague.\n\n` +
        `2. ALWAYS append a one-line entry to \`/workspace/extra/armlab/.claude/memory/MEMORY.md\` pointing at the journal file you just wrote, with a SHORT (≤80 char) tag for what the session was about. Format:\n` +
        `   \`- [${new Date().toISOString().slice(0, 10)} session](../journal/<filename>.md) — <tag>\`\n` +
        `   This is not optional. Even an empty session gets one line ("no work, idle session") so the chronology is preserved.\n\n` +
        `3. Reply with a SHORT human-readable summary (under 200 words) ending with this literal sentinel on its own line:\n${RESET_SENTINEL}\n\n` +
        'Do NOT start new work or run unrelated tools. Just write the two files and reply with the summary. The continuation will be cleared immediately after your reply.',
      reset_request: true,
    }),
    trigger: 1,
  });

  await wakeContainer(ctx.session);

  const timeoutMs = parseInt(process.env.NANOCLAW_RESET_TIMEOUT_MS ?? '60000', 10);
  const poll = await pollForResetSummary(ctx, startSeq, timeoutMs);

  // Always kill + clear after the wait, regardless of poll outcome.
  if (isContainerRunning(ctx.session.id)) {
    killContainer(ctx.session.id, 'admin /reset (post-summary)');
  }
  const cleared = clearContinuations(ctx);

  // Snapshot file with the agent's summary appended (if we got one).
  let snapshotRel: string | undefined;
  if (stats.inCount > 0 || stats.outCount > 0) {
    snapshotRel = writeSessionSnapshot(ctx, {
      inCount: stats.inCount,
      outCount: stats.outCount,
      firstTs: stats.firstTs,
      lastTs: stats.lastTs,
      providers: stats.providers,
      recentInbound: stats.recentInbound,
      recentOutbound: stats.recentOutbound,
      agentSummary: poll.found ? poll.summaryText : undefined,
    });
  }

  // Compose final user-facing reply.
  const lines: string[] = [];
  lines.push(`Messages : ${stats.inCount} in, ${stats.outCount} out`);
  if (stats.firstTs && stats.lastTs && stats.firstTs !== stats.lastTs) {
    lines.push(`Span     : ${stats.firstTs} → ${stats.lastTs}`);
  }
  if (cleared > 0) {
    lines.push(`Cleared  : ${cleared} continuation${cleared === 1 ? '' : 's'} (${stats.providers.join(', ')})`);
  } else {
    lines.push('Cleared  : no active continuation');
  }
  if (snapshotRel) {
    lines.push(`Snapshot : ${snapshotRel}`);
  }
  if (poll.found) {
    lines.push('');
    lines.push('Agent summary:');
    for (const l of poll.summaryText.split('\n')) lines.push(l);
  } else {
    lines.push('Summary  : timed out waiting for agent — cleared anyway.');
  }
  writeReply(ctx, renderReport('**Session reset**', lines));
}

function clearContinuations(ctx: SessionCommandContext): number {
  const outDb = openOutboundDbRw(ctx.session.agent_group_id, ctx.session.id);
  try {
    return outDb.prepare("DELETE FROM session_state WHERE key LIKE 'continuation:%'").run().changes;
  } finally {
    outDb.close();
  }
}

async function doClear(ctx: SessionCommandContext, stats: ResetStats): Promise<void> {
  if (isContainerRunning(ctx.session.id)) {
    killContainer(ctx.session.id, 'admin /reset --quick');
  }
  const cleared = clearContinuations(ctx);

  let snapshotRel: string | undefined;
  if (stats.inCount > 0 || stats.outCount > 0) {
    snapshotRel = writeSessionSnapshot(ctx, {
      inCount: stats.inCount,
      outCount: stats.outCount,
      firstTs: stats.firstTs,
      lastTs: stats.lastTs,
      providers: stats.providers,
      recentInbound: stats.recentInbound,
      recentOutbound: stats.recentOutbound,
    });
  }

  const lines: string[] = [];
  lines.push(`Messages : ${stats.inCount} in, ${stats.outCount} out`);
  if (stats.firstTs && stats.lastTs && stats.firstTs !== stats.lastTs) {
    lines.push(`Span     : ${stats.firstTs} → ${stats.lastTs}`);
  } else if (stats.firstTs) {
    lines.push(`Span     : ${stats.firstTs}`);
  }
  if (cleared > 0) {
    lines.push(`Cleared  : ${cleared} continuation${cleared === 1 ? '' : 's'} (${stats.providers.join(', ')})`);
  } else {
    lines.push('Cleared  : no active continuation');
  }
  if (snapshotRel) {
    lines.push(`Snapshot : ${snapshotRel}`);
  }
  lines.push('Next message starts a fresh conversation.');
  writeReply(ctx, renderReport('**Session reset (quick)**', lines));
}

async function pollForResetSummary(
  ctx: SessionCommandContext,
  startSeq: number,
  timeoutMs: number,
): Promise<{ found: true; summaryText: string } | { found: false }> {
  const intervalMs = Math.min(500, Math.max(20, Math.floor(timeoutMs / 10)));
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const outDb = openOutboundDb(ctx.session.agent_group_id, ctx.session.id);
    let row: { content: string } | undefined;
    try {
      // seq > startSeq filters out any stale sentinel reply from a prior
      // /reset that is still in outbound.db.
      row = outDb
        .prepare(
          `SELECT content FROM messages_out
           WHERE seq > ? AND kind = 'chat' AND content LIKE ?
           ORDER BY seq ASC LIMIT 1`,
        )
        .get(startSeq, `%${RESET_SENTINEL}%`) as { content: string } | undefined;
    } finally {
      outDb.close();
    }
    if (row) {
      const text = extractText(row.content).replace(RESET_SENTINEL, '').trim();
      return { found: true, summaryText: text };
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { found: false };
}

interface SnapshotPayload {
  inCount: number;
  outCount: number;
  firstTs?: string;
  lastTs?: string;
  providers: string[];
  recentInbound: Array<{ timestamp: string; content: string }>;
  recentOutbound: Array<{ timestamp: string; content: string }>;
  agentSummary?: string;
}

function writeSessionSnapshot(ctx: SessionCommandContext, p: SnapshotPayload): string | undefined {
  const group = getAgentGroup(ctx.session.agent_group_id);
  if (!group) {
    log.warn('Snapshot skipped — agent group not found', { agentGroupId: ctx.session.agent_group_id });
    return undefined;
  }
  const folder = path.join(GROUPS_DIR, group.folder, '.session-history');
  try {
    fs.mkdirSync(folder, { recursive: true });
  } catch (err) {
    log.warn('Snapshot directory create failed', { folder, error: (err as Error).message });
    return undefined;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = `${ctx.session.id}-${stamp}.md`;
  const filePath = path.join(folder, file);

  const md: string[] = [];
  md.push(`# Session snapshot — ${ctx.session.id}`);
  md.push('');
  md.push(`- Reset at  : ${new Date().toISOString()}`);
  if (p.firstTs && p.lastTs && p.firstTs !== p.lastTs) {
    md.push(`- Span      : ${p.firstTs} → ${p.lastTs}`);
  } else if (p.firstTs) {
    md.push(`- Span      : ${p.firstTs}`);
  }
  md.push(`- Messages  : ${p.inCount} in, ${p.outCount} out`);
  if (p.providers.length > 0) {
    md.push(`- Cleared   : continuation for ${p.providers.join(', ')}`);
  }
  if (p.agentSummary) {
    md.push('');
    md.push('## Agent summary');
    md.push('');
    md.push(p.agentSummary);
  }
  md.push('');
  md.push('## Recent inbound (oldest → newest, up to 5)');
  md.push('');
  if (p.recentInbound.length === 0) {
    md.push('_(none)_');
  } else {
    for (const row of p.recentInbound) {
      md.push(`- **${row.timestamp}** — ${extractTextForSnapshot(row.content)}`);
    }
  }
  md.push('');
  md.push('## Recent outbound (oldest → newest, up to 5)');
  md.push('');
  if (p.recentOutbound.length === 0) {
    md.push('_(none)_');
  } else {
    for (const row of p.recentOutbound) {
      md.push(`- **${row.timestamp}** — ${extractTextForSnapshot(row.content)}`);
    }
  }
  md.push('');

  try {
    fs.writeFileSync(filePath, md.join('\n'));
  } catch (err) {
    log.warn('Snapshot write failed', { filePath, error: (err as Error).message });
    return undefined;
  }
  return path.join(group.folder, '.session-history', file);
}

function extractTextForSnapshot(raw: string): string {
  try {
    const p = JSON.parse(raw);
    if (typeof p === 'string') return truncate(p, 300);
    if (p && typeof p.text === 'string') return truncate(p.text, 300);
  } catch {
    // fall through
  }
  return truncate(raw, 300);
}

async function handleKill(_args: string, ctx: SessionCommandContext): Promise<void> {
  // v1 wording (nanoclaw-v1/src/index.ts:762-787): same status messages so
  // operator muscle memory works across v1 and v2.
  if (!isContainerRunning(ctx.session.id)) {
    writeReply(ctx, 'No active container to kill.');
    return;
  }
  killContainer(ctx.session.id, 'admin /kill');
  writeReply(ctx, 'Container killed. Session preserved — use /reset if you want a fresh start.');
}

async function handleLast(args: string, ctx: SessionCommandContext): Promise<void> {
  // v1 contract (nanoclaw-v1/src/index.ts:734-758):
  //   - Optional N (1..10, default 1).
  //   - Returns the last N BOT messages — outbound `kind='chat'` only.
  //   - "No agent responses found." when there are no outbound chat rows.
  //   - When N=1, single block "<ts>\n<content>". When N>1, numbered with
  //     "[i] <ts>\n<content>" separated by "---".
  const requested = parseInt(args.trim(), 10);
  const n = Math.min(Math.max(Number.isFinite(requested) ? requested : 1, 1), 10);

  const outDb = openOutboundDb(ctx.session.agent_group_id, ctx.session.id);
  let rows: Array<{ timestamp: string; content: string }> = [];
  try {
    rows = outDb
      .prepare("SELECT timestamp, content FROM messages_out WHERE kind = 'chat' ORDER BY seq DESC LIMIT ?")
      .all(n) as Array<{ timestamp: string; content: string }>;
  } finally {
    outDb.close();
  }

  if (rows.length === 0) {
    writeReply(ctx, 'No agent responses found.');
    return;
  }

  // v1 ordered oldest-first in the output; we mimic that.
  const ordered = rows.slice().reverse();
  const blocks = ordered.map((row, i) => {
    const prefix = ordered.length > 1 ? `[${i + 1}] ${row.timestamp}\n` : `${row.timestamp}\n`;
    return prefix + extractText(row.content);
  });
  const body = blocks.join('\n---\n');
  // Code-fence the body so Discord preserves whitespace and newlines.
  writeReply(ctx, renderReport(undefined, [body]));
}

async function handleBtw(args: string, ctx: SessionCommandContext): Promise<void> {
  // Stash the operator's note into inbound.db with trigger=0 so it sits in
  // the agent's next context batch without waking the container now. The
  // text is prefixed with the v1 marker (nanoclaw-v1/src/index.ts:966) so
  // the agent reads it as a side note rather than as a prompt to act on.
  //
  // Empty /btw is a silent no-op — matches v1's behavior of returning
  // without an error message.
  const trimmed = args.trim();
  if (!trimmed) return;

  const prefixed = `[btw — side note, no response needed unless relevant]: ${trimmed}`;
  writeSessionMessage(ctx.session.agent_group_id, ctx.session.id, {
    id: `btw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: ctx.deliveryAddr.platformId,
    channelType: ctx.deliveryAddr.channelType,
    threadId: ctx.deliveryAddr.threadId,
    content: JSON.stringify({ text: prefixed, btw: true }),
    trigger: 0,
  });
  writeReply(ctx, `Noted — stashed for the next batch (${trimmed.length} chars).`);
}

function extractText(rawContent: string): string {
  try {
    const parsed = JSON.parse(rawContent);
    if (typeof parsed === 'string') return parsed;
    if (parsed && typeof parsed.text === 'string') return parsed.text;
    return rawContent;
  } catch {
    return rawContent;
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}
