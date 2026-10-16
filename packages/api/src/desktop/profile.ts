// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Desktop profile — the `CL_MODE=desktop` switch used when the engine runs
 * as a local sidecar of a desktop app (ClientLedger) instead of as the
 * server appliance. See docs/DESKTOP.md for the full environment contract.
 *
 * `loadDesktopProfile()` is called first thing in bootstrap.ts, before
 * config/env.ts is imported, because several modules read directory
 * variables (UPLOAD_DIR, BACKUP_DIR, ...) at import time. It is pure apart
 * from the documented env mutations: env in, profile + mutated env out.
 *
 * When CL_MODE is unset (or `server`) the loader returns the server profile
 * and does not touch the environment at all — the appliance path is
 * unchanged.
 *
 * This module must stay free of imports from config/env.ts, db/ and any
 * service: bootstrap.ts loads it before the environment is validated.
 */

import crypto from 'node:crypto';
import path from 'node:path';

export type EngineMode = 'server' | 'desktop';
export type QueueBackend = 'bullmq' | 'none';
export type OfflineSetting = 'auto' | 'on' | 'off';

export interface DesktopBind {
  /** IP literal without brackets, e.g. `127.0.0.1` or `::1`. */
  host: string;
  /** 0 asks the OS for a free port; the real port is printed in the ready line. */
  port: number;
}

export interface DesktopProfile {
  mode: EngineMode;
  queueBackend: QueueBackend;
  /** Only set in desktop mode. */
  bind: DesktopBind | null;
  dataDir: string | null;
  logFile: string | null;
  logMaxBytes: number;
  logKeep: number;
  offline: OfflineSetting;
  lan: boolean;
  requireNonSuperuser: boolean;
}

/** Configuration error: bootstrap prints one fatal JSON line and exits 78. */
export class DesktopConfigError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'DesktopConfigError';
    this.code = code;
  }
}

/** sysexits.h EX_CONFIG — configuration problem; restarting will not help. */
export const EXIT_CONFIG = 78;

const DEFAULT_LOG_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_LOG_KEEP = 5;
// ≥ 256 bits: 43+ base64url characters (64 hex characters also match).
const TOKEN_RE = /^[A-Za-z0-9_-]{43,512}$/;

let current: DesktopProfile | null = null;
// SHA-256 of the launch token. The raw token never leaves this module's
// closure except through the secret scrubber registration in bootstrap.
let tokenDigest: Buffer | null = null;
let rawTokenForScrubber: string | null = null;

function parseQueueBackend(raw: string | undefined, fallback: QueueBackend): QueueBackend {
  const v = (raw ?? '').trim().toLowerCase();
  if (v === '') return fallback;
  if (v === 'bullmq' || v === 'none') return v;
  throw new DesktopConfigError(
    'QUEUE_BACKEND_INVALID',
    `QUEUE_BACKEND must be "bullmq" or "none" (got "${raw}").`,
  );
}

function isLoopback(host: string): boolean {
  if (host === '::1') return true;
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  return !!m && m.slice(1).every((o) => Number(o) <= 255);
}

/** Parse `127.0.0.1:3001`, `[::1]:0`, `0.0.0.0:3001`, `[::]:0`. IP literals only. */
export function parseBind(raw: string): DesktopBind {
  const v = raw.trim();
  let host: string;
  let portStr: string;
  const v6 = /^\[([0-9A-Fa-f:.]+)\]:(\d{1,5})$/.exec(v);
  const v4 = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/.exec(v);
  if (v6) {
    host = v6[1]!.toLowerCase();
    portStr = v6[2]!;
  } else if (v4) {
    host = v4[1]!;
    portStr = v4[2]!;
    if (!host.split('.').every((o) => Number(o) <= 255)) {
      throw new DesktopConfigError('CL_BIND_INVALID', `CL_BIND has an invalid IPv4 address: "${raw}".`);
    }
  } else {
    throw new DesktopConfigError(
      'CL_BIND_INVALID',
      `CL_BIND must be "<ipv4>:<port>" or "[<ipv6>]:<port>" (got "${raw}").`,
    );
  }
  const port = Number(portStr);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new DesktopConfigError('CL_BIND_INVALID', `CL_BIND port must be 0-65535 (got "${portStr}").`);
  }
  return { host, port };
}

function parsePositiveInt(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  if (!/^\d+$/.test(raw.trim()) || Number(raw) <= 0) {
    throw new DesktopConfigError('CL_ENV_INVALID', `${name} must be a positive integer (got "${raw}").`);
  }
  return Number(raw);
}

