// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import type { PayrollJEPreview } from '@kis-books/shared';
import { db } from '../db/index.js';
import { tenants, companies, accounts, tags, payrollImportSessions } from '../db/schema/index.js';
import * as svc from './payroll-check-register.service.js';
import { resolvePayrollPostTags, grossOf } from './payroll-je.service.js';

const CHECKS_CSV = [
  'Check Number,Date,Payee Name,Cash Account,Account,Amount,Memo',
  'EFT,07/10/2026,US Treasury,11090,22300,3356.0700,021000020427405',
  '0,07/24/2026,Yaxiel Davila,11090,10000,0.0000,',
  '13313,07/10/2026,Maria Almaraz Ortega,11090,10000,759.2100,',
  'EFT,07/13/2026,Billing EFT Payment,11090,70000,282.0900,',
].join('\n');

let tenantId = '';
let companyId = '';
let sessionId = '';
const acct: Record<string, string> = {};
let tagId = '';
const USER_ID = '00000000-0000-4000-8000-0000000000aa';

async function cleanup() {
  if (!tenantId) return;
  await db.execute(sql`DELETE FROM payroll_check_register_rows WHERE session_id IN (SELECT id FROM payroll_import_sessions WHERE tenant_id = ${tenantId})`);
  for (const tbl of ['journal_lines', 'transaction_tags', 'transactions', 'payroll_import_sessions', 'tags', 'accounts', 'audit_log', 'gl_version_stamps', 'companies']) {
    await db.execute(sql`DELETE FROM ${sql.identifier(tbl)} WHERE tenant_id = ${tenantId}`);
  }
  await db.execute(sql`DELETE FROM tenants WHERE id = ${tenantId}`);
  tenantId = '';
}

beforeEach(async () => {
  await cleanup();
  const [t] = await db.insert(tenants).values({
    name: 'Check Register Test',
    slug: 'chkreg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
  }).returning();
  tenantId = t!.id;
  const [c] = await db.insert(companies).values({ tenantId, businessName: 'Check Register Co' }).returning();
  companyId = c!.id;
  for (const [num, name, accountType] of [
    ['11090', 'Cash - Payroll', 'asset'],
    ['10000', 'Payroll Clearing', 'asset'],
    ['22300', 'Accrued Federal Payroll Taxes', 'liability'],
  ] as const) {
    const [a] = await db.insert(accounts).values({ tenantId, companyId, name, accountType, accountNumber: num }).returning();
    acct[num] = a!.id;
  }
  const [tag] = await db.insert(tags).values({ tenantId, name: 'Location 2' }).returning();
  tagId = tag!.id;
  const [s] = await db.insert(payrollImportSessions).values({
    tenantId, companyId, importMode: 'check_register', originalFilename: 'Checks.csv',
    filePath: '/tmp/Checks.csv', fileHash: 'hash-' + tenantId, status: 'uploaded', rowCount: 4,
  }).returning();
  sessionId = s!.id;
  await svc.storeCheckRegisterFile(tenantId, sessionId, Buffer.from(CHECKS_CSV), 'Checks.csv');
});
afterEach(cleanup);

async function linesFor(transactionIds: string[]) {
  const res = await db.execute(sql`
    SELECT jl.transaction_id, jl.account_id, jl.debit::numeric AS debit, jl.credit::numeric AS credit, jl.tag_id,
           t.txn_type, t.reference_number
    FROM journal_lines jl JOIN transactions t ON t.id = jl.transaction_id
    WHERE jl.tenant_id = ${tenantId} AND jl.transaction_id IN (${sql.join(transactionIds.map((id) => sql`${id}::uuid`), sql`, `)})`);
  return res.rows as Array<{ transaction_id: string; account_id: string; debit: string; credit: string; tag_id: string | null; txn_type: string; reference_number: string | null }>;
}

