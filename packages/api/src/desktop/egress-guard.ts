// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Desktop egress guard — default-deny for outbound network connections
 * when the engine runs as a local sidecar (CL_MODE=desktop).
 *
 * The engine has many modules that can call out (breach lookups, update
 * checks, payment, SMS, cloud storage, tunnels, AI providers ...). Turning
 * each one off by hand breaks the first time new code phones home, so the
 * desktop profile enforces "no outbound connection unless the owner turned
 * the feature on" at the socket level instead:
 *
 *   - net.Socket.prototype.connect, which every TCP client goes through
 *     (net, tls, http, https, http2 and the undici behind global fetch);
 *   - dns.lookup / dns.lookupService / every dns.resolve* and their
 *     promise and Resolver variants, so a blocked name is never even
 *     sent to a DNS server;
 *   - dgram (UDP) send and connect.
 *
 * Allowed destinations:
 *
 *   - loopback: 127.0.0.0/8, ::1, ::ffff:127.0.0.0/104, `localhost`;
 *   - local IPC (Unix sockets, Windows named pipes);
 *   - the DATABASE_URL host (and port);
 *   - CL_EGRESS_ALLOW (comma-separated `host[:port]`, set by the desktop
 *     app at launch);
 *   - entries registered at runtime with setEgressAllowance() — e.g. the
 *     AI provider or SMTP host once the owner has supplied its key or
 *     password for this session.
 *
 * The check is by destination host (and port when the entry has one),
 * never by async context: connection pools (undici, pg) open sockets from
 * whatever context happens to be current. It runs when a connection is
 * opened: removing an allowance stops new connections, while a keep-alive
 * socket that is already open may be reused until its idle timeout.
 *
 * A blocked connection fails the way a refused one does — the socket is
 * destroyed with an EgressBlockedError (code EGRESS_BLOCKED) on the next
 * tick, before any DNS query or packet — and the host (only) is logged at
 * warn level. Delivering the error through the socket instead of throwing
 * from connect() keeps libraries that connect from timers (reconnect
 * loops) from crashing the process with an uncaught exception.
 *
 * Not covered: child processes (pdftoppm, tesseract, Chromium for PDFs,
 * CLI tools) run outside this process. Desktop mode leaves out the
 * features that start network-capable tools (tunnels, Tailscale). The
 * invoice/portal PDF renderers block page network requests themselves;
 * report-export.service.ts does not yet (see docs/DESKTOP.md).
 *
 * bootstrap.ts installs the guard in desktop mode before any other engine
 * module is loaded. It is never installed on the server appliance.
 */

import net from 'node:net';
import dns from 'node:dns';
import dgram from 'node:dgram';
import { syncBuiltinESMExports } from 'node:module';
import { DesktopConfigError } from './profile.js';

export class EgressBlockedError extends Error {
  readonly code = 'EGRESS_BLOCKED';
  readonly host: string;
  constructor(host: string) {
    super(`Outbound connection to ${host} blocked: the feature that needs it is not turned on.`);
    this.name = 'EgressBlockedError';
    this.host = host;
  }
}

export interface EgressTarget {
  host: string;
  /** null or undefined: every port on this host. */
  port?: number | null;
}

interface Entry {
  host: string;
  port: number | null;
}

// ─── host normalization and matching ───────────────────────────────

/** Lowercase, strip brackets and a trailing dot. */
export function normalizeHost(host: string): string {
  let h = host.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h.endsWith('.')) h = h.slice(0, -1);
  return h;
}

const loopback = new net.BlockList();
loopback.addSubnet('127.0.0.0', 8, 'ipv4');
loopback.addAddress('::1', 'ipv6');
loopback.addSubnet('::ffff:127.0.0.0', 104, 'ipv6');

export function isLoopbackHost(host: string): boolean {
  const h = normalizeHost(host);
  if (h === 'localhost') return true;
  const family = net.isIP(h);
  if (family === 4) return loopback.check(h, 'ipv4');
  if (family === 6) {
    try {
      return loopback.check(h, 'ipv6');
    } catch {
      return false;
    }
  }
  return false;
}

/** Two hosts are the same destination (IPv6 compared in canonical form). */
function sameHost(a: string, b: string): boolean {
  if (a === b) return true;
  if (net.isIP(a) === 6 && net.isIP(b) === 6) {
    try {
      const bl = new net.BlockList();
      bl.addAddress(a, 'ipv6');
      return bl.check(b, 'ipv6');
    } catch {
      return false;
    }
  }
  return false;
}

