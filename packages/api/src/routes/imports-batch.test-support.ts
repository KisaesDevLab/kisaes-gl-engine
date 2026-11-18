// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.
//
// Test support for the Bulk Import batch suites (U-261..U-263): synthetic
// Accounting Power files, a session uploader and companySnapshot, the exact
// company state an undone or failed batch must leave unchanged. Imported only
// by *.test.ts files.

import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  importSessions, importRows, importBatches, accounts, contacts, tags, tagGroups, items, transactions, companies,
} from '../db/schema/index.js';
import * as importsService from '../services/imports/imports.service.js';
import type { Co } from './receivables.test-support.js';

export const COA_CSV = `Account, Description, Type, Class, Category, SubAccount Of
"9101","Batch Checking","A","CA - Current assets","Cash",""
"9201","Batch Payables","L","CL - Current liabilities","Accounts Payable - Trade",""
"9301","Batch Equity","Q","Equity","",""
"9401","Batch Sales","I","Revenue","",""
"9501","Batch Supplies","E","Expenses","",""
`;

export const VENDORS_CSV = ` Vendor #, Name, Address 1, Address 2, City, State, Zip, Telephone, Fax, Email,1099, W-9, Active,Terms, Account, Dept Code
"","Synthetic Gravel Co","1 Test Rd","","Testville","MO","65000",,,"",False,False,True,,9501,""
"","Synthetic Paper LLC","2 Test Rd","","Testville","MO","65000",,,"",False,False,True,,9501,""
`;

export const TB_CSV = `Account Code, Type, Description, Beginning Balance, Transactions Debit, Transactions Credit, Unadjusted Balance, Adjustments Debit, Adjustments Credit, Adjusted Balance, Income Statements Debit, Income Statements Credit, Balance Sheets Debit, Balance Sheets Credit, Tickmark, Notes
"9101","A","Batch Checking","5,000.00","0.00","0.00","5,000.00","0.00","0.00","5,000.00","0.00","0.00","5,000.00","0.00","",""
"9301","Q","Batch Equity","-5,000.00","0.00","0.00","-5,000.00","0.00","0.00","-5,000.00","0.00","0.00","0.00","5,000.00","",""
`;

/** A journal file: one sale and one purchase per month in [months], dated the 15th of `year`. */
export function glCsv(year: number, months: number[], account = '9401'): string {
  const head = 'Journal, Date, Reference, Description, Account, Account Name, Debit Amount, Credit Amount, Memo, Department, Updated by\n';
  const rows: string[] = [];
  for (const m of months) {
    const d = `${String(m).padStart(2, '0')}/15/${year}`;
    rows.push(`"CR","${d}","S${year}${m}","Sale","9101","Batch Checking",120.5000,0.0000,"","","u1"`);
    rows.push(`"CR","${d}","S${year}${m}","Sale","${account}","${account === '9401' ? 'Batch Sales' : 'Nowhere'}",0.0000,120.5000,"","","u1"`);
    rows.push(`"CD","${d}","P${year}${m}","Paper","9501","Batch Supplies",40.2500,0.0000,"","","u1"`);
    rows.push(`"CD","${d}","P${year}${m}","Paper","9101","Batch Checking",0.0000,40.2500,"","","u1"`);
  }
  return head + rows.join('\n') + '\n';
}

export async function upload(
  co: Co, name: string, text: string, kind: 'coa' | 'contacts' | 'trial_balance' | 'gl_transactions',
  options: Record<string, unknown> = {}, role: 'post' | 'reference' = 'post',
): Promise<string> {
  const out = await importsService.createSession({
    tenantId: co.tenantId, companyId: co.companyId, userId: co.userId,
    file: { originalname: name, buffer: Buffer.from(text, 'utf8') },
    kind, sourceSystem: 'accounting_power', options: options as never, role,
  });
  return out.session.id;
}

/** The four files of a small conversion: chart, vendors, opening balances, one journal year. */
export async function uploadSet(co: Co, opts: { glAccount?: string; glOptions?: Record<string, unknown> } = {}) {
  return {
    coa: await upload(co, 'coa.csv', COA_CSV, 'coa'),
    vendors: await upload(co, 'vendors.csv', VENDORS_CSV, 'contacts', { contactKind: 'vendor' }),
    tb: await upload(co, 'tb.csv', TB_CSV, 'trial_balance', { tbColumn: 'beginning', tbReportDate: '2024-12-31' }),
    gl: await upload(co, 'gl-2025.csv', glCsv(2025, [1, 2, 3], opts.glAccount), 'gl_transactions', opts.glOptions ?? {}),
  };
}

