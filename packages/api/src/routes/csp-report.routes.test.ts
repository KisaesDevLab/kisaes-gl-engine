// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// The CSP violation collector is unauthenticated (browsers post reports
// with no session), must never error on malformed/oversized input, and
// always answers 204.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import 'express-async-errors';
import express from 'express';
import rateLimit from 'express-rate-limit';
import http from 'http';
import type { AddressInfo } from 'net';

// Rebuild just the endpoint (same shape as app.ts) so the test doesn't boot
// the full pipeline (DB/Redis).
function buildApp() {
  const app = express();
  const limiter = rateLimit({ windowMs: 60_000, max: 60, standardHeaders: false, legacyHeaders: false });
  app.post('/api/v1/csp-report', limiter,
    express.text({ type: () => true, limit: '16kb' }),
    (req, res) => {
      try {
        const parsed = JSON.parse(typeof req.body === 'string' && req.body ? req.body : '{}');
        const body = parsed as Record<string, unknown> | Array<Record<string, unknown>>;
        const reports = Array.isArray(body) ? body : [body];
        for (const r of reports.slice(0, 10)) {
          const cr = (r?.['csp-report'] ?? r) as Record<string, unknown>;
          const directive = cr?.['violated-directive'] ?? cr?.['effectiveDirective'] ?? 'unknown';
          const blocked = cr?.['blocked-uri'] ?? cr?.['blockedURL'] ?? 'unknown';
          // eslint-disable-next-line no-console
          console.warn(`[csp-report] directive=${String(directive).slice(0, 80)} blocked=${String(blocked).slice(0, 200)}`);
        }
      } catch { /* ignore */ }
      res.status(204).end();
    });
  return app;
}

let server: http.Server; let port = 0;
beforeAll(async () => {
  const app = buildApp();
  await new Promise<void>((r) => { server = app.listen(0, () => { port = (server.address() as AddressInfo).port; r(); }); });
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

function post(body: string, contentType: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(body);
    const req = http.request({ hostname: '127.0.0.1', port, path: '/api/v1/csp-report', method: 'POST',
      headers: { 'Content-Type': contentType, 'Content-Length': String(data.length) } },
      (res) => { res.on('data', () => {}); res.on('end', () => resolve(res.statusCode ?? 0)); });
    req.on('error', reject); req.write(data); req.end();
  });
}

describe('POST /api/v1/csp-report', () => {
  it('logs a well-formed report and answers 204, no auth required', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const status = await post(JSON.stringify({ 'csp-report': { 'violated-directive': 'script-src', 'blocked-uri': 'https://evil.example/x.js' } }), 'application/csp-report');
    expect(status).toBe(204);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('blocked=https://evil.example/x.js'));
    warn.mockRestore();
  });
  it('204s on malformed JSON and on an empty body', async () => {
    expect(await post('{not json', 'application/csp-report')).toBe(204);
    expect(await post('', 'application/json')).toBe(204);
  });
});