function serverProfile(env: NodeJS.ProcessEnv): DesktopProfile {
  return {
    mode: 'server',
    queueBackend: parseQueueBackend(env['QUEUE_BACKEND'], 'bullmq'),
    bind: null,
    dataDir: null,
    logFile: null,
    logMaxBytes: DEFAULT_LOG_MAX_BYTES,
    logKeep: DEFAULT_LOG_KEEP,
    offline: 'off',
    lan: false,
    requireNonSuperuser: false,
  };
}

/**
 * Read the CL_* contract from `env`, apply desktop defaults to it, and
 * remember the result as the process profile. Throws DesktopConfigError on
 * an invalid desktop configuration. Server mode never mutates `env`.
 */
export function loadDesktopProfile(env: NodeJS.ProcessEnv = process.env): DesktopProfile {
  const modeRaw = (env['CL_MODE'] ?? '').trim().toLowerCase();
  if (modeRaw === '' || modeRaw === 'server') {
    current = serverProfile(env);
    tokenDigest = null;
    rawTokenForScrubber = null;
    return current;
  }
  if (modeRaw !== 'desktop') {
    throw new DesktopConfigError('CL_MODE_INVALID', `CL_MODE must be "desktop" or unset (got "${env['CL_MODE']}").`);
  }

  // --- launch token: validate, capture, remove from the environment -----
  const token = env['CL_TOKEN'];
  delete env['CL_TOKEN'];
  if (!token) {
    throw new DesktopConfigError('CL_TOKEN_REQUIRED', 'CL_TOKEN is required in desktop mode.');
  }
  if (!TOKEN_RE.test(token)) {
    throw new DesktopConfigError(
      'CL_TOKEN_INVALID',
      'CL_TOKEN must be at least 43 base64url characters or 64 hex characters (256 bits).',
    );
  }

  // --- bind address --------------------------------------------------------
  const bindRaw = env['CL_BIND'];
  if (!bindRaw || bindRaw.trim() === '') {
    throw new DesktopConfigError('CL_BIND_REQUIRED', 'CL_BIND is required in desktop mode (e.g. 127.0.0.1:0).');
  }
  const bind = parseBind(bindRaw);
  // LAN mode is refused until P33 adds TLS: the engine speaks plain HTTP,
  // so a LAN bind would put the launch token, passwords and books on the
  // wire in clear text. When P33 lands, CL_LAN=1 will accept only private
  // literals (RFC 1918 10/8, 172.16/12, 192.168/16; IPv6 ULA fc00::/7;
  // link-local 169.254/16 and fe80::/10) — never 0.0.0.0, :: or a public
  // address — and only with TLS configured.
  if (env['CL_LAN'] === '1') {
    throw new DesktopConfigError(
      'CL_LAN_UNSUPPORTED',
      'CL_LAN=1 is not supported yet: LAN mode needs TLS. Bind to a loopback address.',
    );
  }
  if (!isLoopback(bind.host)) {
    throw new DesktopConfigError(
      'CL_BIND_NOT_LOOPBACK',
      `CL_BIND ${bindRaw} is not a loopback address (127.0.0.0/8 or ::1).`,
    );
  }

  // --- data directory --------------------------------------------------------
  const dataDirRaw = env['CL_DATA_DIR'];
  if (!dataDirRaw || dataDirRaw.trim() === '') {
    throw new DesktopConfigError('CL_DATA_DIR_REQUIRED', 'CL_DATA_DIR is required in desktop mode.');
  }
  // Absolute only: a relative path would depend on the engine's working
  // directory, which the desktop app does not promise.
  if (!path.isAbsolute(dataDirRaw.trim())) {
    throw new DesktopConfigError('CL_DATA_DIR_INVALID', 'CL_DATA_DIR must be an absolute path.');
  }
  const dataDir = path.resolve(dataDirRaw.trim());

  // --- conflicting server-only switches ---------------------------------------
  if (env['RATE_LIMIT_REDIS'] === '1') {
    throw new DesktopConfigError('CL_ENV_CONFLICT', 'RATE_LIMIT_REDIS=1 is not supported in desktop mode (no Redis).');
  }
  if ((env['VIBE_AI_MODE'] ?? '').trim() === 'router') {
    throw new DesktopConfigError('CL_ENV_CONFLICT', 'VIBE_AI_MODE=router is not supported in desktop mode.');
  }
  const queueBackend = parseQueueBackend(env['QUEUE_BACKEND'], 'none');
  if (queueBackend === 'bullmq') {
    throw new DesktopConfigError('CL_ENV_CONFLICT', 'QUEUE_BACKEND=bullmq needs Redis and is not supported in desktop mode.');
  }

  const offlineRaw = (env['CL_OFFLINE'] ?? 'auto').trim().toLowerCase();
  if (offlineRaw !== 'auto' && offlineRaw !== 'on' && offlineRaw !== 'off') {
    throw new DesktopConfigError('CL_ENV_INVALID', `CL_OFFLINE must be auto, on or off (got "${env['CL_OFFLINE']}").`);
  }

  const logMaxBytes = parsePositiveInt('CL_LOG_MAX_BYTES', env['CL_LOG_MAX_BYTES'], DEFAULT_LOG_MAX_BYTES);
  const logKeep = parsePositiveInt('CL_LOG_KEEP', env['CL_LOG_KEEP'], DEFAULT_LOG_KEEP);
  const logFileRaw = (env['CL_LOG_FILE'] ?? '').trim();
  if (logFileRaw !== '' && !path.isAbsolute(logFileRaw)) {
    throw new DesktopConfigError('CL_LOG_FILE_INVALID', 'CL_LOG_FILE must be an absolute path.');
  }
  const logFile = logFileRaw !== '' ? path.resolve(logFileRaw) : null;

  // --- env mutations (documented in docs/DESKTOP.md) -----------------------------
  const setDefault = (key: string, value: string) => {
    if (env[key] === undefined || env[key] === '') env[key] = value;
  };
  setDefault('DATA_DIR', dataDir);
  setDefault('UPLOAD_DIR', path.join(dataDir, 'uploads'));
  setDefault('BACKUP_DIR', path.join(dataDir, 'backups'));
  setDefault('CONFIG_DIR', path.join(dataDir, 'config'));
  setDefault('STORAGE_CACHE_DIR', path.join(dataDir, 'cache'));
  setDefault('CL_ARCHIVE_DIR', path.join(dataDir, 'archives'));
  // Forced: no breach lookups (phone-home), no worker container, no
  // screen share (needs Redis pub/sub).
  env['HIBP_DISABLED'] = '1';
  env['EXPECT_WORKER'] = 'false';
  env['SHARE_ENABLED'] = 'false';
  env['QUEUE_BACKEND'] = queueBackend;
  // env.ts validates PORT; keep it consistent with the bind address.
  env['PORT'] = String(bind.port);

  tokenDigest = crypto.createHash('sha256').update(token, 'utf8').digest();
  rawTokenForScrubber = token;
  current = {
    mode: 'desktop',
    queueBackend,
    bind,
    dataDir,
    logFile,
    logMaxBytes,
    logKeep,
    offline: offlineRaw,
    // Always false until P33 (CL_LAN=1 is refused above).
    lan: false,
    requireNonSuperuser: env['CL_REQUIRE_NON_SUPERUSER'] === '1',
  };
  return current;
}