const MONTH_ENDS = ['2024-12-31', '2025-01-31', '2025-02-28', '2025-03-31', '2025-06-30', '2025-12-31', '2099-12-31'];

/**
 * The company's state that an undone or failed batch must leave exactly as
 * it was: the exact trial balance at every month-end used and far ahead,
 * the stored account balances, timestamp-free dumps of accounts, contacts,
 * tags, groups, items, transactions and lines, and the fiscal month and
 * closing date. Excludes audit rows, batch and session rows and sequences.
 */
export async function companySnapshot(co: Co): Promise<Record<string, unknown>> {
  const tb: Record<string, unknown> = {};
  for (const d of MONTH_ENDS) {
    const r = await db.execute(sql`
      SELECT jl.account_id, SUM(jl.debit - jl.credit)::text AS net
      FROM journal_lines jl JOIN transactions t ON t.id = jl.transaction_id
      WHERE t.tenant_id = ${co.tenantId} AND t.company_id = ${co.companyId} AND t.status = 'posted' AND t.txn_date <= ${d}
      GROUP BY jl.account_id HAVING SUM(jl.debit - jl.credit) <> 0 ORDER BY jl.account_id`);
    tb[d] = r.rows;
  }
  const strip = <T extends Record<string, unknown>>(rows: T[]) => rows
    .map((r) => {
      const o: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(r)) if (!['createdAt', 'updatedAt', 'importBatchId'].includes(k)) o[k] = v;
      return o;
    })
    .sort((a, b) => String(a['id']).localeCompare(String(b['id'])));
  const lines = await db.execute(sql`
    SELECT jl.id, jl.transaction_id, jl.account_id, jl.debit::text, jl.credit::text, jl.tag_id, jl.contact_id
    FROM journal_lines jl WHERE jl.tenant_id = ${co.tenantId} ORDER BY jl.id`);
  const [co2] = await db.select({ m: companies.fiscalYearStartMonth, lock: companies.lockDate }).from(companies)
    .where(eq(companies.id, co.companyId));
  return {
    tb,
    accounts: strip(await db.select().from(accounts).where(eq(accounts.tenantId, co.tenantId))),
    contacts: strip(await db.select().from(contacts).where(eq(contacts.tenantId, co.tenantId))),
    tags: strip(await db.select().from(tags).where(eq(tags.tenantId, co.tenantId))),
    tagGroups: strip(await db.select().from(tagGroups).where(eq(tagGroups.tenantId, co.tenantId))),
    items: strip(await db.select().from(items).where(eq(items.tenantId, co.tenantId))),
    transactions: strip(await db.select().from(transactions).where(eq(transactions.tenantId, co.tenantId))),
    lines: lines.rows,
    applications: (await db.execute(sql`SELECT id, payment_id, invoice_id, amount::text, voided_at IS NOT NULL AS voided FROM payment_applications WHERE tenant_id = ${co.tenantId} ORDER BY id`)).rows,
    billApplications: (await db.execute(sql`SELECT id, payment_id, bill_id, amount::text FROM bill_payment_applications WHERE tenant_id = ${co.tenantId} ORDER BY id`)).rows,
    inventoryMovements: (await db.execute(sql`SELECT id, item_id, transaction_id FROM inventory_movements WHERE tenant_id = ${co.tenantId} ORDER BY id`)).rows,
    company: co2,
  };
}

/** Cleanup of the batch tables for a tenant (run before the harness's standard cleanup). */
export async function cleanImports(tenantId: string): Promise<void> {
  const ids = (await db.select({ id: importSessions.id }).from(importSessions).where(eq(importSessions.tenantId, tenantId))).map((r) => r.id);
  if (ids.length) await db.delete(importRows).where(inArray(importRows.sessionId, ids));
  await db.delete(importSessions).where(eq(importSessions.tenantId, tenantId));
  await db.delete(importBatches).where(eq(importBatches.tenantId, tenantId));
  await db.delete(tagGroups).where(eq(tagGroups.tenantId, tenantId));
}

export async function batchRow(id: string) {
  const [b] = await db.select().from(importBatches).where(eq(importBatches.id, id));
  return b!;
}

export async function stamped(co: Co, batchId: string) {
  const count = async (t: typeof accounts | typeof contacts | typeof transactions | typeof tags) =>
    (await db.select({ id: t.id }).from(t).where(and(eq(t.tenantId, co.tenantId), eq(t.importBatchId, batchId)))).length;
  return { accounts: await count(accounts), contacts: await count(contacts), transactions: await count(transactions), tags: await count(tags) };
}
