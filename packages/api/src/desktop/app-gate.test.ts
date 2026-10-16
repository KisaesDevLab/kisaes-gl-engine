// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Loads the REAL app.ts in desktop and in server mode and checks where the
// gate sits and what it does to the whole route table.

import { describe, it, expect, vi, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { Express } from 'express';

const TOKEN = 'appgate_' + 'y'.repeat(40);

interface Layer {
  name: string;
}

async function loadApp(mode: 'desktop' | 'server'): Promise<Express> {
  vi.resetModules();
  const profile = await import('./profile.js');
  if (mode === 'desktop') {
    profile.loadDesktopProfile({
      CL_MODE: 'desktop',
      CL_TOKEN: TOKEN,
      CL_BIND: '127.0.0.1:0',
      CL_DATA_DIR: path.join(os.tmpdir(), 'cl-app-gate-test'),
    });
  } else {
    profile.loadDesktopProfile({});
  }
  const { app } = await import('../app.js');
  return app;
}

async function withServer<T>(app: Express, fn: (port: number) => Promise<T>): Promise<T> {
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(port);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

function stackOf(app: Express): Layer[] {
  return (app as unknown as { _router: { stack: Layer[] } })._router.stack;
}

afterEach(async () => {
  const profile = await import('./profile.js');
  profile._resetDesktopProfileForTests();
});

describe('app.ts in desktop mode', () => {
  it('mounts the gate before every other middleware and route', async () => {
    const app = await loadApp('desktop');
    const stack = stackOf(app);
    // Express 4 always starts with its internal `query` + `expressInit`.
    expect(stack.slice(0, 2).map((l) => l.name)).toEqual(['query', 'expressInit']);
    expect(stack[2]!.name).toBe('clDesktopGate');
    expect(stack.filter((l) => l.name === 'clDesktopGate')).toHaveLength(1);
  }, 120_000);

  it('the global limiter does not throttle token-authenticated requests', async () => {
    const app = await loadApp('desktop');
    const { setDesktopBoundAddress } = await import('../middleware/desktop-gate.js');
    await withServer(app, async (port) => {
      setDesktopBoundAddress('127.0.0.1', port);
      const statuses = new Set<number>();
      // Global limit is 300/min/IP; go well past it.
      for (let i = 0; i < 350; i++) {
        const r = await fetch(`http://127.0.0.1:${port}/api/v1/no-such-route-${i}`, {
          headers: { 'x-cl-token': TOKEN },
        });
        statuses.add(r.status);
        await r.arrayBuffer();
      }
      expect([...statuses]).toEqual([404]);
    });
  }, 120_000);
});

describe('app.ts desktop feature profile', () => {
  it('every left-out family answers 404 NOT_AVAILABLE_IN_DESKTOP; setup status stays', async () => {
    const app = await loadApp('desktop');
    const { setDesktopBoundAddress } = await import('../middleware/desktop-gate.js');
    const { DESKTOP_UNMOUNTED } = await import('./features.js');
    await withServer(app, async (port) => {
      setDesktopBoundAddress('127.0.0.1', port);
      const get = (p: string, method = 'GET') =>
        fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { 'x-cl-token': TOKEN } });
      for (const f of DESKTOP_UNMOUNTED) {
        for (const p of [f.prefix, `${f.prefix}/anything/below`]) {
          for (const method of ['GET', 'POST']) {
            const r = await get(p, method);
            const body = (await r.json()) as { error?: { code?: string } };
            expect(r.status, `${method} ${p}`).toBe(404);
            expect(body.error?.code, `${method} ${p}`).toBe('NOT_AVAILABLE_IN_DESKTOP');
          }
        }
      }
      // The one setup route the desktop app may use is still routed.
      const status = await get('/api/setup/status');
      const statusBody = (await status.json()) as { error?: { code?: string } };
      expect(statusBody.error?.code).not.toBe('NOT_AVAILABLE_IN_DESKTOP');
      // Non-API paths: JSON 404, never the SPA or HTML.
      const other = await get('/index.html');
      expect(other.status).toBe(404);
      expect(other.headers.get('content-type')).toMatch(/application\/json/);
      // Core bookkeeping routes are still mounted (401 = reached auth, not 404).
      expect((await get('/api/v1/accounts')).status).toBe(401);
    });
  }, 120_000);
});

/** Every mount path and route path at the app level (global middleware excluded). */
function mountPaths(app: Express): string[] {
  const out = new Set<string>();
  const stack = (app as unknown as { _router: { stack: Array<Layer & { route?: { path: string }; regexp: RegExp & { fast_slash?: boolean } }> } })._router.stack;
  for (const l of stack) {
    if (l.route) {
      out.add(l.route.path);
      continue;
    }
    if (l.regexp.fast_slash) continue;
    // Express 4 mount regexp source: ^\/api\/v1\/accounts\/?(?=\/|$)
    const suffix = '\\/?(?=\\/|$)';
    const src = l.regexp.source;
    if (!src.startsWith('^') || !src.endsWith(suffix)) throw new Error(`unparsed mount ${src}`);
    out.add(src.slice(1, -suffix.length).split('\\/').join('/'));
  }
  return [...out];
}

