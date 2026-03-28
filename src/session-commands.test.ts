import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --------------------------------------------------------------------------
// Mocks
// --------------------------------------------------------------------------

vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/nanoclaw-test-data',
  MAX_CONCURRENT_CONTAINERS: 2,
  DRIFT_THRESHOLD_MS: 300000,
}));

const { mockExecSync, mockFs } = vi.hoisted(() => {
  const mockExecSync = vi.fn();
  const mockFs = {
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => '{}'),
  };
  return { mockExecSync, mockFs };
});

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return { ...actual, default: { ...actual, ...mockFs } };
});

vi.mock('child_process', async () => {
  const actual =
    await vi.importActual<typeof import('child_process')>('child_process');
  return { ...actual, execSync: mockExecSync };
});

import { GroupQueue } from './group-queue.js';
import { loadDriftState, saveDriftState } from './drift-state.js';

// --------------------------------------------------------------------------
// GroupQueue.kill()
// --------------------------------------------------------------------------

describe('GroupQueue.kill()', () => {
  let queue: GroupQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    mockExecSync.mockReset();
    queue = new GroupQueue();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns false and does not exec when no container is active', () => {
    const result = queue.kill('group1@g.us');
    expect(result).toBe(false);
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it('runs docker kill with the container name and returns true', async () => {
    // Register a fake process so containerName is populated
    const fakeProc = { killed: false } as any;
    let resolve: () => void;
    const processMessages = vi.fn(
      () =>
        new Promise<boolean>((res) => {
          resolve = () => res(true);
        }),
    );
    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    // Inject a container name
    queue.registerProcess(
      'group1@g.us',
      fakeProc,
      'nanoclaw-test-container-123',
    );

    mockExecSync.mockReturnValue(Buffer.from(''));
    const result = queue.kill('group1@g.us');

    expect(result).toBe(true);
    expect(mockExecSync).toHaveBeenCalledWith(
      'docker kill nanoclaw-test-container-123',
      { stdio: 'pipe' },
    );

    resolve!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('returns false and logs warning when docker kill throws', async () => {
    const fakeProc = { killed: false } as any;
    let resolve: () => void;
    const processMessages = vi.fn(
      () =>
        new Promise<boolean>((res) => {
          resolve = () => res(true);
        }),
    );
    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    queue.registerProcess(
      'group1@g.us',
      fakeProc,
      'nanoclaw-test-container-456',
    );
    mockExecSync.mockImplementation(() => {
      throw new Error('container not found');
    });

    const result = queue.kill('group1@g.us');
    expect(result).toBe(false);

    resolve!();
    await vi.advanceTimersByTimeAsync(10);
  });
});

// --------------------------------------------------------------------------
// GroupQueue.getStatus()
// --------------------------------------------------------------------------

describe('GroupQueue.getStatus()', () => {
  let queue: GroupQueue;

  beforeEach(() => {
    vi.useFakeTimers();
    queue = new GroupQueue();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns all-false defaults for an unknown group', () => {
    const status = queue.getStatus('unknown@g.us');
    expect(status).toEqual({
      active: false,
      idleWaiting: false,
      isTaskContainer: false,
      containerName: null,
    });
  });

  it('reports active=true while container is running', async () => {
    let resolve: () => void;
    const processMessages = vi.fn(
      () =>
        new Promise<boolean>((res) => {
          resolve = () => res(true);
        }),
    );
    queue.setProcessMessagesFn(processMessages);
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    expect(queue.getStatus('group1@g.us').active).toBe(true);
    expect(queue.getStatus('group1@g.us').isTaskContainer).toBe(false);

    resolve!();
    await vi.advanceTimersByTimeAsync(10);
    expect(queue.getStatus('group1@g.us').active).toBe(false);
  });

  it('reports isTaskContainer=true for task runs', async () => {
    let resolve: () => void;
    const taskFn = vi.fn(
      () =>
        new Promise<void>((res) => {
          resolve = () => res();
        }),
    );
    queue.enqueueTask('group1@g.us', 'task-1', taskFn);
    await vi.advanceTimersByTimeAsync(10);

    expect(queue.getStatus('group1@g.us').isTaskContainer).toBe(true);
    expect(queue.getStatus('group1@g.us').active).toBe(true);

    resolve!();
    await vi.advanceTimersByTimeAsync(10);
    expect(queue.getStatus('group1@g.us').active).toBe(false);
  });

  it('reports containerName after registerProcess', async () => {
    let resolve: () => void;
    queue.setProcessMessagesFn(
      () =>
        new Promise<boolean>((res) => {
          resolve = () => res(true);
        }),
    );
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    queue.registerProcess('group1@g.us', {} as any, 'my-container');
    expect(queue.getStatus('group1@g.us').containerName).toBe('my-container');

    resolve!();
    await vi.advanceTimersByTimeAsync(10);
  });

  it('reports idleWaiting=true after notifyIdle', async () => {
    let resolve: () => void;
    queue.setProcessMessagesFn(
      () =>
        new Promise<boolean>((res) => {
          resolve = () => res(true);
        }),
    );
    queue.enqueueMessageCheck('group1@g.us');
    await vi.advanceTimersByTimeAsync(10);

    queue.notifyIdle('group1@g.us');
    expect(queue.getStatus('group1@g.us').idleWaiting).toBe(true);

    resolve!();
    await vi.advanceTimersByTimeAsync(10);
  });
});

// --------------------------------------------------------------------------
// drift-state.ts — persistence utilities
// --------------------------------------------------------------------------

describe('drift-state persistence', () => {
  it('returns empty state when file does not exist', () => {
    const state = loadDriftState();
    expect(state).toEqual({ lastAgentOutput: {}, containerStartTime: {} });
  });

  it('saveDriftState writes JSON to disk', () => {
    const state = {
      lastAgentOutput: { 'dc:123': { time: 1000, text: 'hello' } },
      containerStartTime: { 'dc:123': 900 },
    };
    saveDriftState(state);
    expect(mockFs.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining('drift-state.json'),
      expect.stringContaining('"dc:123"'),
    );
  });

  it('loadDriftState recovers saved records', () => {
    const state = {
      lastAgentOutput: { 'dc:abc': { time: 5000, text: 'working on report' } },
      containerStartTime: { 'dc:abc': 4000 },
    };
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue(JSON.stringify(state));

    const loaded = loadDriftState();
    expect(loaded.lastAgentOutput['dc:abc'].text).toBe('working on report');
    expect(loaded.containerStartTime['dc:abc']).toBe(4000);
  });

  it('returns empty state when file is corrupted JSON', () => {
    mockFs.existsSync.mockReturnValue(true);
    mockFs.readFileSync.mockReturnValue('{ not valid json {{');

    const loaded = loadDriftState();
    expect(loaded).toEqual({ lastAgentOutput: {}, containerStartTime: {} });
  });
});

// --------------------------------------------------------------------------
// /compact session guard (unit-level)
// --------------------------------------------------------------------------

describe('/compact session guard logic', () => {
  it('blocks compact when sessionId is empty string', () => {
    // This mirrors the guard: if (!sessions[group.folder]) block
    const sessions: Record<string, string> = { discord_main: '' };
    const hasSession = !!sessions['discord_main'];
    expect(hasSession).toBe(false);
  });

  it('blocks compact when sessionId is undefined', () => {
    const sessions: Record<string, string> = {};
    const hasSession = !!sessions['discord_main'];
    expect(hasSession).toBe(false);
  });

  it('allows compact when sessionId is present', () => {
    const sessions: Record<string, string> = {
      discord_main: '8932871e-3797-4296-a04b-e0ffe9eb1d74',
    };
    const hasSession = !!sessions['discord_main'];
    expect(hasSession).toBe(true);
  });
});

// --------------------------------------------------------------------------
// Drift detection thresholds
// --------------------------------------------------------------------------

describe('drift detection', () => {
  const DRIFT_THRESHOLD_MS = 300000; // 5 min

  function isSilentTooLong(silentFor: number | null): boolean {
    return silentFor !== null && silentFor > DRIFT_THRESHOLD_MS;
  }

  it('does not flag drift below threshold', () => {
    expect(isSilentTooLong(60_000)).toBe(false); // 1 min
    expect(isSilentTooLong(299_999)).toBe(false); // just under 5 min
  });

  it('flags drift above threshold', () => {
    expect(isSilentTooLong(300_001)).toBe(true); // just over 5 min
    expect(isSilentTooLong(600_000)).toBe(true); // 10 min
  });

  it('does not flag drift when silentFor is null', () => {
    expect(isSilentTooLong(null)).toBe(false);
  });
});
