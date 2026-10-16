// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Offline handling for online-only features (desktop mode).
 *
 * A feature that needs the internet (cloud AI, sending email) calls
 * `ensureOnline(feature, target)` before it opens a connection, and passes
 * any error it gets back through `classifyNetworkError`. Both turn "there
 * is no network" into one typed error, `OfflineUnavailableError`, which the
 * error handler returns as HTTP 503 with code OFFLINE_UNAVAILABLE — within
 * 2 seconds instead of after a 60-second SDK timeout.
 *
 * Behavior follows the CL_OFFLINE setting of the desktop profile:
 *
 *   off   no checks at all. This is always the setting of the server
 *         appliance, so on the server every function here is a no-op and
 *         errors pass through unchanged.
 *   on    the owner said "I am offline": online features fail immediately
 *         and nothing is ever probed.
 *   auto  (desktop default) probe the feature's OWN host (the one the
 *         owner turned on) with a 1.5 s budget, cache a success for 30 s.
 *
 * There is no generic internet check and no phone-home: the probe only
 * ever connects to the host the feature is about to use anyway.
 *
 * `/health` reports the result as `online` / `lastOnlineCheck`.
 */

import net from 'node:net';
import { AppError } from './errors.js';
import { desktopProfile, type OfflineSetting } from '../desktop/profile.js';

/** Combined DNS + TCP connect budget of one probe. */
export const PROBE_BUDGET_MS = 1_500;
/** A successful probe of a host is trusted this long. */
export const ONLINE_CACHE_MS = 30_000;
/**
 * A failed probe of a host is trusted this long, so the fallback chain or
 * a retry of the same feature does not pay the probe budget twice.
 */
export const OFFLINE_CACHE_MS = 5_000;

export interface NetTarget {
  host: string;
  port: number;
}

const FEATURE_MESSAGES: Array<[RegExp, string]> = [
  [/^ai(:|$)/, 'AI suggestions from an online provider need an internet connection. Check your connection and try again, or use a local AI model.'],
  [/^smtp$/, 'Sending email needs an internet connection. Check your connection and try again.'],
];

function messageFor(feature: string): string {
  for (const [re, msg] of FEATURE_MESSAGES) if (re.test(feature)) return msg;
  return 'This feature needs an internet connection. Check your connection and try again.';
}

/**
 * An online-only feature cannot run because the computer is offline (or
 * the owner set CL_OFFLINE=on). HTTP 503, code OFFLINE_UNAVAILABLE; the
 * response body also carries `feature` (e.g. `ai:anthropic`, `smtp`).
 */
export class OfflineUnavailableError extends AppError {
  readonly feature: string;
  constructor(feature: string, message?: string) {
    super(503, message ?? messageFor(feature), 'OFFLINE_UNAVAILABLE');
    this.name = 'OfflineUnavailableError';
    this.feature = feature;
  }
}

export function isOfflineUnavailable(err: unknown): err is OfflineUnavailableError {
  return err instanceof OfflineUnavailableError
    || (!!err && typeof err === 'object' && (err as { code?: unknown }).code === 'OFFLINE_UNAVAILABLE');
}

// ─── connectivity state ─────────────────────────────────────────────

interface State {
  online: boolean | null;
  lastOnlineCheck: Date | null;
}

let state: State = { online: null, lastOnlineCheck: null };
const okUntil = new Map<string, number>();
const failUntil = new Map<string, number>();
const inflight = new Map<string, Promise<'online' | 'offline' | 'inconclusive'>>();

function setting(): OfflineSetting {
  return desktopProfile().offline;
}

/** CL_OFFLINE=on: online features fail at once and nothing is probed. */
export function isForcedOffline(): boolean {
  return setting() === 'on';
}

function record(online: boolean): void {
  state = { online, lastOnlineCheck: new Date() };
}

/**
 * What `/health` reports. `online` is null until the first probe or
 * classified failure; with CL_OFFLINE=on it is always false (the owner
 * declared the machine offline) and `lastOnlineCheck` stays null because
 * nothing is ever probed.
 */
export function connectivityState(): { online: boolean | null; lastOnlineCheck: string | null } {
  if (setting() === 'on') return { online: false, lastOnlineCheck: null };
  return {
    online: state.online,
    lastOnlineCheck: state.lastOnlineCheck ? state.lastOnlineCheck.toISOString() : null,
  };
}

/** Test hook: forget every probe result. */
export function _resetConnectivityForTests(): void {
  state = { online: null, lastOnlineCheck: null };
  okUntil.clear();
  failUntil.clear();
  inflight.clear();
}

// ─── probe ──────────────────────────────────────────────────────────

type ProbeResult = 'online' | 'offline' | 'inconclusive';

