// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.
//
// Report Builder performance (U-119, ClientLedger A07 PR-D, R-T17). Opt-in:
// RB_EXPLAIN=1 (minutes to build; never in CI). Generates a company with
// about 1,000,000 journal lines over three years — invoices, customer
// payments applied to them, expenses — then runs the worst case: a cash
// Balance Sheet with 36 monthly columns plus a General Ledger detail
// section, and an accrual one, each within the 30 s run deadline. Prints
// the timings and the EXPLAIN of the cash fact statement for the PR body.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { BUILDER_STARTERS, type BuilderDefinition } from '@kis-books/shared';
import { db } from '../db/index.js';
import { runReport } from '../services/report-builder/run.js';
import { runRequestSchema } from '../services/report-builder/request.js';
import { makeCompany, cleanTenant, type Co } from '../services/templates/templates.test-helpers.js';

const ON = process.env['RB_EXPLAIN'] === '1';
const N_INVOICES = Number(process.env['RB_EXPLAIN_INVOICES'] ?? 200_000);
const tenantIds: string[] = [];
let c: Co;

beforeAll(async () => {
  if (!ON) return;
  c = await makeCompany('rbx', tenantIds);
  const t0 = Date.now();
  // Invoices (2 lines), payments (2 lines) each applied in full, expenses (2 lines): 6 lines per invoice slot,
  // N_INVOICES slots → 1.2M lines at the default.
  await db.execute(sql`
    INSERT INTO transactions (id, tenant_id, company_id, txn_type, txn_date, status, total, contact_id, due_date)
    SELECT md5(${c.tenantId} || 'inv' || g)::uuid, ${c.tenantId}, ${c.companyId}, 'invoice', DATE '2024-01-01' + (g % 1090), 'posted', 100, ${c.customer}, DATE '2024-01-31' + (g % 1090)
    FROM generate_series(1, ${N_INVOICES}) g`);
  await db.execute(sql`
    INSERT INTO transactions (id, tenant_id, company_id, txn_type, txn_date, status, total, contact_id)
    SELECT md5(${c.tenantId} || 'pay' || g)::uuid, ${c.tenantId}, ${c.companyId}, 'customer_payment', DATE '2024-01-01' + (g % 1090) + 10, 'posted', 100, ${c.customer}
    FROM generate_series(1, ${N_INVOICES}) g`);
  await db.execute(sql`
    INSERT INTO transactions (id, tenant_id, company_id, txn_type, txn_date, status, total, contact_id)
    SELECT md5(${c.tenantId} || 'exp' || g)::uuid, ${c.tenantId}, ${c.companyId}, 'expense', DATE '2024-01-01' + (g % 1090), 'posted', 40, ${c.vendor}
    FROM generate_series(1, ${N_INVOICES}) g`);
  await db.execute(sql`
    INSERT INTO journal_lines (tenant_id, company_id, transaction_id, account_id, debit, credit, line_order)
    SELECT ${c.tenantId}, ${c.companyId}, md5(${c.tenantId} || p || g)::uuid, a, d, cr, o FROM generate_series(1, ${N_INVOICES}) g,
      (VALUES ('inv', ${c.ar}::uuid, 100::numeric, 0::numeric, 0), ('inv', ${c.income}::uuid, 0, 100, 1),
              ('pay', ${c.bank}::uuid, 100, 0, 0), ('pay', ${c.ar}::uuid, 0, 100, 1),
              ('exp', ${c.expense}::uuid, 40, 0, 0), ('exp', ${c.bank}::uuid, 0, 40, 1)) v(p, a, d, cr, o)`);
  await db.execute(sql`
    INSERT INTO payment_applications (tenant_id, company_id, payment_id, invoice_id, amount)
    SELECT ${c.tenantId}, ${c.companyId}, md5(${c.tenantId} || 'pay' || g)::uuid, md5(${c.tenantId} || 'inv' || g)::uuid, 100 FROM generate_series(1, ${N_INVOICES}) g`);
  await db.execute(sql`ANALYZE transactions`);
  await db.execute(sql`ANALYZE journal_lines`);
  await db.execute(sql`ANALYZE payment_applications`);
  console.log(`[rb-explain] generated ${N_INVOICES * 6} lines in ${Math.round((Date.now() - t0) / 1000)} s`);
}, 1_800_000);

afterAll(async () => {
  // Bulk-delete the generated rows first (the generic cleanup walks rows one by one).
  for (const id of tenantIds) {
    await db.execute(sql`DELETE FROM payment_applications WHERE tenant_id = ${id}`);
    await db.execute(sql`DELETE FROM journal_lines WHERE tenant_id = ${id}`);
    await db.execute(sql`DELETE FROM transactions WHERE tenant_id = ${id}`);
  }
  while (tenantIds.length) await cleanTenant(tenantIds.pop()!);
}, 1_800_000);

describe.skipIf(!ON)('Report Builder worst case on ~1M lines (RB_EXPLAIN=1)', () => {
  for (const basis of ['cash', 'accrual'] as const) {
    it(`${basis} Balance Sheet by month (36 columns) plus a General Ledger detail section within 30 s`, async () => {
      const bs = BUILDER_STARTERS.find((s) => s.key === 'balance_sheet')!.definition;
      const gl = BUILDER_STARTERS.find((s) => s.key === 'transaction_detail_by_account')!.definition;
      const def: BuilderDefinition = {
        ...bs,
        columns: { ...bs.columns, periods: 'month' },
        nodes: [...bs.nodes, { ...(gl.nodes[0] as object), id: 'ledger', display: 'detail' } as BuilderDefinition['nodes'][number]],
      };
      const months = Array.from({ length: 36 }, (_, i) => {
        const y = 2024 + Math.floor(i / 12), m = (i % 12) + 1;
        const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
        return { from: `${y}-${String(m).padStart(2, '0')}-01`, to: `${y}-${String(m).padStart(2, '0')}-${last}` };
      });
      const req = runRequestSchema.parse({
        definition: def, dates: { asOf: '2026-12-31' }, periodRanges: months, basis,
        fiscalYearStarts: ['2024-01-01', '2025-01-01', '2026-01-01'],
      });
      const perms = new Proxy({}, { get: () => 'full' }) as never;
      const t0 = Date.now();
      const r = await runReport({ tenantId: c.tenantId, companyId: c.companyId, permissions: perms }, req);
      const ms = Date.now() - t0;
      console.log(`[rb-explain] ${basis}: ${ms} ms, ${r.rows.length} rows, truncated ${r.meta.truncated}`);
      expect(ms).toBeLessThan(30_000);
      // Preview (U-217): the same run cut at 50 detail rows per line.
      const t1 = Date.now();
      const p = await runReport({ tenantId: c.tenantId, companyId: c.companyId, permissions: perms }, { ...req, purpose: 'preview' });
      const pms = Date.now() - t1;
      console.log(`[rb-explain] ${basis} preview: ${pms} ms, ${p.rows.length} rows, truncated ${p.meta.truncated}`);
      expect(pms).toBeLessThan(30_000);
    }, 120_000);
  }
});
