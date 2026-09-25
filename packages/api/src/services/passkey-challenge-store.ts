// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import RedisPkg from 'ioredis';
import { recordSecurityEvent } from '../utils/security-audit.js';

// ─── Passkey WebAuthn challenge store (Redis-backed) ───────────
//
// WebAuthn ceremonies are two requests: the client first asks for
// options (which embed a server-issued challenge), then posts back a
// signature over that challenge. The server must remember the challenge
// between the two requests and enforce that it is used exactly once.
//
// The original store was a process-local Map. That is correct only for a
// single API process: on a multi-replica deployment the options request
// and the verify request can land on different replicas, so the verify
// replica never sees the challenge and every passkey ceremony fails.
// Worse, the single-use guarantee that WebAuthn depends on would only
// hold per-replica.
//
// This module moves the authoritative store to Redis (already a required
// dependency of the appliance — REDIS_URL has no default and BullMQ needs
// it) and uses GETDEL so "read the challenge and burn it" is a single
// atomic operation. Across any number of replicas, exactly one concurrent
// verify can win.
//
// Resilience: every operation dual-writes to a process-local Map and, when
// a Redis command throws (connection refused / timeout), falls back to
// that Map. This keeps a single-container install — and the airgapped
// Vitest suite, which has no Redis — working exactly like the old
// in-memory store. Crucially, when a Redis command SUCCEEDS we trust its
// result exclusively (a GETDEL miss means "already consumed or expired",
// full stop) and never consult the Map; consulting the Map on a Redis
// miss would let a second replica re-consume from its local copy a
// challenge Redis already handed to the first replica, reopening the very
// double-use hole this exists to close.
//
// One exception to "a Redis miss is final": a challenge whose Redis write
// FAILED lives only in this process's Map (it is flagged memoryOnly). No
// other replica can hold it, so consuming it from the Map on a Redis miss
// cannot double-spend it. Without this, a challenge issued while Redis was
// (re)connecting was unredeemable once Redis came back, and the user saw
// "Challenge expired" seconds after starting a sign-in.
//
// The client connects lazily with the offline queue off, so a command sent
// before the socket is ready throws instead of queueing. ensureReady() waits
// briefly for the connection first; before it existed, the first ceremony
// after every API start (and every Redis reconnect) failed this way.

const Redis = (RedisPkg as unknown as { default?: typeof import('ioredis').default }).default
  ?? (RedisPkg as unknown as typeof import('ioredis').default);
type RedisClient = InstanceType<typeof Redis>;

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const CHALLENGE_TTL_SEC = 5 * 60;

const REG_PREFIX = 'pk:reg:';
const AUTH_PREFIX = 'pk:auth:';

// ─── Redis client (lazy, shared) ───────────────────────────────

let sharedClient: RedisClient | null = null;
let lastErrorLog = 0;

function getClient(): RedisClient {
  if (sharedClient) return sharedClient;
  const url = process.env['REDIS_URL'] || 'redis://redis:6379';
  sharedClient = new Redis(url, {
    // Challenge ops are tiny and sit on the interactive login path. Fail
    // fast and fall back to the in-memory map rather than hang the
    // ceremony; ioredis keeps reconnecting in the background.
    maxRetriesPerRequest: 1,
    enableReadyCheck: false,
    enableOfflineQueue: false,
    commandTimeout: 1000,
    lazyConnect: true,
  });
  sharedClient.on('error', (err: Error) => {
    // A full outage emits an error per reconnect attempt (ioredis backs
    // off but still retries every couple of seconds). Gate on a 60s local
    // throttle so we don't call into the audit layer constantly;
    // recordSecurityEvent additionally coalesces the warn + audit row over
    // its own 15-minute window.
    const now = Date.now();
    if (now - lastErrorLog < 60_000) return;
    lastErrorLog = now;
    recordSecurityEvent({
      component: 'passkey_challenge_redis',
      reason: 'connection_error',
      details: { message: err.message },
    });
  });
  return sharedClient;
}

// ─── In-memory fallback (also dual-written) ────────────────────

// How long a store/consume waits for a not-yet-ready connection before
// falling back to the Map. Short: this sits on the interactive login path.
const READY_WAIT_MS = 1500;

