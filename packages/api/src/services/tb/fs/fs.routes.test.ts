// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Report-ready financial statements through the real TB router gates:
// create from the default layout, compute ties to the GL, exports, the
// finalize → stale → reopen → v2 cycle, portal publish, and the access
// gates (flag off, client user, cross-company).

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { eq, sql } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';
import ExcelJS from 'exceljs';
import { db, pool } from '../../../db/index.js';
import {
  accounts, companies, journalLines, reportInstances, tenantFeatureFlags, tenants, transactions, users,
} from '../../../db/schema/index.js';
import { errorHandler } from '../../../middleware/error-handler.js';

// Chromium is not available in every test environment; the PDF itself is
// covered by a manual / smoke render. Here it is a real (tiny) PDF.
vi.mock('./fs-render.service.js', () => ({
  renderFsPdf: async () => {
    const d = await PDFDocument.create();
    d.addPage();
    d.addPage();
    return { bytes: Buffer.from(await d.save()), pageCount: 2, sectionPages: {} };
  },
}));

const { tbRouter } = await import('../../../routes/tb.routes.js');

let server: Server | null = null;
let port = 0;
let tenantId = '';
let companyId = '';
let otherCompanyId = '';
let ownerToken = '';
let clientToken = '';
let userId = '';
const A: Record<string, string> = {};

