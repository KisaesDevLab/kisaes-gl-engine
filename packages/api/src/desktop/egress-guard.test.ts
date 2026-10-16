// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// desktop/egress-guard.ts: default-deny outbound connections. Every test
// installs the guard and the afterEach restores the patched builtins, since
// the suite runs all files in one process. Blocked destinations are never
// contacted (that is the point), so the file needs no internet; allowed
// destinations are loopback test servers.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import dns from 'node:dns';
import dgram from 'node:dgram';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import {
  EgressBlockedError,
  _uninstallEgressGuardForTests,
  clearEgressAllowance,
  egressAllowlist,
  egressWorkerPrelude,
  installEgressGuard,
  isEgressAllowed,
  isEgressGuardInstalled,
  isLoopbackHost,
  parseAllowList,
  setEgressAllowance,
} from './egress-guard.js';
import { DesktopConfigError } from './profile.js';

const ORIGINAL_CONNECT = net.Socket.prototype.connect;
const ORIGINAL_WORKER = Worker;
const ORIGINAL_LOOKUP = dns.lookup;

let lookupSpy: unknown;

function install(allow?: string) {
  installEgressGuard({ databaseUrl: 'postgresql://u:p@db.internal:5544/books', allow });
}

beforeEach(() => {
  // Spy BEFORE install so the guard wraps the spy: a call that reaches the
  // spy is a lookup that would have gone to the resolver.
  lookupSpy = vi.spyOn(dns, 'lookup');
});

afterEach(() => {
  _uninstallEgressGuardForTests();
  vi.restoreAllMocks();
});

function socketError(s: net.Socket): Promise<NodeJS.ErrnoException> {
  return new Promise((resolve, reject) => {
    s.once('error', resolve);
    s.once('connect', () => {
      s.destroy();
      reject(new Error('connected, expected EGRESS_BLOCKED'));
    });
  });
}

async function server(): Promise<{ port: number; close: () => Promise<void> }> {
  const srv = http.createServer((_req, res) => res.end('ok'));
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  return {
    port: (srv.address() as AddressInfo).port,
    close: () => new Promise<void>((r) => { srv.closeAllConnections(); srv.close(() => r()); }),
  };
}

// Resolves every name to loopback without DNS, in both lookup styles net uses.
const fakeLookup = ((_h: string, opts: unknown, cb: (...a: unknown[]) => void) => {
  if (opts && typeof opts === 'object' && (opts as { all?: boolean }).all) cb(null, [{ address: '127.0.0.1', family: 4 }]);
  else cb(null, '127.0.0.1', 4);
}) as unknown as net.LookupFunction;

