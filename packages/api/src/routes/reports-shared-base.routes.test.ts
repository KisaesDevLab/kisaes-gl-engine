// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.
//
// U-208: the /api/v1/reports base is shared by several routers, mounted in
// app.ts order. The GET-only customer-statement, sales-tax and inventory
// report routers sit ahead of the ask router and reportsRouter, and their
// router-level guard runs for every request passing through. It used
// requireResource('reports'), which maps a POST to an 'update' check; the
// 'reports' resource is read-only (capped at view), so every POST under
// /reports (ask, email) was 403 PERMISSION_DENIED, even for the owner.
// Route tests that mount one router alone never saw it, so these mount the
// routers together in app.ts order:
//   - a reports reader (owner, or a bookkeeper with reports view) reaches
//     POST /reports/ask and POST /reports/email's own handlers;
//   - each of the three routers still refuses its GETs without reports read
//     and serves them with it.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ sent: [] as Array<Record<string, unknown>>, ai: vi.fn() }));
vi.mock('nodemailer', () => ({
  default: {
    createTransport: () => ({
      verify: async () => true,
      sendMail: async (mail: Record<string, unknown>) => { mocks.sent.push(mail); return { messageId: 'm-' + mocks.sent.length }; },
    }),
  },
}));
vi.mock('../services/ai-providers/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/ai-providers/index.js')>()),
  executeWithFallback: (...a: unknown[]) => mocks.ai(...a),
}));

// First: it wraps only the route layers created after it loads.
import 'express-async-errors';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Router } from 'express';
import { db } from '../db/index.js';
import { eq } from 'drizzle-orm';
import { aiConfig, companies } from '../db/schema/index.js';
import { customerStatementReportsRouter } from './customer-statements.routes.js';
import { salesTaxReportsRouter } from './sales-tax.routes.js';
import { inventoryReportsRouter } from './inventory-reports.routes.js';
import { reportAskRouter } from './report-ask.routes.js';
import { reportsRouter } from './reports.routes.js';
import { Harness, type Co } from './receivables.test-support.js';

const h = new Harness();
let c: Co;

// The /api/v1/reports routers in app.ts mount order (reportPacksRouter, mounted
// first, guards each of its own routes and is left out).
const SHARED: Array<[string, Router]> = [
  ['customerStatementReportsRouter', customerStatementReportsRouter],
  ['salesTaxReportsRouter', salesTaxReportsRouter],
  ['inventoryReportsRouter', inventoryReportsRouter],
  ['reportAskRouter', reportAskRouter],
  ['reportsRouter', reportsRouter],
];

const ASK = {
  question: 'Profit and loss for last quarter',
  reports: [{ key: 'profit_and_loss', title: 'Profit and Loss', params: ['range', 'basis'] }],
  datePresets: ['last_quarter'],
  today: '2026-11-10',
};
const PDF = Buffer.from('%PDF-1.4\n% report\n').toString('base64');
const EMAIL = { to: ['owner@example.test'], subject: 'October P&L', body: 'Attached.', filename: 'pl.pdf', fileBase64: PDF };

// One GET each router owns, answered 200 for a reports reader on a new
// company (inventory turned on for the inventory report).
const OWN_GETS: Array<[string, Router, string]> = [
  ['customerStatementReportsRouter', customerStatementReportsRouter, '/api/v1/reports/customer-statements?asOf=2026-11-30'],
  ['salesTaxReportsRouter', salesTaxReportsRouter, '/api/v1/reports/sales-tax-liability?start_date=2026-01-01&end_date=2026-11-30'],
  ['inventoryReportsRouter', inventoryReportsRouter, '/api/v1/reports/inventory-stock-status'],
];

beforeEach(async () => {
  mocks.sent.length = 0;
  mocks.ai.mockReset();
  mocks.ai.mockRejectedValue(new Error('no provider call expected'));
  // AI off: the ask route refuses with its own consent error.
  await db.delete(aiConfig);
});

afterEach(async () => {
  await h.stop();
  await db.delete(aiConfig);
});

describe('POSTs under the shared /reports base (U-208)', () => {
  beforeEach(async () => {
    await h.start(SHARED.map(([, r]) => ['/api/v1/reports', r] as [string, Router]));
    c = await h.company();
  });

  it('mounts the routers in the order app.ts does', () => {
    const appTs = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app.ts'), 'utf8');
    const mounted = [...appTs.matchAll(/app\.use\('\/api\/v1\/reports',\s*(\w+)\)/g)].map((m) => m[1]);
    const names = SHARED.map(([n]) => n);
    expect(mounted.filter((n) => names.includes(n!))).toEqual(names);
  });

  it.each([['the owner'], ['a bookkeeper with reports view']])('%s reaches POST /reports/ask and POST /reports/email', async (who) => {
    const token = who === 'the owner' ? c.token : await h.staffToken(c, { reports: 'view' });

    const ask = await h.request('POST', '/api/v1/reports/ask', token, ASK);
    expect([ask.status, ask.json['error']?.code], JSON.stringify(ask.json)).toEqual([403, 'AI_CONSENT_REQUIRED']);
    expect(mocks.ai).not.toHaveBeenCalled();

    const email = await h.request('POST', '/api/v1/reports/email', token, EMAIL);
    expect([email.status, email.json['error']?.code], JSON.stringify(email.json)).toEqual([400, 'SMTP_NOT_CONFIGURED']);
    expect(mocks.sent).toHaveLength(0);
  });

  it('without reports read, POST /reports/ask and /reports/email stay 403 PERMISSION_DENIED', async () => {
    const bankingOnly = await h.staffToken(c, { banking: 'full' });
    for (const [p, body] of [['/api/v1/reports/ask', ASK], ['/api/v1/reports/email', EMAIL]] as const) {
      const r = await h.request('POST', p, bankingOnly, body);
      expect([r.status, r.json['error']?.code], p).toEqual([403, 'PERMISSION_DENIED']);
    }
    expect(mocks.ai).not.toHaveBeenCalled();
    expect(mocks.sent).toHaveLength(0);
  });
});

describe('the GET-only /reports routers keep their own permission (U-208)', () => {
  it.each(OWN_GETS)('%s: 403 PERMISSION_DENIED without reports read; 200 with reports view and for the owner', async (_name, router, url) => {
    await h.start([['/api/v1/reports', router]]);
    c = await h.company();
    await db.update(companies).set({ inventoryEnabled: true }).where(eq(companies.id, c.companyId));

    const bankingOnly = await h.staffToken(c, { banking: 'full' });
    const denied = await h.request('GET', url, bankingOnly);
    expect([denied.status, denied.json['error']?.code], url).toEqual([403, 'PERMISSION_DENIED']);

    const viewer = await h.staffToken(c, { reports: 'view' });
    for (const token of [viewer, c.token]) {
      const ok = await h.request('GET', url, token);
      expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    }
  });
});
