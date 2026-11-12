// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.
//
// Report Builder preview runs (U-217, report-builder-preview-v1; ClientLedger
// A08): purpose 'preview' is the screen run cut at 50 detail rows per line.
//   - every line's preview detail rows equal the full run's first 50 rows
//     (same cells, order, running balance and drill paths);
//   - a line with more ends in a more row whose cursor pages /run/detail to
//     exactly the full run's remaining rows; shorter lines are not cut;
//   - meta.truncated / meta.preview mark the cut; line, total and earnings
//     rows are the same as the full run's.

import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { BUILDER_STARTERS, type BuilderDefinition } from '@kis-books/shared';
import { reportBuilderRouter } from './report-builder.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import * as ledger from '../services/ledger.service.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';
import { PREVIEW_DETAIL_ROWS_PER_LINE } from '../services/report-builder/limits.js';
import { makeCompany, cleanTenant, suffix, type Co } from '../services/templates/templates.test-helpers.js';

let server: Server | null = null;
let port = 0;
const tenantIds: string[] = [];
let c: Co;
const FY = ['2025-01-01', '2026-01-01'];
const DATES = { from: '2026-01-01', to: '2026-12-31' };
const SALES = 73;

interface Res { status: number; json: ReturnType<typeof JSON.parse> }
function call(method: string, p: string, body?: unknown): Promise<Res> {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined;
    const req = http.request({
      hostname: '127.0.0.1', port, path: `/api/v1/report-builder${p}`, method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.token}`, 'X-Company-Id': c.companyId, ...(data ? { 'Content-Length': String(data.length) } : {}) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (x) => chunks.push(x));
      res.on('end', () => { const raw = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : null }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const starter = (key: string): BuilderDefinition => JSON.parse(JSON.stringify(BUILDER_STARTERS.find((s) => s.key === key)!.definition)) as BuilderDefinition;
type Row = { kind: string; nodeId: string; path: string[]; cells: Array<string | null>; cursor?: string | null };
const key = (p: string[]) => p.join('|');

beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/v1/report-builder', reportBuilderRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); }); });
  c = await makeCompany(`rbp${suffix().slice(-4)}`, tenantIds);
  // Opening balance (prior year) so the bank's running balance starts above zero.
  await ledger.postTransaction(c.tenantId, { txnType: 'journal_entry', txnDate: '2025-06-30', memo: 'open',
    lines: [{ accountId: c.bank, debit: '500.00', credit: '0' }, { accountId: c.income, debit: '0', credit: '500.00' }] } as never, c.userId, c.companyId);
  // 73 sales (bank and income lines past the cut; several on one day so the tie-break order counts), 7 expenses (under it).
  for (let i = 0; i < SALES; i++) {
    const d = `2026-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 5) + 1).padStart(2, '0')}`;
    await ledger.postTransaction(c.tenantId, { txnType: 'cash_sale', txnDate: d, memo: `s${i}`, contactId: c.customer, total: `${10 + i}.00`,
      lines: [{ accountId: c.bank, debit: `${10 + i}.00`, credit: '0' }, { accountId: c.income, debit: '0', credit: `${10 + i}.00` }] } as never, c.userId, c.companyId);
  }
  for (let i = 0; i < 7; i++) {
    await ledger.postTransaction(c.tenantId, { txnType: 'expense', txnDate: `2026-04-0${i + 1}`, memo: `e${i}`, contactId: c.vendor, total: '3.00',
      lines: [{ accountId: c.expense, debit: '3.00', credit: '0' }, { accountId: c.bank, debit: '0', credit: '3.00' }] } as never, c.userId, c.companyId);
  }
}, 180_000);

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  while (tenantIds.length) await cleanTenant(tenantIds.pop()!);
});

/** Detail rows under each line path, in order, and the more row (if any) that ends them. */
function byLine(rows: Row[]) {
  const out = new Map<string, { detail: Row[]; more: Row | null }>();
  let cur: string | null = null;
  for (const r of rows) {
    if (r.kind === 'line') { cur = key(r.path); out.set(cur, { detail: [], more: null }); continue; }
    if (cur === null) continue;
    if (r.kind === 'detail') out.get(cur)!.detail.push(r);
    else if (r.kind === 'more') out.get(cur)!.more = r;
    else cur = null;
  }
  return out;
}

describe('report-builder-preview-v1 (U-217)', () => {
  it('advertises the capability', () => {
    expect(DESKTOP_CAPABILITIES).toContain('report-builder-preview-v1');
    expect(PREVIEW_DETAIL_ROWS_PER_LINE).toBe(50);
  });

  for (const basis of ['accrual', 'cash'] as const) {
    it(`preview rows equal the full run's rows up to the cut; the cursor pages the rest (${basis})`, async () => {
      const d = starter('transaction_detail_by_account');
      const body = { definition: d, dates: DATES, basis, fiscalYearStarts: FY, expandAll: true };
      const full = await call('POST', '/run', { ...body, purpose: 'screen' });
      const prev = await call('POST', '/run', { ...body, purpose: 'preview' });
      expect(full.status, JSON.stringify(full.json).slice(0, 300)).toBe(200);
      expect(prev.status, JSON.stringify(prev.json).slice(0, 300)).toBe(200);
      expect(prev.json.fingerprint).toBe(full.json.fingerprint);
      expect(prev.json.meta.preview).toEqual({ detailRowsPerLine: 50 });
      expect(prev.json.meta.truncated).toBe(true);
      expect(full.json.meta.preview).toBeUndefined();
      expect(full.json.meta.truncated).toBe(false);

      // Everything but detail and more rows is the same run.
      const frame = (rows: Row[]) => rows.filter((r) => r.kind !== 'detail' && r.kind !== 'more');
      expect(frame(prev.json.rows)).toEqual(frame(full.json.rows));

      const f = byLine(full.json.rows);
      const p = byLine(prev.json.rows);
      expect([...p.keys()]).toEqual([...f.keys()]);
      let cut = 0;
      for (const [k, want] of f) {
        const got = p.get(k)!;
        expect(want.more, k).toBeNull();
        expect(got.detail, k).toEqual(want.detail.slice(0, 50));
        if (want.detail.length <= 50) { expect(got.more, k).toBeNull(); continue; }
        cut++;
        expect(got.more?.cursor, k).toBeTruthy();
        // The cursor pages exactly the full run's remaining rows.
        const rest: Row[] = [];
        let cursor: string | null = got.more!.cursor!;
        const line = prev.json.rows.find((r: Row) => r.kind === 'line' && key(r.path) === k) as Row;
        while (cursor) {
          const page = await call('POST', '/run/detail', { definition: d, dates: DATES, basis, fiscalYearStarts: FY, nodeId: line.nodeId, path: line.path,
            fingerprint: prev.json.fingerprint, stamp: prev.json.stamp, cursor });
          expect(page.status, JSON.stringify(page.json).slice(0, 300)).toBe(200);
          rest.push(...page.json.rows);
          cursor = page.json.cursor;
        }
        const strip = (r: Row) => ({ ...r, level: undefined });
        expect(rest.map(strip), k).toEqual(want.detail.slice(50).map(strip));
      }
      // Bank and income have 73+ rows: both cut; the expense line (7 rows) is not.
      expect(cut).toBeGreaterThanOrEqual(2);
    }, 120_000);
  }

  it('purpose must be screen, export or preview', async () => {
    const r = await call('POST', '/run', { definition: starter('profit_loss'), dates: DATES, fiscalYearStarts: FY, purpose: 'peek' });
    expect(r.status).toBe(400);
  });
});