// ─── allowlist ──────────────────────────────────────────────────────

let staticEntries: Entry[] = [];
const dynamicEntries = new Map<string, Entry[]>();

function toEntry(t: EgressTarget): Entry {
  const host = normalizeHost(t.host);
  if (!host) throw new Error('egress allowance needs a host');
  const port = t.port === undefined || t.port === null ? null : Number(t.port);
  if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error(`egress allowance has an invalid port: ${t.port}`);
  }
  return { host, port };
}

/**
 * Set (replace) the destinations `source` may reach, e.g.
 * `setEgressAllowance('ai.anthropic', [{ host: 'api.anthropic.com', port: 443 }])`.
 * An empty list removes the source.
 */
export function setEgressAllowance(source: string, targets: readonly EgressTarget[]): void {
  if (targets.length === 0) {
    dynamicEntries.delete(source);
    return;
  }
  dynamicEntries.set(source, targets.map(toEntry));
}

export function clearEgressAllowance(source: string): void {
  dynamicEntries.delete(source);
}

/** Current allowlist (static + dynamic), for diagnostics and tests. */
export function egressAllowlist(): Array<{ source: string; host: string; port: number | null }> {
  const out: Array<{ source: string; host: string; port: number | null }> = [];
  for (const e of staticEntries) out.push({ source: 'static', ...e });
  for (const [source, list] of dynamicEntries) for (const e of list) out.push({ source, ...e });
  return out;
}

/** Whether a connection to host[:port] is allowed. Port null = DNS-only check. */
export function isEgressAllowed(host: string, port: number | null = null): boolean {
  const h = normalizeHost(host);
  if (h === '' || isLoopbackHost(h)) return true;
  const match = (e: Entry) => sameHost(e.host, h) && (e.port === null || port === null || e.port === port);
  if (staticEntries.some(match)) return true;
  for (const list of dynamicEntries.values()) if (list.some(match)) return true;
  return false;
}

/** Parse `host[:port]` / `[v6]:port` / bare v6, comma-separated. */
export function parseAllowList(raw: string | undefined): EgressTarget[] {
  if (!raw || raw.trim() === '') return [];
  return raw.split(',').map((part) => part.trim()).filter(Boolean).map((item) => {
    const v6 = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(item);
    if (v6) return { host: v6[1]!, port: v6[2] ? Number(v6[2]) : null };
    if (net.isIP(item) === 6) return { host: item, port: null };
    const hp = /^([A-Za-z0-9.-]+)(?::(\d{1,5}))?$/.exec(item);
    if (!hp) throw new DesktopConfigError('CL_EGRESS_ALLOW_INVALID', `CL_EGRESS_ALLOW has an invalid entry: "${item}".`);
    const port = hp[2] ? Number(hp[2]) : null;
    if (port !== null && (port < 1 || port > 65535)) {
      throw new DesktopConfigError('CL_EGRESS_ALLOW_INVALID', `CL_EGRESS_ALLOW has an invalid port: "${item}".`);
    }
    return { host: hp[1]!, port };
  });
}

function databaseEntries(databaseUrl: string | undefined): Entry[] {
  if (!databaseUrl) return [];
  try {
    const u = new URL(databaseUrl);
    const out: Entry[] = [];
    if (u.hostname) out.push(toEntry({ host: u.hostname, port: u.port ? Number(u.port) : 5432 }));
    // `?host=` may name a socket directory (IPC, always allowed) or a host.
    const qh = u.searchParams.get('host');
    if (qh && !qh.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(qh)) {
      out.push(toEntry({ host: qh, port: u.port ? Number(u.port) : 5432 }));
    }
    return out;
  } catch {
    return [];
  }
}

// ─── logging ────────────────────────────────────────────────────────

const lastLogged = new Map<string, number>();
const LOG_EVERY_MS = 60_000;

function logBlocked(host: string): void {
  const now = Date.now();
  if ((lastLogged.get(host) ?? 0) + LOG_EVERY_MS > now) return;
  lastLogged.set(host, now);
  if (lastLogged.size > 1000) lastLogged.clear();
  // Host only: never the port, path, payload or the calling feature's data.
  console.warn(JSON.stringify({ level: 'warn', component: 'egress-guard', event: 'blocked', host }));
}

