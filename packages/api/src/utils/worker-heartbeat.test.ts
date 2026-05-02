// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock ioredis so the helper exercises the SCAN/MGET/SET/DEL flow
// without a real Redis connection. Each test wires up the fake
// behavior it cares about.
const setMock = vi.fn(async (..._args: unknown[]) => 'OK');
const delMock = vi.fn(async (..._args: unknown[]) => 1);
const scanMock = vi.fn(async (..._args: unknown[]) => ['0', [] as string[]]);
const mgetMock = vi.fn(async (..._args: unknown[]) => [] as (string | null)[]);
const quitMock = vi.fn(async () => 'OK');

vi.mock('ioredis', () => {
  class MockRedis {
    set = setMock;
    del = delMock;
    scan = scanMock;
    mget = mgetMock;
    quit = quitMock;
    on(_evt: string, _cb: unknown) {
      return this;
    }
  }
  return { default: MockRedis };
});

// Re-import after mocks are in place. Vitest hoists vi.mock so this is fine.
const {
  startHeartbeat,
  readHeartbeats,
  generateWorkerId,
  closeWorkerHeartbeatClients,
  _resetHeartbeatClientsForTest,
  HEARTBEAT_KEY_PREFIX,
  HEARTBEAT_TTL_SECONDS,
} = await import('./worker-heartbeat.js');

