// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// Report areas (U-227, report-areas-v1), against the REAL app:
//   - router walk: every route behind a `reports` read guard, and every
//     route under /api/v1/reports and /api/v2/reports, has an explicit area
//     (the fail-closed fallback must not be what covers a mounted route)
//   - an A/P-template bookkeeper is refused A/R reports, the P&L, packs,
//     Ask, a ledger Builder section and emailing the P&L, and can run A/P
//     aging and save a bill; an A/R-template bookkeeper can save an
//     invoice and a sales receipt
//   - a template without financial_reports inherits reports; owner and
//     readonly are unchanged

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('express-rate-limit', async (orig) => {
  const real = await orig<typeof import('express-rate-limit')>();
  const pass = () => (_req: unknown, _res: unknown, next: () => void) => next();
  return { ...real, default: pass, rateLimit: pass };
});
import type { Express } from 'express';
import { eq } from 'drizzle-orm';
import { BUILDER_STARTERS, type PermissionMap } from '@kis-books/shared';
import { db } from '../db/index.js';
import { contacts, userPermissions } from '../db/schema/index.js';
import * as ledger from '../services/ledger.service.js';
import { REPORT_AREAS, areaForReportKey, hasExplicitArea, reportAreaFor } from '../services/report-areas.js';
import { startSensitiveHarness, type SensitiveHarness } from './sensitive.test-fixtures.js';

// The plan's built-in templates (P29 plan §1), every key listed.
const AP: PermissionMap = {
  transactions: 'none', recurring: 'full', contacts: 'full', attachments: 'full',
  batch_entry: 'none', duplicates: 'none', bulk_import: 'none', banking: 'none', checks: 'full', payroll_import: 'none', budgets: 'none', tags: 'view',
  invoices: 'none', receive_payment: 'none', estimates: 'none', sales_tax: 'none', daily_sales: 'none',
  bills: 'full', pay_bills: 'full', vendor_credits: 'full',
  items: 'view', accounts: 'view',
  company_settings: 'view', reports: 'view', financial_reports: 'none', dashboard: 'view',
  audit_log: 'none', trial_balance: 'none', tax_estimator: 'none', ai_chat: 'none',
};
const AR: PermissionMap = {
  transactions: 'full', recurring: 'full', contacts: 'full', attachments: 'full',
  batch_entry: 'none', duplicates: 'none', bulk_import: 'none', banking: 'none', checks: 'none', payroll_import: 'none', budgets: 'none', tags: 'view',
  invoices: 'full', receive_payment: 'full', estimates: 'full', sales_tax: 'full', daily_sales: 'full',
  bills: 'none', pay_bills: 'none', vendor_credits: 'none',
  items: 'view', accounts: 'view',
  company_settings: 'view', reports: 'view', financial_reports: 'none', dashboard: 'view',
  audit_log: 'none', trial_balance: 'none', tax_estimator: 'none', ai_chat: 'none',
};

let h: SensitiveHarness;
let vendor = '';
let customer = '';

async function giveBk(overrides: PermissionMap) {
  await db.delete(userPermissions).where(eq(userPermissions.userId, h.bookkeeperId));
  await db.insert(userPermissions).values({ tenantId: h.tenantId, userId: h.bookkeeperId, overrides: overrides as never });
}

const RANGE = 'start_date=2026-01-01&end_date=2026-12-31';
const glStarter = () => {
  const s = BUILDER_STARTERS.find((x) => (x.definition as { nodes: Array<{ type: string; source?: string }> }).nodes
    .some((n) => n.type === 'section' && n.source === 'gl'));
  if (!s) throw new Error('no gl starter');
  return JSON.parse(JSON.stringify(s.definition));
};

beforeAll(async () => {
  h = await startSensitiveHarness('report-areas');
  const [v] = await db.insert(contacts).values({ tenantId: h.tenantId, contactType: 'vendor', displayName: 'Area Vendor' }).returning();
  const [c] = await db.insert(contacts).values({ tenantId: h.tenantId, contactType: 'customer', displayName: 'Area Customer' }).returning();
  vendor = v!.id;
  customer = c!.id;
  await ledger.postTransaction(h.tenantId, {
    txnType: 'deposit' as never, txnDate: '2026-03-01', memo: 'sale',
    lines: [{ accountId: h.acct.bank, debit: '100.00', credit: '0' }, { accountId: h.acct.sales, debit: '0', credit: '100.00' }],
  }, h.ownerId, h.companyId);
}, 120_000);

afterAll(async () => { await h.close(); });

// ─── Router walk ────────────────────────────────────────────────

interface Route { method: string; path: string; needsReports: boolean }

