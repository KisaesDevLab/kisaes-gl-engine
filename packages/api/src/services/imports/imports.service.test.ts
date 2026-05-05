// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import ExcelJS from 'exceljs';
import { eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import {
  tenants,
  users,
  sessions,
  accounts,
  companies,
  contacts,
  auditLog,
  transactions,
  journalLines,
  tags,
  transactionTags,
  importSessions,
} from '../../db/schema/index.js';
import * as importsService from './imports.service.js';
import { createCompanyForTenant } from '../company.service.js';

let tenantId: string;
let companyId: string;
let userId: string;

async function cleanDb() {
  await db.delete(importSessions);
  await db.delete(transactionTags);
  await db.delete(tags);
  await db.delete(journalLines);
  await db.delete(transactions);
  await db.delete(auditLog);
  await db.delete(contacts);
  await db.delete(accounts);
  await db.delete(companies);
  await db.delete(sessions);
  await db.delete(users);
  await db.delete(tenants);
}

async function bootstrap() {
  const [tenant] = await db
    .insert(tenants)
    .values({ name: 'Imports Test', slug: 'imports-test-' + Date.now() })
    .returning();
  tenantId = tenant!.id;

  const company = await createCompanyForTenant(tenantId, 'Imports Test Co');
  companyId = company!.id;

  const [user] = await db
    .insert(users)
    .values({
      tenantId,
      email: `test-${Date.now()}@example.com`,
      passwordHash: 'unused',
      displayName: 'Test User',
      isActive: true,
    })
    .returning();
  userId = user!.id;
}

function fileFromText(name: string, text: string): { originalname: string; buffer: Buffer } {
  return { originalname: name, buffer: Buffer.from(text, 'utf8') };
}

async function xlsxFromGrid(name: string, sheetName: string, rows: unknown[][]): Promise<{ originalname: string; buffer: Buffer }> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  for (const r of rows) ws.addRow(r);
  const buffer = await wb.xlsx.writeBuffer();
  return { originalname: name, buffer: Buffer.from(buffer) };
}