function blocked(host: string): EgressBlockedError {
  const h = normalizeHost(host) || String(host);
  logBlocked(h);
  return new EgressBlockedError(h);
}

// ─── patches ────────────────────────────────────────────────────────

type AnyFn = (this: unknown, ...args: unknown[]) => unknown;

interface Saved {
  target: Record<string, unknown>;
  key: string;
  value: unknown;
}

let saved: Saved[] = [];
let installed = false;

function patch(target: object | undefined, key: string, make: (orig: AnyFn) => AnyFn): void {
  if (!target) return;
  const t = target as Record<string, unknown>;
  const orig = t[key];
  if (typeof orig !== 'function') return;
  saved.push({ target: t, key, value: orig });
  t[key] = make(orig as AnyFn);
}

type ConnectTarget = { kind: 'ipc' } | { kind: 'tcp'; host: string; port: number | null };

/** Read the destination from the argument forms Socket#connect accepts. */
/** Not a valid hostname: never on the allowlist, so the connect is blocked. */
const INVALID_HOST = '[invalid-host]';

/**
 * Read the destination from the argument forms Socket#connect accepts,
 * using Node's own rules (lib/net.js normalizeArgs/isPipeName): a string
 * first argument is a pipe path only when `!(Number(arg) >= 0)`, so `'0x1f90'`
 * or `'8080.0'` are ports. Anything Node would not read as a host string is
 * treated as blocked rather than defaulting to localhost.
 */
function connectTarget(args: unknown[]): ConnectTarget {
  let first = args[0];
  // net.connect() hands Socket#connect its normalized `[options, cb]`.
  if (Array.isArray(first)) first = first[0];
  if (first && typeof first === 'object') {
    const o = first as { path?: unknown; host?: unknown; port?: unknown };
    if (typeof o.path === 'string' && o.path !== '') return { kind: 'ipc' };
    if (o.path !== undefined && o.path !== null && o.path !== '') return { kind: 'tcp', host: INVALID_HOST, port: null };
    let host: string;
    if (o.host === undefined || o.host === null || o.host === '') host = 'localhost';
    else if (typeof o.host === 'string') host = o.host;
    else host = INVALID_HOST;
    const port = o.port === undefined || o.port === null ? null : Number(o.port);
    return { kind: 'tcp', host, port: Number.isFinite(port) ? port : null };
  }
  if (typeof first === 'string' && !(Number(first) >= 0)) return { kind: 'ipc' };
  const host = typeof args[1] === 'string' && args[1] !== '' ? args[1] : 'localhost';
  const port = Number(first);
  return { kind: 'tcp', host, port: Number.isFinite(port) ? port : null };
}

function callbackOf(args: unknown[]): AnyFn | null {
  for (let i = args.length - 1; i >= 0; i--) {
    if (typeof args[i] === 'function') return args[i] as AnyFn;
  }
  return null;
}

/** Callback-style DNS API: deliver the error through the callback. */
function guardCallbackDns(nameOf: (args: unknown[]) => unknown) {
  return (orig: AnyFn) =>
    function guarded(this: unknown, ...args: unknown[]) {
      const name = nameOf(args);
      if (typeof name === 'string' && !isEgressAllowed(name)) {
        const err = blocked(name);
        const cb = callbackOf(args);
        if (cb) {
          process.nextTick(cb, err);
          return undefined;
        }
        throw err;
      }
      return orig.apply(this, args);
    };
}

/** Promise-style DNS API: reject. */
function guardPromiseDns(nameOf: (args: unknown[]) => unknown) {
  return (orig: AnyFn) =>
    function guarded(this: unknown, ...args: unknown[]) {
      const name = nameOf(args);
      if (typeof name === 'string' && !isEgressAllowed(name)) return Promise.reject(blocked(name));
      return orig.apply(this, args);
    };
}

const RESOLVE_METHODS = [
  'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa', 'resolveCname', 'resolveMx',
  'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTlsa', 'resolveTxt',
  'reverse',
];

