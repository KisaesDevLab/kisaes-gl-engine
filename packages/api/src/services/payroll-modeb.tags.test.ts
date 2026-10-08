// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, companies, accounts, tags, payrollImportSessions, payrollImportRows } from '../db/schema/index.js';
import * as importService from './payroll-import.service.js';
import * as modeB from './payroll-modeb.service.js';

const USER_ID = '00000000-0000-4000-8000-0000000000bb';
let tenantId = '';
let companyId = '';
let sessionId = '';
let wagesAcct = '';
let fitAcct = '';
let cashAcct = '';
let bentonville = '';
let rogers = '';

const GL_ROWS = [
  { Description: 'Wages and Salary - Bentonville', Debit: '100.00', Credit: '' },
  { Description: 'Federal Withholding', Debit: '', Credit: '10.00' },
  { Description: 'Net Payroll', Debit: '', Credit: '90.00' },
];

async function cleanup() {
  if (!tenantId) return;
  for (const tbl of ['journal_lines', 'transaction_tags', 'transactions', 'payroll_description_account_map', 'tags', 'accounts', 'audit_log', 'gl_version_stamps']) {
    await db.execute(sql`DELETE FROM ${sql.identifier(tbl)} WHERE tenant_id = ${tenantId}`);
  }
  await db.execute(sql`DELETE FROM payroll_import_rows WHERE session_id IN (SELECT id FROM payroll_import_sessions WHERE tenant_id = ${tenantId})`);
  for (const tbl of ['payroll_import_sessions', 'companies']) {
    await db.execute(sql`DELETE FROM ${sql.identifier(tbl)} WHERE tenant_id = ${tenantId}`);
  }
  await db.execute(sql`DELETE FROM tenants WHERE id = ${tenantId}`);
  tenantId = '';
}

beforeEach(async () => {
  await cleanup();
  const [t] = await db.insert(tenants).values({
    name: 'Payroll Tag Test',
    slug: 'paytag-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
  }).returning();
  tenantId = t!.id;
  const [c] = await db.insert(companies).values({ tenantId, businessName: 'Payroll Tag Co' }).returning();
  companyId = c!.id;
  const mk = async (name: string, accountType: string, accountNumber: string) =>
    (await db.insert(accounts).values({ tenantId, companyId, name, accountType, accountNumber }).returning())[0]!.id;
  wagesAcct = await mk('Wages', 'expense', '60000');
  fitAcct = await mk('Accrued FIT', 'liability', '25100');
  cashAcct = await mk('Cash', 'asset', '10100');
  bentonville = (await db.insert(tags).values({ tenantId, name: 'Bentonville' }).returning())[0]!.id;
  rogers = (await db.insert(tags).values({ tenantId, name: 'Rogers' }).returning())[0]!.id;

  const [s] = await db.insert(payrollImportSessions).values({
    tenantId, companyId, importMode: 'prebuilt_je', originalFilename: 'GLEntries.csv',
    filePath: '/tmp/GLEntries.csv', fileHash: 'hash-' + tenantId, status: 'uploaded', rowCount: GL_ROWS.length,
    metadata: { detectedProvider: 'payroll_relief_gl' },
  }).returning();
  sessionId = s!.id;
  await db.insert(payrollImportRows).values(GL_ROWS.map((r, i) => ({
    sessionId,
    rowNumber: i + 1,
    rawData: { Date: '07/10/2026', Reference: 'PR1', Account: '', Memo: '', ...r },
  })));
});
afterEach(cleanup);

describe('Mode B description-mapping tags', () => {
  it('suggests a tag from the " - <Tag name>" suffix only', async () => {
    const map = await importService.getDescriptionMap(tenantId, sessionId);
    const byDesc = Object.fromEntries(map.map((m) => [m.sourceDescription, m]));
    expect(byDesc['Wages and Salary - Bentonville']!.tagId).toBe(bentonville);
    expect(byDesc['Wages and Salary - Bentonville']!.tagSuggested).toBe(true);
    expect(byDesc['Federal Withholding']!.tagId).toBeNull();
  });

  it('saves the tag with the mapping, reuses it, and stamps it on the posted lines', async () => {
    await importService.saveDescriptionMap(tenantId, sessionId, 'payroll_relief_gl', [
      { sourceDescription: 'Wages and Salary - Bentonville', accountId: wagesAcct, tagId: bentonville },
      { sourceDescription: 'Federal Withholding', accountId: fitAcct, tagId: rogers },
      { sourceDescription: 'Net Payroll', accountId: cashAcct, tagId: null },
    ]);

    // The saved tag comes back as saved, not as a suggestion.
    const map = await importService.getDescriptionMap(tenantId, sessionId);
    const fit = map.find((m) => m.sourceDescription === 'Federal Withholding')!;
    expect(fit.tagId).toBe(rogers);
    expect(fit.tagSuggested).toBe(false);

    // Per-line override on the preview wins over the mapping for that line.
    const res = await modeB.postModeBJE(tenantId, sessionId, USER_ID, true, companyId, {
      lineTags: [{ jeIndex: 0, lineIndex: 2, date: '2026-07-10', tagId: rogers }],
    });
    expect('journalEntryIds' in res ? res.journalEntryIds?.length : 0).toBe(1);

    const rows = (await db.execute(sql`
      SELECT account_id, tag_id FROM journal_lines WHERE tenant_id = ${tenantId}`)).rows as Array<{ account_id: string; tag_id: string | null }>;
    const tagOf = Object.fromEntries(rows.map((r) => [r.account_id, r.tag_id]));
    expect(tagOf[wagesAcct]).toBe(bentonville);
    expect(tagOf[fitAcct]).toBe(rogers);
    expect(tagOf[cashAcct]).toBe(rogers); // the override
  });

  it('a tag chosen for all lines replaces the mapped tags', async () => {
    await importService.saveDescriptionMap(tenantId, sessionId, 'payroll_relief_gl', [
      { sourceDescription: 'Wages and Salary - Bentonville', accountId: wagesAcct, tagId: bentonville },
      { sourceDescription: 'Federal Withholding', accountId: fitAcct },
      { sourceDescription: 'Net Payroll', accountId: cashAcct },
    ]);
    await modeB.postModeBJE(tenantId, sessionId, USER_ID, true, companyId, { tagId: rogers });
    const rows = (await db.execute(sql`
      SELECT DISTINCT tag_id FROM journal_lines WHERE tenant_id = ${tenantId}`)).rows as Array<{ tag_id: string | null }>;
    expect(rows.map((r) => r.tag_id)).toEqual([rogers]);
  });

  it('rejects another tenant’s tag on save', async () => {
    await expect(importService.saveDescriptionMap(tenantId, sessionId, 'payroll_relief_gl', [
      { sourceDescription: 'Net Payroll', accountId: cashAcct, tagId: '00000000-0000-4000-8000-000000000000' },
    ])).rejects.toThrow(/do not belong/);
  });
});
