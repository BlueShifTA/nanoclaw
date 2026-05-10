/**
 * v1 PARITY AUDIT — enforces that v2's session-command outputs match the
 * v1 contract documented in nanoclaw-v1/src/index.ts (lines 661-904).
 *
 * The tests are intentionally strict on the user-visible signals that
 * existed in v1, so v2 changes can't silently lose them. Each section
 * cites the v1 line range.
 *
 * Mocks: container-runner (no Docker). Real per-test SQLite DBs.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockIsContainerRunning, mockKillContainer, mockWakeContainer, TEST_DIR, TEST_GROUPS_DIR } = vi.hoisted(() => ({
  mockIsContainerRunning: vi.fn(),
  mockKillContainer: vi.fn(),
  mockWakeContainer: vi.fn(),
  TEST_DIR: '/tmp/nanoclaw-test-v1-parity',
  TEST_GROUPS_DIR: '/tmp/nanoclaw-test-v1-parity-groups',
}));

vi.mock('./container-runner.js', () => ({
  isContainerRunning: mockIsContainerRunning,
  killContainer: mockKillContainer,
  wakeContainer: mockWakeContainer,
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: TEST_DIR, GROUPS_DIR: TEST_GROUPS_DIR };
});

import { initTestDb, closeDb, runMigrations, createAgentGroup } from './db/index.js';
import { ensureSchema } from './db/session-db.js';
import { inboundDbPath, openInboundDb, outboundDbPath } from './session-manager.js';
import { handleSessionCommand } from './session-commands.js';
import type { Session } from './types.js';

const AGENT_GROUP = 'ag-v1-parity';
const SESSION_ID = 'sess-v1-parity';

function buildSession(): Session {
  return {
    id: SESSION_ID,
    agent_group_id: AGENT_GROUP,
    messaging_group_id: 'mg-1',
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'idle',
    last_active: null,
    created_at: new Date().toISOString(),
  };
}
function ctx() {
  return {
    session: buildSession(),
    deliveryAddr: { channelType: 'discord', platformId: 'discord:guild:123', threadId: 'discord:thread:456' },
  };
}
function ensureSessionDbs(): void {
  fs.mkdirSync(path.join(TEST_DIR, 'v2-sessions', AGENT_GROUP, SESSION_ID), { recursive: true });
  ensureSchema(inboundDbPath(AGENT_GROUP, SESSION_ID), 'inbound');
  ensureSchema(outboundDbPath(AGENT_GROUP, SESSION_ID), 'outbound');
}
function lastOutboundText(): string {
  const db = new Database(outboundDbPath(AGENT_GROUP, SESSION_ID));
  try {
    const row = db.prepare('SELECT content FROM messages_out ORDER BY seq DESC LIMIT 1').get() as
      | { content: string }
      | undefined;
    if (!row) return '';
    try {
      return (JSON.parse(row.content) as { text?: string }).text ?? '';
    } catch {
      return row.content;
    }
  } finally {
    db.close();
  }
}

beforeEach(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.rmSync(TEST_GROUPS_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(path.join(TEST_GROUPS_DIR, 'test'), { recursive: true });
  const db = initTestDb();
  runMigrations(db);
  createAgentGroup({
    id: AGENT_GROUP,
    name: 'Test',
    folder: 'test',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  ensureSessionDbs();
  mockIsContainerRunning.mockReset();
  mockKillContainer.mockReset();
  mockWakeContainer.mockReset().mockResolvedValue(true);
});

afterEach(() => {
  closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.rmSync(TEST_GROUPS_DIR, { recursive: true, force: true });
  vi.clearAllMocks();
});

// =============================================================================
// /ping  — v1 lines 661-731
// =============================================================================
//
// v1 contract:
//   Line 1: "NanoClaw alive"
//   Line 2: Agent: <state>   one of:
//     - "running scheduled task (Xh Ym)"
//     - "idle (container alive, waiting for input)"
//     - "processing (running Xh Ym[, last output Yh Ym ago])"
//     - "idle (no active container)"
//   Line 3: Session: <id-prefix>…  OR  Session: none
//   Line 4: Last activity: <localised>  OR  Last activity: none
//   Line 5 (optional): Last output: "<truncated>…"
//   Line 6 (optional): ⚠️ Possible drift — silent for X. ...
//
// Side effect (not asserted here — covered by integration): if container
// active and not drifted, queue a [ping] prompt to active container.
// =============================================================================
describe('v1-parity: /ping', () => {
  it('includes "NanoClaw alive" header', async () => {
    mockIsContainerRunning.mockReturnValue(false);
    await handleSessionCommand('/ping', '', ctx());
    expect(lastOutboundText()).toMatch(/NanoClaw alive/);
  });

  it('shows "idle (no active container)" when no container', async () => {
    mockIsContainerRunning.mockReturnValue(false);
    await handleSessionCommand('/ping', '', ctx());
    expect(lastOutboundText()).toMatch(/Agent:.*idle.*no active container/i);
  });

  it('shows "processing" or "idle (container alive...)" when container is running', async () => {
    // v1 distinguishes: container running + inbound being processed → "processing",
    // vs container running + nothing in-flight → "idle (container alive, waiting for input)".
    // Either signal is acceptable so long as the operator can tell the container is up.
    mockIsContainerRunning.mockReturnValue(true);
    await handleSessionCommand('/ping', '', ctx());
    expect(lastOutboundText()).toMatch(/Agent:.*(processing|container alive)/i);
  });

  it('includes Session: line with FULL id (operator preference — overrides v1 truncation)', async () => {
    mockIsContainerRunning.mockReturnValue(false);
    await handleSessionCommand('/ping', '', ctx());
    expect(lastOutboundText()).toMatch(new RegExp(`Session:\\s+${SESSION_ID}`));
  });

  it('includes Last activity: line', async () => {
    mockIsContainerRunning.mockReturnValue(false);
    await handleSessionCommand('/ping', '', ctx());
    expect(lastOutboundText()).toMatch(/Last activity:/i);
  });
});

// =============================================================================
// /last [n]  — v1 lines 734-758
// =============================================================================
//
// v1 contract:
//   - Optional arg N (1..10, default 1)
//   - Returns the last N BOT messages (outbound only) — NOT inbound
//   - Multiple results separated by "---" with a "[i] <time>\n" prefix
//   - Single result has just "<time>\n<content>"
//   - "No agent responses found." when DB is empty
// =============================================================================
describe('v1-parity: /last', () => {
  function seedOutbound(text: string): void {
    const db = new Database(outboundDbPath(AGENT_GROUP, SESSION_ID));
    db.prepare(
      `INSERT INTO messages_out (id, seq, timestamp, kind, platform_id, channel_type, content)
       VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 2 FROM messages_out), datetime('now'),
               'chat', 'discord:guild:123', 'discord', ?)`,
    ).run(`out-${Date.now()}-${Math.random()}`, JSON.stringify({ text }));
    db.close();
  }

  it('with no outbound rows, replies "No agent responses found."', async () => {
    await handleSessionCommand('/last', '', ctx());
    expect(lastOutboundText()).toMatch(/No agent responses found/i);
  });

  it('without arg, returns just the most recent agent output (1 message)', async () => {
    seedOutbound('first reply');
    seedOutbound('second reply');
    seedOutbound('third reply');

    await handleSessionCommand('/last', '', ctx());
    const text = lastOutboundText();
    expect(text).toContain('third reply');
    expect(text).not.toContain('second reply');
  });

  it('with arg "2", returns the last 2 agent outputs', async () => {
    seedOutbound('first reply');
    seedOutbound('second reply');
    seedOutbound('third reply');

    await handleSessionCommand('/last', '2', ctx());
    const text = lastOutboundText();
    expect(text).toContain('second reply');
    expect(text).toContain('third reply');
    expect(text).not.toContain('first reply');
  });

  it('caps N at 10 (defensive — v1 clamps)', async () => {
    for (let i = 0; i < 15; i++) seedOutbound(`msg ${i}`);
    await handleSessionCommand('/last', '999', ctx());
    const text = lastOutboundText();
    // 15 seeded, max 10 returned — so msg 4 (15-10) is the oldest in the reply.
    expect(text).not.toContain('msg 3');
    expect(text).toContain('msg 14');
  });

  it('does NOT mix inbound (user) rows into the output — bot only', async () => {
    const inDb = openInboundDb(AGENT_GROUP, SESSION_ID);
    inDb
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, content, status, trigger)
         VALUES ('user-msg', (SELECT COALESCE(MAX(seq), 0) + 2 FROM messages_in), 'chat',
                 datetime('now'), '{"text":"USER WROTE THIS"}', 'completed', 1)`,
      )
      .run();
    inDb.close();
    seedOutbound('AGENT WROTE THIS');

    await handleSessionCommand('/last', '', ctx());
    const text = lastOutboundText();
    expect(text).toContain('AGENT WROTE THIS');
    expect(text).not.toContain('USER WROTE THIS');
  });
});

// =============================================================================
// /kill  — v1 lines 762-787
// =============================================================================
describe('v1-parity: /kill', () => {
  it('"No active container to kill." when no container running', async () => {
    mockIsContainerRunning.mockReturnValue(false);
    await handleSessionCommand('/kill', '', ctx());
    expect(lastOutboundText()).toMatch(/No active container to kill/i);
  });

  it('on kill, mentions /reset as the alternative to actually clear state', async () => {
    mockIsContainerRunning.mockReturnValue(true);
    await handleSessionCommand('/kill', '', ctx());
    expect(lastOutboundText()).toMatch(/\/reset/);
    expect(lastOutboundText()).toMatch(/(killed|preserved)/i);
  });
});

// =============================================================================
// /btw  — v1 lines 962-977
// =============================================================================
//
// v1 contract: prefixes the note with "[btw — side note, no response needed
// unless relevant]: " before forwarding to the agent. Empty /btw is a
// silent no-op (returns without error message).
// =============================================================================
describe('v1-parity: /btw', () => {
  function listInbound(): Array<{ content: string; trigger: number }> {
    const db = new Database(inboundDbPath(AGENT_GROUP, SESSION_ID));
    try {
      return db.prepare('SELECT content, trigger FROM messages_in ORDER BY seq ASC').all() as Array<{
        content: string;
        trigger: number;
      }>;
    } finally {
      db.close();
    }
  }

  it('empty /btw is silent (no user-facing error, no inbound row added)', async () => {
    await handleSessionCommand('/btw', '', ctx());
    expect(listInbound()).toEqual([]);
  });

  it('prefixes the note with the [btw — side note, no response needed unless relevant]: marker', async () => {
    await handleSessionCommand('/btw', 'the slack channel id is C123', ctx());
    const rows = listInbound();
    expect(rows.length).toBe(1);
    const parsed = JSON.parse(rows[0].content);
    expect(parsed.text).toMatch(/\[btw — side note, no response needed unless relevant\]:/);
    expect(parsed.text).toContain('the slack channel id is C123');
  });

  it('stores with trigger=0 (context only, no agent wake)', async () => {
    await handleSessionCommand('/btw', 'context note', ctx());
    const rows = listInbound();
    expect(rows[0].trigger).toBe(0);
  });
});

// =============================================================================
// /reset  — v1 lines 790-867
// =============================================================================
//
// v1 contract:
//   - If no session: "No active session to summarise. State cleared."
//   - Else: "Summarising session before reset..." THEN runs an agent
//     turn with this exact prompt:
//       1. Write journal to /workspace/extra/armlab/journal/<ts>.md
//       2. Update persistent memory in /workspace/group/CLAUDE.md (append
//          "## Session <ts>" section)
//       3. Reply with short confirmation
//   - After agent reply: clear session + drift state + advance cursor
//   - Final message: "Session cleared. Ready for a fresh start."
//
// v2 deviates intentionally: the in-container path is /workspace/agent/
// (not /workspace/group/) and the memory file is CLAUDE.local.md (not
// CLAUDE.md). The parity tests below pin the v1 INTENT (journal write +
// persistent memory update), not the exact v1 paths.
// =============================================================================
describe('v1-parity: /reset', () => {
  function seedOneInbound(): void {
    const inDb = openInboundDb(AGENT_GROUP, SESSION_ID);
    inDb
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, content, status, trigger)
         VALUES ('in-1', (SELECT COALESCE(MAX(seq), 0) + 2 FROM messages_in), 'chat',
                 datetime('now'), '{"text":"a real prompt"}', 'completed', 1)`,
      )
      .run();
    inDb.close();
  }
  function lastInbound(): { content: string } | undefined {
    const db = new Database(inboundDbPath(AGENT_GROUP, SESSION_ID));
    try {
      return db.prepare('SELECT content FROM messages_in ORDER BY seq DESC LIMIT 1').get() as
        | { content: string }
        | undefined;
    } finally {
      db.close();
    }
  }

  it('summary prompt instructs the agent to write a journal entry', async () => {
    seedOneInbound();
    const outDb = new Database(outboundDbPath(AGENT_GROUP, SESSION_ID));
    outDb
      .prepare(
        `INSERT INTO messages_out (id, seq, timestamp, kind, platform_id, channel_type, content)
         VALUES ('reply-sentinel', (SELECT COALESCE(MAX(seq), 0) + 1 FROM messages_out),
                 datetime('now'), 'chat', 'discord:guild:123', 'discord',
                 '{"text":"done __SESSION_RESET_SUMMARY_COMPLETE__"}')`,
      )
      .run();
    outDb.close();

    mockIsContainerRunning.mockReturnValue(false);
    await handleSessionCommand('/reset', '', ctx());

    // The inbound message just before the agent's sentinel reply should be
    // our summary-request prompt — and that prompt must mention "journal".
    const lastIn = lastInbound();
    expect(lastIn).toBeTruthy();
    const text = JSON.parse(lastIn!.content).text as string;
    expect(text).toMatch(/journal/i);
  });

  it('summary prompt instructs the agent to update persistent memory', async () => {
    seedOneInbound();
    const outDb = new Database(outboundDbPath(AGENT_GROUP, SESSION_ID));
    outDb
      .prepare(
        `INSERT INTO messages_out (id, seq, timestamp, kind, platform_id, channel_type, content)
         VALUES ('reply-sentinel', (SELECT COALESCE(MAX(seq), 0) + 1 FROM messages_out),
                 datetime('now'), 'chat', 'discord:guild:123', 'discord',
                 '{"text":"done __SESSION_RESET_SUMMARY_COMPLETE__"}')`,
      )
      .run();
    outDb.close();

    mockIsContainerRunning.mockReturnValue(false);
    await handleSessionCommand('/reset', '', ctx());

    const lastIn = lastInbound();
    expect(lastIn).toBeTruthy();
    const text = JSON.parse(lastIn!.content).text as string;
    expect(text).toMatch(/memory|CLAUDE\.local\.md|MEMORY\.md/i);
  });

  it('with no session content, falls back to a clean "nothing to summarise" path', async () => {
    mockIsContainerRunning.mockReturnValue(false);
    // No seed — empty session.
    await handleSessionCommand('/reset', '', ctx());

    const reply = lastOutboundText();
    expect(reply).toMatch(/no active|cleared|empty/i);
    // And: no reset-req-* in inbound (didn't bother the agent).
    const db = new Database(inboundDbPath(AGENT_GROUP, SESSION_ID));
    const row = db.prepare("SELECT COUNT(*) AS c FROM messages_in WHERE id LIKE 'reset-req-%'").get() as { c: number };
    db.close();
    expect(row.c).toBe(0);
  });
});

// =============================================================================
// /compact  — v1 lines 870-904
// =============================================================================
//
// v1 contract:
//   - If no session: "No active session to compact."
//   - If container active: pipe "/compact" directly to it (queue.sendMessage)
//   - Else: spawn new container with /compact prompt
//
// v2 differs architecturally: /compact is in command-gate's ADMIN_COMMANDS
// set and passes through to the container/SDK normally. There's no
// dedicated host handler. This test simply documents the divergence so a
// regression that drops /compact from ADMIN_COMMANDS is caught.
// =============================================================================
describe('v1-parity: /compact', () => {
  it('/compact is whitelisted in command-gate as an admin pass-through', async () => {
    const { default: gateModule } = await import('./command-gate.js').then((m) => ({ default: m }));
    // Smoke: gateCommand should not classify /compact as "filter" or unknown.
    // We can't call it directly without DB setup, but we can grep the source
    // to confirm the constant has /compact.
    const src = fs.readFileSync(path.join(__dirname, 'command-gate.ts'), 'utf-8');
    expect(src).toMatch(/['"]\/compact['"]/);
    expect(typeof gateModule.gateCommand).toBe('function');
  });
});