const firstArg = (args: unknown[]) => args[0];
// dns.lookup of an IP literal answers locally without a query (net.Server
// listen() uses it for the bind address, e.g. 0.0.0.0 with CL_LAN=1), so
// only names are checked there. Connections to IP literals are still
// checked in Socket#connect.
const lookupName = (args: unknown[]) => (typeof args[0] === 'string' && net.isIP(args[0]) ? undefined : args[0]);

function patchDns(): void {
  patch(dns, 'lookup', guardCallbackDns(lookupName));
  patch(dns, 'lookupService', guardCallbackDns(firstArg));
  patch(dns.promises, 'lookup', guardPromiseDns(lookupName));
  patch(dns.promises, 'lookupService', guardPromiseDns(firstArg));
  for (const m of RESOLVE_METHODS) {
    patch(dns, m, guardCallbackDns(firstArg));
    patch(dns.Resolver?.prototype, m, guardCallbackDns(firstArg));
    patch(dns.promises, m, guardPromiseDns(firstArg));
    patch(dns.promises.Resolver?.prototype, m, guardPromiseDns(firstArg));
  }
}

function patchNet(): void {
  patch(net.Socket.prototype, 'connect', (orig) =>
    function guardedConnect(this: unknown, ...args: unknown[]) {
      const socket = this as net.Socket;
      const t = connectTarget(args);
      if (t.kind === 'tcp' && !isEgressAllowed(t.host, t.port)) {
        const err = blocked(t.host);
        process.nextTick(() => socket.destroy(err));
        return socket;
      }
      return orig.apply(this, args);
    });
}

function patchDgram(): void {
  patch(dgram.Socket.prototype, 'connect', (orig) =>
    function guardedUdpConnect(this: unknown, ...args: unknown[]) {
      const sock = this as dgram.Socket;
      const host = typeof args[1] === 'string' && args[1] !== '' ? args[1] : 'localhost';
      if (!isEgressAllowed(host, Number(args[0]))) {
        const err = blocked(host);
        const cb = callbackOf(args);
        if (cb) process.nextTick(cb, err);
        else process.nextTick(() => sock.emit('error', err));
        return undefined;
      }
      return orig.apply(this, args);
    });
  patch(dgram.Socket.prototype, 'send', (orig) =>
    function guardedUdpSend(this: unknown, ...args: unknown[]) {
      const sock = this as dgram.Socket;
      // Connected sockets were checked in connect(); remoteAddress() throws
      // when the socket is not connected.
      let connected = false;
      try {
        sock.remoteAddress();
        connected = true;
      } catch {
        connected = false;
      }
      if (!connected) {
        // Same argument shuffle as dgram's own send():
        // (msg, offset, length, port, address, cb) or (msg, port, address, cb).
        const [, a1, a2, a3, a4] = args;
        const long = !!a4 || (!!a3 && typeof a3 !== 'function');
        const port = long ? a3 : a1;
        const address = long ? a4 : a2;
        const host = typeof address === 'string' && address !== '' ? address : 'localhost';
        if (!isEgressAllowed(host, Number(port))) {
          const err = blocked(host);
          const cb = callbackOf(args);
          if (cb) process.nextTick(cb, err);
          else process.nextTick(() => sock.emit('error', err));
          return undefined;
        }
      }
      return orig.apply(this, args);
    });
}

export interface EgressGuardOptions {
  databaseUrl?: string;
  /** CL_EGRESS_ALLOW. */
  allow?: string;
}

/**
 * Install the guard (idempotent). Throws DesktopConfigError when
 * CL_EGRESS_ALLOW cannot be parsed.
 */
export function installEgressGuard(opts: EgressGuardOptions = {}): void {
  const fromEnv = parseAllowList(opts.allow).map(toEntry);
  staticEntries = [...databaseEntries(opts.databaseUrl), ...fromEnv];
  if (installed) return;
  installed = true;
  saved = [];
  patchNet();
  patchDns();
  patchDgram();
  // ESM named imports of builtins (`import { lookup } from 'node:dns'`)
  // only see the patched functions after a sync.
  syncBuiltinESMExports();
}

export function isEgressGuardInstalled(): boolean {
  return installed;
}

/** Test hook: restore every patched function and clear the allowlist. */
export function _uninstallEgressGuardForTests(): void {
  for (const s of saved.reverse()) s.target[s.key] = s.value;
  saved = [];
  installed = false;
  staticEntries = [];
  dynamicEntries.clear();
  lastLogged.clear();
  syncBuiltinESMExports();
}
