// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

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

const memory = new Map<string, { challenge: string; expires: number }>();

function memSet(key: string, challenge: string): void {
  memory.set(key, { challenge, expires: Date.now() + CHALLENGE_TTL_MS });
  // Opportunistic sweep so abandoned ceremonies don't grow the map
  // unbounded when Redis is the active backend and the map is only a
  // fallback that rarely gets consumed.
  const now = Date.now();
  for (const [k, v] of memory.entries()) {
    if (now > v.expires) memory.delete(k);
  }
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
    await getClient().set(key, challenge, 'PX', CHALLENGE_TTL_MS);
  } catch {
    // Redis unreachable — the in-memory write above is the fallback.
  }
}

export async function consumeRegistrationChallenge(userId: string): Promise<string | null> {
  const key = REG_PREFIX + userId;
  try {
    // GETDEL: atomic read-and-burn. On success Redis is authoritative —
    // do not consult memory (see module header).
    const value = await getClient().getdel(key);
    memory.delete(key);
    return value ?? null;
  } catch {
    return memGetDel(key);
  }
}

export async function storeAuthenticationChallenge(challenge: string): Promise<void> {
  const key = AUTH_PREFIX + challenge;
  memSet(key, challenge);
  try {
    await getClient().set(key, challenge, 'EX', CHALLENGE_TTL_SEC);
  } catch {
    // Redis unreachable — in-memory write is the fallback.
  }
}

export async function consumeAuthenticationChallenge(challenge: string): Promise<boolean> {
  const key = AUTH_PREFIX + challenge;
  try {
    const value = await getClient().getdel(key);
    memory.delete(key);
    // The key IS the challenge, so any non-null hit is an exact match.
    return value !== null && value !== undefined;
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