describe('Imports Service', () => {
  beforeEach(async () => {
    await cleanDb();
    await bootstrap();
  });
  afterEach(async () => {
    await cleanDb();
  });

  // ── Accounting Power ────────────────────────────────────────────

  describe('Accounting Power CoA', () => {
    const csv = `Account, Description, Type, Class, Category, SubAccount Of
"1000","Cash - GSB Checking","A","CA - Current assets","Cash",""
"1100","Accounts receivable","A","CA - Current assets","Accounts Receivable",""
"2000","Accounts payable","L","CL - Current liabilities","Accounts Payable - Trade",""
"4000","Sales","I","Revenue","",""
"5000","Cost of sales","C","COGS","",""
`;

    it('round-trips and is idempotent', async () => {
      const out1 = await importsService.createSession({
        tenantId,
        companyId,
        userId,
        file: fileFromText('coa.csv', csv),
        kind: 'coa',
        sourceSystem: 'accounting_power',
        options: {},
      });
      expect(out1.session.errorCount).toBe(0);
      expect(out1.session.rowCount).toBe(5);

      const result1 = await importsService.commitSession(tenantId, companyId, userId, out1.session.id);
      expect(result1.result.created).toBe(5);
      expect(result1.result.skipped).toBe(0);

      // Run again — every row should now be skipped.
      const out2 = await importsService.createSession({
        tenantId,
        companyId,
        userId,
        file: fileFromText('coa-2.csv', csv),
        kind: 'coa',
        sourceSystem: 'accounting_power',
        options: {},
      });
      const result2 = await importsService.commitSession(tenantId, companyId, userId, out2.session.id);
      expect(result2.result.created).toBe(0);
      expect(result2.result.skipped).toBe(5);

      const allAccts = await db.select().from(accounts).where(eq(accounts.tenantId, tenantId));
      expect(allAccts.length).toBe(5);
      expect(allAccts.find((a) => a.accountNumber === '1000')!.accountType).toBe('asset');
      expect(allAccts.find((a) => a.accountNumber === '4000')!.accountType).toBe('revenue');
      expect(allAccts.find((a) => a.accountNumber === '5000')!.accountType).toBe('cogs');
    });
  });

  describe('Accounting Power Trial Balance', () => {
    const csv = `Account Code, Type, Description, Beginning Balance, Transactions Debit, Transactions Credit, Unadjusted Balance, Adjustments Debit, Adjustments Credit, Adjusted Balance, Income Statements Debit, Income Statements Credit, Balance Sheets Debit, Balance Sheets Credit, Tickmark, Notes
"1000","A","Cash","1,000.00","0.00","0.00","1,000.00","0.00","0.00","1,500.00","0.00","0.00","1,500.00","0.00","",""
"2000","L","Accounts payable","-1,000.00","0.00","0.00","-1,000.00","0.00","0.00","-1,500.00","0.00","0.00","0.00","1,500.00","",""
`;

    async function seedCoa() {
      await db.insert(accounts).values([
        { tenantId, companyId, accountNumber: '1000', name: 'Cash', accountType: 'asset' },
        { tenantId, companyId, accountNumber: '2000', name: 'Accounts payable', accountType: 'liability' },
      ]);
    }

    it('posts beginning + adjusted as separate JEs', async () => {
      await seedCoa();

      const beg = await importsService.createSession({
        tenantId,
        companyId,
        userId,
        file: fileFromText('tb.csv', csv),
        kind: 'trial_balance',
        sourceSystem: 'accounting_power',
        options: { tbColumn: 'beginning', tbReportDate: '2025-01-01' },
      });
      expect(beg.session.errorCount).toBe(0);
      const begCommit = await importsService.commitSession(tenantId, companyId, userId, beg.session.id);
      expect(begCommit.result.created).toBe(1);

      const adj = await importsService.createSession({
        tenantId,
        companyId,
        userId,
        file: fileFromText('tb.csv', csv),
        kind: 'trial_balance',
        sourceSystem: 'accounting_power',
        options: { tbColumn: 'adjusted', tbReportDate: '2025-12-31' },
      });
      const adjCommit = await importsService.commitSession(tenantId, companyId, userId, adj.session.id);
      expect(adjCommit.result.created).toBe(1);

      const txns = await db.select().from(transactions).where(eq(transactions.tenantId, tenantId));
      expect(txns.length).toBe(2);
      expect(txns.map((t) => t.txnDate).sort()).toEqual(['2025-01-01', '2025-12-31']);
    });

    it('refuses re-import of the same (date, column) combo', async () => {
      await seedCoa();
      const first = await importsService.createSession({
        tenantId,
        companyId,
        userId,
        file: fileFromText('tb.csv', csv),
        kind: 'trial_balance',
        sourceSystem: 'accounting_power',
        options: { tbColumn: 'beginning', tbReportDate: '2025-01-01' },
      });
      await importsService.commitSession(tenantId, companyId, userId, first.session.id);

      const second = await importsService.createSession({
        tenantId,
        companyId,
        userId,
        file: fileFromText('tb-again.csv', csv),
        kind: 'trial_balance',
        sourceSystem: 'accounting_power',
        options: { tbColumn: 'beginning', tbReportDate: '2025-01-01' },
      });
      await expect(
        importsService.commitSession(tenantId, companyId, userId, second.session.id),
      ).rejects.toMatchObject({ code: 'IMPORT_TB_DUPLICATE' });
    });
  });

  describe('Accounting Power GL with inline void', () => {
    // Original JE 7080: cash → AP for 100. Then a VOID with reversed
    // signs and "Check Voided" memo. Adapter should split into two JEs
    // (original + reversal); both balance, net to zero across both.
    const csv = `Journal, Date, Reference, Description, Account, Account Name, Debit Amount, Credit Amount, Memo, Department, Updated by
"CD","01/02/2025","7080","Wrapology","2000","Accounts payable",100.0000,0.0000,"","","u1"
"CD","01/02/2025","7080","Wrapology","1000","Cash",0.0000,100.0000,"","","u1"
"CD","01/02/2025","7080","Wrapology","2000","Accounts payable",0.0000,100.0000,"Check Voided","","u1"
"CD","01/02/2025","7080","Wrapology","1000","Cash",100.0000,0.0000,"Check Voided","","u1"
`;

    it('imports original + reversal and is idempotent', async () => {
      await db.insert(accounts).values([
        { tenantId, companyId, accountNumber: '1000', name: 'Cash', accountType: 'asset' },
        { tenantId, companyId, accountNumber: '2000', name: 'Accounts payable', accountType: 'liability' },
      ]);

      const out = await importsService.createSession({
        tenantId,
        companyId,
        userId,
        file: fileFromText('gl.csv', csv),
        kind: 'gl_transactions',
        sourceSystem: 'accounting_power',
        options: {},
      });
      expect(out.preview.jeGroupCount).toBe(2);
      expect(out.preview.voidEntryCount).toBe(1);

      const commit = await importsService.commitSession(tenantId, companyId, userId, out.session.id);
      expect(commit.result.created).toBe(2);
      expect(commit.result.voidsReversed).toBe(1);

      const txns = await db
        .select()
        .from(transactions)
        .where(eq(transactions.tenantId, tenantId));
      expect(txns.length).toBe(2);
      expect(txns.find((t) => /VOID/.test(t.memo ?? ''))).toBeDefined();

      // Re-commit (after a dup-upload): everything should be skipped.
      const again = await importsService.createSession({
        tenantId,
        companyId,
        userId,
        file: fileFromText('gl-again.csv', csv),
        kind: 'gl_transactions',
        sourceSystem: 'accounting_power',
        options: {},
      });
      const againCommit = await importsService.commitSession(
        tenantId,
        companyId,
        userId,
        again.session.id,
      );
      // sourceId is keyed on the file hash (not sessionId), so a
      // second upload of the same bytes generates the same sourceIds.
      // Every entry should be deduped against the rows posted by the
      // first commit, leaving zero new transactions.
      expect(againCommit.result.created).toBe(0);
      expect(againCommit.result.skipped).toBe(2);
      const txnCount = await db.select().from(transactions).where(eq(transactions.tenantId, tenantId));
      expect(txnCount.length).toBe(2); // unchanged from the first commit
    });

    it('does not classify lines with the substring "void" in unrelated memos as reversals', async () => {
      // The earlier `\bvoid(ed)?\b` regex would have flagged the second
      // line below as a reversal because the memo contains "Voided".
      // The tightened regex requires the memo to be *only* "void"/
      // "voided"/"check voided" (with optional whitespace), so an
      // explanatory memo that includes the word doesn't trigger.
      const csvFalsePositive = `Journal, Date, Reference, Description, Account, Account Name, Debit Amount, Credit Amount, Memo, Department, Updated by
"GJ","02/01/2025","ADJ-1","Reclass","6000","Office expense",50.0000,0.0000,"Voided invoice from 2023 was the source","","u1"
"GJ","02/01/2025","ADJ-1","Reclass","1000","Cash",0.0000,50.0000,"Voided invoice from 2023 was the source","","u1"
`;
      await db.insert(accounts).values([
        { tenantId, companyId, accountNumber: '1000', name: 'Cash', accountType: 'asset' },
        { tenantId, companyId, accountNumber: '6000', name: 'Office expense', accountType: 'expense' },
      ]);
      const out = await importsService.createSession({
        tenantId, companyId, userId,
        file: fileFromText('fp.csv', csvFalsePositive),
        kind: 'gl_transactions',
        sourceSystem: 'accounting_power',
        options: {},
      });
      // Single JE (no split into original + reversal).
      expect(out.preview.jeGroupCount).toBe(1);
      expect(out.preview.voidEntryCount).toBe(0);
    });
  });

  // ── QuickBooks Online ───────────────────────────────────────────

  describe('QuickBooks Online CoA', () => {
    it('round-trips with parent linking', async () => {
      const file = await xlsxFromGrid('coa.xlsx', 'Sheet1', [
        ['Account List'],
        ['Test Co'],
        [],
        ['Full name', 'Type', 'Detail type', 'Description', 'Total balance'],
        ['Income', 'Income', 'Sales of Product Income', '', ''],
        ['Income:Service', 'Income', 'Service/Fee Income', '', ''],
        ['Bank Account', 'Bank', 'Checking', '', '1000'],
      ]);
      const out = await importsService.createSession({
        tenantId,
        companyId,
        userId,
        file,
        kind: 'coa',
        sourceSystem: 'quickbooks_online',
        options: {},
      });
      expect(out.session.errorCount).toBe(0);
      const commit = await importsService.commitSession(tenantId, companyId, userId, out.session.id);
      expect(commit.result.created).toBe(3);

      const allAccts = await db.select().from(accounts).where(eq(accounts.tenantId, tenantId));
      const income = allAccts.find((a) => a.name === 'Income')!;
      const service = allAccts.find((a) => a.name === 'Service')!;
      expect(service.parentId).toBe(income.id);
    });
  });

  describe('QuickBooks Online Contacts', () => {
    it('imports customers and is idempotent', async () => {
      const file = await xlsxFromGrid('customers.xlsx', 'Customer Contact List', [
        ['Test Co'],
        ['Customer Contact List'],
        [],
        [],
        [null, 'Customer', 'Phone Numbers', 'Email', 'Full Name', 'Billing Address', 'Shipping Address'],
        [null, 'Acme Corp', '555-0100', 'a@example.com', 'Acme Corp', '1 Main St', null],
        [null, 'Beta LLC', null, null, 'Beta LLC', null, null],
      ]);
      const out = await importsService.createSession({
        tenantId,
        companyId,
        userId,
        file,
        kind: 'contacts',
        sourceSystem: 'quickbooks_online',
        options: { contactKind: 'customer' },
      });
      const commit = await importsService.commitSession(tenantId, companyId, userId, out.session.id);
      expect(commit.result.created).toBe(2);

      const re = await importsService.createSession({
        tenantId,
        companyId,
        userId,
        file: { ...file, originalname: 'customers-2.xlsx' },
        kind: 'contacts',
        sourceSystem: 'quickbooks_online',
        options: { contactKind: 'customer' },
      });
      const commit2 = await importsService.commitSession(tenantId, companyId, userId, re.session.id);
      expect(commit2.result.created).toBe(0);
      expect(commit2.result.skipped).toBe(2);
    });
  });

  describe('QuickBooks Online Trial Balance', () => {
    it('parses As-Of date and posts a single JE', async () => {
      await db.insert(accounts).values([
        { tenantId, companyId, name: 'Cash', accountType: 'asset' },
        { tenantId, companyId, name: 'Equity', accountType: 'equity' },
      ]);
      const file = await xlsxFromGrid('tb.xlsx', 'Trial Balance', [
        ['Test Co'],
        ['Trial Balance'],
        ['As of December 31, 2025'],
        [],
        [null, 'Debit', 'Credit'],
        ['Cash', 1000, null],
        ['Equity', null, 1000],
      ]);
      const out = await importsService.createSession({
        tenantId,
        companyId,
        userId,
        file,
        kind: 'trial_balance',
        sourceSystem: 'quickbooks_online',
        options: {},
      });
      expect(out.session.errorCount).toBe(0);
      expect(out.session.reportDate).toBe('2025-12-31');
      const commit = await importsService.commitSession(tenantId, companyId, userId, out.session.id);
      expect(commit.result.created).toBe(1);

      const txns = await db.select().from(transactions).where(eq(transactions.tenantId, tenantId));
      expect(txns.length).toBe(1);
      expect(txns[0]!.txnDate).toBe('2025-12-31');
    });
  });

  describe('QuickBooks Online GL Journal', () => {
    it('groups by JE header and posts each', async () => {
      await db.insert(accounts).values([
        { tenantId, companyId, name: 'Car Wash Checking', accountType: 'asset' },
        { tenantId, companyId, name: 'Operating Revenue', accountType: 'revenue' },
      ]);
      // 2 JEs, each 2 lines + a totals row + blank separator (mirrors
      // the layout of a real QBO Journal export).
      const file = await xlsxFromGrid('journal.xlsx', 'Journal', [
        ['Test Co'],
        ['Journal'],
        ['January 2025'],
        [],
        [null, 'Date', 'Transaction Type', 'Num', 'Name', 'Memo/Description', 'Account', 'Debit', 'Credit'],
        [null, '01/02/2025', 'Deposit', null, null, 'Sale 1', 'Car Wash Checking', 3.5, null],
        [null, null, null, null, null, 'Sale 1', 'Operating Revenue', null, 3.5],
        [null, null, null, null, null, null, null, 3.5, 3.5],
        [],
        [null, '01/03/2025', 'Deposit', null, null, 'Sale 2', 'Car Wash Checking', 9.25, null],
        [null, null, null, null, null, 'Sale 2', 'Operating Revenue', null, 9.25],
        [null, null, null, null, null, null, null, 9.25, 9.25],
      ]);
      const out = await importsService.createSession({
        tenantId,
        companyId,
        userId,
        file,
        kind: 'gl_transactions',
        sourceSystem: 'quickbooks_online',
        options: {},
      });
      expect(out.session.errorCount).toBe(0);
      expect(out.preview.jeGroupCount).toBe(2);

      const commit = await importsService.commitSession(tenantId, companyId, userId, out.session.id);
      expect(commit.result.created).toBe(2);

      const txns = await db.select().from(transactions).where(eq(transactions.tenantId, tenantId));
      expect(txns.length).toBe(2);
      expect(txns.map((t) => t.txnDate).sort()).toEqual(['2025-01-02', '2025-01-03']);
    });
  });

  // ── Error-path coverage ────────────────────────────────────────

  describe('error paths', () => {
    it('refuses GL commit when an account number is missing from the CoA', async () => {
      // CoA seeded with Cash but NOT 9999.
      await db.insert(accounts).values([
        { tenantId, companyId, accountNumber: '1000', name: 'Cash', accountType: 'asset' },
      ]);
      const csv = `Journal, Date, Reference, Description, Account, Account Name, Debit Amount, Credit Amount, Memo, Department, Updated by
"CD","01/02/2025","X1","Vendor","9999","Unknown",10.0000,0.0000,"","","u"
"CD","01/02/2025","X1","Vendor","1000","Cash",0.0000,10.0000,"","","u"
`;
      const out = await importsService.createSession({
        tenantId, companyId, userId,
        file: fileFromText('gl.csv', csv),
        kind: 'gl_transactions',
        sourceSystem: 'accounting_power',
        options: {},
      });
      // The unknown-account error should be flagged at validation time,
      // and committing should be refused via IMPORT_HAS_ERRORS.
      expect(out.session.errorCount).toBeGreaterThan(0);
      expect(out.validationErrors.some((e) => e.code === 'IMPORT_UNKNOWN_ACCOUNT')).toBe(true);
      await expect(
        importsService.commitSession(tenantId, companyId, userId, out.session.id),
      ).rejects.toMatchObject({ code: 'IMPORT_HAS_ERRORS' });
    });

    it('flags unbalanced JE with IMPORT_JE_UNBALANCED', async () => {
      await db.insert(accounts).values([
        { tenantId, companyId, accountNumber: '1000', name: 'Cash', accountType: 'asset' },
        { tenantId, companyId, accountNumber: '4000', name: 'Sales', accountType: 'revenue' },
      ]);
      const csv = `Journal, Date, Reference, Description, Account, Account Name, Debit Amount, Credit Amount, Memo, Department, Updated by
"GJ","01/02/2025","B1","Bad","1000","Cash",100.0000,0.0000,"","","u"
"GJ","01/02/2025","B1","Bad","4000","Sales",0.0000,99.0000,"","","u"
`;
      const out = await importsService.createSession({
        tenantId, companyId, userId,
        file: fileFromText('gl.csv', csv),
        kind: 'gl_transactions',
        sourceSystem: 'accounting_power',
        options: {},
      });
      expect(out.validationErrors.some((e) => e.code === 'IMPORT_JE_UNBALANCED')).toBe(true);
    });

    it('rejects an upload with a missing header (IMPORT_HEADER_NOT_FOUND)', async () => {
      const garbage = `random text\nthis is not a CoA\n`;
      const out = await importsService.createSession({
        tenantId, companyId, userId,
        file: fileFromText('garbage.csv', garbage),
        kind: 'coa',
        sourceSystem: 'accounting_power',
        options: {},
      });
      expect(out.validationErrors.some((e) => e.code === 'IMPORT_HEADER_NOT_FOUND')).toBe(true);
    });

    it('rejects AP TB upload without tbColumn or tbReportDate', async () => {
      // Missing options.tbColumn.
      await expect(
        importsService.createSession({
          tenantId, companyId, userId,
          file: fileFromText('tb.csv', 'Account Code,Type,Description,Beginning Balance\n'),
          kind: 'trial_balance',
          sourceSystem: 'accounting_power',
          options: {},
        }),
      ).rejects.toMatchObject({ code: 'IMPORT_TB_COLUMN_REQUIRED' });
    });
  });

  // ── Cross-tenant isolation ─────────────────────────────────────

  describe('cross-tenant scoping', () => {
    it('does not leak a session from tenant A when fetched as tenant B', async () => {
      // Create a session under the bootstrapped (tenant A, company A).
      await db.insert(accounts).values([
        { tenantId, companyId, accountNumber: '1000', name: 'Cash', accountType: 'asset' },
      ]);
      const apCsv = `Account, Description, Type, Class, Category, SubAccount Of
"1000","Cash","A","CA","",""
`;
      const a = await importsService.createSession({
        tenantId, companyId, userId,
        file: fileFromText('a-coa.csv', apCsv),
        kind: 'coa',
        sourceSystem: 'accounting_power',
        options: {},
      });

      // Spin up a second tenant + company.
      const [tenantB] = await db
        .insert(tenants)
        .values({ name: 'Other tenant', slug: 'other-tenant-' + Date.now() })
        .returning();
      const companyB = await createCompanyForTenant(tenantB!.id, 'Other Co');

      // getSession with tenant B + company B + tenant A's session id → null.
      const cross = await importsService.getSession(tenantB!.id, companyB!.id, a.session.id);
      expect(cross).toBeNull();

      // Commit attempt across tenants → notFound.
      await expect(
        importsService.commitSession(tenantB!.id, companyB!.id, userId, a.session.id),
      ).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  // ── AP CoA parent linking ──────────────────────────────────────

  describe('AP CoA parent linking', () => {
    it('links sub-accounts via SubAccount Of', async () => {
      const csv = `Account, Description, Type, Class, Category, SubAccount Of
"1000","Cash","A","CA","",""
"1010","Cash - Petty","A","CA","","1000"
"1020","Cash - Operating","A","CA","","1000"
`;
      const out = await importsService.createSession({
        tenantId, companyId, userId,
        file: fileFromText('coa.csv', csv),
        kind: 'coa',
        sourceSystem: 'accounting_power',
        options: {},
      });
      await importsService.commitSession(tenantId, companyId, userId, out.session.id);

      const all = await db.select().from(accounts).where(eq(accounts.tenantId, tenantId));
      const parent = all.find((a) => a.accountNumber === '1000')!;
      const child1 = all.find((a) => a.accountNumber === '1010')!;
      const child2 = all.find((a) => a.accountNumber === '1020')!;
      expect(child1.parentId).toBe(parent.id);
      expect(child2.parentId).toBe(parent.id);
      expect(parent.parentId).toBeNull();
    });
  });

  // ── AP TB column + signed-balance behavior ─────────────────────

  describe('AP TB signed-balance handling', () => {
    it('posts negative balance as a credit, not a debit', async () => {
      await db.insert(accounts).values([
        { tenantId, companyId, accountNumber: '1000', name: 'Cash', accountType: 'asset' },
        { tenantId, companyId, accountNumber: '2000', name: 'AP', accountType: 'liability' },
      ]);
      const csv = `Account Code, Type, Description, Beginning Balance, Transactions Debit, Transactions Credit, Unadjusted Balance, Adjustments Debit, Adjustments Credit, Adjusted Balance, Income Statements Debit, Income Statements Credit, Balance Sheets Debit, Balance Sheets Credit, Tickmark, Notes
"1000","A","Cash","500.00","0.00","0.00","500.00","0.00","0.00","500.00","0.00","0.00","500.00","0.00","",""
"2000","L","AP","-500.00","0.00","0.00","-500.00","0.00","0.00","-500.00","0.00","0.00","0.00","500.00","",""
`;
      const out = await importsService.createSession({
        tenantId, companyId, userId,
        file: fileFromText('tb.csv', csv),
        kind: 'trial_balance',
        sourceSystem: 'accounting_power',
        options: { tbColumn: 'beginning', tbReportDate: '2025-01-01' },
      });
      await importsService.commitSession(tenantId, companyId, userId, out.session.id);

      const txns = await db.select().from(transactions).where(eq(transactions.tenantId, tenantId));
      expect(txns.length).toBe(1);
      const lines = await db
        .select()
        .from(journalLines)
        .where(eq(journalLines.transactionId, txns[0]!.id));
      // Walk the lines via account ids; assert amounts.
      const acctRows = await db.select().from(accounts).where(eq(accounts.tenantId, tenantId));
      const cashId = acctRows.find((a) => a.accountNumber === '1000')!.id;
      const apId = acctRows.find((a) => a.accountNumber === '2000')!.id;
      const cashLine = lines.find((l) => l.accountId === cashId)!;
      const apLine = lines.find((l) => l.accountId === apId)!;
      // Cash (1000) had +500 → debit; AP (2000) had -500 → credit (abs).
      expect(parseFloat(cashLine.debit)).toBeCloseTo(500.0, 2);
      expect(parseFloat(cashLine.credit)).toBe(0);
      expect(parseFloat(apLine.credit)).toBeCloseTo(500.0, 2);
      expect(parseFloat(apLine.debit)).toBe(0);
    });
  });

  // ── QBO Vendor contacts ────────────────────────────────────────

  describe('QBO vendor contacts', () => {
    it('imports a Vendor sheet when contactKind=vendor', async () => {
      const file = await xlsxFromGrid('vendors.xlsx', 'Vendor Contact List', [
        ['Test Co'],
        ['Vendor Contact List'],
        [],
        [],
        [null, 'Vendor', 'Phone Numbers', 'Email', 'Full Name', 'Address', 'Account #'],
        [null, 'Acme Supplies', null, null, 'Acme Supplies LLC', '1 Main St', null],
        [null, 'Beta Subs', null, null, null, null, null],
      ]);
      const out = await importsService.createSession({
        tenantId, companyId, userId,
        file,
        kind: 'contacts',
        sourceSystem: 'quickbooks_online',
        options: { contactKind: 'vendor' },
      });
      const result = await importsService.commitSession(tenantId, companyId, userId, out.session.id);
      expect(result.result.created).toBe(2);

      const all = await db.select().from(contacts).where(eq(contacts.tenantId, tenantId));
      expect(all.every((c) => c.contactType === 'vendor')).toBe(true);
    });
  });

  // ── CoA updateExistingCoa option ──────────────────────────────

  describe('CoA updateExistingCoa', () => {
    it('overwrites name/detailType when the option is set', async () => {
      // Pre-existing account with old name.
      await db.insert(accounts).values([
        { tenantId, companyId, accountNumber: '1000', name: 'Old Name', accountType: 'asset', detailType: 'Old detail' },
      ]);
      const csv = `Account, Description, Type, Class, Category, SubAccount Of
"1000","Cash - Updated","A","CA","Cash",""
`;
      const out = await importsService.createSession({
        tenantId, companyId, userId,
        file: fileFromText('coa.csv', csv),
        kind: 'coa',
        sourceSystem: 'accounting_power',
        options: { updateExistingCoa: true },
      });
      const r = await importsService.commitSession(tenantId, companyId, userId, out.session.id);
      expect(r.result.created).toBe(0);
      expect(r.result.updated).toBe(1);

      const acct = (await db.select().from(accounts).where(eq(accounts.tenantId, tenantId)))[0]!;
      expect(acct.name).toBe('Cash - Updated');
      expect(acct.detailType).toBe('CA / Cash');
    });
  });
});