/**
 * Resolve and TCP-connect to `target` (the connect does the DNS lookup)
 * within PROBE_BUDGET_MS, then close the socket without sending anything.
 *
 *   online        connected
 *   offline       timeout, or a no-network error (same rules as
 *                 classifyNetworkError)
 *   inconclusive  any other error, e.g. a refused connection on loopback
 *                 (a name that resolves to this machine): the machine is
 *                 not offline, so nothing is recorded or cached and the
 *                 real call reports its own error
 *
 * Errors raised by the desktop egress guard are rethrown: a host the owner
 * has not turned on is a configuration problem, not "offline".
 */
export function _probe(target: NetTarget): Promise<ProbeResult> {
  return new Promise<ProbeResult>((resolve, reject) => {
    let done = false;
    const socket = net.connect({ host: target.host, port: target.port });
    const finish = (result: ProbeResult | Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const timer = setTimeout(() => finish('offline'), PROBE_BUDGET_MS);
    socket.once('connect', () => finish('online'));
    socket.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EGRESS_BLOCKED') finish(egressNotAllowed(err));
      else finish(offlineCause(err) ? 'offline' : 'inconclusive');
    });
  });
}

function egressNotAllowed(cause: Error): AppError {
  const e = new AppError(
    503,
    'This online feature is not turned on in this app, so its connection was blocked.',
    'EGRESS_BLOCKED',
  );
  (e as Error & { cause?: unknown }).cause = cause;
  return e;
}

/**
 * Make sure `feature` can reach `target` before using it. No-op on the
 * server (CL_OFFLINE is always `off` there). Throws OfflineUnavailableError
 * within PROBE_BUDGET_MS when the host cannot be reached.
 */
export async function ensureOnline(feature: string, target: NetTarget): Promise<void> {
  const mode = setting();
  if (mode === 'off') return;
  // A service on this machine (e.g. a local mail relay) works offline and
  // says nothing about the internet: never probed, never recorded.
  if (isLoopbackAddress(target.host)) return;
  if (mode === 'on') throw new OfflineUnavailableError(feature);

  const key = `${target.host.toLowerCase()}:${target.port}`;
  const now = Date.now();
  if ((okUntil.get(key) ?? 0) > now) return;
  if ((failUntil.get(key) ?? 0) > now) throw new OfflineUnavailableError(feature);

  let p = inflight.get(key);
  if (!p) {
    p = _probe(target).finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  const result = await p;
  if (result === 'inconclusive') return;
  if (result === 'online') {
    okUntil.set(key, Date.now() + ONLINE_CACHE_MS);
    failUntil.delete(key);
    record(true);
    return;
  }
  failUntil.set(key, Date.now() + OFFLINE_CACHE_MS);
  okUntil.delete(key);
  record(false);
  throw new OfflineUnavailableError(feature);
}

/** `https://api.example.com/v1` → `{ host, port: 443 }`. */
export function targetFromUrl(url: string): NetTarget {
  const u = new URL(url);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const port = u.port ? Number(u.port) : u.protocol === 'http:' ? 80 : 443;
  return { host, port };
}

// ─── error classification ───────────────────────────────────────────

const OFFLINE_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ENETDOWN',
  'EHOSTDOWN',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'UND_ERR_CONNECT_TIMEOUT',
]);

function isLoopbackAddress(addr: unknown): boolean {
  if (typeof addr !== 'string') return false;
  const a = addr.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/^::ffff:/, '');
  return a === '::1' || a === 'localhost' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

function offlineCause(err: unknown, depth = 0): boolean {
  if (!err || typeof err !== 'object' || depth > 6) return false;
  const e = err as { code?: unknown; address?: unknown; cause?: unknown; errors?: unknown };
  if (typeof e.code === 'string' && OFFLINE_CODES.has(e.code)) {
    // A refused connection on loopback means a local service (e.g. Ollama)
    // is not running — the machine is not offline.
    if (e.code === 'ECONNREFUSED' && isLoopbackAddress(e.address)) return false;
    return true;
  }
  if (Array.isArray(e.errors) && e.errors.some((x) => offlineCause(x, depth + 1))) return true;
  return offlineCause(e.cause, depth + 1);
}

/**
 * If `err` (or anything in its `cause` chain) is a "no network" error,
 * mark the state offline and return an OfflineUnavailableError for
 * `feature`; otherwise return null. Always null on the server.
 */
export function classifyNetworkError(err: unknown, feature: string): OfflineUnavailableError | null {
  if (setting() === 'off') return null;
  if (err instanceof OfflineUnavailableError) return err;
  if (!offlineCause(err)) return null;
  record(false);
  return new OfflineUnavailableError(feature);
}
