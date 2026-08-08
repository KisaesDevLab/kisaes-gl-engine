// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Phase 12 smoke: every report builder produces a respond()-ready
// object (title + data + _exportColumns) over a small fixture, and the
// numeric spine of the key reports ties to the engine.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, pool } from '../../db/index.js';
import {
  accounts, accountTaxAssignments, companies, companyTaxProfiles,
  journalLines, tbGroupings, tbTickmarkApplications, tbTickmarks,
  tenants, transactions,
} from '../../db/schema/index.js';
import { importSeed } from './tax-code-seed.service.js';
import { seedDefaultGroupings } from './groupings.service.js';
import * as tbReports from './tb-reports.service.js';

const SEED_FILE_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'seeds', 'tax-codes', '2025', 'tax-codes.xlsx');

let tenantId: string;
let companyId: string;
const A: Record<string, string> = {};

beforeAll(async () => {
  // CI runs against a fresh DB with no tax-code seed — import it
  // idempotently (byte-identical re-import is a no-op locally).
  await importSeed({ taxYear: 2025, buffer: readFileSync(SEED_FILE_PATH), dryRun: false });
  const [t] = await db.insert(tenants).values({ name: 'tb-rep-test', slug: `tb-rep-${Date.now()}` }).returning();
  tenantId = t!.id;
  const [c] = await db.insert(companies).values({ tenantId, businessName: 'Report Co', fiscalYearStartMonth: 1 }).returning();
  companyId = c!.id;
  await db.insert(companyTaxProfiles).values({ tenantId, companyId, returnForm: '1120S' });
  const mk = async (num: string, name: string, type: string, detail: string | null = null) => {
    const [a] = await db.insert(accounts).values({ tenantId, companyId, accountNumber: num, name, accountType: type, detailType: detail }).returning();
    A[name] = a!.id;
  };
  await mk('1000', 'Cash', 'asset', 'bank');
  await mk('4000', 'Revenue', 'revenue');
  await mk('5000', 'Rent', 'expense');
  const [txn] = await db.insert(transactions).values({
    tenantId, companyId, txnType: 'journal_entry', txnDate: '2026-03-01', status: 'posted', basis: 'both',
  }).returning();
  await db.insert(journalLines).values([
    { tenantId, transactionId: txn!.id, accountId: A['Cash']!, debit: '800', credit: '0', lineOrder: 0 },
    { tenantId, transactionId: txn!.id, accountId: A['Revenue']!, debit: '0', credit: '1000', lineOrder: 1 },
    { tenantId, transactionId: txn!.id, accountId: A['Rent']!, debit: '200', credit: '0', lineOrder: 2 },
  ]);
  // Assign codes so return-order/code-summary have lines.
  const codeRes = await db.execute(sql`
    SELECT code, activity_type FROM tax_codes WHERE return_form IN ('1120S', 'common') AND code <> 'DONOTMAP' LIMIT 1
  `);
  const code = (codeRes.rows as Array<{ code: string; activity_type: string }>)[0]!;
  for (const name of ['Cash', 'Revenue', 'Rent']) {
    await db.insert(accountTaxAssignments).values({
      tenantId, companyId, accountId: A[name]!, activityUnitId: null,
      seedCode: code.code, seedActivityType: code.activity_type, source: 'manual',
    });
  }
  await seedDefaultGroupings(tenantId, companyId);
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM tb_tickmark_applications WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM tb_tickmarks WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM tb_grouping_accounts WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM tb_groupings WHERE tenant_id = ${tenantId}`);
  await db.delete(accountTaxAssignments).where(eq(accountTaxAssignments.tenantId, tenantId));
  await db.delete(companyTaxProfiles).where(eq(companyTaxProfiles.tenantId, tenantId));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
  await db.execute(sql`DELETE FROM gl_version_stamps WHERE tenant_id = ${tenantId}`);
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  await pool.end();
});

describe('TB report family (Phase 12)', () => {
  const END = '2026-12-31';

  it('every builder returns a respond()-ready object', async () => {
    const builders: Array<[string, () => Promise<{ title: string; data: unknown[]; _exportColumns: unknown[] }>]> = [
      ['workpaper', () => tbReports.buildTbWorkpaperReport(tenantId, companyId, END, 'accrual')],
      ['grouped', () => tbReports.buildTbGroupedReport(tenantId, companyId, END, 'accrual')],
      ['leadsheets', () => tbReports.buildTbLeadsheetsReport(tenantId, companyId, END, 'accrual')],
      ['return-order', () => tbReports.buildTbReturnOrderReport(tenantId, companyId, END, 'accrual')],
      ['tax-basis-pl', () => tbReports.buildTbTaxBasisPl(tenantId, companyId, END, 'accrual', null)],
      ['flux', () => tbReports.buildTbFluxReport(tenantId, companyId, END, 'accrual')],
      ['aje-listing', () => tbReports.buildTbAjeListing(tenantId, companyId, END, false)],
      ['bookkeeper-letter', () => tbReports.buildTbAjeListing(tenantId, companyId, END, true)],
      ['rje-listing', () => tbReports.buildTbRjeListing(tenantId, companyId, END)],
      ['code-summary', () => tbReports.buildTbCodeSummary(tenantId, companyId, END, 'accrual')],
      ['m1', () => tbReports.buildTbM1Report(tenantId, companyId, END, 'accrual')],
      ['m2', () => tbReports.buildTbM2Report(tenantId, companyId, END, 'accrual')],
      ['workpaper-index', () => tbReports.buildTbWorkpaperIndex(tenantId, companyId, END)],
      ['diagnostics', () => tbReports.buildTbDiagnosticsReport(tenantId, companyId, END, 'accrual')],
    ];
    for (const [name, build] of builders) {
      const report = await build();
      expect(report.title, name).toBeTruthy();
      expect(Array.isArray(report.data), name).toBe(true);
      expect(report._exportColumns.length, name).toBeGreaterThan(1);
    }
  });

  it('key numbers tie: workpaper rows, grouped sections, code summary total', async () => {
    const wp = await tbReports.buildTbWorkpaperReport(tenantId, companyId, END, 'accrual');
    // 3 accounts + totals row.
    expect(wp.data.length).toBe(4);

    const grouped = await tbReports.buildTbGroupedReport(tenantId, companyId, END, 'accrual');
    const bannerNames = grouped.data.filter((r) => r['account_number'] === '---').map((r) => r['name']);
    expect(String(bannerNames.find((n) => String(n).includes('Cash')))).toContain('Cash');

    const summary = await tbReports.buildTbCodeSummary(tenantId, companyId, END, 'accrual');
    // All three accounts share one code; TB nets to zero across all
    // accounts, so the single code line nets to zero too.
    expect(summary.data.length).toBe(1);
    expect(Number(summary.data[0]!['amount'])).toBeCloseTo(0, 2);

    const pl = await tbReports.buildTbTaxBasisPl(tenantId, companyId, END, 'accrual', null);
    const net = pl.data.find((r) => r['name'] === 'NET INCOME/(LOSS)')!;
    expect(Number(net['book'])).toBeCloseTo(800, 2);
  });

  it('leadsheets report: sign-off line per grouping, grouping_id scopes to one, used-marks legend', async () => {
    // Apply one tickmark to Cash; a second unused tickmark must NOT
    // reach the legend.
    const [used] = await db.insert(tbTickmarks).values({ tenantId, symbol: 'F', description: 'Footed', sortOrder: 1 }).returning();
    await db.insert(tbTickmarks).values({ tenantId, symbol: 'Z', description: 'Unused mark', sortOrder: 2 });
    await db.insert(tbTickmarkApplications).values({
      tenantId, companyId, taxYear: 2026, accountId: A['Cash']!, column: 'adjusted', tickmarkId: used!.id,
    });

    const all = await tbReports.buildTbLeadsheetsReport(tenantId, companyId, END, 'accrual');
    expect(all.title).toContain('Leadsheets');
    expect(all._exportColumns.some((c) => c.key === 'attachments')).toBe(true);
    const legendHeader = all.data.findIndex((r) => r['name'] === 'Tickmark Legend');
    expect(legendHeader).toBeGreaterThan(-1);
    const legendRows = all.data.slice(legendHeader + 1);
    expect(legendRows.map((r) => r['marks'])).toEqual(['F']);
    expect(legendRows[0]!['name']).toBe('Footed');
    // Every rendered leadsheet section carries a Prepared/Reviewed line
    // (the Tickmark Legend banner is a section marker too — exclude it).
    const sections = all.data.filter((r) => r['account_number'] === '---' && r['name'] !== 'Tickmark Legend').length;
    const sigLines = all.data.filter((r) => String(r['name']).startsWith('Prepared:')).length;
    expect(sections).toBeGreaterThan(0);
    expect(sigLines).toBe(sections);

    const [anyGrouping] = await db.select().from(tbGroupings)
      .where(and(eq(tbGroupings.tenantId, tenantId), eq(tbGroupings.companyId, companyId)))
      .limit(1);
    const single = await tbReports.buildTbLeadsheetsReport(tenantId, companyId, END, 'accrual', anyGrouping!.id);
    expect(single.title).toMatch(/^Leadsheet /);
    expect(single.data.filter((r) => r['account_number'] === '---' && r['name'] !== 'Tickmark Legend').length).toBe(1);

    await expect(tbReports.buildTbLeadsheetsReport(tenantId, companyId, END, 'accrual', '00000000-0000-0000-0000-000000000099'))
      .rejects.toMatchObject({ statusCode: 404 });
  });
});
