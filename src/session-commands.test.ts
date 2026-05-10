/**
 * Session command handler tests. Uses real per-test SQLite session DBs
 * but mocks the container runner (no Docker).
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockIsContainerRunning, mockKillContainer, TEST_DIR } = vi.hoisted(() => ({
  mockIsContainerRunning: vi.fn(),
  mockKillContainer: vi.fn(),
  TEST_DIR: '/tmp/nanoclaw-test-session-commands',
}));

vi.mock('./container-runner.js', () => ({
  isContainerRunning: mockIsContainerRunning,
  killContainer: mockKillContainer,
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: TEST_DIR };
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
  fs.mkdirSync(TEST_DIR, { recursive: true });
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
});

afterEach(() => {
  closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  vi.clearAllMocks();
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
    await handleSessionCommand('/reset', '', ctx());

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

  it('kills container if one is running so it cannot rewrite a stale continuation', async () => {
    mockIsContainerRunning.mockReturnValue(true);
    await handleSessionCommand('/reset', '', ctx());
    expect(mockKillContainer).toHaveBeenCalledWith(SESSION_ID, 'admin /reset');
  });

  it('replies cleanly even when there is nothing to clear', async () => {
    mockIsContainerRunning.mockReturnValue(false);
    await handleSessionCommand('/reset', '', ctx());
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
    await handleSessionCommand('/reset', '', ctx());

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
