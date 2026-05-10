/**
 * Command-gate classifier tests. Pins both the existing pass/filter/deny
 * behaviour and the new handle action for host-side session commands.
 *
 * Uses a fresh in-memory DB per test so user_roles lookups exercise the
 * real query path rather than a mock.
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockGetDb, mockHasTable } = vi.hoisted(() => ({
  mockGetDb: vi.fn(),
  mockHasTable: vi.fn(),
}));

vi.mock('./db/connection.js', () => ({
  getDb: mockGetDb,
  hasTable: mockHasTable,
}));

import { gateCommand } from './command-gate.js';

let db: Database.Database;

function grantRole(userId: string, role: 'owner' | 'admin', scoped: string | null = null): void {
  db.prepare('INSERT INTO user_roles (user_id, role, agent_group_id) VALUES (?, ?, ?)').run(userId, role, scoped);
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE user_roles (
      user_id          TEXT NOT NULL,
      role             TEXT NOT NULL,
      agent_group_id   TEXT,
      created_at       TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  mockGetDb.mockReturnValue(db);
  mockHasTable.mockReturnValue(true);
});

afterEach(() => {
  db.close();
  vi.clearAllMocks();
});

describe('gateCommand — slash-command classification', () => {
  it('passes plain text through', () => {
    expect(gateCommand('hello', 'user:1', 'ag-1')).toEqual({ action: 'pass' });
  });

  it('passes JSON-wrapped plain text through', () => {
    expect(gateCommand(JSON.stringify({ text: 'hello' }), 'user:1', 'ag-1')).toEqual({ action: 'pass' });
  });

  it('filters /help silently regardless of role', () => {
    expect(gateCommand('/help', null, 'ag-1')).toEqual({ action: 'filter' });
    grantRole('user:owner', 'owner');
    expect(gateCommand('/help', 'user:owner', 'ag-1')).toEqual({ action: 'filter' });
  });

  it('denies admin command from non-admin', () => {
    expect(gateCommand('/compact', 'user:1', 'ag-1')).toEqual({
      action: 'deny',
      command: '/compact',
    });
  });

  it('passes admin command when sender has owner role', () => {
    grantRole('user:owner', 'owner');
    expect(gateCommand('/compact', 'user:owner', 'ag-1')).toEqual({ action: 'pass' });
  });

  it('passes admin command when sender has global admin role', () => {
    grantRole('user:admin', 'admin');
    expect(gateCommand('/compact', 'user:admin', 'ag-1')).toEqual({ action: 'pass' });
  });

  it('respects scoped admin (admin only for matching agent_group_id)', () => {
    grantRole('user:scoped', 'admin', 'ag-1');
    expect(gateCommand('/compact', 'user:scoped', 'ag-1')).toEqual({ action: 'pass' });
    expect(gateCommand('/compact', 'user:scoped', 'ag-2')).toEqual({
      action: 'deny',
      command: '/compact',
    });
  });

  it('passes unknown slash commands through to the container', () => {
    expect(gateCommand('/some-future-thing', 'user:1', 'ag-1')).toEqual({ action: 'pass' });
  });

  it('allows identified users when permissions module is not installed', () => {
    mockHasTable.mockReturnValue(false);
    expect(gateCommand('/compact', 'user:1', 'ag-1')).toEqual({ action: 'pass' });
  });

  it('still denies anonymous senders even with no permissions module', () => {
    mockHasTable.mockReturnValue(false);
    expect(gateCommand('/compact', null, 'ag-1')).toEqual({
      action: 'deny',
      command: '/compact',
    });
  });
});

describe('gateCommand — handled session commands', () => {
  it('returns handle action for /ping when owner', () => {
    grantRole('user:owner', 'owner');
    expect(gateCommand('/ping', 'user:owner', 'ag-1')).toEqual({
      action: 'handle',
      command: '/ping',
      args: '',
    });
  });

  it('extracts args after the command', () => {
    grantRole('user:owner', 'owner');
    expect(gateCommand('/btw remember to bring the notes', 'user:owner', 'ag-1')).toEqual({
      action: 'handle',
      command: '/btw',
      args: 'remember to bring the notes',
    });
  });

  it('denies /kill from non-admin', () => {
    expect(gateCommand('/kill', 'user:1', 'ag-1')).toEqual({
      action: 'deny',
      command: '/kill',
    });
  });

  it('handles every documented session command for admin', () => {
    grantRole('user:owner', 'owner');
    for (const cmd of ['/ping', '/reset', '/kill', '/last', '/btw']) {
      const result = gateCommand(cmd, 'user:owner', 'ag-1');
      expect(result.action).toBe('handle');
    }
  });

  it('normalises case (uppercase /PING resolves to lowercase)', () => {
    grantRole('user:owner', 'owner');
    expect(gateCommand('/PING', 'user:owner', 'ag-1')).toEqual({
      action: 'handle',
      command: '/ping',
      args: '',
    });
  });
});