describe('every mount is classified for desktop mode', () => {
  it('each app-level mount is in DESKTOP_KEPT or DESKTOP_UNMOUNTED (both modes), and DESKTOP_KEPT has no stale entries', async () => {
    const seen = new Set<string>();
    for (const mode of ['server', 'desktop'] as const) {
      const app = await loadApp(mode);
      const { DESKTOP_KEPT, familyOf } = await import('./features.js');
      const paths = mountPaths(app);
      expect(paths.length, mode).toBeGreaterThan(50);
      const unclassified = paths.filter((p) => !DESKTOP_KEPT.includes(p) && !familyOf(p));
      // A new route family? Add it to DESKTOP_KEPT after reviewing it for
      // desktop mode, or to DESKTOP_UNMOUNTED (desktop/features.ts).
      expect(unclassified, mode).toEqual([]);
      for (const p of paths) seen.add(p);
      (await import('./profile.js'))._resetDesktopProfileForTests();
    }
    const { DESKTOP_KEPT, familyOf } = await import('./features.js');
    expect(DESKTOP_KEPT.filter((p) => !seen.has(p)), 'stale DESKTOP_KEPT entries').toEqual([]);
    expect(DESKTOP_KEPT.filter((p) => familyOf(p)), 'kept and unmounted at once').toEqual([]);
    expect(new Set(DESKTOP_KEPT).size).toBe(DESKTOP_KEPT.length);
  }, 240_000);

  it('the online / appliance-only admin routes are all under an unmounted family', async () => {
    await loadApp('desktop');
    const { familyOf } = await import('./features.js');
    const { adminRouter } = await import('../routes/admin.routes.js');
    const routes = (adminRouter as unknown as { stack: Array<{ route?: { path: string } }> }).stack
      .filter((l) => l.route)
      .map((l) => `/api/v1/admin${l.route!.path}`);
    const online = /^\/api\/v1\/admin\/(plaid\/|backup\/remote-|storage\/system-|updates\/check|tunnel-config|cloudflared\/|mcp\/|tfa\/sms-test|create-client|security\/)/;
    const listed = routes.filter((p) => online.test(p));
    expect(listed.length).toBeGreaterThan(30);
    expect(listed.filter((p) => !familyOf(p))).toEqual([]);
  }, 120_000);
});

describe('app.ts in server mode (CL_MODE unset)', () => {
  it('mounts every family the desktop edition leaves out', async () => {
    const app = await loadApp('server');
    const { DESKTOP_UNMOUNTED } = await import('./features.js');
    await withServer(app, async (port) => {
      for (const f of DESKTOP_UNMOUNTED) {
        const r = await fetch(`http://127.0.0.1:${port}${f.prefix}/anything/below`, { method: 'POST' });
        const text = await r.text();
        expect(text, f.prefix).not.toContain('NOT_AVAILABLE_IN_DESKTOP');
      }
    });
  }, 120_000);

  it('does not mount the gate and needs no X-CL-Token', async () => {
    const app = await loadApp('server');
    expect(stackOf(app).some((l) => l.name === 'clDesktopGate')).toBe(false);
    await withServer(app, async (port) => {
      const r = await fetch(`http://127.0.0.1:${port}/api/v1/ping`);
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ ok: true });
      // Control for the desktop limiter test above: the server path still
      // enforces the global 300/min ceiling.
      const statuses = new Set<number>();
      for (let i = 0; i < 310; i++) {
        const x = await fetch(`http://127.0.0.1:${port}/api/v1/no-such-route-${i}`);
        statuses.add(x.status);
        await x.arrayBuffer();
      }
      expect(statuses.has(429)).toBe(true);
    });
  }, 120_000);

  it('anonymous /health keeps the exact v1 body (no version, commit, schema or role)', async () => {
    const app = await loadApp('server');
    await withServer(app, async (port) => {
      for (const p of ['/health', '/api/health', '/api/v1/health']) {
        const r = await fetch(`http://127.0.0.1:${port}${p}`);
        const body = (await r.json()) as Record<string, unknown> & { checks: { db: Record<string, unknown> } };
        expect(Object.keys(body), p).toEqual(['status', 'db', 'redis', 'queue', 'workers', 'timestamp', 'checks']);
        expect(Object.keys(body.checks.db).sort(), p).toEqual(['latencyMs', 'ok']);
      }
    });
  }, 120_000);

  it('has no desktop-only routes', async () => {
    const app = await loadApp('server');
    await withServer(app, async (port) => {
      const info = await fetch(`http://127.0.0.1:${port}/api/v1/desktop/info`);
      expect(info.status).toBe(404);
      expect(((await info.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
    });
  }, 120_000);
});