function call(method: string, path: string, opts: { body?: unknown; token?: string; company?: string } = {}): Promise<{ status: number; json: any; buffer: Buffer; type: string }> {
  return new Promise((resolve, reject) => {
    const data = opts.body !== undefined ? Buffer.from(JSON.stringify(opts.body)) : undefined;
    const req = http.request({
      hostname: '127.0.0.1', port, path: `/api/v1/tb/fs${path}`, method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.token ?? ownerToken}`,
        'X-Company-Id': opts.company ?? companyId,
        ...(data ? { 'Content-Length': String(data.length) } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const type = String(res.headers['content-type'] ?? '');
        let json: any = null;
        if (type.includes('json')) { try { json = JSON.parse(buffer.toString('utf8')); } catch { json = null; } }
        resolve({ status: res.statusCode ?? 0, json, buffer, type });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function post(date: string, lines: Array<[string, number, number]>) {
  const [t] = await db.insert(transactions).values({ tenantId, companyId, txnType: 'journal_entry', txnDate: date, status: 'posted', basis: 'both' }).returning();
  await db.insert(journalLines).values(lines.map(([acct, dr, cr], i) => ({
    tenantId, transactionId: t!.id, accountId: A[acct]!, debit: String(dr), credit: String(cr), lineOrder: i,
  })));
}

beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use('/api/v1/tb', tbRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); }); });

  const [t] = await db.insert(tenants).values({ name: 'FS', slug: `fs-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` }).returning();
  tenantId = t!.id;
  await db.insert(tenantFeatureFlags).values([
    { tenantId, flagKey: 'TRIAL_BALANCE_V1', enabled: true },
    { tenantId, flagKey: 'FINANCIAL_STATEMENTS_V1', enabled: true },
  ]);
  const [c] = await db.insert(companies).values({ tenantId, businessName: 'Acme Widgets, Inc.', entityType: 'c_corp', fiscalYearStartMonth: 1 }).returning();
  companyId = c!.id;
  const [c2] = await db.insert(companies).values({ tenantId, businessName: 'Other Co', fiscalYearStartMonth: 1 }).returning();
  otherCompanyId = c2!.id;
  const [u] = await db.insert(users).values({
    tenantId, email: `fs-${Date.now()}@example.com`, passwordHash: await bcrypt.hash('secret-123-456', 4), role: 'owner', displayName: 'Owner',
  }).returning();
  userId = u!.id;
  ownerToken = jwt.sign({ userId, tenantId, role: 'owner', isSuperAdmin: false }, process.env['JWT_SECRET']!, { expiresIn: '10m' });
  const [cu] = await db.insert(users).values({
    tenantId, email: `fs-client-${Date.now()}@example.com`, passwordHash: await bcrypt.hash('secret-123-456', 4), role: 'owner', displayName: 'Client', userType: 'client',
  }).returning();
  clientToken = jwt.sign({ userId: cu!.id, tenantId, role: 'owner', isSuperAdmin: false }, process.env['JWT_SECRET']!, { expiresIn: '10m' });

  const mk = async (key: string, num: string, name: string, type: string, detail: string | null = null, systemTag: string | null = null) => {
    const [a] = await db.insert(accounts).values({ tenantId, companyId, accountNumber: num, name, accountType: type, detailType: detail, systemTag }).returning();
    A[key] = a!.id;
  };
  await mk('cash', '1000', 'Checking', 'asset', 'bank');
  await mk('ar', '1100', 'Accounts Receivable', 'asset', 'accounts_receivable');
  await mk('equip', '1500', 'Equipment', 'asset', 'fixed_asset');
  await mk('accdep', '1510', 'Accumulated Depreciation', 'asset', 'accumulated_depreciation');
  await mk('ap', '2000', 'Accounts Payable', 'liability', 'accounts_payable');
  await mk('cs', '3000', 'Common Stock', 'equity', 'capital_stock');
  await mk('re', '3100', 'Retained Earnings', 'equity', 'retained_earnings', 'retained_earnings');
  await mk('sales', '4000', 'Sales', 'revenue');
  await mk('rent', '6000', 'Rent', 'expense');
  await mk('depr', '6100', 'Depreciation Expense', 'expense');

  // 2024: capitalize + first year of operations.
  await post('2024-01-02', [['cash', 11000, 0], ['cs', 0, 1000], ['ap', 0, 10000]]);
  await post('2024-06-30', [['cash', 30000.40, 0], ['sales', 0, 30000.40]]);
  await post('2024-07-01', [['rent', 12000, 0], ['cash', 0, 12000]]);
  // 2025
  await post('2025-02-01', [['equip', 5000, 0], ['cash', 0, 5000]]);
  await post('2025-05-15', [['ar', 6200.10, 0], ['sales', 0, 6200.10]]);
  await post('2025-06-30', [['cash', 20000.33, 0], ['sales', 0, 20000.33]]);
  await post('2025-09-30', [['rent', 9000.25, 0], ['cash', 0, 9000.25]]);
  await post('2025-12-31', [['depr', 1000, 0], ['accdep', 0, 1000]]);
  await post('2025-12-31', [['ap', 2500, 0], ['cash', 0, 2500]]);
});

afterAll(async () => {
  for (const tbl of ['fs_cash_flow_overrides', 'fs_report_versions', 'fs_reports', 'fs_company_layouts', 'fs_layout_templates', 'fs_style_presets', 'fs_report_letters', 'fs_firm_profiles', 'tb_grouping_accounts', 'tb_groupings']) {
    await db.execute(sql.raw(`DELETE FROM ${tbl} WHERE tenant_id = '${tenantId}'`));
  }
  await db.delete(reportInstances).where(eq(reportInstances.tenantId, tenantId));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
  await db.execute(sql`DELETE FROM gl_version_stamps WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM audit_log WHERE tenant_id = ${tenantId}`);
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(users).where(eq(users.tenantId, tenantId));
  await db.delete(tenantFeatureFlags).where(eq(tenantFeatureFlags.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  await new Promise<void>((r) => server?.close(() => r()));
  await pool.end();
});

const SETTINGS = { periodEnd: '2025-12-31', framework: 'gaap', bookBasis: 'accrual', columns: { mode: 'cy_py', pctOfRevenue: false, varianceAmt: false, variancePct: false } };

const rowVal = (st: any, caption: string, col = 0) => {
  const r = st.rows.find((x: any) => x.caption === caption);
  if (!r) throw new Error(`no row ${caption}: ${st.rows.map((x: any) => x.caption).join('|')}`);
  return r.values[col];
};

describe('financial statements API', () => {
  let reportId = '';

  it('seeds the firm library lazily (built-in presets)', async () => {
    const res = await call('GET', '/library');
    expect(res.status).toBe(200);
    expect(res.json.presets.map((p: any) => p.builtinKey).sort()).toEqual(['classic_serif', 'modern_sans']);
    expect(res.json.ownedByFirm).toBe(false);
  });

  it('creates a report from the default layout and computes statements that tie to the GL', async () => {
    const res = await call('POST', '/reports', { body: { name: 'Acme 2025', settings: SETTINGS, layoutSource: { kind: 'default' } } });
    expect(res.status).toBe(201);
    reportId = res.json.report.id;

    const comp = await call('POST', `/reports/${reportId}/compute`, { body: {} });
    expect(comp.status).toBe(200);
    const model = comp.json.model;
    expect(model.checks.filter((c: any) => c.severity === 'error')).toEqual([]);
    const bs = model.statements.find((s: any) => s.kind === 'balance_sheet');
    const is = model.statements.find((s: any) => s.kind === 'income_statement');
    const cf = model.statements.find((s: any) => s.kind === 'cash_flows');
    expect(bs.title).toBe('Balance Sheets');
    // Cash: 11000 + 30000.40 − 12000 − 5000 + 20000.33 − 9000.25 − 2500 = 32500.48
    expect(rowVal(bs, 'Cash')).toBe(32500);
    expect(rowVal(bs, 'Cash', 1)).toBe(29000);
    expect(rowVal(bs, 'TOTAL ASSETS')).toBe(rowVal(bs, "TOTAL LIABILITIES AND STOCKHOLDERS' EQUITY"));
    // 2025 NI = 6200.10 + 20000.33 − 9000.25 − 1000 = 16200.18, but the
    // rounded equity roll-forward (18,000 + NI = 34,201 on the balance
    // sheet: 18,000.40 + 16,200.18 = 34,200.58) needs 16,201 — the
    // income statement absorbs the rounding so every statement agrees.
    expect(rowVal(is, 'NET INCOME')).toBe(16201);
    expect(rowVal(is, 'NET INCOME', 1)).toBe(18000);
    expect(rowVal(cf, 'CASH, END OF YEAR')).toBe(32500);
    expect(rowVal(cf, 'Cash, beginning of year')).toBe(29000);
    expect(rowVal(cf, 'Depreciation and amortization')).toBe(1000);
  });

  it('serves live-preview data (engine source + resolved letter)', async () => {
    const res = await call('POST', `/reports/${reportId}/preview-data`, { body: {} });
    expect(res.status).toBe(200);
    expect(res.json.source.companyName).toBe('Acme Widgets, Inc.');
    expect(res.json.source.workpapers['2024-12-31'].hasData).toBe(true);
    expect(res.json.source.groupings.length).toBeGreaterThan(5);
  });

  it('exports Excel with live formulas and Word', async () => {
    const x = await call('GET', `/reports/${reportId}/export?format=xlsx`);
    expect(x.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(x.buffer as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toContain('Balance Sheets');
    let formulas = 0;
    wb.getWorksheet('Balance Sheets')!.eachRow((row) => row.eachCell((c) => { if (c.formula) formulas++; }));
    expect(formulas).toBeGreaterThan(5);
    const d = await call('GET', `/reports/${reportId}/export?format=docx`);
    expect(d.status).toBe(200);
    expect(d.type).toContain('wordprocessingml');
    expect(d.buffer.subarray(0, 2).toString()).toBe('PK');
  });

  it('finalize freezes a version; a later GL change marks it stale but never changes it', async () => {
    const fin = await call('POST', `/reports/${reportId}/finalize`, { body: {} });
    expect(fin.status).toBe(200);
    expect(fin.json.versionNo).toBe(1);

    const locked = await call('PATCH', `/reports/${reportId}`, { body: { name: 'x' } });
    expect(locked.status).toBe(423);

    const v1 = await call('GET', `/reports/${reportId}/versions/1`);
    const frozenNi = rowVal(v1.json.model.statements.find((s: any) => s.kind === 'income_statement'), 'NET INCOME');
    expect(v1.json.stale).toBe(false);

    await post('2025-12-31', [['rent', 100, 0], ['cash', 0, 100]]);
    const v1b = await call('GET', `/reports/${reportId}/versions/1`);
    expect(v1b.json.stale).toBe(true);
    expect(rowVal(v1b.json.model.statements.find((s: any) => s.kind === 'income_statement'), 'NET INCOME')).toBe(frozenNi);
    const imp = await call('GET', `/reports/${reportId}/versions/1/impact`);
    expect(imp.json).toEqual({ stale: true, changed: true });

    const pdf = await call('GET', `/reports/${reportId}/export?format=pdf&version=1`);
    expect(pdf.status).toBe(200);
    expect(pdf.buffer.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('publishes the final to the portal list and keeps it out of Report Builder', async () => {
    const pub = await call('POST', `/reports/${reportId}/versions/1/publish`, { body: { title: 'Acme 2025 Financial Statements' } });
    expect(pub.status).toBe(200);
    const [inst] = await db.select().from(reportInstances).where(eq(reportInstances.id, pub.json.instanceId));
    expect(inst!.status).toBe('published');
    expect(inst!.source).toBe('financial_statements');
    const { listInstances } = await import('../../portal-reports.service.js');
    expect((await listInstances(tenantId, companyId)).some((i) => i.id === inst!.id)).toBe(false);
  });

  it('reopen then finalize creates v2 and supersedes v1', async () => {
    expect((await call('POST', `/reports/${reportId}/reopen`)).status).toBe(204);
    const fin = await call('POST', `/reports/${reportId}/finalize`, { body: {} });
    expect(fin.json.versionNo).toBe(2);
    const versions = await call('GET', `/reports/${reportId}/versions`);
    expect(versions.json.versions.map((v: any) => [v.versionNo, v.status])).toEqual([[2, 'final'], [1, 'superseded']]);
  });

  it('blocks finalize on validation errors unless overridden with a reason', async () => {
    const created = await call('POST', '/reports', { body: { name: 'Broken', settings: { ...SETTINGS, columns: { ...SETTINGS.columns, mode: 'single' } }, layoutSource: { kind: 'default' } } });
    const id = created.json.report.id;
    const detail = await call('GET', `/reports/${id}`);
    const layout = detail.json.layout.layout;
    // Drop revenue from the income statement → NI mismatch.
    const is = layout.statements.find((s: any) => s.kind === 'income_statement');
    is.body = is.body.filter((n: any) => n.id !== 'is_revenue');
    const gp = is.body.find((n: any) => n.id === 'is_gross_profit');
    gp.terms = gp.terms.filter((t: any) => t.nodeId !== 'is_revenue');
    const saved = await call('PATCH', `/layouts/${detail.json.layout.id}`, { body: { layout, expectedUpdatedAt: detail.json.layout.updatedAt } });
    expect(saved.status).toBe(200);
    const stale = await call('PATCH', `/layouts/${detail.json.layout.id}`, { body: { layout, expectedUpdatedAt: detail.json.layout.updatedAt } });
    expect(stale.status).toBe(409);
    const blocked = await call('POST', `/reports/${id}/finalize`, { body: {} });
    expect(blocked.status).toBe(422);
    expect(blocked.json.error?.details?.checks?.map((c: any) => c.code) ?? blocked.json.details?.checks?.map((c: any) => c.code)).toContain('TB_FS_NI_MISMATCH');
    const ok = await call('POST', `/reports/${id}/finalize`, { body: { overrideValidation: true, reason: 'Draft for review' } });
    expect(ok.status).toBe(200);
    expect(ok.json.validationOverride).toBe(true);
  });

  it('quarter + YTD vs prior year ties every column to the P&L report', async () => {
    const { buildProfitAndLoss } = await import('../../report.service.js');
    const settings = {
      periodEnd: '2025-06-30', period: { type: 'quarter', start: '2025-04-01' }, framework: 'gaap', bookBasis: 'accrual',
      columns: { mode: 'period_ytd_py', pctOfRevenue: false, varianceAmt: false, variancePct: false },
    };
    const created = await call('POST', '/reports', { body: { name: 'Q2 2025', settings, layoutSource: { kind: 'default' } } });
    expect(created.status).toBe(201);
    const comp = await call('POST', `/reports/${created.json.report.id}/compute`, { body: {} });
    expect(comp.status).toBe(200);
    const model = comp.json.model;
    expect(model.checks.filter((c: any) => c.severity === 'error')).toEqual([]);
    const is = model.statements.find((x: any) => x.kind === 'income_statement');
    expect(is.dateLine).toBe('For the Three and Six Months Ended June 30, 2025 and 2024');
    const ni = is.rows.find((r: any) => r.caption === 'NET INCOME').values;
    const ranges = [['2025-04-01', '2025-06-30'], ['2024-04-01', '2024-06-30'], ['2025-01-01', '2025-06-30'], ['2024-01-01', '2024-06-30']];
    for (let i = 0; i < ranges.length; i++) {
      const pl = await buildProfitAndLoss(tenantId, ranges[i]![0]!, ranges[i]![1]!, 'accrual', companyId);
      expect(Math.abs(ni[i] - pl.netIncome)).toBeLessThanOrEqual(1);
    }
    const bs = model.statements.find((x: any) => x.kind === 'balance_sheet');
    expect(bs.dateLine).toBe('June 30, 2025 and December 31, 2024');
    // Stored period survives a reload.
    const detail = await call('GET', `/reports/${created.json.report.id}`);
    expect(detail.json.report.settings.period).toEqual({ type: 'quarter', start: '2025-04-01' });
    // Roll forward = next quarter.
    const rolled = await call('POST', `/reports/${created.json.report.id}/roll-forward`, { body: {} });
    const next = await call('GET', `/reports/${rolled.json.report.id}`);
    expect(next.json.report.settings.periodEnd).toBe('2025-09-30');
    expect(next.json.report.settings.period).toEqual({ type: 'quarter', start: '2025-07-01' });
  });

  it('a custom range across the fiscal year-end reconciles', async () => {
    const { buildProfitAndLoss } = await import('../../report.service.js');
    const settings = {
      periodEnd: '2025-06-30', period: { type: 'custom', start: '2024-07-01' }, framework: 'gaap', bookBasis: 'accrual',
      columns: { mode: 'single', pctOfRevenue: false, varianceAmt: false, variancePct: false },
    };
    const created = await call('POST', '/reports', { body: { name: 'Trailing 12', settings, layoutSource: { kind: 'default' } } });
    const comp = await call('POST', `/reports/${created.json.report.id}/compute`, { body: {} });
    const model = comp.json.model;
    expect(model.checks.filter((c: any) => c.severity === 'error')).toEqual([]);
    const is = model.statements.find((x: any) => x.kind === 'income_statement');
    expect(is.dateLine).toBe('For the Twelve Months Ended June 30, 2025');
    const pl = await buildProfitAndLoss(tenantId, '2024-07-01', '2025-06-30', 'accrual', companyId);
    expect(Math.abs(is.rows.find((r: any) => r.caption === 'NET INCOME').values[0] - pl.netIncome)).toBeLessThanOrEqual(1);
    const cf = model.statements.find((x: any) => x.kind === 'cash_flows');
    expect(cf.rows.find((r: any) => r.caption === 'Cash, beginning of period').values[0]).toBe(41000); // cash at 2024-06-30: 11,000 + 30,000.40
  });

  it('rejects income-tax basis for a quarter', async () => {
    const res = await call('POST', '/reports', { body: {
      name: 'Tax Q', layoutSource: { kind: 'default' },
      settings: { periodEnd: '2025-06-30', period: { type: 'quarter', start: '2025-04-01' }, framework: 'tax', bookBasis: 'accrual', columns: { mode: 'single', pctOfRevenue: false, varianceAmt: false, variancePct: false } },
    } });
    expect(res.status).toBe(400);
  });

  it('gates: client users, flag off, other company', async () => {
    expect((await call('GET', '/reports', { token: clientToken })).status).toBe(404);
    const other = await call('GET', `/reports/${reportId}`, { company: otherCompanyId });
    expect(other.status).toBe(404);
    await db.update(tenantFeatureFlags).set({ enabled: false }).where(sql`${tenantFeatureFlags.tenantId} = ${tenantId} AND ${tenantFeatureFlags.flagKey} = 'FINANCIAL_STATEMENTS_V1'`);
    expect((await call('GET', '/reports')).status).toBe(404);
    await db.update(tenantFeatureFlags).set({ enabled: true }).where(sql`${tenantFeatureFlags.tenantId} = ${tenantId} AND ${tenantFeatureFlags.flagKey} = 'FINANCIAL_STATEMENTS_V1'`);
  });
});
