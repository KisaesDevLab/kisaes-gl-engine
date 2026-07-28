// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Redis plumbing for peer screen share: per-session pub/sub fan-out,
// single-use WS auth tickets, snapshot cache, presence, byte counters, and a
// cross-instance control channel (kill switch / targeted revoke). rrweb event
// payloads only ever transit pub/sub — nothing is persisted to Postgres or
// disk (asserted in tests).

import RedisPkg from 'ioredis';
import { randomBytes } from 'node:crypto';
import { env } from '../../config/env.js';
import { log } from '../../utils/logger.js';

const Redis = (RedisPkg as unknown as { default?: typeof import('ioredis').default }).default
  ?? (RedisPkg as unknown as typeof import('ioredis').default);

type RedisClient = InstanceType<typeof Redis>;

// Lazily created singletons. Pub/sub needs a dedicated subscriber connection
// (a subscribing ioredis client cannot issue regular commands).
let cmdClient: RedisClient | null = null;
let subClient: RedisClient | null = null;

export function shareRedis(): RedisClient {
  if (!cmdClient) {
    cmdClient = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: false });
    cmdClient.on('error', (err: Error) => {
      log.warn({ component: 'share-redis', event: 'redis_error', message: err.message });
    });
  }
  return cmdClient;
}

export function shareRedisSub(): RedisClient {
  if (!subClient) {
    subClient = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2, lazyConnect: false });
    subClient.on('error', (err: Error) => {
      log.warn({ component: 'share-redis', event: 'redis_sub_error', message: err.message });
    });
  }
  return subClient;
}

export async function closeShareRedis(): Promise<void> {
  await Promise.allSettled([cmdClient?.quit(), subClient?.quit()]);
  cmdClient = null;
  subClient = null;
}

// ── Key/channel names ───────────────────────────────────────────────────────

export const streamChannel = (sessionId: string) => `share:session:${sessionId}:stream`;
/** Messages addressed to the sharer's socket (snapshot requests, pointers),
 *  routed via pub/sub so it works when sharer and viewer land on different
 *  server instances. */
export const toSharerChannel = (sessionId: string) => `share:session:${sessionId}:to-sharer`;
/** Cross-instance control: kill switch, targeted session/user termination,
 *  participant updates. */
export const CONTROL_CHANNEL = 'share:control';

const ticketKey = (ticket: string) => `share:ticket:${ticket}`;
const snapshotKey = (sessionId: string) => `share:session:${sessionId}:snapshot`;
const presenceKey = (sessionId: string) => `share:session:${sessionId}:presence`;
const bytesKey = (sessionId: string) => `share:session:${sessionId}:bytes`;
const activityKey = (sessionId: string) => `share:session:${sessionId}:last-activity`;
const failCountKey = (userId: string) => `share:codefail:${userId}`;

// ── WS auth tickets (single-use, 30s TTL) ──────────────────────────────────

export interface ShareTicket {
  sessionId: string;
  userId: string;
  role: 'sharer' | 'viewer';
  participantId: string | null;
}

export async function issueTicket(payload: ShareTicket): Promise<string> {
  const ticket = randomBytes(24).toString('base64url');
  await shareRedis().set(ticketKey(ticket), JSON.stringify(payload), 'EX', 30);
  return ticket;
}

/** Atomically consume a ticket — a ticket authenticates exactly one socket. */
export async function consumeTicket(ticket: string): Promise<ShareTicket | null> {
  if (!ticket || ticket.length > 128) return null;
  const raw = await shareRedis().getdel(ticketKey(ticket));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ShareTicket;
  } catch {
    return null;
  }
}

// ── Snapshot cache (Meta + FullSnapshot pair, session TTL) ─────────────────

export async function cacheSnapshot(sessionId: string, framesJson: string, ttlSeconds: number): Promise<void> {
  await shareRedis().set(snapshotKey(sessionId), framesJson, 'EX', ttlSeconds);
}

export async function getCachedSnapshot(sessionId: string): Promise<string | null> {
  return shareRedis().get(snapshotKey(sessionId));
}

// ── Presence / activity / bytes ────────────────────────────────────────────

export async function refreshPresence(sessionId: string, ttlSeconds = 60): Promise<void> {
  await shareRedis().set(presenceKey(sessionId), '1', 'EX', ttlSeconds);
}

export async function hasPresence(sessionId: string): Promise<boolean> {
  return (await shareRedis().exists(presenceKey(sessionId))) === 1;
}

export async function touchActivity(sessionId: string): Promise<void> {
  await shareRedis().set(activityKey(sessionId), String(Date.now()), 'EX', 24 * 3600);
}

export async function lastActivityAt(sessionId: string): Promise<number | null> {
  const raw = await shareRedis().get(activityKey(sessionId));
  return raw ? Number(raw) : null;
}

/** Add relayed bytes; returns the new session total. */
export async function addBytes(sessionId: string, n: number): Promise<number> {
  const key = bytesKey(sessionId);
  const total = await shareRedis().incrby(key, n);
  await shareRedis().expire(key, 24 * 3600);
  return total;
}

export async function getBytes(sessionId: string): Promise<number> {
  const raw = await shareRedis().get(bytesKey(sessionId));
  return raw ? Number(raw) : 0;
}

// ── Brute-force counter for join-code submissions ──────────────────────────

/** Increment the consecutive-failure counter; returns the new count. Resets
 *  on success via clearCodeFailures. Counter self-expires after an hour. */
export async function recordCodeFailure(userId: string): Promise<number> {
  const key = failCountKey(userId);
  const n = await shareRedis().incr(key);
  await shareRedis().expire(key, 3600);
  return n;
}

export async function clearCodeFailures(userId: string): Promise<void> {
  await shareRedis().del(failCountKey(userId));
}

export async function codeFailureCount(userId: string): Promise<number> {
  const raw = await shareRedis().get(failCountKey(userId));
  return raw ? Number(raw) : 0;
}

// ── Terminated-session cleanup (13.10) ─────────────────────────────────────

export async function purgeSessionKeys(sessionId: string): Promise<void> {
  await shareRedis().del(snapshotKey(sessionId), presenceKey(sessionId), bytesKey(sessionId), activityKey(sessionId));
}

// ── Control channel ────────────────────────────────────────────────────────

export type ShareControlMessage =
  | { type: 'end-session'; sessionId: string; reason: string }
  | { type: 'end-user'; userId: string; reason: string }
  | { type: 'kill-all'; reason: string }
  | { type: 'eject-participant'; sessionId: string; participantId: string }
  | { type: 'participant-update'; sessionId: string };

export async function publishControl(msg: ShareControlMessage): Promise<void> {
  await shareRedis().publish(CONTROL_CHANNEL, JSON.stringify(msg));
}