async function ensureReady(client: RedisClient): Promise<void> {
  if (client.status === 'ready') return;
  if (client.status === 'wait') {
    // lazyConnect: nothing has opened the socket yet.
    client.connect().catch(() => { /* surfaced via the 'error' handler */ });
  } else if (client.status !== 'connecting' && client.status !== 'connect') {
    // reconnecting / close / end: Redis is down. Fail fast to the Map
    // instead of adding a wait to every login during an outage.
    throw new Error(`redis not ready (${client.status})`);
  }
  await new Promise<void>((resolve, reject) => {
    const done = (err?: Error) => {
      clearTimeout(timer);
      client.off('ready', onReady);
      client.off('error', onFail);
      client.off('close', onFail);
      if (err) reject(err); else resolve();
    };
    const onReady = () => done();
    const onFail = () => done(new Error('redis connection failed'));
    const timer = setTimeout(() => done(new Error('redis not ready')), READY_WAIT_MS);
    client.once('ready', onReady);
    client.once('error', onFail);
    client.once('close', onFail);
    if (client.status === 'ready') done();
  });
}

async function redis(): Promise<RedisClient> {
  const client = getClient();
  await ensureReady(client);
  return client;
}

const memory = new Map<string, { challenge: string; expires: number; memoryOnly: boolean }>();

function memSet(key: string, challenge: string): void {
  // memoryOnly starts true and is cleared once the Redis write succeeds.
  memory.set(key, { challenge, expires: Date.now() + CHALLENGE_TTL_MS, memoryOnly: true });
  // Opportunistic sweep so abandoned ceremonies don't grow the map
  // unbounded when Redis is the active backend and the map is only a
  // fallback that rarely gets consumed.
  const now = Date.now();
  for (const [k, v] of memory.entries()) {
    if (now > v.expires) memory.delete(k);
  }
}

function markRedisBacked(key: string): void {
  const entry = memory.get(key);
  if (entry) entry.memoryOnly = false;
}

// After a Redis miss: redeem the local copy only if Redis never had it.
function memGetDelIfMemoryOnly(key: string): string | null {
  const entry = memory.get(key);
  if (!entry || !entry.memoryOnly) {
    memory.delete(key);
    return null;
  }
  return memGetDel(key);
}

function memGetDel(key: string): string | null {
  const entry = memory.get(key);
  memory.delete(key);
  if (!entry || Date.now() > entry.expires) return null;
  return entry.challenge;
}

// ─── Public API ────────────────────────────────────────────────
//
// Registration challenges are keyed by userId — the caller is already
// authenticated, so only the user who requested registration can complete
// it. Authentication challenges are keyed by the challenge bytes
// themselves (passkey sign-in is optionally usernameless/discoverable, so
// there is no user to key on) and the client must echo that exact
// challenge back inside the signed clientDataJSON.

export async function storeRegistrationChallenge(userId: string, challenge: string): Promise<void> {
  const key = REG_PREFIX + userId;
  memSet(key, challenge);
  try {
    await (await redis()).set(key, challenge, 'PX', CHALLENGE_TTL_MS);
    markRedisBacked(key);
  } catch {
    // Redis unreachable — the in-memory write above is the fallback.
  }
}

export async function consumeRegistrationChallenge(userId: string): Promise<string | null> {
  const key = REG_PREFIX + userId;
  try {
    // GETDEL: atomic read-and-burn. On success Redis is authoritative —
    // do not consult memory (see module header).
    const value = await (await redis()).getdel(key);
    if (value !== null && value !== undefined) {
      memory.delete(key);
      return value;
    }
    return memGetDelIfMemoryOnly(key);
  } catch {
    return memGetDel(key);
  }
}

export async function storeAuthenticationChallenge(challenge: string): Promise<void> {
  const key = AUTH_PREFIX + challenge;
  memSet(key, challenge);
  try {
    await (await redis()).set(key, challenge, 'EX', CHALLENGE_TTL_SEC);
    markRedisBacked(key);
  } catch {
    // Redis unreachable — in-memory write is the fallback.
  }
}

export async function consumeAuthenticationChallenge(challenge: string): Promise<boolean> {
  const key = AUTH_PREFIX + challenge;
  try {
    const value = await (await redis()).getdel(key);
    // The key IS the challenge, so any non-null hit is an exact match.
    if (value !== null && value !== undefined) {
      memory.delete(key);
      return true;
    }
    return memGetDelIfMemoryOnly(key) !== null;
  } catch {
    return memGetDel(key) !== null;
  }
}

/**
 * Test hook — close the shared client so Vitest can exit cleanly. Safe to
 * call when no client was ever created.
 */
export async function closePasskeyChallengeStore(): Promise<void> {
  memory.clear();
  if (!sharedClient) return;
  try {
    await sharedClient.quit();
  } catch {
    // Not connected (or mid-reconnect) — disconnect synchronously.
    sharedClient.disconnect();
  }
  sharedClient = null;
}