describe('blocked destinations (no allowance)', () => {
  it('net.connect to a hostname: EGRESS_BLOCKED, no DNS lookup', async () => {
    install();
    const err = await socketError(net.connect(443, 'example.com'));
    expect(err).toBeInstanceOf(EgressBlockedError);
    expect(err.code).toBe('EGRESS_BLOCKED');
    expect(lookupSpy).not.toHaveBeenCalled();
  });

  it('tls.connect: EGRESS_BLOCKED', async () => {
    install();
    const err = await socketError(tls.connect({ host: 'example.com', port: 443, servername: 'example.com' }));
    expect(err.code).toBe('EGRESS_BLOCKED');
    expect(lookupSpy).not.toHaveBeenCalled();
  });

  it('http.get: request error EGRESS_BLOCKED', async () => {
    install();
    const err = await new Promise<NodeJS.ErrnoException>((resolve) => {
      http.get('http://example.com/', () => resolve(new Error('unexpected response'))).on('error', resolve);
    });
    expect(err.code).toBe('EGRESS_BLOCKED');
    expect(lookupSpy).not.toHaveBeenCalled();
  });

  it('global fetch (undici): rejects with EGRESS_BLOCKED as the cause', async () => {
    install();
    const err = await fetch('https://api.github.com/repos/x/y/releases/latest').then(
      () => null,
      (e: unknown) => e as { cause?: { code?: string } },
    );
    expect(err?.cause?.code).toBe('EGRESS_BLOCKED');
    expect(lookupSpy).not.toHaveBeenCalled();
  });

  it('IP literals that are not loopback, and odd numeric forms, are blocked', async () => {
    install();
    for (const host of ['93.184.215.14', '10.0.0.5', '2130706433', '0x7f.1', '2606:2800:21f:cb07:6820:80da:af6b:8b2c']) {
      const err = await socketError(net.connect({ host, port: 443 }));
      expect(err.code, host).toBe('EGRESS_BLOCKED');
    }
  });

  it('string ports in any form Node accepts (hex, decimal with .0, padded) are ports, not pipe paths', async () => {
    install();
    const s = await server();
    try {
      // 192.0.2.1 (TEST-NET-1) would never answer; the guard must refuse before
      // trying. A pipe-path misread would instead give ENOENT or EACCES.
      for (const port of ['0x' + s.port.toString(16), `${s.port}.0`, ` ${s.port} `, `${s.port}e0`]) {
        const err = await socketError(new net.Socket().connect(port as unknown as number, '192.0.2.1'));
        expect(err.code, port).toBe('EGRESS_BLOCKED');
      }
      // Control: the same forms against loopback really are ports.
      const ok = new net.Socket().connect(('0x' + s.port.toString(16)) as unknown as number, '127.0.0.1');
      await new Promise<void>((res, rej) => { ok.once('connect', () => res()); ok.once('error', rej); });
      ok.destroy();
    } finally {
      await s.close();
    }
  });

  it('a non-string host option is blocked, not read as localhost', async () => {
    install();
    for (const host of [{ toString: () => '192.0.2.1' }, 3232235521, ['192.0.2.1']]) {
      const sock = new net.Socket();
      const err = await new Promise<NodeJS.ErrnoException>((resolve) => {
        sock.once('error', resolve);
        try {
          sock.connect({ host: host as unknown as string, port: 80 });
        } catch (e) {
          resolve(e as NodeJS.ErrnoException);
        }
      });
      expect(err.code, String(host)).toBe('EGRESS_BLOCKED');
    }
  });

  it('dns.lookup / dns.promises.lookup / dns/promises named import: blocked, never resolved', async () => {
    install();
    const cbErr = await new Promise<NodeJS.ErrnoException | null>((r) => dns.lookup('example.com', (e) => r(e)));
    expect(cbErr?.code).toBe('EGRESS_BLOCKED');
    await expect(dns.promises.lookup('example.com')).rejects.toMatchObject({ code: 'EGRESS_BLOCKED' });
    const ns = await import('node:dns/promises');
    await expect(ns.lookup('example.com')).rejects.toMatchObject({ code: 'EGRESS_BLOCKED' });
    const named = await import('node:dns');
    const viaNamed = await new Promise<NodeJS.ErrnoException | null>((r) => named.lookup('example.com', (e) => r(e)));
    expect(viaNamed?.code).toBe('EGRESS_BLOCKED');
    expect(lookupSpy).not.toHaveBeenCalled();
  });

  it('dns.lookup of an IP literal answers locally (server listen on 0.0.0.0 needs it)', async () => {
    install();
    const r = await dns.promises.lookup('0.0.0.0');
    expect(r).toEqual({ address: '0.0.0.0', family: 4 });
    const srv = net.createServer();
    await new Promise<void>((res, rej) => { srv.once('error', rej); srv.listen(0, '0.0.0.0', () => res()); });
    await new Promise<void>((res) => srv.close(() => res()));
    // ...while a connection to a non-loopback literal stays blocked.
    const err = await socketError(net.connect(443, '0.0.0.0'));
    expect(err.code).toBe('EGRESS_BLOCKED');
  });

  it('dns.resolve*, Resolver and reverse: blocked (no query sent)', async () => {
    install();
    const viaCb = await new Promise<NodeJS.ErrnoException | null>((r) => dns.resolve4('example.com', (e) => r(e)));
    expect(viaCb?.code).toBe('EGRESS_BLOCKED');
    const viaResolve = await new Promise<NodeJS.ErrnoException | null>((r) => dns.resolve('example.com', 'TXT', (e) => r(e)));
    expect(viaResolve?.code).toBe('EGRESS_BLOCKED');
    await expect(dns.promises.resolveTxt('example.com')).rejects.toMatchObject({ code: 'EGRESS_BLOCKED' });
    const resolver = new dns.Resolver();
    const viaResolver = await new Promise<NodeJS.ErrnoException | null>((r) => resolver.resolveMx('example.com', (e) => r(e)));
    expect(viaResolver?.code).toBe('EGRESS_BLOCKED');
    await expect(new dns.promises.Resolver().resolve6('example.com')).rejects.toMatchObject({ code: 'EGRESS_BLOCKED' });
    await expect(dns.promises.reverse('8.8.8.8')).rejects.toMatchObject({ code: 'EGRESS_BLOCKED' });
  });

  it('UDP send to a non-loopback address is blocked', async () => {
    install();
    const sock = dgram.createSocket('udp4');
    try {
      const err = await new Promise<Error | null>((r) => sock.send(Buffer.from('x'), 53, '192.0.2.1', (e) => r(e)));
      expect((err as NodeJS.ErrnoException | null)?.code).toBe('EGRESS_BLOCKED');
    } finally {
      sock.close();
    }
  });

  it('logs the host only, once per minute per host', async () => {
    install();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await socketError(net.connect(8443, 'blocked.example'));
    await socketError(net.connect(8443, 'blocked.example'));
    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('egress-guard'));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({ level: 'warn', component: 'egress-guard', event: 'blocked', host: 'blocked.example' });
    expect(lines[0]).not.toContain('8443');
  });
});

