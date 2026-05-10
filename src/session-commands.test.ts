/**
 * Session command handler tests. Uses real per-test SQLite session DBs
 * but mocks the container runner (no Docker).
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockIsContainerRunning, mockKillContainer, mockWakeContainer, TEST_DIR, TEST_GROUPS_DIR } = vi.hoisted(() => ({
  mockIsContainerRunning: vi.fn(),
  mockKillContainer: vi.fn(),
  mockWakeContainer: vi.fn(),
  TEST_DIR: '/tmp/nanoclaw-test-session-commands',
  TEST_GROUPS_DIR: '/tmp/nanoclaw-test-session-commands-groups',
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
import { inboundDbPath, openInboundDb, openOutboundDb, outboundDbPath } from './session-manager.js';
import { handleSessionCommand } from './session-commands.js';
import type { Session } from './types.js';

const AGENT_GROUP = 'ag-cmd';
const SESSION_ID = 'sess-cmd';

function now(): string {
  return new Date().toISOString();
}

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
    created_at: now(),
  };
}

function ctx() {
  return {
    session: buildSession(),
    deliveryAddr: {
      channelType: 'discord',
      platformId: 'discord:guild:123',
      threadId: 'discord:thread:456',
    },
  };
}

function ensureSessionDbs(): void {
  const sessDir = path.join(TEST_DIR, 'v2-sessions', AGENT_GROUP, SESSION_ID);
  fs.mkdirSync(sessDir, { recursive: true });
  ensureSchema(inboundDbPath(AGENT_GROUP, SESSION_ID), 'inbound');
  ensureSchema(outboundDbPath(AGENT_GROUP, SESSION_ID), 'outbound');
}

function lastOutbound(): { kind: string; content: string } | undefined {
  const db = new Database(outboundDbPath(AGENT_GROUP, SESSION_ID));
  try {
    return db.prepare('SELECT kind, content FROM messages_out ORDER BY seq DESC LIMIT 1').get() as
      | { kind: string; content: string }
      | undefined;
  } finally {
    db.close();
  }
}

function outboundText(): string | undefined {
  const row = lastOutbound();
  if (!row) return undefined;
  try {
    return (JSON.parse(row.content) as { text?: string }).text;
  } catch {
    return row.content;
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
    created_at: now(),
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

describe('reply rendering — fenced code block preserves whitespace on Discord', () => {
  // The Discord chat adapter parses outgoing `markdown` into a markdown
  // AST then re-emits — single newlines collapse to spaces under
  // standard paragraph semantics. Replies that need column alignment
  // (the multi-line status reports) MUST live inside a ```...``` fence
  // so Discord renders the body verbatim, monospace.
  it('/ping reply body is wrapped in a fenced code block', async () => {
    mockIsContainerRunning.mockReturnValue(false);
    await handleSessionCommand('/ping', '', ctx());
    const text = outboundText() ?? '';
    expect(text).toMatch(/```[\s\S]*Container[\s\S]*```/);
  });

  it('/reset reply body is wrapped in a fenced code block', async () => {
    mockIsContainerRunning.mockReturnValue(false);
    await handleSessionCommand('/reset', '', ctx());
    const text = outboundText() ?? '';
    expect(text).toMatch(/```[\s\S]*Messages[\s\S]*```/);
  });

  it('/last reply body is wrapped in a fenced code block', async () => {
    await handleSessionCommand('/last', '', ctx());
    const text = outboundText() ?? '';
    expect(text).toMatch(/```[\s\S]*In[\s\S]*```/);
  });
});

describe('/ping — container status report', () => {
  it('reports container state (idle when not running)', async () => {
    mockIsContainerRunning.mockReturnValue(false);
    await handleSessionCommand('/ping', '', ctx());
    const text = outboundText() ?? '';
    expect(text).toContain('Container');
    expect(text).toContain('idle');
  });

  it('reports container state (running when alive)', async () => {
    mockIsContainerRunning.mockReturnValue(true);
    await handleSessionCommand('/ping', '', ctx());
    const text = outboundText() ?? '';
    expect(text).toContain('Container');
    expect(text).toContain('running');
  });

  it('reports continuation status — "none" when no continuation row', async () => {
    mockIsContainerRunning.mockReturnValue(false);
    await handleSessionCommand('/ping', '', ctx());
    const text = outboundText() ?? '';
    expect(text).toContain('Continuation');
    expect(text).toContain('none');
  });

  it('reports continuation status — provider names when continuations exist', async () => {
    const db = new Database(outboundDbPath(AGENT_GROUP, SESSION_ID));
    db.prepare(
      "INSERT INTO session_state (key, value, updated_at) VALUES ('continuation:claude', 'abc', datetime('now'))",
    ).run();
    db.close();

    mockIsContainerRunning.mockReturnValue(false);
    await handleSessionCommand('/ping', '', ctx());
    const text = outboundText() ?? '';
    expect(text).toContain('claude');
  });

  it('reports message counts (in, out)', async () => {
    mockIsContainerRunning.mockReturnValue(false);
    await handleSessionCommand('/ping', '', ctx());
    const text = outboundText() ?? '';
    expect(text).toMatch(/Messages.*\d+ in.*\d+ out/);
  });

  it('does not call killContainer', async () => {
    mockIsContainerRunning.mockReturnValue(false);
    await handleSessionCommand('/ping', '', ctx());
    expect(mockKillContainer).not.toHaveBeenCalled();
  });

  it('reports activity state — idle when nothing is in-flight', async () => {
    mockIsContainerRunning.mockReturnValue(false);
    await handleSessionCommand('/ping', '', ctx());
    const text = outboundText() ?? '';
    expect(text).toContain('Activity');
    expect(text).toMatch(/idle/i);
  });

  it('reports activity state — processing when messages_in has status=processing', async () => {
    const inDb = openInboundDb(AGENT_GROUP, SESSION_ID);
    inDb
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, content, status, trigger)
         VALUES ('msg-proc', (SELECT COALESCE(MAX(seq), 0) + 2 FROM messages_in), 'chat', datetime('now'), '{"text":"hi"}', 'processing', 1)`,
      )
      .run();
    inDb.close();

    mockIsContainerRunning.mockReturnValue(true);
    await handleSessionCommand('/ping', '', ctx());
    const text = outboundText() ?? '';
    expect(text).toMatch(/processing/i);
    expect(text).toMatch(/1 message/i);
  });

  it('reports scheduled-tasks state — count of pending tasks with process_after in the future', async () => {
    const inDb = openInboundDb(AGENT_GROUP, SESSION_ID);
    inDb
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, process_after, content, status, trigger)
         VALUES ('task-1', (SELECT COALESCE(MAX(seq), 0) + 2 FROM messages_in),
                 'task', datetime('now'), datetime('now', '+1 hour'),
                 '{"text":"future task"}', 'pending', 1)`,
      )
      .run();
    inDb
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, process_after, content, status, trigger)
         VALUES ('task-2', (SELECT COALESCE(MAX(seq), 0) + 2 FROM messages_in),
                 'task', datetime('now'), datetime('now', '+2 hour'),
                 '{"text":"another task"}', 'pending', 1)`,
      )
      .run();
    inDb.close();

    mockIsContainerRunning.mockReturnValue(false);
    await handleSessionCommand('/ping', '', ctx());
    const text = outboundText() ?? '';
    expect(text).toMatch(/Scheduled/i);
    expect(text).toMatch(/2 task/i);
  });

  it('reports scheduled-tasks state — "none" when no future tasks pending', async () => {
    mockIsContainerRunning.mockReturnValue(false);
    await handleSessionCommand('/ping', '', ctx());
    const text = outboundText() ?? '';
    expect(text).toMatch(/Scheduled.*none/i);
  });

  it('reports a due (overdue) scheduled task differently from future ones', async () => {
    const inDb = openInboundDb(AGENT_GROUP, SESSION_ID);
    inDb
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, process_after, content, status, trigger)
         VALUES ('task-due', (SELECT COALESCE(MAX(seq), 0) + 2 FROM messages_in),
                 'task', datetime('now', '-2 hour'), datetime('now', '-1 hour'),
                 '{"text":"overdue task"}', 'pending', 1)`,
      )
      .run();
    inDb.close();

    mockIsContainerRunning.mockReturnValue(false);
    await handleSessionCommand('/ping', '', ctx());
    const text = outboundText() ?? '';
    // "1 due" (overdue), 0 future — host-sweep will fire it on the next tick.
    expect(text).toMatch(/1 due|overdue|1 task.*due/i);
  });
});

describe('/reset', () => {
  function seedContinuation(provider: string, value: string): void {
    const db = new Database(outboundDbPath(AGENT_GROUP, SESSION_ID));
    db.prepare("INSERT INTO session_state (key, value, updated_at) VALUES (?, ?, datetime('now'))").run(
      `continuation:${provider}`,
      value,
    );
    db.close();
  }

  function countContinuations(): number {
    const db = new Database(outboundDbPath(AGENT_GROUP, SESSION_ID));
    try {
      return (
        db.prepare("SELECT COUNT(*) AS c FROM session_state WHERE key LIKE 'continuation:%'").get() as { c: number }
      ).c;
    } finally {
      db.close();
    }
  }

  it('clears every continuation row', async () => {
    seedContinuation('claude', 'session-abc');
    seedContinuation('codex', 'session-xyz');
    expect(countContinuations()).toBe(2);

    mockIsContainerRunning.mockReturnValue(false);
    await handleSessionCommand('/reset', '', ctx());

    expect(countContinuations()).toBe(0);
    const text = outboundText() ?? '';
    expect(text).toMatch(/2 continuations/);
    expect(text).toContain('claude');
    expect(text).toContain('codex');
  });

  it('summarises the session before clearing — counts and time span', async () => {
    // Seed a small history so the summary has something to count.
    const inDb = openInboundDb(AGENT_GROUP, SESSION_ID);
    inDb
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, content, status, trigger)
         VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 2 FROM messages_in), 'chat', datetime('now'), ?, 'pending', 1)`,
      )
      .run('in-1', JSON.stringify({ text: 'first user msg' }));
    inDb
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, content, status, trigger)
         VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 2 FROM messages_in), 'chat', datetime('now'), ?, 'pending', 1)`,
      )
      .run('in-2', JSON.stringify({ text: 'second user msg' }));
    inDb.close();

    const outDb = new Database(outboundDbPath(AGENT_GROUP, SESSION_ID));
    outDb
      .prepare(
        `INSERT INTO messages_out (id, seq, timestamp, kind, platform_id, channel_type, content)
         VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 2 FROM messages_out), datetime('now'), 'chat', 'discord:guild:123', 'discord', ?)`,
      )
      .run('out-1', JSON.stringify({ text: 'agent reply' }));
    outDb.close();

    seedContinuation('claude', 'session-abc');
    mockIsContainerRunning.mockReturnValue(false);
    await handleSessionCommand('/reset', '--quick', ctx());

    const text = outboundText() ?? '';
    // Summary lines must mention message counts and an indication of
    // what was cleared. The exact format is flexible but these signals
    // must be present so the operator sees what the session held before
    // it got wiped.
    expect(text).toMatch(/2 in/);
    expect(text).toMatch(/1 out/);
    expect(text).toMatch(/Cleared/);
  });

  it('summary still produced for an empty session (no messages)', async () => {
    mockIsContainerRunning.mockReturnValue(false);
    await handleSessionCommand('/reset', '', ctx());
    const text = outboundText() ?? '';
    expect(text).toMatch(/0 in/);
    expect(text).toMatch(/0 out/);
  });

  it('writes a session-history snapshot file to the group folder before clearing (quick mode)', async () => {
    // Seed real content so the snapshot has something to record.
    const inDb = openInboundDb(AGENT_GROUP, SESSION_ID);
    inDb
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, content, status, trigger)
         VALUES ('in-snap-1', (SELECT COALESCE(MAX(seq), 0) + 2 FROM messages_in), 'chat',
                 datetime('now'), '{"text":"the prompt"}', 'completed', 1)`,
      )
      .run();
    inDb.close();
    const outDb = new Database(outboundDbPath(AGENT_GROUP, SESSION_ID));
    outDb
      .prepare(
        `INSERT INTO messages_out (id, seq, timestamp, kind, platform_id, channel_type, content)
         VALUES ('out-snap-1', (SELECT COALESCE(MAX(seq), 0) + 2 FROM messages_out), datetime('now'),
                 'chat', 'discord:guild:123', 'discord', '{"text":"the reply"}')`,
      )
      .run();
    outDb.close();
    seedContinuation('claude', 'continuation-abc');

    mockIsContainerRunning.mockReturnValue(false);
    await handleSessionCommand('/reset', '--quick', ctx());

    const historyDir = path.join(TEST_GROUPS_DIR, 'test', '.session-history');
    expect(fs.existsSync(historyDir), '.session-history directory must exist').toBe(true);
    const files = fs.readdirSync(historyDir).filter((f) => f.endsWith('.md'));
    expect(files.length, 'one snapshot file should be written').toBe(1);

    const content = fs.readFileSync(path.join(historyDir, files[0]), 'utf-8');
    expect(content).toContain(SESSION_ID);
    expect(content).toContain('the prompt');
    expect(content).toContain('the reply');
    expect(content).toMatch(/1 in/);
    expect(content).toMatch(/1 out/);
    expect(content).toContain('claude'); // continuation provider that was cleared
  });

  it('does not write a snapshot for a completely empty session (avoids zero-content clutter)', async () => {
    mockIsContainerRunning.mockReturnValue(false);
    await handleSessionCommand('/reset', '', ctx());
    const historyDir = path.join(TEST_GROUPS_DIR, 'test', '.session-history');
    const files = fs.existsSync(historyDir) ? fs.readdirSync(historyDir).filter((f) => f.endsWith('.md')) : [];
    expect(files.length, 'no snapshot for empty session').toBe(0);
  });

  it('snapshot path mentioned in /reset --quick reply', async () => {
    const inDb = openInboundDb(AGENT_GROUP, SESSION_ID);
    inDb
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, content, status, trigger)
         VALUES ('in-snap-path', (SELECT COALESCE(MAX(seq), 0) + 2 FROM messages_in), 'chat',
                 datetime('now'), '{"text":"hi"}', 'completed', 1)`,
      )
      .run();
    inDb.close();

    mockIsContainerRunning.mockReturnValue(false);
    await handleSessionCommand('/reset', '--quick', ctx());
    const text = outboundText() ?? '';
    expect(text).toMatch(/.session-history/);
  });
});

describe('/reset — agent-driven summary then clear (default)', () => {
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
  function seedContinuation(provider: string, value: string): void {
    const db = new Database(outboundDbPath(AGENT_GROUP, SESSION_ID));
    db.prepare(
      "INSERT INTO session_state (key, value, updated_at) VALUES (?, ?, datetime('now'))",
    ).run(`continuation:${provider}`, value);
    db.close();
  }
  /** Simulate the container writing the agent's summary reply (with sentinel). */
  function injectAgentReply(textWithSentinel: string): void {
    const db = new Database(outboundDbPath(AGENT_GROUP, SESSION_ID));
    db.prepare(
      `INSERT INTO messages_out (id, seq, timestamp, kind, platform_id, channel_type, content)
       VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM messages_out), datetime('now'),
               'chat', 'discord:guild:123', 'discord', ?)`,
    ).run(`agent-reply-${Date.now()}`, JSON.stringify({ text: textWithSentinel }));
    db.close();
  }
  function listInboundIds(): string[] {
    const db = new Database(inboundDbPath(AGENT_GROUP, SESSION_ID));
    try {
      return (db.prepare('SELECT id FROM messages_in ORDER BY seq ASC').all() as Array<{ id: string }>).map(
        (r) => r.id,
      );
    } finally {
      db.close();
    }
  }

  it('writes a summary-request inbound message and wakes the container', async () => {
    seedOneInbound();
    seedContinuation('claude', 'abc');
    mockIsContainerRunning.mockReturnValue(false);

    // Pre-write the agent's sentinel reply so the poll resolves immediately.
    injectAgentReply('Summary: discussed the F-series migration. Wrote /workspace/extra/armlab/journal/2026-05-11.md. __SESSION_RESET_SUMMARY_COMPLETE__');

    await handleSessionCommand('/reset', '', ctx());

    const ids = listInboundIds();
    expect(ids.some((id) => id.startsWith('reset-req-')), 'a reset-req-* row must be in inbound').toBe(true);
    expect(mockWakeContainer).toHaveBeenCalled();
  });

  it('clears the continuation only AFTER the agent replied with the sentinel', async () => {
    seedOneInbound();
    seedContinuation('claude', 'abc');
    mockIsContainerRunning.mockReturnValue(false);

    injectAgentReply('Wrote journal at /workspace/extra/armlab/journal/2026-05-11.md __SESSION_RESET_SUMMARY_COMPLETE__');

    await handleSessionCommand('/reset', '', ctx());

    // After the sentinel was found, continuation must be cleared.
    const outDb = new Database(outboundDbPath(AGENT_GROUP, SESSION_ID));
    const remaining = (
      outDb.prepare("SELECT COUNT(*) AS c FROM session_state WHERE key LIKE 'continuation:%'").get() as { c: number }
    ).c;
    outDb.close();
    expect(remaining).toBe(0);
  });

  it('reply to user echoes the agent summary text (sentinel stripped)', async () => {
    seedOneInbound();
    mockIsContainerRunning.mockReturnValue(false);
    injectAgentReply('Summary: worked on F6 + F7. Journal at /tmp/x.md __SESSION_RESET_SUMMARY_COMPLETE__');

    await handleSessionCommand('/reset', '', ctx());

    const text = outboundText() ?? '';
    expect(text).toContain('worked on F6 + F7');
    expect(text).not.toContain('__SESSION_RESET_SUMMARY_COMPLETE__');
  });

  it('--quick flag skips the agent summary and does the immediate clear', async () => {
    seedOneInbound();
    seedContinuation('claude', 'abc');
    mockIsContainerRunning.mockReturnValue(false);

    await handleSessionCommand('/reset', '--quick', ctx());

    const ids = listInboundIds();
    expect(ids.some((id) => id.startsWith('reset-req-')), 'no reset-req in inbound for --quick').toBe(false);
    expect(mockWakeContainer).not.toHaveBeenCalled();
    const outDb = new Database(outboundDbPath(AGENT_GROUP, SESSION_ID));
    const remaining = (
      outDb.prepare("SELECT COUNT(*) AS c FROM session_state WHERE key LIKE 'continuation:%'").get() as { c: number }
    ).c;
    outDb.close();
    expect(remaining).toBe(0);
  });

  it('empty session falls back to quick clear (no summary request)', async () => {
    mockIsContainerRunning.mockReturnValue(false);
    await handleSessionCommand('/reset', '', ctx());
    const ids = listInboundIds();
    expect(ids.some((id) => id.startsWith('reset-req-'))).toBe(false);
  });

  it('on poll timeout, clears anyway and notes the timeout in the reply', async () => {
    seedOneInbound();
    seedContinuation('claude', 'abc');
    mockIsContainerRunning.mockReturnValue(false);
    // No injectAgentReply — agent never responds, poll must time out.

    // Run with a very short timeout via env override.
    const prev = process.env.NANOCLAW_RESET_TIMEOUT_MS;
    process.env.NANOCLAW_RESET_TIMEOUT_MS = '50';
    try {
      await handleSessionCommand('/reset', '', ctx());
    } finally {
      if (prev === undefined) delete process.env.NANOCLAW_RESET_TIMEOUT_MS;
      else process.env.NANOCLAW_RESET_TIMEOUT_MS = prev;
    }

    const text = outboundText() ?? '';
    expect(text).toMatch(/timed out|timeout/i);
    const outDb = new Database(outboundDbPath(AGENT_GROUP, SESSION_ID));
    const remaining = (
      outDb.prepare("SELECT COUNT(*) AS c FROM session_state WHERE key LIKE 'continuation:%'").get() as { c: number }
    ).c;
    outDb.close();
    expect(remaining).toBe(0);
  });

  it('kills container if one is running so it cannot rewrite a stale continuation', async () => {
    mockIsContainerRunning.mockReturnValue(true);
    await handleSessionCommand('/reset', '--quick', ctx());
    expect(mockKillContainer).toHaveBeenCalled();
    expect(mockKillContainer.mock.calls[0]?.[0]).toBe(SESSION_ID);
    expect(String(mockKillContainer.mock.calls[0]?.[1])).toMatch(/admin \/reset/);
  });

  it('replies cleanly even when there is nothing to clear', async () => {
    mockIsContainerRunning.mockReturnValue(false);
    await handleSessionCommand('/reset', '--quick', ctx());
    expect(outboundText()).toMatch(/no active continuation/);
  });

  it('preserves non-continuation session_state keys', async () => {
    const db = new Database(outboundDbPath(AGENT_GROUP, SESSION_ID));
    db.prepare(
      "INSERT INTO session_state (key, value, updated_at) VALUES ('whatever', 'keep-me', datetime('now'))",
    ).run();
    db.close();
    seedContinuation('claude', 'session-abc');

    mockIsContainerRunning.mockReturnValue(false);
    await handleSessionCommand('/reset', '--quick', ctx());

    const after = new Database(outboundDbPath(AGENT_GROUP, SESSION_ID));
    const row = after.prepare('SELECT value FROM session_state WHERE key = ?').get('whatever') as
      | { value: string }
      | undefined;
    after.close();
    expect(row?.value).toBe('keep-me');
  });
});

