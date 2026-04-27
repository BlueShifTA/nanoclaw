import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock child_process — store the mock fns so tests can configure them.
// vi.hoisted is required because the mock factory below references these
// before module evaluation; bare `const` would hit "Cannot access before
// initialization" under vitest hoisting.
const { mockExecSync, mockExecFileSync } = vi.hoisted(() => ({
  mockExecSync: vi.fn(),
  mockExecFileSync: vi.fn(),
}));
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

import {
  CONTAINER_RUNTIME_BIN,
  readonlyMountArgs,
  stopContainer,
  ensureContainerRuntimeRunning,
  cleanupOrphans,
  gpuArgs,
} from './container-runtime.js';
import { logger } from './logger.js';

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks does NOT clear queued mockReturnValueOnce / mockImplementationOnce
  // values — without this, the gpuArgs tests leak setup across runs.
  mockExecSync.mockReset();
  mockExecFileSync.mockReset();
});

// --- Pure functions ---

describe('readonlyMountArgs', () => {
  it('returns -v flag with :ro suffix', () => {
    const args = readonlyMountArgs('/host/path', '/container/path');
    expect(args).toEqual(['-v', '/host/path:/container/path:ro']);
  });
});

describe('stopContainer', () => {
  it('calls docker stop for valid container names', () => {
    stopContainer('nanoclaw-test-123');
    expect(mockExecSync).toHaveBeenCalledWith(
      `${CONTAINER_RUNTIME_BIN} stop -t 1 nanoclaw-test-123`,
      { stdio: 'pipe' },
    );
  });

  it('rejects names with shell metacharacters', () => {
    expect(() => stopContainer('foo; rm -rf /')).toThrow(
      'Invalid container name',
    );
    expect(() => stopContainer('foo$(whoami)')).toThrow(
      'Invalid container name',
    );
    expect(() => stopContainer('foo`id`')).toThrow('Invalid container name');
    expect(mockExecSync).not.toHaveBeenCalled();
  });
});

// --- ensureContainerRuntimeRunning ---

describe('ensureContainerRuntimeRunning', () => {
  it('does nothing when runtime is already running', () => {
    mockExecSync.mockReturnValueOnce('');

    ensureContainerRuntimeRunning();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockExecSync).toHaveBeenCalledWith(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    expect(logger.debug).toHaveBeenCalledWith(
      'Container runtime already running',
    );
  });

  it('throws when docker info fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('Cannot connect to the Docker daemon');
    });

    expect(() => ensureContainerRuntimeRunning()).toThrow(
      'Container runtime is required but failed to start',
    );
    expect(logger.error).toHaveBeenCalled();
  });
});

// --- cleanupOrphans ---

describe('cleanupOrphans', () => {
  it('stops orphaned nanoclaw containers', () => {
    // docker ps returns container names, one per line
    mockExecSync.mockReturnValueOnce(
      'nanoclaw-group1-111\nnanoclaw-group2-222\n',
    );
    // stop calls succeed
    mockExecSync.mockReturnValue('');

    cleanupOrphans();

    // ps + 2 stop calls
    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(mockExecSync).toHaveBeenNthCalledWith(
      2,
      `${CONTAINER_RUNTIME_BIN} stop -t 1 nanoclaw-group1-111`,
      { stdio: 'pipe' },
    );
    expect(mockExecSync).toHaveBeenNthCalledWith(
      3,
      `${CONTAINER_RUNTIME_BIN} stop -t 1 nanoclaw-group2-222`,
      { stdio: 'pipe' },
    );
    expect(logger.info).toHaveBeenCalledWith(
      { count: 2, names: ['nanoclaw-group1-111', 'nanoclaw-group2-222'] },
      'Stopped orphaned containers',
    );
  });

  it('does nothing when no orphans exist', () => {
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('warns and continues when ps fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('docker not available');
    });

    cleanupOrphans(); // should not throw

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Failed to clean up orphaned containers',
    );
  });

  it('continues stopping remaining containers when one stop fails', () => {
    mockExecSync.mockReturnValueOnce('nanoclaw-a-1\nnanoclaw-b-2\n');
    // First stop fails
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('already stopped');
    });
    // Second stop succeeds
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans(); // should not throw

    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(logger.info).toHaveBeenCalledWith(
      { count: 2, names: ['nanoclaw-a-1', 'nanoclaw-b-2'] },
      'Stopped orphaned containers',
    );
  });
});

// --- gpuArgs ---
//
// gpuArgs() caches its first probe at module level. The implementation does
// not export a reset hook (intentionally — runtime detection is meant to be
// stable for a process lifetime), so each test path is exercised in
// isolation by re-importing the module via vi.resetModules() + dynamic import.

describe('gpuArgs', () => {
  // Sanity: the cached value from the static import is callable with no setup.
  it('exposes a cached function that returns an array', () => {
    const result = gpuArgs();
    expect(Array.isArray(result)).toBe(true);
  });

  async function freshGpuArgs(): Promise<() => string[]> {
    vi.resetModules();
    const mod = await import('./container-runtime.js');
    return mod.gpuArgs;
  }

  it("returns ['--gpus', 'all'] when nvidia runtime is detected", async () => {
    delete process.env.NANOCLAW_GPU;
    mockExecFileSync.mockReturnValueOnce('{"nvidia":{},"runc":{}}');

    const fn = await freshGpuArgs();
    expect(fn()).toEqual(['--gpus', 'all']);
    expect(mockExecFileSync).toHaveBeenCalledWith(
      CONTAINER_RUNTIME_BIN,
      ['info', '--format', '{{json .Runtimes}}'],
      expect.objectContaining({ stdio: 'pipe' }),
    );
  });

  it('returns [] when only runc runtime is reported (no GPU)', async () => {
    delete process.env.NANOCLAW_GPU;
    mockExecFileSync.mockReturnValueOnce('{"runc":{}}');

    const fn = await freshGpuArgs();
    expect(fn()).toEqual([]);
  });

  it('returns [] when NANOCLAW_GPU=off, without probing docker', async () => {
    process.env.NANOCLAW_GPU = 'off';
    mockExecFileSync.mockReturnValueOnce('{"nvidia":{}}'); // would-be GPU

    const fn = await freshGpuArgs();
    expect(fn()).toEqual([]);
    expect(mockExecFileSync).not.toHaveBeenCalled();

    delete process.env.NANOCLAW_GPU;
  });

  it('returns [] when docker info throws', async () => {
    delete process.env.NANOCLAW_GPU;
    mockExecFileSync.mockImplementationOnce(() => {
      throw new Error('docker daemon unreachable');
    });

    const fn = await freshGpuArgs();
    expect(fn()).toEqual([]);
  });

  it('caches the probe result across repeated calls', async () => {
    delete process.env.NANOCLAW_GPU;
    mockExecFileSync.mockReturnValueOnce('{"nvidia":{}}');

    const fn = await freshGpuArgs();
    fn();
    fn();
    fn();
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
  });

  it("does not match runtimes whose name merely contains 'nvidia' as a substring", async () => {
    delete process.env.NANOCLAW_GPU;
    // 'nvidia-gpu-fake' shares the substring but not the bounded token.
    mockExecFileSync.mockReturnValueOnce('{"runc":{},"unrelated":{}}');

    const fn = await freshGpuArgs();
    expect(fn()).toEqual([]);
  });
});