/**
 * The process profile. Loads lazily from process.env when bootstrap did not
 * run (scripts, the worker package, tests importing modules directly).
 */
export function desktopProfile(): DesktopProfile {
  return current ?? loadDesktopProfile(process.env);
}

export function isDesktop(): boolean {
  return desktopProfile().mode === 'desktop';
}

export function queueBackend(): QueueBackend {
  return desktopProfile().queueBackend;
}

/**
 * Whether any Redis client may be constructed. Always true for the server
 * appliance with its default configuration (unchanged behavior). False in
 * desktop mode, and for a server install that opted out of Redis by
 * choosing QUEUE_BACKEND=none without a REDIS_URL.
 */
export function redisEnabled(): boolean {
  const p = desktopProfile();
  if (p.mode === 'desktop') return false;
  if (p.queueBackend !== 'bullmq' && !process.env['REDIS_URL']) return false;
  return true;
}

/**
 * Constant-time check of an `X-CL-Token` header value. Both sides are
 * hashed first so the comparison length never depends on the input.
 */
export function verifyDesktopToken(header: string | string[] | undefined): boolean {
  if (!tokenDigest) return false;
  if (typeof header !== 'string' || header.length === 0) {
    // Still burn one comparison so a missing header is not measurably faster.
    crypto.timingSafeEqual(tokenDigest, tokenDigest);
    return false;
  }
  const candidate = crypto.createHash('sha256').update(header, 'utf8').digest();
  return crypto.timingSafeEqual(candidate, tokenDigest);
}

/**
 * Desktop mode never writes boot secrets (the recovery file, the sentinel,
 * a .env): the desktop app keeps them in the OS keychain. The appliance
 * writers call this first so a route or code path that was missed in the
 * feature profile still cannot put them on disk. No-op on the server.
 */
export function assertNoSecretWriteInDesktop(what: string): void {
  if (desktopProfile().mode === 'desktop') {
    throw new Error(`${what} is not written in desktop mode (the desktop app keeps secrets in the OS keychain).`);
  }
}

/** The raw launch token, for registration with the secret scrubber only. */
export function desktopTokenForScrubber(): string | null {
  return rawTokenForScrubber;
}

/** Test hook: forget the cached profile and token. */
export function _resetDesktopProfileForTests(): void {
  current = null;
  tokenDigest = null;
  rawTokenForScrubber = null;
}