describe('check-register payroll import', () => {
  it('stores checks with their account numbers, drops $0 voids, and resolves the numbers', async () => {
    const reg = await svc.getCheckRegister(tenantId, sessionId);
    expect(reg.checks).toHaveLength(3);
    expect(reg.skippedZeroCount).toBe(1);
    expect(reg.cashCodes).toEqual([{ code: '11090', accountId: acct['11090'], accountName: 'Cash - Payroll', checkCount: 3 }]);
    const byCode = Object.fromEntries(reg.offsetCodes.map((c) => [c.code, c.accountId]));
    expect(byCode['22300']).toBe(acct['22300']);
    expect(byCode['10000']).toBe(acct['10000']);
    expect(byCode['70000']).toBeNull(); // not in this chart of accounts
  });

  it('posts every check to one chosen account, paid from the file’s cash account, tagged', async () => {
    const res = await svc.postCheckRegister(tenantId, sessionId, {
      cashSource: 'file', offsetSource: 'account', offsetAccountId: acct['10000'], tagId,
    }, USER_ID, companyId);
    expect(res.posted).toBe(3);

    const lines = await linesFor(res.transactionIds);
    expect(lines).toHaveLength(6);
    for (const l of lines) {
      expect(l.txn_type).toBe('check');
      expect(l.tag_id).toBe(tagId);
      if (Number(l.debit) > 0) expect(l.account_id).toBe(acct['10000']);
      else expect(l.account_id).toBe(acct['11090']);
    }
    // Header tags too (written by the ledger with TAGS_SPLIT_LEVEL_V2 on, by
    // the import with it off) — one row per check either way.
    const tt = await db.execute(sql`SELECT count(*)::int AS c FROM transaction_tags WHERE tenant_id = ${tenantId} AND tag_id = ${tagId}`);
    expect((tt.rows[0] as { c: number }).c).toBe(3);
    const treasury = lines.find((l) => Number(l.credit) === 3356.07);
    expect(treasury?.reference_number).toBe('EFT');

    const [session] = await db.select().from(payrollImportSessions).where(eq(payrollImportSessions.id, sessionId));
    expect(session!.status).toBe('posted');
    await expect(svc.postCheckRegister(tenantId, sessionId, {
      cashSource: 'file', offsetSource: 'account', offsetAccountId: acct['10000'],
    }, USER_ID, companyId)).rejects.toThrow(/already posted/i);
  });

  it('refuses the whole file when an Account number has no match, posting nothing', async () => {
    await expect(svc.postCheckRegister(tenantId, sessionId, {
      cashSource: 'file', offsetSource: 'file',
    }, USER_ID, companyId)).rejects.toThrow(/offset account 70000/);
    const res = await db.execute(sql`SELECT count(*)::int AS c FROM transactions WHERE tenant_id = ${tenantId}`);
    expect((res.rows[0] as { c: number }).c).toBe(0);
  });

  it('posts each check to the file’s own Account once every number resolves', async () => {
    await db.insert(accounts).values({ tenantId, companyId, name: 'Payroll Taxes', accountType: 'expense', accountNumber: '70000' });
    const res = await svc.postCheckRegister(tenantId, sessionId, {
      cashSource: 'account', cashAccountId: acct['11090'], offsetSource: 'file',
    }, USER_ID, companyId);
    const lines = await linesFor(res.transactionIds);
    const treasuryDebit = lines.find((l) => Number(l.debit) === 3356.07);
    expect(treasuryDebit?.account_id).toBe(acct['22300']);
  });
});

describe('payroll JE post tags', () => {
  const previews: PayrollJEPreview[] = [{
    date: '2026-07-10', memo: 'Payroll', totalDebits: '10.00', totalCredits: '10.00', isBalanced: true,
    lines: [
      { lineType: 'w', description: 'Wages', accountId: null, accountName: null, accountNumber: null, debit: '10.00', credit: '0.00' },
      { lineType: 'n', description: 'Net', accountId: null, accountName: null, accountNumber: null, debit: '0.00', credit: '10.00' },
    ],
  }];

  it('applies the all-lines tag with per-line overrides', async () => {
    const tagFor = await resolvePayrollPostTags(tenantId, previews, {
      tagId, lineTags: [{ jeIndex: 0, lineIndex: 1, date: '2026-07-10', tagId: null }],
    });
    expect(tagFor(0, 0)).toBe(tagId);
    expect(tagFor(0, 1)).toBeNull();
  });

  it('rejects overrides for a preview that changed', async () => {
    await expect(resolvePayrollPostTags(tenantId, previews, {
      lineTags: [{ jeIndex: 0, lineIndex: 0, date: '2026-07-24', tagId }],
    })).rejects.toThrow(/preview changed/);
  });

  it('rejects another tenant’s tag', async () => {
    await expect(resolvePayrollPostTags(tenantId, previews, { tagId: '00000000-0000-4000-8000-000000000000' }))
      .rejects.toThrow(/do not belong/);
  });

  it('gross pay defaults to net pay when the file has none', () => {
    expect(grossOf({ net_pay: 759.21 })).toBe(759.21);
    expect(grossOf({ net_pay: 700, gross_pay: 900 })).toBe(900);
  });
});
