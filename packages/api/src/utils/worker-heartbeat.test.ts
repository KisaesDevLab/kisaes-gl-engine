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
const { startHeartbeat, readHeartbeats, generateWorkerId, HEARTBEAT_KEY_PREFIX, HEARTBEAT_TTL_SECONDS } = await import(
  './worker-heartbeat.js'
);

describe('worker-heartbeat (vibe-mybooks-compatibility-addendum §3.6)', () => {
  beforeEach(() => {
    setMock.mockClear();
    delMock.mockClear();
    scanMock.mockClear();
    mgetMock.mockClear();
  });

  it('generateWorkerId produces a stable, hostname-prefixed identifier', () => {
    const id = generateWorkerId();
    expect(id.length).toBeGreaterThan(0);
    expect(id).toContain('-'); // hostname-uuid8 separator
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
    expect(status.lastHeartbeatMs!).toBeLessThan(2000);
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
    expect(status.lastHeartbeatMs!).toBeLessThan(2000);
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
});
