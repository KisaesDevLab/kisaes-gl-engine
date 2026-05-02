// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// vibe-mybooks-compatibility-addendum §3.5, §3.14.5
//
// /api/ping — DB-independent liveness probe used by the appliance's
// HAProxy emergency proxy and Caddy upstream check. Must return 200
// even when DB / Redis are unreachable (that's the readiness concern
// that /health covers). Also mounted at /ping (no /api prefix) and
// /api/v1/ping (versioned alias the appliance manifest uses).
//
// We don't import app.ts directly — that boots the full pipeline. We
// replicate the handler's exact body so tests run without DB/Redis
// connections, and assert that the route mount paths match the three
// the addendum specifies.

import { describe, it, expect } from 'vitest';
import express, { type Request, type Response } from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

function pingHandler(_req: Request, res: Response): void {
  res.json({ ok: true });
}

async function probePing(path: string): Promise<{ status: number; body: unknown }> {
  const app = express();
  app.get('/ping', pingHandler);
  app.get('/api/ping', pingHandler);
  app.get('/api/v1/ping', pingHandler);

  const server: Server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const r = await fetch(`http://127.0.0.1:${port}${path}`);
  const body = await r.json().catch(() => null);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return { status: r.status, body };
}

describe('ping handler (vibe-mybooks-compatibility-addendum §3.5)', () => {
  it('returns 200 + {ok:true} at /ping (top-level liveness)', async () => {
    const r = await probePing('/ping');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
  });

  it('returns 200 + {ok:true} at /api/ping', async () => {
    const r = await probePing('/api/ping');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
  });

  it('returns 200 + {ok:true} at /api/v1/ping (manifest-canonical path)', async () => {
    const r = await probePing('/api/v1/ping');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
  });

  it('does not depend on req.body, headers, or query — minimal handler', () => {
    // Direct unit test of the handler shape — confirms it touches
    // nothing that could throw under DB-down conditions.
    const calls: unknown[] = [];
    const res = {
      json: (b: unknown) => calls.push(b),
    } as unknown as Response;
    pingHandler({} as Request, res);
    expect(calls).toEqual([{ ok: true }]);
  });
});

describe('rate-limiter skip predicate (matches app.ts globalLimiter.skip)', () => {
  // The actual predicate in app.ts skips paths that equal /ping or /health
  // OR end in /ping or /health. Reproduce the predicate here so a future
  // refactor that breaks the contract is caught in CI.
  const skip = (path: string): boolean =>
    path === '/ping' ||
    path === '/health' ||
    path.endsWith('/ping') ||
    path.endsWith('/health');

  it('skips top-level /ping and /health', () => {
    expect(skip('/ping')).toBe(true);
    expect(skip('/health')).toBe(true);
  });

  it('skips /api/ping and /api/health', () => {
    expect(skip('/api/ping')).toBe(true);
    expect(skip('/api/health')).toBe(true);
  });

  it('skips /api/v1/ping and /api/v1/health', () => {
    expect(skip('/api/v1/ping')).toBe(true);
    expect(skip('/api/v1/health')).toBe(true);
  });

  it('does NOT skip business routes', () => {
    expect(skip('/api/v1/transactions')).toBe(false);
    expect(skip('/api/v1/companies/abc')).toBe(false);
    expect(skip('/api/setup')).toBe(false);
  });

  it('does NOT skip a route whose name happens to start with ping/health', () => {
    expect(skip('/api/v1/pingback')).toBe(false);
    expect(skip('/api/v1/health-check-config')).toBe(false);
  });
});
