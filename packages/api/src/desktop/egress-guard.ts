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
 *   - dgram (UDP) send and connect;
 *   - worker_threads.Worker: every worker thread runs the same guard
 *     (same code, a snapshot of the allowlist taken when the worker
 *     starts) before any of its own code, and so do workers it starts.
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
 * With CL_OFFLINE=on only loopback, IPC and the database are allowed:
 * CL_EGRESS_ALLOW and runtime allowances are ignored.
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
 * Implementation note: all patching lives in guardCore(), which must stay
 * SELF-CONTAINED (no reference to anything outside its own body except its
 * parameters and JS/Node globals). Worker threads run the very same
 * function: its source is serialized into the worker's prelude.
 *
 * Not covered: child processes (pdftoppm, tesseract CLI, Chromium for
 * PDFs, CLI tools) run outside this process; see docs/DESKTOP.md.
 *
 * bootstrap.ts installs the guard in desktop mode before any other engine
 * module is loaded. It is never installed on the server appliance.
 */

import net from 'node:net';
import dns from 'node:dns';
import dgram from 'node:dgram';
import path from 'node:path';
import url from 'node:url';
import workerThreads from 'node:worker_threads';
import nodeModule from 'node:module';
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

/** One allowlist entry. `source` 'db' survives CL_OFFLINE=on; nothing else does. */
interface Entry {
  host: string;
  port: number | null;
  source: string;
}

interface CoreConfig {
  entries: Entry[];
  offline: boolean;
  logEveryMs: number;
}

type Fn = (this: unknown, ...args: unknown[]) => unknown;

interface CoreModules {
  net: typeof net;
  dns: typeof dns;
  dgram: typeof dgram;
  path: typeof path;
  url: typeof url;
  worker_threads: typeof workerThreads;
  module: typeof nodeModule;
  makeError?: (host: string) => Error;
}

interface CoreHandle {
  normalize(host: string): string;
  isLoopback(host: string): boolean;
  isAllowed(host: string, port: number | null): boolean;
  setEntries(entries: Entry[]): void;
  /** JS source that installs this guard (with the current allowlist) in a worker thread. */
  workerPrelude(): string;
  restore(): void;
}

/**
 * The whole guard. SELF-CONTAINED: see the note at the top of this file.
 * With `install` false it only provides the helpers (no patching).
 */