describe('worker-heartbeat (vibe-mybooks-compatibility-addendum §3.6)', () => {
  beforeEach(() => {
    setMock.mockClear();
    delMock.mockClear();
    scanMock.mockClear();
    mgetMock.mockClear();
    quitMock.mockClear();
    _resetHeartbeatClientsForTest();
  });

  it('generateWorkerId produces a stable, hostname-prefixed identifier', () => {
    const id = generateWorkerId();
    expect(id.length).toBeGreaterThan(0);
    expect(id).toContain('-'); // hostname-randhex separator
    // Suffix is 8 hex chars (4 random bytes)
    expect(id.split('-').pop()!).toMatch(/^[0-9a-f]{8}$/);
  });

  it('startHeartbeat writes to Redis on the first tick (no waiting)', async () => {
    const handle = startHeartbeat('test-worker-1');
    // The immediate tick is async — give the microtask queue a moment.
    await new Promise((r) => setTimeout(r, 10));
    expect(setMock).toHaveBeenCalled();
    const args = setMock.mock.calls[0]!;
    expect(args[0]).toBe(`${HEARTBEAT_KEY_PREFIX}test-worker-1`);
    // Value is a parseable ISO timestamp.
    expect(() => new Date(args[1] as string).toISOString()).not.toThrow();
    // EX option carries the documented TTL.
    expect(args[2]).toBe('EX');
    expect(args[3]).toBe(HEARTBEAT_TTL_SECONDS);
    await handle.stop();
  });

  it('handle.stop() DELs the key and is idempotent', async () => {
    const handle = startHeartbeat('test-worker-2');
    await handle.stop();
    expect(delMock).toHaveBeenCalledWith(`${HEARTBEAT_KEY_PREFIX}test-worker-2`);
    delMock.mockClear();
    await handle.stop(); // second call is a no-op
    expect(delMock).not.toHaveBeenCalled();
  });

  it('handle.stop() returns within ~1s even if DEL hangs (QA-R2 M4 — tightened bound)', async () => {
    delMock.mockImplementationOnce(
      () => new Promise(() => {/* never resolves */}),
    );
    const handle = startHeartbeat('test-worker-hung');
    const t0 = Date.now();
    await handle.stop();
    const elapsed = Date.now() - t0;
    // Stop timeout is 1000ms; tighten the bound to <1500 so a regression
    // that fell through to ioredis's 2000ms commandTimeout (or skipped
    // the timeout race entirely) would be caught.
    expect(elapsed).toBeLessThan(1500);
    // Sanity floor — must be at least the timeout duration.
    expect(elapsed).toBeGreaterThanOrEqual(900);
  });

  it('readHeartbeats returns ok=false with count=0 when no keys present', async () => {
    scanMock.mockResolvedValueOnce(['0', []]);
    const status = await readHeartbeats();
    expect(status.ok).toBe(false);
    expect(status.count).toBe(0);
    expect(status.lastHeartbeatMs).toBeNull();
  });

  it('readHeartbeats returns ok=true when at least one heartbeat is fresh', async () => {
    scanMock.mockResolvedValueOnce(['0', [`${HEARTBEAT_KEY_PREFIX}w1`]]);
    mgetMock.mockResolvedValueOnce([new Date().toISOString()]);
    const status = await readHeartbeats();
    expect(status.ok).toBe(true);
    expect(status.count).toBe(1);
    expect(status.lastHeartbeatMs).not.toBeNull();
    // Generous bound — slow CI machines occasionally see >2s here.
    expect(status.lastHeartbeatMs!).toBeLessThan(5000);
  });

  it('readHeartbeats returns ok=false when all heartbeats are stale (>30s)', async () => {
    scanMock.mockResolvedValueOnce(['0', [`${HEARTBEAT_KEY_PREFIX}w1`]]);
    const stale = new Date(Date.now() - 45_000).toISOString();
    mgetMock.mockResolvedValueOnce([stale]);
    const status = await readHeartbeats();
    expect(status.ok).toBe(false);
    expect(status.count).toBe(1);
    expect(status.lastHeartbeatMs).toBeGreaterThan(30_000);
  });

  it('readHeartbeats picks the freshest heartbeat across multiple workers', async () => {
    scanMock.mockResolvedValueOnce([
      '0',
      [`${HEARTBEAT_KEY_PREFIX}w1`, `${HEARTBEAT_KEY_PREFIX}w2`, `${HEARTBEAT_KEY_PREFIX}w3`],
    ]);
    const oldOne = new Date(Date.now() - 25_000).toISOString();
    const fresh = new Date(Date.now() - 1_000).toISOString();
    const middle = new Date(Date.now() - 10_000).toISOString();
    mgetMock.mockResolvedValueOnce([oldOne, fresh, middle]);
    const status = await readHeartbeats();
    expect(status.ok).toBe(true);
    expect(status.count).toBe(3);
    expect(status.lastHeartbeatMs!).toBeLessThan(5000);
  });

  it('readHeartbeats reports an error when Redis throws', async () => {
    scanMock.mockRejectedValueOnce(new Error('connection refused'));
    const status = await readHeartbeats();
    expect(status.ok).toBe(false);
    expect(status.count).toBe(0);
    expect(status.error).toContain('connection refused');
  });

  it('readHeartbeats handles a paginated SCAN (cursor returns nonzero then zero)', async () => {
    scanMock
      .mockResolvedValueOnce(['42', [`${HEARTBEAT_KEY_PREFIX}w1`]])
      .mockResolvedValueOnce(['0', [`${HEARTBEAT_KEY_PREFIX}w2`]]);
    const fresh = new Date().toISOString();
    mgetMock.mockResolvedValueOnce([fresh, fresh]);
    const status = await readHeartbeats();
    expect(status.count).toBe(2);
    expect(status.ok).toBe(true);
    expect(scanMock).toHaveBeenCalledTimes(2);
  });

  it('readHeartbeats skips null/empty values without crashing', async () => {
    scanMock.mockResolvedValueOnce([
      '0',
      [`${HEARTBEAT_KEY_PREFIX}w1`, `${HEARTBEAT_KEY_PREFIX}w2`],
    ]);
    mgetMock.mockResolvedValueOnce([null, new Date().toISOString()]);
    const status = await readHeartbeats();
    expect(status.count).toBe(2);
    expect(status.ok).toBe(true);
  });

  it('readHeartbeats chunks MGET into batches of 100 with correct contents (QA-R2 M1)', async () => {
    // 250 keys → 3 MGET batches: 100, 100, 50.
    const keys = Array.from({ length: 250 }, (_, i) => `${HEARTBEAT_KEY_PREFIX}w${i}`);
    scanMock.mockResolvedValueOnce(['0', keys]);
    mgetMock.mockImplementation(async (...args: unknown[]) => {
      return Array.from({ length: args.length }, () => new Date().toISOString());
    });
    const status = await readHeartbeats();
    expect(status.count).toBe(250);
    expect(status.ok).toBe(true);
    expect(mgetMock).toHaveBeenCalledTimes(3);

    // Assert each batch has the right keys, in order — catches an
    // off-by-one slicing regression that would still produce 3 calls
    // but lose keys at the chunk boundaries.
    expect(mgetMock.mock.calls[0]).toEqual(keys.slice(0, 100));
    expect(mgetMock.mock.calls[1]).toEqual(keys.slice(100, 200));
    expect(mgetMock.mock.calls[2]).toEqual(keys.slice(200, 250));
    // And the union of all calls covers every key exactly once.
    const allKeysSent = mgetMock.mock.calls.flat();
    expect(allKeysSent).toHaveLength(250);
    expect(new Set(allKeysSent).size).toBe(250);
  });

  it('after closeWorkerHeartbeatClients(), readHeartbeats returns a closing error rather than spawning a fresh client', async () => {
    await closeWorkerHeartbeatClients();
    const status = await readHeartbeats();
    expect(status.ok).toBe(false);
    expect(status.error).toMatch(/closing/i);
    // No SCAN issued because the closing flag is checked first.
    expect(scanMock).not.toHaveBeenCalled();
  });

  it('logs a warning ONLY after FAILURE_LOG_THRESHOLD consecutive write failures (QA-R2 H2)', async () => {
    // Drive failures via fake timers. vi.advanceTimersByTimeAsync
    // also flushes the resulting promise microtasks so the rejected
    // set() call gets caught and consecutiveFailures increments.
    vi.useFakeTimers();
    try {
      setMock.mockReset();
      setMock.mockRejectedValue(new Error('test redis down'));
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const handle = startHeartbeat('test-worker-failing');

      // Immediate tick (1st failure) — let the rejected promise settle.
      await vi.advanceTimersByTimeAsync(0);
      expect(setMock).toHaveBeenCalledTimes(1);
      expect(warnSpy).not.toHaveBeenCalled();

      // Tick 2 (15s later, 2nd failure) — still under threshold.
      await vi.advanceTimersByTimeAsync(15_000);
      expect(setMock).toHaveBeenCalledTimes(2);
      expect(warnSpy).not.toHaveBeenCalled();

      // Tick 3 (3rd failure, threshold reached) — warn fires once.
      await vi.advanceTimersByTimeAsync(15_000);
      expect(setMock).toHaveBeenCalledTimes(3);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toMatch(/3 consecutive/);

      // Tick 4-11 — silent (between threshold and next log point at 12).
      for (let i = 0; i < 8; i++) {
        await vi.advanceTimersByTimeAsync(15_000);
      }
      expect(warnSpy).toHaveBeenCalledTimes(1);

      // Tick 12 (multiple of FAILURE_LOG_THRESHOLD * 4 = 12) — warn again.
      await vi.advanceTimersByTimeAsync(15_000);
      expect(warnSpy).toHaveBeenCalledTimes(2);

      // Recovery: set succeeds, counter resets, warn count stays at 2.
      setMock.mockReset();
      setMock.mockResolvedValue('OK');
      await vi.advanceTimersByTimeAsync(15_000);
      expect(warnSpy).toHaveBeenCalledTimes(2);

      // Use real timers for the stop() call — it itself uses setTimeout
      // (the 1s race) and we want it to actually elapse.
      vi.useRealTimers();
      await handle.stop();
      warnSpy.mockRestore();
    } finally {
      // Defensive: if assertions threw, make sure we leave real timers
      // in place so subsequent tests don't inherit fake ones.
      try {
        vi.useRealTimers();
      } catch {
        /* already real */
      }
      setMock.mockReset();
      setMock.mockResolvedValue('OK');
    }
  });
});