describe('allowed destinations', () => {
  it('loopback by address and by name, including fetch through the undici pool', async () => {
    install();
    const s = await server();
    try {
      for (const host of ['127.0.0.1', 'localhost']) {
        const sock = net.connect(s.port, host);
        await new Promise<void>((res, rej) => { sock.once('connect', () => res()); sock.once('error', rej); });
        sock.destroy();
      }
      const r = await fetch(`http://127.0.0.1:${s.port}/`);
      expect(await r.text()).toBe('ok');
    } finally {
      await s.close();
    }
    expect(isLoopbackHost('127.8.9.10')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('0:0:0:0:0:0:0:1')).toBe(true);
    expect(isLoopbackHost('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('LOCALHOST.')).toBe(true);
    expect(isLoopbackHost('128.0.0.1')).toBe(false);
    expect(isLoopbackHost('localhost.example.com')).toBe(false);
  });

  it('IPC paths (Unix sockets / named pipes) are not network egress', () => {
    install();
    expect(isEgressAllowed('', null)).toBe(true);
    // connectTarget is internal; a pipe path never reaches the host check.
    const path = process.platform === 'win32' ? '\\\\.\\pipe\\cl-egress-test-none' : '/tmp/cl-egress-test-none.sock';
    const s = net.connect({ path });
    return new Promise<void>((resolve) => {
      s.once('error', (e: NodeJS.ErrnoException) => {
        expect(e.code).not.toBe('EGRESS_BLOCKED');
        resolve();
      });
    });
  });

  it('the DATABASE_URL host is allowed on its port only; its name may be resolved', () => {
    install();
    expect(isEgressAllowed('db.internal', 5544)).toBe(true);
    expect(isEgressAllowed('DB.Internal.', 5544)).toBe(true);
    expect(isEgressAllowed('db.internal', 22)).toBe(false);
    expect(isEgressAllowed('db.internal', null)).toBe(true);
  });

  it('the real pg driver connects to the test database through the guard', async () => {
    installEgressGuard({ databaseUrl: process.env['DATABASE_URL'] });
    const client = new pg.Client({ connectionString: process.env['DATABASE_URL'] });
    await client.connect();
    try {
      const r = await client.query('SELECT 1 AS one');
      expect(r.rows[0]).toEqual({ one: 1 });
    } finally {
      await client.end();
    }
  });

  it('CL_EGRESS_ALLOW entries (host, host:port, [v6]:port)', () => {
    install('ollama.lan:11434, smtp.example.org ,[fd00::5]:8080');
    expect(isEgressAllowed('ollama.lan', 11434)).toBe(true);
    expect(isEgressAllowed('ollama.lan', 80)).toBe(false);
    expect(isEgressAllowed('smtp.example.org', 587)).toBe(true);
    expect(isEgressAllowed('fd00:0:0:0:0:0:0:5', 8080)).toBe(true);
    expect(isEgressAllowed('fd00::6', 8080)).toBe(false);
  });

  it('an invalid CL_EGRESS_ALLOW is a desktop configuration error', () => {
    expect(() => parseAllowList('good.example, bad host')).toThrow(DesktopConfigError);
    expect(() => parseAllowList('x.example:70000')).toThrow(DesktopConfigError);
    expect(parseAllowList(undefined)).toEqual([]);
  });

  it('runtime allowance: blocked before, allowed after, blocked again when cleared', async () => {
    install();
    const s = await server();
    try {
      // agent:false: a fresh socket per request. A revoked allowance governs
      // NEW connections; an already-open keep-alive socket is not cut.
      const get = () =>
        new Promise<{ code?: string; body?: string }>((resolve) => {
          http
            .get({ host: 'ai.provider.test', port: s.port, path: '/', lookup: fakeLookup, agent: false }, (res) => {
              let body = '';
              res.on('data', (c) => (body += c));
              res.on('end', () => resolve({ body }));
            })
            .on('error', (e: NodeJS.ErrnoException) => resolve({ code: e.code }));
        });

      expect(await get()).toEqual({ code: 'EGRESS_BLOCKED' });

      setEgressAllowance('ai.test', [{ host: 'ai.provider.test', port: s.port }]);
      expect(egressAllowlist()).toContainEqual({ source: 'ai.test', host: 'ai.provider.test', port: s.port });
      expect(await get()).toEqual({ body: 'ok' });

      // Port-scoped: another port on the same host stays blocked.
      expect(isEgressAllowed('ai.provider.test', s.port + 1)).toBe(false);

      clearEgressAllowance('ai.test');
      expect(await get()).toEqual({ code: 'EGRESS_BLOCKED' });

      setEgressAllowance('ai.test', [{ host: 'ai.provider.test' }]);
      expect(isEgressAllowed('ai.provider.test', 1234)).toBe(true);
      setEgressAllowance('ai.test', []);
      expect(isEgressAllowed('ai.provider.test', 1234)).toBe(false);
    } finally {
      await s.close();
    }
  });
});

// A non-loopback IPv4 address of this machine: a server bound to 0.0.0.0
// answers on it, so a connect that is not blocked really succeeds, while
// nothing leaves the machine.
function lanAddress(): string | null {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
}

async function anyInterfaceServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const srv = net.createServer((s) => { s.on('error', () => undefined); s.end(); });
  await new Promise<void>((r) => srv.listen(0, '0.0.0.0', r));
  return { port: (srv.address() as AddressInfo).port, close: () => new Promise<void>((r) => srv.close(() => r())) };
}

const CONNECT_CODE = `
const { parentPort, workerData } = require('node:worker_threads');
const net = require('node:net');
const opts = { host: workerData.host, port: workerData.port };
if (workerData.fakeLookup) opts.lookup = (h, o, cb) => (o && o.all ? cb(null, [{ address: '127.0.0.1', family: 4 }]) : cb(null, '127.0.0.1', 4));
const s = net.connect(opts);
s.on('connect', () => { parentPort.postMessage('CONNECTED'); s.destroy(); });
s.on('error', (e) => parentPort.postMessage(e.code || 'ERROR'));
`;

function runWorker(make: () => Worker): Promise<string> {
  return new Promise((resolve, reject) => {
    const w = make();
    w.once('message', (msg) => { resolve(String(msg)); void w.terminate(); });
    w.once('error', reject);
    w.once('exit', (code) => resolve(`exit ${code}`));
  });
}

const lan = lanAddress();

describe('worker threads', () => {
  it.skipIf(!lan)('control: without the guard a worker reaches the LAN address', async () => {
    const s = await anyInterfaceServer();
    try {
      const r = await runWorker(() => new Worker(CONNECT_CODE, { eval: true, workerData: { host: lan, port: s.port } }));
      expect(r).toBe('CONNECTED');
    } finally {
      await s.close();
    }
  });

  it.skipIf(!lan)('an eval worker cannot connect to the LAN address', async () => {
    const s = await anyInterfaceServer();
    try {
      install();
      const r = await runWorker(() => new Worker(CONNECT_CODE, { eval: true, workerData: { host: lan, port: s.port } }));
      expect(r).toBe('EGRESS_BLOCKED');
    } finally {
      await s.close();
    }
  });

  it('a file worker (CommonJS and .mjs) runs its own code under the guard', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-egress-worker-'));
    const cjs = path.join(dir, 'w.cjs');
    const mjs = path.join(dir, 'w.mjs');
    fs.writeFileSync(cjs, CONNECT_CODE);
    fs.writeFileSync(mjs, `import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);\n${CONNECT_CODE}`);
    const s = await server();
    try {
      install();
      for (const file of [cjs, mjs]) {
        expect(await runWorker(() => new Worker(file, { workerData: { host: '192.0.2.1', port: 80 } })), file).toBe('EGRESS_BLOCKED');
        // Loopback still works, so the worker's own code ran normally.
        expect(await runWorker(() => new Worker(file, { workerData: { host: '127.0.0.1', port: s.port } })), file).toBe('CONNECTED');
      }
      // A file: URL works the same way.
      expect(await runWorker(() => new Worker(pathToFileURL(cjs), { workerData: { host: '192.0.2.1', port: 80 } }))).toBe('EGRESS_BLOCKED');
    } finally {
      await s.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('DNS inside a worker is guarded too', async () => {
    install();
    const r = await runWorker(() => new Worker(
      "require('node:dns').lookup('example.com', (e) => require('node:worker_threads').parentPort.postMessage(e ? e.code : 'RESOLVED'));",
      { eval: true },
    ));
    expect(r).toBe('EGRESS_BLOCKED');
    expect(lookupSpy).not.toHaveBeenCalled();
  });

  it('a worker started by a worker is guarded as well', async () => {
    install();
    const nested = `
      const { Worker, parentPort } = require('node:worker_threads');
      const inner = new Worker(${JSON.stringify(CONNECT_CODE)}, { eval: true, workerData: { host: '192.0.2.1', port: 80 } });
      inner.on('message', (m) => parentPort.postMessage(m));
    `;
    expect(await runWorker(() => new Worker(nested, { eval: true }))).toBe('EGRESS_BLOCKED');
  });

  it('a worker gets the allowlist as it was when it started', async () => {
    install();
    const s = await server();
    try {
      setEgressAllowance('ai.test', [{ host: 'ai.provider.test', port: s.port }]);
      const data = { host: 'ai.provider.test', port: s.port, fakeLookup: true };
      expect(await runWorker(() => new Worker(CONNECT_CODE, { eval: true, workerData: data }))).toBe('CONNECTED');
      clearEgressAllowance('ai.test');
      expect(await runWorker(() => new Worker(CONNECT_CODE, { eval: true, workerData: data }))).toBe('EGRESS_BLOCKED');
    } finally {
      await s.close();
    }
  });

  it('URL schemes other than file: are refused', () => {
    install();
    expect(() => new Worker(new URL('data:text/javascript,1'))).toThrow(EgressBlockedError);
  });

  it('the prelude is self-contained JavaScript', () => {
    install();
    // Compiles as a script without the engine's modules in scope.
    expect(() => new Function('require', egressWorkerPrelude())).not.toThrow();
  });
});

describe('install / uninstall', () => {
  it('refuses to install when a critical patch cannot be applied, and leaves nothing patched', () => {
    const desc = Object.getOwnPropertyDescriptor(dns, 'lookup')!;
    Object.defineProperty(dns, 'lookup', { ...desc, writable: false });
    try {
      expect(() => install()).toThrow(/could not patch/);
      expect(isEgressGuardInstalled()).toBe(false);
      expect(net.Socket.prototype.connect).toBe(ORIGINAL_CONNECT);
    } finally {
      Object.defineProperty(dns, 'lookup', desc);
    }
  });

  it('is idempotent and the test hook restores the builtins', async () => {
    install();
    install();
    expect(isEgressGuardInstalled()).toBe(true);
    expect(net.Socket.prototype.connect).not.toBe(ORIGINAL_CONNECT);
    _uninstallEgressGuardForTests();
    expect(isEgressGuardInstalled()).toBe(false);
    expect(net.Socket.prototype.connect).toBe(ORIGINAL_CONNECT);
    expect((await import('node:worker_threads')).Worker).toBe(ORIGINAL_WORKER);
    vi.restoreAllMocks();
    expect(dns.lookup).toBe(ORIGINAL_LOOKUP);
  });
});
