// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import ExcelJS from 'exceljs';
import { eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import {
  tenants,
  users,
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

// Tenant-SCOPED cleanup. The previous version deleted every row of
// every table, which nuked concurrently-running suites' data — and
// blew up on FKs those suites hold (e.g. bank_statements → accounts),
// failing this whole file whenever another test happened to have
// in-flight rows. Only ever touch our own tenant.
async function cleanDb() {
  if (!tenantId) return;
  await db.delete(importSessions).where(eq(importSessions.tenantId, tenantId));
  await db.delete(transactionTags).where(eq(transactionTags.tenantId, tenantId));
  await db.delete(tags).where(eq(tags.tenantId, tenantId));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(contacts).where(eq(contacts.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(users).where(eq(users.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  tenantId = '';
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

    it('maps E to EXPENSE (not equity) and Q to equity', async () => {
      // Regression: E was mapped to 'equity', silently flipping every
      // Accounting Power expense account onto the balance sheet.
      const csvEQ = `Account, Description, Type, Class, Category, SubAccount Of
"3000","Owner capital","Q","Equity","",""
"6000","Rent expense","E","Expenses","",""
`;
      const out = await importsService.createSession({
        tenantId, companyId, userId,
        file: fileFromText('coa-eq.csv', csvEQ),
        kind: 'coa', sourceSystem: 'accounting_power', options: {},
      });
      expect(out.session.errorCount).toBe(0);
      await importsService.commitSession(tenantId, companyId, userId, out.session.id);
      const allAccts = await db.select().from(accounts).where(eq(accounts.tenantId, tenantId));
      expect(allAccts.find((a) => a.accountNumber === '6000')!.accountType).toBe('expense');
      expect(allAccts.find((a) => a.accountNumber === '3000')!.accountType).toBe('equity');
    });
  });

  describe('QuickBooks Online CoA (CSV export)', () => {
    it('parses the QBO CSV format with account numbers and skips junk rows', async () => {
      // QBO exports the CoA as CSV (not XLSX) with these exact columns;
      // this format previously threw IMPORT_INVALID_FORMAT (ExcelJS on CSV).
      const csv = `Account number,Full Name,Account type,Detail type
11000,CASH - Operating,Bank,Checking
20100,Cards Payable,Credit Card,Credit Card
96000,Interest Expense,Other Expense,Other Miscellaneous Expense
TOTAL,,,
"Wednesday, Jul 15, 2026 09:03:29 AM GMT-7",,,
`;
      const out = await importsService.createSession({
        tenantId, companyId, userId,
        file: fileFromText('qbo-coa.csv', csv),
        kind: 'coa', sourceSystem: 'quickbooks_online', options: {},
      });
      expect(out.session.errorCount).toBe(0);
      expect(out.session.rowCount).toBe(3);
      await importsService.commitSession(tenantId, companyId, userId, out.session.id);
      const allAccts = await db.select().from(accounts).where(eq(accounts.tenantId, tenantId));
      expect(allAccts).toHaveLength(3);
      expect(allAccts.find((a) => a.name === 'CASH - Operating')!.accountType).toBe('asset');
      expect(allAccts.find((a) => a.name === 'CASH - Operating')!.accountNumber).toBe('11000');
      expect(allAccts.find((a) => a.name === 'Interest Expense')!.accountType).toBe('other_expense');
    });

    it('accepts the "Account name" header variant and rows without numbers', async () => {
      // QBO emits "Account name" (not "Full Name") on some export paths;
      // this variant previously produced a SILENT zero-row session.
      const csv = `Account number,Account name,Account type,Detail type
11000,CASH - Freedom,Bank,Checking
,Reconciliation Discrepancies,Other Expense,Other Miscellaneous Expense
`;
      const out = await importsService.createSession({
        tenantId, companyId, userId,
        file: fileFromText('qbo-coa-name-variant.csv', csv),
        kind: 'coa', sourceSystem: 'quickbooks_online', options: {},
      });
      expect(out.session.errorCount).toBe(0);
      expect(out.session.rowCount).toBe(2);
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

  describe('Accounting Power vendor contacts', () => {
    // Real AP vendor export shape: leading-space headers, quoted fields,
    // embedded newlines inside quoted addresses, True/False 1099 flag.
    const csv = ` Vendor #, Name, Address 1, Address 2, City, State, Zip, Telephone, Fax, Email,1099, W-9, Active,Terms, Account, Dept Code
"","3 Way Construction","11646 Farm Road 2030","","Monett","MO","65708",,,"",True,False,True,,6390,""
"","Barry County Youth Camp","Barry County Youth Camp
Cythia Martin","","Monett","MO","65708",,,"",False,False,True,Net 15,5920,""
"","Shane Shaffer","27348 Cimarron Dr","","Eagle Rock","MO","65641",,,"shaffereleven@gmail.com",False,False,True,,6390,""
`;

    it('imports AP vendors with 1099 flag and multi-line addresses', async () => {
      const out = await importsService.createSession({
        tenantId, companyId, userId,
        file: fileFromText('vendors.csv', csv),
        kind: 'contacts',
        sourceSystem: 'accounting_power',
        options: { contactKind: 'vendor' },
      });
      expect(out.validationErrors).toHaveLength(0);
      expect(out.preview.totalRows).toBe(3);

      const commit = await importsService.commitSession(tenantId, companyId, userId, out.session.id);
      expect(commit.result.created).toBe(3);

      const rows = await db.select().from(contacts).where(eq(contacts.tenantId, tenantId));
      const threeWay = rows.find((r) => r.displayName === '3 Way Construction');
      expect(threeWay?.is1099Eligible).toBe(true);
      expect(threeWay?.contactType).toBe('vendor');
      const camp = rows.find((r) => r.displayName === 'Barry County Youth Camp');
      expect(camp?.is1099Eligible).toBe(false);
      expect(camp?.billingLine1).toContain('Barry County Youth Camp');
      const shane = rows.find((r) => r.displayName === 'Shane Shaffer');
      expect(shane?.email).toBe('shaffereleven@gmail.com');
    });

    it('links the AP "Account" column to the vendor default expense account', async () => {
      // COA is imported before vendors in a migration — seed the 6390
      // account; 5920 is deliberately absent so its vendor stays
      // unlinked (never a failure).
      const [exp6390] = await db.insert(accounts).values([
        { tenantId, companyId, accountNumber: '6390', name: 'Repairs & Maintenance', accountType: 'expense' },
      ]).returning();

      const out = await importsService.createSession({
        tenantId, companyId, userId,
        file: fileFromText('vendors.csv', csv),
        kind: 'contacts',
        sourceSystem: 'accounting_power',
        options: { contactKind: 'vendor' },
      });
      const commit = await importsService.commitSession(tenantId, companyId, userId, out.session.id);
      expect(commit.result.created).toBe(3);
      // 3 Way Construction (6390) + Shane Shaffer (6390) resolve; the
      // camp's 5920 has no COA match.
      expect(commit.result.accountsLinked).toBe(2);

      const rows = await db.select().from(contacts).where(eq(contacts.tenantId, tenantId));
      expect(rows.find((r) => r.displayName === '3 Way Construction')?.defaultExpenseAccountId).toBe(exp6390!.id);
      expect(rows.find((r) => r.displayName === 'Shane Shaffer')?.defaultExpenseAccountId).toBe(exp6390!.id);
      expect(rows.find((r) => r.displayName === 'Barry County Youth Camp')?.defaultExpenseAccountId).toBeNull();
    });
  });

  describe('Accounting Power GL with zero-amount lines', () => {
    // AP exports emit placeholder rows with 0.00 in BOTH columns, and
    // occasionally an entirely-zero entry. These used to fail the whole
    // import at commit ("Transaction must have non-zero amounts").
    const csv = `Journal, Date, Reference, Description, Account, Account Name, Debit Amount, Credit Amount, Memo, Department, Updated by
"GJ","01/05/2025","9001","Sale","1000","Cash",250.0000,0.0000,"","","u1"
"GJ","01/05/2025","9001","Sale","4000","Sales",0.0000,250.0000,"","","u1"
"GJ","01/05/2025","9001","Sale","4000","Sales",0.0000,0.0000,"placeholder","","u1"
"GJ","01/06/2025","9002","Zero memo entry","1000","Cash",0.0000,0.0000,"","","u1"
"GJ","01/06/2025","9002","Zero memo entry","4000","Sales",0.0000,0.0000,"","","u1"
`;

    it('drops zero lines, skips all-zero entries, and commits', async () => {
      await db.insert(accounts).values([
        { tenantId, companyId, accountNumber: '1000', name: 'Cash', accountType: 'asset' },
        { tenantId, companyId, accountNumber: '4000', name: 'Sales', accountType: 'revenue' },
      ]);
      const out = await importsService.createSession({
        tenantId, companyId, userId,
        file: fileFromText('gl-zero.csv', csv),
        kind: 'gl_transactions',
        sourceSystem: 'accounting_power',
        options: {},
      });
      // Only the real JE survives; the all-zero entry is skipped.
      expect(out.preview.jeGroupCount).toBe(1);
      expect(out.validationErrors).toHaveLength(0);
      const commit = await importsService.commitSession(tenantId, companyId, userId, out.session.id);
      expect(commit.result.created).toBe(1);
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

    it('matches a GL description to an existing vendor (case-insensitive) and sets the payee', async () => {
      await db.insert(accounts).values([
        { tenantId, companyId, accountNumber: '1000', name: 'Cash', accountType: 'asset' },
        { tenantId, companyId, accountNumber: '6000', name: 'Office expense', accountType: 'expense' },
      ]);
      const [vendor] = await db.insert(contacts).values({
        tenantId, companyId, displayName: 'Acme Supplies', contactType: 'vendor', isActive: true,
      }).returning();

      // Description differs in case/punctuation from the vendor name.
      const csv = `Journal, Date, Reference, Description, Account, Account Name, Debit Amount, Credit Amount, Memo, Department, Updated by
"GJ","03/01/2025","V-1","ACME SUPPLIES","6000","Office expense",100.0000,0.0000,"","","u1"
"GJ","03/01/2025","V-1","ACME SUPPLIES","1000","Cash",0.0000,100.0000,"","","u1"
`;
      const out = await importsService.createSession({
        tenantId, companyId, userId,
        file: fileFromText('gl-vendor.csv', csv),
        kind: 'gl_transactions',
        sourceSystem: 'accounting_power',
        options: {},
      });
      const commit = await importsService.commitSession(tenantId, companyId, userId, out.session.id);
      expect(commit.result.created).toBe(1);
      expect(commit.result.vendorsMatched).toBe(1);

      const txns = await db.select().from(transactions).where(eq(transactions.tenantId, tenantId));
      expect(txns.length).toBe(1);
      expect(txns[0]!.contactId).toBe(vendor!.id);
    });

    it('leaves the payee blank when the description matches no vendor', async () => {
      await db.insert(accounts).values([
        { tenantId, companyId, accountNumber: '1000', name: 'Cash', accountType: 'asset' },
        { tenantId, companyId, accountNumber: '6000', name: 'Office expense', accountType: 'expense' },
      ]);
      await db.insert(contacts).values({
        tenantId, companyId, displayName: 'Acme Supplies', contactType: 'vendor', isActive: true,
      });
      const csv = `Journal, Date, Reference, Description, Account, Account Name, Debit Amount, Credit Amount, Memo, Department, Updated by
"GJ","03/02/2025","N-1","Some unrelated memo line","6000","Office expense",25.0000,0.0000,"","","u1"
"GJ","03/02/2025","N-1","Some unrelated memo line","1000","Cash",0.0000,25.0000,"","","u1"
`;
      const out = await importsService.createSession({
        tenantId, companyId, userId,
        file: fileFromText('gl-novendor.csv', csv),
        kind: 'gl_transactions',
        sourceSystem: 'accounting_power',
        options: {},
      });
      const commit = await importsService.commitSession(tenantId, companyId, userId, out.session.id);
      expect(commit.result.vendorsMatched).toBe(0);
      const txns = await db.select().from(transactions).where(eq(transactions.tenantId, tenantId));
      expect(txns.length).toBe(1);
      expect(txns[0]!.contactId).toBeNull();
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

    it('skips the grand-TOTAL and trailing timestamp rows (real QBO footer)', async () => {
      await db.insert(accounts).values([
        { tenantId, companyId, name: 'Car Wash Checking', accountType: 'asset' },
        { tenantId, companyId, name: 'Operating Revenue', accountType: 'revenue' },
      ]);
      const file = await xlsxFromGrid('journal-footer.xlsx', 'Journal', [
        ['Test Co'],
        ['Journal'],
        ['All Dates'],
        [],
        [null, 'Date', 'Transaction Type', 'Num', 'Name', 'Memo/Description', 'Account', 'Debit', 'Credit'],
        [null, '01/02/2025', 'Deposit', null, null, 'Sale 1', 'Car Wash Checking', 3.5, null],
        [null, null, null, null, null, 'Sale 1', 'Operating Revenue', null, 3.5],
        [null, null, null, null, null, null, null, 3.5, 3.5],
        [],
        [null, 'TOTAL', null, null, null, null, null, 3.5, 3.5],
        [],
        ['Wednesday, Jul 15, 2026 09:03:29 AM GMT-7 - Accrual Basis'],
      ]);
      const out = await importsService.createSession({
        tenantId, companyId, userId,
        file, kind: 'gl_transactions', sourceSystem: 'quickbooks_online', options: {},
      });
      expect(out.session.errorCount).toBe(0);
      expect(out.preview.jeGroupCount).toBe(1);
    });

    it('does NOT treat a JE line for an account named "Total ..." as a footer', async () => {
      await db.insert(accounts).values([
        { tenantId, companyId, name: 'Total Car Care', accountType: 'expense' },
        { tenantId, companyId, name: 'Operating Cash', accountType: 'asset' },
      ]);
      const file = await xlsxFromGrid('journal-total-acct.xlsx', 'Journal', [
        ['Test Co'], ['Journal'], ['All Dates'], [],
        [null, 'Date', 'Transaction Type', 'Num', 'Name', 'Memo/Description', 'Account', 'Debit', 'Credit'],
        [null, '01/05/2025', 'Expense', null, null, 'Wash', 'Total Car Care', 10, null],
        [null, null, null, null, null, 'Wash', 'Operating Cash', null, 10],
        [null, null, null, null, null, null, null, 10, 10],
      ]);
      const out = await importsService.createSession({
        tenantId, companyId, userId,
        file, kind: 'gl_transactions', sourceSystem: 'quickbooks_online', options: {},
      });
      expect(out.session.errorCount).toBe(0);
      expect(out.preview.jeGroupCount).toBe(1);
      // The "Total Car Care" line must survive — the JE has both lines.
      const commit = await importsService.commitSession(tenantId, companyId, userId, out.session.id);
      expect(commit.result.created).toBe(1);
    });

    it('skips a between-entry "Total <group>" subtotal without erroring', async () => {
      await db.insert(accounts).values([
        { tenantId, companyId, name: 'Car Wash Checking', accountType: 'asset' },
        { tenantId, companyId, name: 'Operating Revenue', accountType: 'revenue' },
      ]);
      const file = await xlsxFromGrid('journal-subtotal.xlsx', 'Journal', [
        ['Test Co'], ['Journal'], ['All Dates'], [],
        [null, 'Date', 'Transaction Type', 'Num', 'Name', 'Memo/Description', 'Account', 'Debit', 'Credit'],
        [null, '01/02/2025', 'Deposit', null, null, 'Sale 1', 'Car Wash Checking', 3.5, null],
        [null, null, null, null, null, 'Sale 1', 'Operating Revenue', null, 3.5],
        [null, null, null, null, null, null, null, 3.5, 3.5], // per-JE total closes JE1
        // Between-entry subtotal footer in the Account column (current === null):
        [null, null, null, null, null, null, 'Total Operating Revenue', null, 3.5],
        [null, '01/03/2025', 'Deposit', null, null, 'Sale 2', 'Car Wash Checking', 9.25, null],
        [null, null, null, null, null, 'Sale 2', 'Operating Revenue', null, 9.25],
        [null, null, null, null, null, null, null, 9.25, 9.25],
        [null, 'TOTAL', null, null, null, null, null, 12.75, 12.75],
      ]);
      const out = await importsService.createSession({
        tenantId, companyId, userId,
        file, kind: 'gl_transactions', sourceSystem: 'quickbooks_online', options: {},
      });
      expect(out.session.errorCount).toBe(0);
      expect(out.preview.jeGroupCount).toBe(2);
    });

    it('matches accounts when the Account cell combines number and name ("#### Name")', async () => {
      // QBO's Journal export writes the account number and name in ONE cell.
      // Numbered CoA → matches on the leading number token.
      await db.insert(accounts).values([
        { tenantId, companyId, accountNumber: '1000', name: 'Car Wash Checking', accountType: 'asset' },
        { tenantId, companyId, accountNumber: '4000', name: 'Operating Revenue', accountType: 'revenue' },
      ]);
      const file = await xlsxFromGrid('journal-combined.xlsx', 'Journal', [
        ['Test Co'], ['Journal'], ['All Dates'], [],
        [null, 'Date', 'Transaction Type', 'Num', 'Name', 'Memo/Description', 'Account', 'Debit', 'Credit'],
        [null, '01/02/2025', 'Deposit', null, null, 'Sale 1', '1000 Car Wash Checking', 3.5, null],
        [null, null, null, null, null, 'Sale 1', '4000 Operating Revenue', null, 3.5],
        [null, null, null, null, null, null, null, 3.5, 3.5],
      ]);
      const out = await importsService.createSession({
        tenantId, companyId, userId,
        file, kind: 'gl_transactions', sourceSystem: 'quickbooks_online', options: {},
      });
      expect(out.session.errorCount).toBe(0);
      expect(out.preview.jeGroupCount).toBe(1);
      const commit = await importsService.commitSession(tenantId, companyId, userId, out.session.id);
      expect(commit.result.created).toBe(1);
    });

    it('matches combined "#### Name" cells against a numberless CoA via the name', async () => {
      // CoA without account numbers → the leading number is stripped and the
      // remaining name matches.
      await db.insert(accounts).values([
        { tenantId, companyId, name: 'Car Wash Checking', accountType: 'asset' },
        { tenantId, companyId, name: 'Operating Revenue', accountType: 'revenue' },
      ]);
      const file = await xlsxFromGrid('journal-combined-noname.xlsx', 'Journal', [
        ['Test Co'], ['Journal'], ['All Dates'], [],
        [null, 'Date', 'Transaction Type', 'Num', 'Name', 'Memo/Description', 'Account', 'Debit', 'Credit'],
        [null, '01/02/2025', 'Deposit', null, null, 'Sale 1', '1000 Car Wash Checking', 3.5, null],
        [null, null, null, null, null, 'Sale 1', '4000 Operating Revenue', null, 3.5],
        [null, null, null, null, null, null, null, 3.5, 3.5],
      ]);
      const out = await importsService.createSession({
        tenantId, companyId, userId,
        file, kind: 'gl_transactions', sourceSystem: 'quickbooks_online', options: {},
      });
      expect(out.session.errorCount).toBe(0);
      const commit = await importsService.commitSession(tenantId, companyId, userId, out.session.id);
      expect(commit.result.created).toBe(1);
    });

    it('drops zero-amount lines with no account (QBO void/filler) instead of erroring', async () => {
      // QBO emits filler lines with debit 0 and a blank account — voided
      // checks ("VOID: VOID"), reversing-JE legs, empty split legs. They
      // must be dropped, not treated as a posting to a "?" account.
      await db.insert(accounts).values([
        { tenantId, companyId, accountNumber: '1000', name: 'Checking', accountType: 'asset' },
        { tenantId, companyId, accountNumber: '4000', name: 'Revenue', accountType: 'revenue' },
      ]);
      const file = await xlsxFromGrid('journal-filler.xlsx', 'Journal', [
        ['Test Co'], ['Journal'], ['All Dates'], [],
        [null, 'Date', 'Transaction Type', 'Num', 'Name', 'Memo/Description', 'Account', 'Debit', 'Credit'],
        [null, '01/02/2025', 'Journal Entry', 'jlh', null, 'Sale 1', '1000 Checking', 3.5, null],
        [null, null, null, null, null, 'Sale 1', '4000 Revenue', null, 3.5],
        // Filler: blank account, debit 0 → must be dropped, not a "?" error.
        [null, null, null, null, null, 'VOID: VOID', null, 0, null],
        [null, null, null, null, null, null, null, 3.5, 3.5],
      ]);
      const out = await importsService.createSession({
        tenantId, companyId, userId,
        file, kind: 'gl_transactions', sourceSystem: 'quickbooks_online', options: {},
      });
      expect(out.session.errorCount).toBe(0);
      expect(out.preview.jeGroupCount).toBe(1);
      const commit = await importsService.commitSession(tenantId, companyId, userId, out.session.id);
      expect(commit.result.created).toBe(1);
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