describe('/kill', () => {
  it('calls killContainer when one is running', async () => {
    mockIsContainerRunning.mockReturnValue(true);
    await handleSessionCommand('/kill', '', ctx());
    expect(mockKillContainer).toHaveBeenCalledWith(SESSION_ID, 'admin /kill');
    expect(outboundText()).toBe('Container killed.');
  });

  it('replies "no container" without invoking killContainer when idle', async () => {
    mockIsContainerRunning.mockReturnValue(false);
    await handleSessionCommand('/kill', '', ctx());
    expect(mockKillContainer).not.toHaveBeenCalled();
    expect(outboundText()).toMatch(/No container running/);
  });
});

describe('/last', () => {
  function seedInbound(text: string): void {
    const db = openInboundDb(AGENT_GROUP, SESSION_ID);
    db.prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, content, status, trigger)
       VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 2 FROM messages_in), 'chat', datetime('now'), ?, 'pending', 1)`,
    ).run(`in-${Date.now()}-${Math.random()}`, JSON.stringify({ text }));
    db.close();
  }

  function seedOutbound(text: string): void {
    const db = new Database(outboundDbPath(AGENT_GROUP, SESSION_ID));
    db.prepare(
      `INSERT INTO messages_out (id, seq, timestamp, kind, platform_id, channel_type, content)
       VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 2 FROM messages_out), datetime('now'), 'chat', 'discord:guild:123', 'discord', ?)`,
    ).run(`out-${Date.now()}-${Math.random()}`, JSON.stringify({ text }));
    db.close();
  }

  it('reports "(none)" for both sides on an empty session', async () => {
    await handleSessionCommand('/last', '', ctx());
    const text = outboundText() ?? '';
    expect(text).toMatch(/Last interaction/);
    expect(text).toMatch(/In  : \(none\)/);
    expect(text).toMatch(/Out : \(none\)/);
  });

  it('shows the latest inbound and outbound texts', async () => {
    seedInbound('earlier inbound');
    seedInbound('the latest inbound');
    seedOutbound('the latest outbound');

    await handleSessionCommand('/last', '', ctx());
    const text = outboundText() ?? '';
    expect(text).toContain('the latest inbound');
    expect(text).toContain('the latest outbound');
    expect(text).not.toContain('earlier inbound');
  });

  it('truncates long messages', async () => {
    seedInbound('x'.repeat(500));
    await handleSessionCommand('/last', '', ctx());
    const text = outboundText() ?? '';
    expect(text).toContain('…');
    expect(text.length).toBeLessThan(500);
  });
});

describe('/btw', () => {
  function listInboundContents(): Array<{ trigger: number; content: string }> {
    const db = new Database(inboundDbPath(AGENT_GROUP, SESSION_ID));
    try {
      return db.prepare('SELECT trigger, content FROM messages_in ORDER BY seq ASC').all() as Array<{
        trigger: number;
        content: string;
      }>;
    } finally {
      db.close();
    }
  }

  it('rejects empty args with a usage hint', async () => {
    await handleSessionCommand('/btw', '', ctx());
    expect(outboundText()).toMatch(/Usage:/);
    expect(listInboundContents()).toEqual([]);
  });

  it('writes the note with trigger=0 so it does not wake the agent now', async () => {
    await handleSessionCommand('/btw', 'remember the slack channel id is C123', ctx());
    const rows = listInboundContents();
    expect(rows).toHaveLength(1);
    expect(rows[0].trigger).toBe(0);
    const parsed = JSON.parse(rows[0].content);
    expect(parsed.text).toBe('remember the slack channel id is C123');
    expect(parsed.btw).toBe(true);
  });

  it('confirms back to the operator', async () => {
    await handleSessionCommand('/btw', 'short note', ctx());
    expect(outboundText()).toMatch(/Noted/);
  });
});

describe('unknown command dispatch', () => {
  it('does not throw and does not write outbound', async () => {
    await handleSessionCommand('/not-real', '', ctx());
    expect(lastOutbound()).toBeUndefined();
  });
});