function mountPath(layer: { regexp: RegExp & { fast_slash?: boolean }; keys?: unknown[] }): string | null {
  if (layer.regexp.fast_slash) return '';
  if (layer.keys && layer.keys.length > 0) return null;
  const m = /^\^(.*)\\\/\?\(\?=\\\/\|\$\)$/.exec(layer.regexp.source);
  if (!m) return null;
  const p = m[1]!.replace(/\\\//g, '/').replace(/\\\./g, '.').replace(/\\-/g, '-');
  return /[\\()[\]*+?^$]/.test(p) ? null : p;
}

const isReportsRead = (fn: unknown) => {
  const p = (fn as { permission?: { resource: string; action: string } } | null)?.permission;
  return !!p && p.resource === 'reports' && p.action === 'read';
};

/** Every route, flagged when a `reports` read guard runs before it (router level or on the route). */
function collect(stack: any[], prefix: string, inherited: boolean, out: Route[], unmounted: string[]): void {
  let flag = inherited;
  for (const layer of stack) {
    if (layer.route) {
      const own = (layer.route.stack as Array<{ handle: unknown }>).some((l) => isReportsRead(l.handle));
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      for (const p of paths) {
        if (typeof p !== 'string') continue;
        for (const m of Object.keys(layer.route.methods)) out.push({ method: m.toUpperCase(), path: prefix + p, needsReports: flag || own });
      }
    } else if (layer.handle?.stack && Array.isArray(layer.handle.stack)) {
      const mp = mountPath(layer);
      if (mp === null) { unmounted.push(String(layer.regexp)); continue; }
      collect(layer.handle.stack, prefix + mp, flag, out, unmounted);
    } else if (isReportsRead(layer.handle)) {
      flag = true;
    }
  }
}

// Report families outside the path table, by design: Builder runs check
// rights per section by data source (and saved definitions need reports
// only); the practice portal reports are unchanged.
const OUTSIDE_TABLE = ['/api/v1/report-builder', '/api/v1/practice/reports'];

describe('report areas: router walk', () => {
  it('every report route has an explicit area', async () => {
    const { app } = await import('../app.js');
    const routes: Route[] = [];
    const unmounted: string[] = [];
    collect(((app as Express & { _router: { stack: any[] } })._router).stack, '', false, routes, unmounted);
    const reportRoutes = routes.filter((r) => r.needsReports
      || r.path.toLowerCase().startsWith('/api/v1/reports/') || r.path.toLowerCase().startsWith('/api/v2/reports/'));
    expect(reportRoutes.length).toBeGreaterThan(60);
    const missing: string[] = [];
    for (const r of reportRoutes) {
      if (OUTSIDE_TABLE.some((p) => r.path === p || r.path.startsWith(`${p}/`))) continue;
      const area = reportAreaFor(r.method, r.path);
      const slug = r.path.toLowerCase().split('/').filter(Boolean)[3] ?? '';
      if (!area) { missing.push(`${r.method} ${r.path} (not a report path)`); continue; }
      if (slug === 'email') continue; // the area of body reportKey
      if (!hasExplicitArea(slug)) missing.push(`${r.method} ${r.path}`);
    }
    expect(missing).toEqual([]);
  });

  it('unknown slugs and report keys fall back to financial_reports; keys normalise', () => {
    expect(reportAreaFor('GET', '/api/v1/reports/some-new-report')).toBe('financial_reports');
    expect(reportAreaFor('GET', '/API/V1/Reports/AR-Aging-Summary/')).toBe('invoices');
    expect(reportAreaFor('GET', '/api/v1/reports')).toBe('financial_reports');
    expect(reportAreaFor('GET', '/api/v1/budgets/00000000-0000-4000-8000-000000000000/vs-actual')).toBe('financial_reports');
    expect(reportAreaFor('GET', '/api/v1/accounts')).toBeNull();
    expect(reportAreaFor('POST', '/api/v1/reports/email', { reportKey: 'ap_aging_summary' })).toBe('bills');
    expect(reportAreaFor('POST', '/api/v1/reports/email', { reportKey: 'profit_loss_by_month' })).toBe('financial_reports');
    expect(reportAreaFor('POST', '/api/v1/reports/email', {})).toBe('financial_reports');
    expect(areaForReportKey('nonsense')).toBe('financial_reports');
    expect(REPORT_AREAS['closing-date-exceptions']).toBe('audit_log');
  });
});

// ─── Live refusals and positive saves ───────────────────────────

describe('report areas: A/P and A/R templates', () => {
  it('A/P is refused A/R reports, the P&L, packs, Ask and emailing the P&L', async () => {
    await giveBk(AP);
    for (const p of [`/api/v1/reports/ar-aging-summary?as_of_date=2026-12-31`, `/api/v1/reports/invoice-list?${RANGE}`,
      `/api/v1/reports/profit-loss?${RANGE}`, `/api/v1/reports/profit-loss?${RANGE}&exact=1`, '/api/v1/reports/packs',
      `/api/v2/reports/profit-loss?${RANGE}`, `/api/v1/reports/AR-AGING-SUMMARY`]) {
      const r = await h.call('bk', 'GET', p);
      expect(r.status, p).toBe(403);
      expect(r.json.error.code, p).toBe('PERMISSION_DENIED');
    }
    const ask = await h.call('bk', 'POST', '/api/v1/reports/ask', { question: 'What did I make this year?' });
    expect(ask.status).toBe(403);
    const email = await h.call('bk', 'POST', '/api/v1/reports/email', {
      reportKey: 'profit_loss', to: ['a@example.com'], subject: 'P&L', filename: 'pl.pdf', fileBase64: 'JVBERi0=',
    });
    expect(email.status).toBe(403);
    expect(email.json.error.code).toBe('PERMISSION_DENIED');
    const noKey = await h.call('bk', 'POST', '/api/v1/reports/email', { to: ['a@example.com'], filename: 'x.pdf', fileBase64: 'JVBERi0=' });
    expect(noKey.status).toBe(403);
  });

  it('A/P gets a denied row for a ledger Builder section and 403 on its detail', async () => {
    await giveBk(AP);
    const d = glStarter();
    const dates = { from: '2026-01-01', to: '2026-12-31' };
    const r = await h.call('bk', 'POST', '/api/v1/report-builder/run', { definition: d, dates, fiscalYearStarts: ['2025-01-01', '2026-01-01'] });
    expect(r.status, r.text.slice(0, 300)).toBe(200);
    expect(r.json.meta.denied.length).toBeGreaterThan(0);
    expect(r.json.rows.some((x: { kind: string }) => x.kind === 'denied')).toBe(true);
    const own = await h.call('owner', 'POST', '/api/v1/report-builder/run', { definition: d, dates, fiscalYearStarts: ['2025-01-01', '2026-01-01'] });
    expect(own.status).toBe(200);
    expect(own.json.meta.denied).toEqual([]);
  });

  it('A/P runs A/P aging and saves a bill', async () => {
    await giveBk(AP);
    const aging = await h.call('bk', 'GET', '/api/v1/reports/ap-aging-summary?as_of_date=2026-12-31');
    expect(aging.status, aging.text.slice(0, 300)).toBe(200);
    const bill = await h.call('bk', 'POST', '/api/v1/bills', {
      contactId: vendor, txnDate: '2026-11-03', lines: [{ accountId: h.acct.supplies, amount: '25.00', description: 'Paper' }],
    });
    expect(bill.status, bill.text.slice(0, 300)).toBe(201);
  });

  it('A/R saves an invoice and a sales receipt, runs A/R aging, is refused A/P aging', async () => {
    await giveBk(AR);
    const inv = await h.call('bk', 'POST', '/api/v1/invoices', {
      contactId: customer, txnDate: '2026-11-04', lines: [{ accountId: h.acct.sales, description: 'Install', quantity: '1', unitPrice: '100.00' }],
    });
    expect([200, 201], inv.text.slice(0, 300)).toContain(inv.status);
    const sale = await h.call('bk', 'POST', '/api/v1/transactions', {
      txnType: 'cash_sale', txnDate: '2026-11-04', contactId: customer, depositToAccountId: h.acct.bank,
      lines: [{ accountId: h.acct.sales, description: 'Walk-in', quantity: '1', unitPrice: '40.00' }],
    });
    expect([200, 201], sale.text.slice(0, 300)).toContain(sale.status);
    expect((await h.call('bk', 'GET', '/api/v1/reports/ar-aging-summary?as_of_date=2026-12-31')).status).toBe(200);
    expect((await h.call('bk', 'GET', '/api/v1/reports/ap-aging-summary?as_of_date=2026-12-31')).status).toBe(403);
  });

  it('a template without financial_reports inherits reports; an explicit none wins', async () => {
    await giveBk({ reports: 'view', invoices: 'view' });
    expect((await h.call('bk', 'GET', `/api/v1/reports/profit-loss?${RANGE}`)).status).toBe(200);
    const me = await h.call('bk', 'GET', '/api/v1/auth/me');
    expect(me.json.permissions?.financial_reports ?? me.json.user?.permissions?.financial_reports).toBe('view');
    await giveBk({ reports: 'none', invoices: 'view' });
    expect((await h.call('bk', 'GET', `/api/v1/reports/profit-loss?${RANGE}`)).status).toBe(403);
    await giveBk({ reports: 'view', financial_reports: 'none' });
    expect((await h.call('bk', 'GET', `/api/v1/reports/profit-loss?${RANGE}`)).status).toBe(403);
  });

  it('owner and a legacy bookkeeper are unchanged (readonly: shared resolver tests)', async () => {
    for (const p of [`/api/v1/reports/profit-loss?${RANGE}`, '/api/v1/reports/ar-aging-summary?as_of_date=2026-12-31',
      '/api/v1/reports/ap-aging-summary?as_of_date=2026-12-31']) {
      expect((await h.call('owner', 'GET', p)).status, p).toBe(200);
    }
    await db.delete(userPermissions).where(eq(userPermissions.userId, h.bookkeeperId));
    expect((await h.call('bk', 'GET', `/api/v1/reports/profit-loss?${RANGE}`)).status).toBe(200);
  });
});