function guardCore(cfg: CoreConfig, m: CoreModules, install: boolean): CoreHandle {
  const INVALID_HOST = '#invalid-host';
  let entries: Entry[] = cfg.entries.slice();
  const saved: Array<{ target: Record<string, unknown>; key: string; value: unknown }> = [];
  const lastLogged = new Map<string, number>();

  const loopback = new m.net.BlockList();
  loopback.addSubnet('127.0.0.0', 8, 'ipv4');
  loopback.addAddress('::1', 'ipv6');
  loopback.addSubnet('::ffff:127.0.0.0', 104, 'ipv6');

  function normalize(host: string): string {
    let h = String(host).trim().toLowerCase();
    if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
    if (h.endsWith('.')) h = h.slice(0, -1);
    return h;
  }

  function isLoopback(host: string): boolean {
    const h = normalize(host);
    if (h === 'localhost') return true;
    const family = m.net.isIP(h);
    try {
      if (family === 4) return loopback.check(h, 'ipv4');
      if (family === 6) return loopback.check(h, 'ipv6');
    } catch {
      return false;
    }
    return false;
  }

  function sameHost(a: string, b: string): boolean {
    if (a === b) return true;
    if (m.net.isIP(a) === 6 && m.net.isIP(b) === 6) {
      try {
        const bl = new m.net.BlockList();
        bl.addAddress(a, 'ipv6');
        return bl.check(b, 'ipv6');
      } catch {
        return false;
      }
    }
    return false;
  }

  function isAllowed(host: string, port: number | null): boolean {
    if (host === '' || isLoopback(host)) return true;
    const h = normalize(host);
    for (const e of entries) {
      if (cfg.offline && e.source !== 'db') continue;
      if (sameHost(e.host, h) && (e.port === null || port === null || e.port === port)) return true;
    }
    return false;
  }

  function blocked(host: string): Error {
    const h = normalize(host) || String(host);
    const now = Date.now();
    if ((lastLogged.get(h) ?? 0) + cfg.logEveryMs <= now) {
      lastLogged.set(h, now);
      if (lastLogged.size > 1000) lastLogged.clear();
      // Host only: never the port, path, payload or the calling feature's data.
      console.warn(JSON.stringify({ level: 'warn', component: 'egress-guard', event: 'blocked', host: h }));
    }
    if (m.makeError) return m.makeError(h);
    const err = new Error(`Outbound connection to ${h} blocked: the feature that needs it is not turned on.`);
    return Object.assign(err, { name: 'EgressBlockedError', code: 'EGRESS_BLOCKED', host: h });
  }

  function patch(target: object | undefined, key: string, make: (orig: Fn) => Fn): void {
    if (!target) return;
    const t = target as Record<string, unknown>;
    const orig = t[key];
    if (typeof orig !== 'function') return;
    saved.push({ target: t, key, value: orig });
    t[key] = make(orig as Fn);
  }

  function callbackOf(args: unknown[]): Fn | null {
    for (let i = args.length - 1; i >= 0; i--) if (typeof args[i] === 'function') return args[i] as Fn;
    return null;
  }

  // Socket#connect destination, by Node's own rules (lib/net.js
  // normalizeArgs/isPipeName): a string first argument is a pipe path only
  // when !(Number(arg) >= 0). Hosts Node would not read as a string are
  // blocked rather than defaulted to localhost.
  function connectTarget(args: unknown[]): { ipc: true } | { ipc: false; host: string; port: number | null } {
    let first = args[0];
    if (Array.isArray(first)) first = first[0];
    if (first && typeof first === 'object') {
      const o = first as { path?: unknown; host?: unknown; port?: unknown };
      if (typeof o.path === 'string' && o.path !== '') return { ipc: true };
      if (o.path !== undefined && o.path !== null && o.path !== '') return { ipc: false, host: INVALID_HOST, port: null };
      let host: string;
      if (o.host === undefined || o.host === null || o.host === '') host = 'localhost';
      else if (typeof o.host === 'string') host = o.host;
      else host = INVALID_HOST;
      const port = o.port === undefined || o.port === null ? null : Number(o.port);
      return { ipc: false, host, port: Number.isFinite(port) ? port : null };
    }
    if (typeof first === 'string' && !(Number(first) >= 0)) return { ipc: true };
    const host = typeof args[1] === 'string' && args[1] !== '' ? args[1] : 'localhost';
    const port = Number(first);
    return { ipc: false, host, port: Number.isFinite(port) ? port : null };
  }

  function guardCallbackDns(nameOf: (args: unknown[]) => unknown) {
    return (orig: Fn): Fn =>
      function guarded(this: unknown, ...args: unknown[]) {
        const name = nameOf(args);
        if (typeof name === 'string' && !isAllowed(name, null)) {
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

  function guardPromiseDns(nameOf: (args: unknown[]) => unknown) {
    return (orig: Fn): Fn =>
      function guarded(this: unknown, ...args: unknown[]) {
        const name = nameOf(args);
        if (typeof name === 'string' && !isAllowed(name, null)) return Promise.reject(blocked(name));
        return orig.apply(this, args);
      };
  }

  function workerPrelude(): string {
    const snapshot: CoreConfig = { entries, offline: cfg.offline, logEveryMs: cfg.logEveryMs };
    // `__name` shim: some TypeScript runners (tsx, esbuild keepNames) add
    // __name(...) calls inside function bodies. The IIFE keeps the shim and
    // the guard out of the worker's own scope.
    return '(function () { var __name = function (f) { return f; }; '
      + `var core = (${guardCore.toString()}); `
      + `core(${JSON.stringify(snapshot)}, { net: require('node:net'), dns: require('node:dns'), `
      + "dgram: require('node:dgram'), path: require('node:path'), url: require('node:url'), "
      + "worker_threads: require('node:worker_threads'), module: require('node:module') }, true); })();\n";
  }

  function restore(): void {
    for (const s of saved.reverse()) s.target[s.key] = s.value;
    saved.length = 0;
    m.module.syncBuiltinESMExports();
  }

  const handle: CoreHandle = {
    normalize,
    isLoopback,
    isAllowed,
    setEntries(next: Entry[]) { entries = next.slice(); },
    workerPrelude,
    restore,
  };
  if (!install) return handle;

  // --- TCP -----------------------------------------------------------------
  patch(m.net.Socket.prototype, 'connect', (orig) =>
    function guardedConnect(this: unknown, ...args: unknown[]) {
      const socket = this as { destroy(err: Error): void };
      const t = connectTarget(args);
      if (!t.ipc && !isAllowed(t.host, t.port)) {
        const err = blocked(t.host);
        process.nextTick(() => socket.destroy(err));
        return socket;
      }
      return orig.apply(this, args);
    });

  // --- DNS -----------------------------------------------------------------
  const firstArg = (args: unknown[]) => args[0];
  // dns.lookup of an IP literal answers locally without a query (net.Server
  // listen() uses it for the bind address), so only names are checked there.
  const lookupName = (args: unknown[]) => (typeof args[0] === 'string' && m.net.isIP(args[0]) ? undefined : args[0]);
  patch(m.dns, 'lookup', guardCallbackDns(lookupName));
  patch(m.dns, 'lookupService', guardCallbackDns(firstArg));
  patch(m.dns.promises, 'lookup', guardPromiseDns(lookupName));
  patch(m.dns.promises, 'lookupService', guardPromiseDns(firstArg));
  const resolveMethods = [
    'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa', 'resolveCname', 'resolveMx',
    'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTlsa', 'resolveTxt',
    'reverse',
  ];
  for (const name of resolveMethods) {
    patch(m.dns, name, guardCallbackDns(firstArg));
    patch(m.dns.Resolver?.prototype, name, guardCallbackDns(firstArg));
    patch(m.dns.promises, name, guardPromiseDns(firstArg));
    patch(m.dns.promises.Resolver?.prototype, name, guardPromiseDns(firstArg));
  }

  // --- UDP -----------------------------------------------------------------
  patch(m.dgram.Socket.prototype, 'connect', (orig) =>
    function guardedUdpConnect(this: unknown, ...args: unknown[]) {
      const sock = this as { emit(ev: string, e: Error): void };
      const host = typeof args[1] === 'string' && args[1] !== '' ? args[1] : 'localhost';
      if (!isAllowed(host, Number(args[0]))) {
        const err = blocked(host);
        const cb = callbackOf(args);
        if (cb) process.nextTick(cb, err);
        else process.nextTick(() => sock.emit('error', err));
        return undefined;
      }
      return orig.apply(this, args);
    });
  patch(m.dgram.Socket.prototype, 'send', (orig) =>
    function guardedUdpSend(this: unknown, ...args: unknown[]) {
      const sock = this as { remoteAddress(): unknown; emit(ev: string, e: Error): void };
      let connected = false;
      try {
        sock.remoteAddress();
        connected = true;
      } catch {
        connected = false;
      }
      if (!connected) {
        // dgram send(): (msg, offset, length, port, address, cb) or (msg, port, address, cb).
        const a1 = args[1];
        const a2 = args[2];
        const a3 = args[3];
        const a4 = args[4];
        const long = !!a4 || (!!a3 && typeof a3 !== 'function');
        const port = long ? a3 : a1;
        const address = long ? a4 : a2;
        const host = typeof address === 'string' && address !== '' ? address : 'localhost';
        if (!isAllowed(host, Number(port))) {
          const err = blocked(host);
          const cb = callbackOf(args);
          if (cb) process.nextTick(cb, err);
          else process.nextTick(() => sock.emit('error', err));
          return undefined;
        }
      }
      return orig.apply(this, args);
    });

  // --- worker threads ------------------------------------------------------
  // Every worker starts with this guard's prelude, then its own code: an
  // `eval` worker gets the prelude prepended; a file worker becomes an
  // eval worker that loads the file (require for CommonJS, import() for
  // .mjs / file URLs to .mjs).
  const OrigWorker = m.worker_threads.Worker;
  class GuardedWorker extends OrigWorker {
    constructor(filename: string | URL, options?: Record<string, unknown>) {
      const opts: Record<string, unknown> = { ...(options ?? {}) };
      let body: string;
      if (opts['eval']) {
        body = String(filename);
      } else {
        let file: string;
        const asUrl = typeof filename === 'object' && filename !== null ? String(filename) : null;
        if ((asUrl ?? '').startsWith('file:') || (typeof filename === 'string' && filename.startsWith('file:'))) {
          file = m.url.fileURLToPath(asUrl ?? (filename as string));
        } else if (asUrl !== null) {
          throw blocked(asUrl.slice(0, 40));
        } else if (typeof filename === 'string' && !/^[a-z][a-z0-9+.-]*:/i.test(filename.replace(/^[a-z]:[\\/]/i, ''))) {
          file = m.path.resolve(filename);
        } else {
          // data:, http: and other URL schemes are not loaded in desktop mode.
          throw blocked(String(filename).slice(0, 40));
        }
        body = /\.mjs$/i.test(file)
          ? `import(${JSON.stringify(m.url.pathToFileURL(file).href)});`
          : `require(${JSON.stringify(file)});`;
      }
      opts['eval'] = true;
      super(workerPrelude() + body, opts as ConstructorParameters<typeof OrigWorker>[1]);
    }
  }
  patch(m.worker_threads, 'Worker', () => GuardedWorker as unknown as Fn);

  // ESM named imports of builtins (`import { lookup } from 'node:dns'`)
  // only see the patched functions after a sync.
  m.module.syncBuiltinESMExports();

  return handle;
}

// ─── module API (main thread) ───────────────────────────────────────

const LOG_EVERY_MS = 60_000;
const MODULES: CoreModules = {
  net,
  dns,
  dgram,
  path,
  url,
  worker_threads: workerThreads,
  module: nodeModule,
  makeError: (host) => new EgressBlockedError(host),
};

/** Non-patching instance for the pure helpers. */
const helpers = guardCore({ entries: [], offline: false, logEveryMs: LOG_EVERY_MS }, MODULES, false);

let handle: CoreHandle | null = null;
let staticEntries: Entry[] = [];
const dynamicEntries = new Map<string, Entry[]>();

function sync(): void {
  const all = [...staticEntries];
  for (const list of dynamicEntries.values()) all.push(...list);
  (handle ?? helpers).setEntries(all);
}

/** Lowercase, strip brackets and a trailing dot. */
export function normalizeHost(host: string): string {
  return helpers.normalize(host);
}

export function isLoopbackHost(host: string): boolean {
  return helpers.isLoopback(host);
}

function toEntry(t: EgressTarget, source: string): Entry {
  const host = normalizeHost(t.host);
  if (!host) throw new Error('egress allowance needs a host');
  const port = t.port === undefined || t.port === null ? null : Number(t.port);
  if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error(`egress allowance has an invalid port: ${t.port}`);
  }
  return { host, port, source };
}

/**
 * Set (replace) the destinations `source` may reach, e.g.
 * `setEgressAllowance('ai.anthropic', [{ host: 'api.anthropic.com', port: 443 }])`.
 * An empty list removes the source. Ignored while CL_OFFLINE=on. Worker
 * threads keep the allowlist they started with.
 */
export function setEgressAllowance(source: string, targets: readonly EgressTarget[]): void {
  if (source === 'db' || source === 'env') throw new Error(`reserved egress source: ${source}`);
  if (targets.length === 0) dynamicEntries.delete(source);
  else dynamicEntries.set(source, targets.map((t) => toEntry(t, source)));
  sync();
}

export function clearEgressAllowance(source: string): void {
  dynamicEntries.delete(source);
  sync();
}

/** Current allowlist (static + dynamic), for diagnostics and tests. */
export function egressAllowlist(): Array<{ source: string; host: string; port: number | null }> {
  const out: Array<{ source: string; host: string; port: number | null }> = [];
  for (const e of staticEntries) out.push({ source: 'static', host: e.host, port: e.port });
  for (const [source, list] of dynamicEntries) for (const e of list) out.push({ source, host: e.host, port: e.port });
  return out;
}

/** Whether a connection to host[:port] is allowed. Port null = DNS-only check. */
export function isEgressAllowed(host: string, port: number | null = null): boolean {
  return (handle ?? helpers).isAllowed(host, port);
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
    if (u.hostname) out.push(toEntry({ host: u.hostname, port: u.port ? Number(u.port) : 5432 }, 'db'));
    // `?host=` may name a socket directory (IPC, always allowed) or a host.
    const qh = u.searchParams.get('host');
    if (qh && !qh.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(qh)) {
      out.push(toEntry({ host: qh, port: u.port ? Number(u.port) : 5432 }, 'db'));
    }
    return out;
  } catch {
    return [];
  }
}

export interface EgressGuardOptions {
  databaseUrl?: string;
  /** CL_EGRESS_ALLOW. */
  allow?: string;
  /** CL_OFFLINE=on: allow only loopback, IPC and the database. */
  offline?: boolean;
}

/**
 * Install the guard (idempotent for the allowlist; the patches are applied
 * once). Throws DesktopConfigError when CL_EGRESS_ALLOW cannot be parsed,
 * and Error when the critical patches could not be applied.
 */
export function installEgressGuard(opts: EgressGuardOptions = {}): void {
  const fromEnv = parseAllowList(opts.allow).map((t) => toEntry(t, 'env'));
  staticEntries = [...databaseEntries(opts.databaseUrl), ...fromEnv];
  if (!handle) {
    handle = guardCore({ entries: [], offline: opts.offline === true, logEveryMs: LOG_EVERY_MS }, MODULES, true);
  }
  sync();
}

export function isEgressGuardInstalled(): boolean {
  return handle !== null;
}

/** The worker-thread prelude (for tests and diagnostics). */
export function egressWorkerPrelude(): string {
  return (handle ?? helpers).workerPrelude();
}

/** Test hook: restore every patched function and clear the allowlist. */
export function _uninstallEgressGuardForTests(): void {
  handle?.restore();
  handle = null;
  staticEntries = [];
  dynamicEntries.clear();
  sync();
}
