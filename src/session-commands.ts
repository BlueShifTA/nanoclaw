/**
 * Host-side session command handlers. These run on the host without
 * waking the container; they manipulate session state (continuation
 * pointer, container lifecycle) and write replies directly to
 * outbound.db so the normal delivery loop picks them up.
 *
 * Dispatched from router.ts when gateCommand returns `action: 'handle'`.
 */
import { killContainer, isContainerRunning } from './container-runner.js';
import { log } from './log.js';
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

export async function handleSessionCommand(
  command: string,
  args: string,
  ctx: SessionCommandContext,
): Promise<void> {
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

async function handlePing(_args: string, ctx: SessionCommandContext): Promise<void> {
  const running = isContainerRunning(ctx.session.id);
  writeReply(ctx, running ? 'pong (container running)' : 'pong');
}

async function handleReset(_args: string, ctx: SessionCommandContext): Promise<void> {
  // Clear every provider's continuation row so the next message starts a
  // fresh conversation. Kill any live container so it can't write a stale
  // continuation back after we cleared it.
  if (isContainerRunning(ctx.session.id)) {
    killContainer(ctx.session.id, 'admin /reset');
  }
  const db = openOutboundDbRw(ctx.session.agent_group_id, ctx.session.id);
  let changes = 0;
  try {
    const result = db
      .prepare("DELETE FROM session_state WHERE key LIKE 'continuation:%'")
      .run();
    changes = result.changes;
  } finally {
    db.close();
  }
  writeReply(
    ctx,
    changes > 0
      ? `Session reset. Cleared ${changes} continuation${changes === 1 ? '' : 's'} — next message starts fresh.`
      : 'Session reset. No active continuation to clear — next message starts fresh.',
  );
}

async function handleKill(_args: string, ctx: SessionCommandContext): Promise<void> {
  if (!isContainerRunning(ctx.session.id)) {
    writeReply(ctx, 'No container running for this session.');
    return;
  }
  killContainer(ctx.session.id, 'admin /kill');
  writeReply(ctx, 'Container killed.');
}

async function handleLast(_args: string, ctx: SessionCommandContext): Promise<void> {
  // Pull the most recent inbound message and most recent outbound (delivered
  // or pending) message so the operator can see where the conversation
  // stands without re-reading the channel scrollback.
  let lastInbound: { timestamp: string; content: string } | undefined;
  let lastOutbound: { timestamp: string; content: string } | undefined;

  const inboundDb = openInboundDb(ctx.session.agent_group_id, ctx.session.id);
  try {
    lastInbound = inboundDb
      .prepare(
        "SELECT timestamp, content FROM messages_in WHERE kind IN ('chat', 'chat-sdk') ORDER BY seq DESC LIMIT 1",
      )
      .get() as { timestamp: string; content: string } | undefined;
  } finally {
    inboundDb.close();
  }

  const outboundDb = openOutboundDb(ctx.session.agent_group_id, ctx.session.id);
  try {
    lastOutbound = outboundDb
      .prepare(
        "SELECT timestamp, content FROM messages_out WHERE kind = 'chat' ORDER BY seq DESC LIMIT 1",
      )
      .get() as { timestamp: string; content: string } | undefined;
  } finally {
    outboundDb.close();
  }

  const lines: string[] = ['*Last interaction*'];
  if (lastInbound) {
    lines.push(`In  (${lastInbound.timestamp}): ${truncate(extractText(lastInbound.content), 200)}`);
  } else {
    lines.push('In  : (none)');
  }
  if (lastOutbound) {
    lines.push(`Out (${lastOutbound.timestamp}): ${truncate(extractText(lastOutbound.content), 200)}`);
  } else {
    lines.push('Out : (none)');
  }
  writeReply(ctx, lines.join('\n'));
}

async function handleBtw(args: string, ctx: SessionCommandContext): Promise<void> {
  // Stash the operator's note into inbound.db with trigger=0 so it sits in
  // the agent's next context batch without waking the container right now.
  // The next real (triggering) message will see it.
  if (!args) {
    writeReply(ctx, 'Usage: /btw <note>. Stashes the note into the next message batch without replying.');
    return;
  }
  writeSessionMessage(ctx.session.agent_group_id, ctx.session.id, {
    id: `btw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: ctx.deliveryAddr.platformId,
    channelType: ctx.deliveryAddr.channelType,
    threadId: ctx.deliveryAddr.threadId,
    content: JSON.stringify({ text: args, btw: true }),
    trigger: 0,
  });
  writeReply(ctx, `Noted — stashed for the next batch (${args.length} chars).`);
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
