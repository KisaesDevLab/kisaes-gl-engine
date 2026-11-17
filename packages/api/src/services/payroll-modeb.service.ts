// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

import { eq, and, inArray } from 'drizzle-orm';
import type { PayrollJEPreview, PayrollCheckRow, ModeBColumnConfig } from '@kis-books/shared';
import { TAX_AGENCY_PATTERNS, MODE_B_COLUMN_CONFIGS, PROVIDER_DISPLAY_NAMES } from '@kis-books/shared';
import { db } from '../db/index.js';
import {
  payrollImportSessions,
  payrollImportRows,
  payrollCheckRegisterRows,
  payrollDescriptionAccountMap,
  accounts,
  tags,
} from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import DecimalLib from 'decimal.js';
import { parseCurrency, parseDate, parseFile, detectHeaderRow, detectProvider, parsePayrollMoney, type PayrollMoneyErrorCode } from './payroll-parse.service.js';
import * as ledger from './ledger.service.js';
import * as importService from './payroll-import.service.js';
import {
  resolvePayrollPostTags,
  stampPayrollHeaderTags,
  postPayrollSession,
  type PayrollPostTags,
} from './payroll-je.service.js';
import type { DbOrTx } from '../db/index.js';

const Decimal = DecimalLib.default || DecimalLib;

// ── Default column config (Payroll Relief backward compat) ──

const DEFAULT_CONFIG: ModeBColumnConfig = MODE_B_COLUMN_CONFIGS['payroll_relief_gl']!;

/** Resolve the column config for a given provider */
function resolveColumnConfig(provider: string | null): ModeBColumnConfig {
  if (provider && MODE_B_COLUMN_CONFIGS[provider]) return MODE_B_COLUMN_CONFIGS[provider]!;
  return DEFAULT_CONFIG;
}

/** Case-insensitive column lookup — tries exact then lowercase match */
function col(row: Record<string, string>, colName: string): string {
  if (row[colName] !== undefined) return row[colName]!;
  const lower = colName.toLowerCase();
  for (const [key, val] of Object.entries(row)) {
    if (key.toLowerCase() === lower) return val;
  }
  return '';
}

// ── Mode B: Parse GL Entries (generalized) ──

type Dec = InstanceType<typeof Decimal>;

export interface GLEntryRow {
  date: string;
  reference: string;
  description: string;
  debit: Dec;
  credit: Dec;
  memo: string;
  accountCode: string;
  /** Position of the source row in the input (0-based). */
  index: number;
  /** Set when an amount cell is not a whole-cent number (U-250). */
  amountError?: PayrollMoneyErrorCode;
}

/** Exact debit/credit for one GL row under a provider's amount convention.
 *  An unparseable cell is reported, never read as 0 (U-250). */
export function glRowAmounts(
  r: Record<string, string>,
  c: ModeBColumnConfig,
): { debit: Dec; credit: Dec; error?: PayrollMoneyErrorCode } {
  const zero = new Decimal(0);
  const read = (v: string) => parsePayrollMoney(v);
  switch (c.amountConvention) {
    case 'separate_dr_cr': {
      const d = read(col(r, c.debitColumn || 'Debit'));
      const cr = read(col(r, c.creditColumn || 'Credit'));
      if (!d.ok) return { debit: zero, credit: zero, error: d.code };
      if (!cr.ok) return { debit: zero, credit: zero, error: cr.code };
      return { debit: new Decimal(d.value), credit: new Decimal(cr.value) };
    }
    case 'signed_single': {
      const a = read(col(r, c.amountColumn || 'Amount'));
      if (!a.ok) return { debit: zero, credit: zero, error: a.code };
      const amount = new Decimal(a.value);
      return amount.gte(0) ? { debit: amount, credit: zero } : { debit: zero, credit: amount.abs() };
    }
    case 'category_derived': {
      const a = read(col(r, c.amountColumn || 'Amount'));
      if (!a.ok) return { debit: zero, credit: zero, error: a.code };
      const amount = new Decimal(a.value).abs();
      const category = col(r, c.accountCategoryColumn || 'Category').toLowerCase().trim();
      // Expenses are debits; Liabilities and Assets (net pay) are credits
      return category.startsWith('expense') || category.startsWith('cost')
        ? { debit: amount, credit: zero }
        : { debit: zero, credit: amount };
    }
    default:
      return { debit: zero, credit: zero };
  }
}

export function parseGLEntries(rows: Record<string, string>[], config?: ModeBColumnConfig): GLEntryRow[] {
  const c = config || DEFAULT_CONFIG;

  return rows
    .map((r, index) => ({ r, index }))
    .filter(({ r }) => col(r, c.descriptionColumn))
    .map(({ r, index }) => {
      const description = col(r, c.descriptionColumn).trim();
      const dateStr = col(r, c.dateColumn);
      const memo = c.memoColumn ? col(r, c.memoColumn).trim() : '';
      const reference = c.referenceColumn ? col(r, c.referenceColumn) : '';
      const accountCode = c.accountCodeColumn ? col(r, c.accountCodeColumn) : '';
      const { debit, credit, error } = glRowAmounts(r, c);

      const entry: GLEntryRow = {
        date: parseDate(dateStr) || '',
        reference,
        description,
        debit,
        credit,
        memo,
        accountCode,
        index,
      };
      if (error) entry.amountError = error;
      return entry;
    })
    .filter(r => r.description && (r.amountError || r.debit.gt(0) || r.credit.gt(0)));
}

// ── Group by Date ──

export function groupByDate(entries: GLEntryRow[]): Map<string, GLEntryRow[]> {
  const groups = new Map<string, GLEntryRow[]>();
  for (const entry of entries) {
    if (!entry.date) continue;
    const existing = groups.get(entry.date) || [];
    existing.push(entry);
    groups.set(entry.date, existing);
  }
  return groups;
}

// ── Extract Pay Period from Memo ──

export function extractPayPeriod(memo: string, periodRegex?: string): { start: string; end: string } | null {
  // Try custom regex first if provided
  if (periodRegex) {
    try {
      const customMatch = memo.match(new RegExp(periodRegex, 'i'));
      if (customMatch && customMatch[1] && customMatch[2]) {
        const start = parseDate(customMatch[1]);
        const end = parseDate(customMatch[2]);
        if (start && end) return { start, end };
      }
    } catch { /* invalid regex, fall through */ }
  }
  // Default: "Period: MM/DD/YYYY to MM/DD/YYYY"
  const match = memo.match(/Period:\s*(\d{2}\/\d{2}\/\d{4})\s*to\s*(\d{2}\/\d{2}\/\d{4})/i);
  if (!match) return null;
  const start = parseDate(match[1]!);
  const end = parseDate(match[2]!);
  if (!start || !end) return null;
  return { start, end };
}

// ── Balance Check ──

/** Exact totals (U-250): balanced only when debits equal credits to the cent. */
export function checkBalance(entries: Pick<GLEntryRow, 'debit' | 'credit'>[]): { totalDebits: string; totalCredits: string; difference: string; balanced: boolean } {
  let totalDebits = new Decimal(0);
  let totalCredits = new Decimal(0);
  for (const e of entries) {
    totalDebits = totalDebits.plus(e.debit);
    totalCredits = totalCredits.plus(e.credit);
  }
  return {
    totalDebits: totalDebits.toFixed(2),
    totalCredits: totalCredits.toFixed(2),
    difference: totalDebits.minus(totalCredits).toFixed(2),
    balanced: totalDebits.eq(totalCredits),
  };
}
// ── Check Classification ──

function classifyCheck(payeeName: string, memo: string): 'employee' | 'contractor' | 'tax_payment' {
  for (const pattern of TAX_AGENCY_PATTERNS) {
    if (pattern.test(payeeName)) return 'tax_payment';
  }
  if (memo && /tax|withheld|payment/i.test(memo)) return 'tax_payment';
  return 'employee';
}

// ── Parse & Store Checks ──

export async function parseAndStoreChecks(
  tenantId: string,
  sessionId: string,
  buffer: Buffer,
  filename: string,
) {
  const { rows } = await parseFile(buffer, filename);
  const headerRow = detectHeaderRow(rows);
  const headers = rows[headerRow] || [];
  const dataRows = rows.slice(headerRow + 1);

  const checkRows = dataRows
    .filter(r => r.some(c => c.trim() !== ''))
    .map((row, i) => {
      const raw: Record<string, string> = {};
      headers.forEach((h, j) => { raw[h] = row[j] || ''; });

      const amount = parseCurrency(raw['Amount'] || raw['amount'] || '0');
      const payeeName = (raw['Payee Name'] || raw['payee_name'] || '').trim();
      const memo = (raw['Memo'] || raw['memo'] || '').trim();
      const checkNumber = (raw['Check Number'] || raw['check_number'] || '').trim();
      const checkDate = parseDate(raw['Date'] || raw['date'] || '') || '';
      const cashAccountCode = (raw['Cash Account'] || raw['cash_account'] || '').trim();
      const offsetAccountCode = (raw['Account'] || raw['account'] || '').trim();

      return {
        sessionId,
        rowNumber: i + 1,
        checkNumber: checkNumber || null,
        checkDate,
        payeeName,
        amount: Math.round(amount * 100) / 100 + '',
        memo: memo || null,
        checkType: classifyCheck(payeeName, memo),
        cashAccountCode: cashAccountCode || null,
        offsetAccountCode: offsetAccountCode || null,
        posted: false,
      };
    })
    .filter(r => r.payeeName && r.checkDate);
  // $0 rows are voided checks — nothing to post.
  const nonZero = checkRows.filter(r => Number(r.amount) !== 0);
  const skippedZero = checkRows.length - nonZero.length;

  for (let i = 0; i < nonZero.length; i += 500) {
    await db.insert(payrollCheckRegisterRows).values(nonZero.slice(i, i + 500) as any);
  }

  return { stored: nonZero.length, skippedZero };
}

// ── Get Checks ──

export async function getChecks(tenantId: string, sessionId: string): Promise<PayrollCheckRow[]> {
  await importService.getSession(tenantId, sessionId);
  const rows = await db.select().from(payrollCheckRegisterRows)
    .where(eq(payrollCheckRegisterRows.sessionId, sessionId))
    .orderBy(payrollCheckRegisterRows.rowNumber);

  return rows.map(r => ({
    id: r.id,
    rowNumber: r.rowNumber,
    checkNumber: r.checkNumber,
    checkDate: r.checkDate,
    payeeName: r.payeeName,
    amount: r.amount,
    memo: r.memo,
    checkType: r.checkType as any,
    cashAccountCode: r.cashAccountCode,
    offsetAccountCode: r.offsetAccountCode,
    posted: r.posted ?? false,
    transactionId: r.transactionId,
  }));
}

// ── Generate Mode B JE Preview ──

export async function generateModeBJE(tenantId: string, sessionId: string, executor: DbOrTx = db): Promise<{ previews: PayrollJEPreview[] }> {
  const session = await importService.getSession(tenantId, sessionId);
  const companyId = session.companyId;
  const metadata = session.metadata as any;
  const providerKey = metadata?.detectedProvider || 'payroll_relief_gl';
  const columnConfig = resolveColumnConfig(providerKey);
  const providerName = PROVIDER_DISPLAY_NAMES[providerKey] || 'Payroll';

  // Get all raw rows
  const rawRows = await executor.select().from(payrollImportRows)
    .where(eq(payrollImportRows.sessionId, sessionId))
    .orderBy(payrollImportRows.rowNumber);

  const entries = parseGLEntries(rawRows.map(r => r.rawData as Record<string, string>), columnConfig);
  const badAmounts = entries.filter(e => e.amountError);
  if (badAmounts.length > 0) {
    // Never read a bad cell as 0 (U-250): name the rows, never the cell text.
    throw AppError.unprocessableEntity(
      `${badAmounts.length} row(s) have an amount that is not a whole-cent number. Fix the file and upload it again.`,
      'PAYROLL_AMOUNT_INVALID',
      { rows: badAmounts.map(e => ({ rowNumber: rawRows[e.index]?.rowNumber ?? e.index + 1, code: e.amountError })) },
    );
  }
  const groups = groupByDate(entries);

  // Get description→account mappings
  const descMappings = companyId ? await executor.select()
    .from(payrollDescriptionAccountMap)
    .where(and(
      eq(payrollDescriptionAccountMap.tenantId, tenantId),
      eq(payrollDescriptionAccountMap.companyId, companyId),
    )) : [];

  const descMap = new Map(descMappings.map(m => [m.sourceDescription, m]));

  // Get account details
  const accountIds = [...new Set(descMappings.map(m => m.accountId))];
  const accts = accountIds.length > 0
    ? await executor.select({ id: accounts.id, name: accounts.name, accountNumber: accounts.accountNumber })
        .from(accounts).where(inArray(accounts.id, accountIds))
    : [];
  const acctMap = new Map(accts.map(a => [a.id, a]));

  // Mapped tags that still exist in this tenant (a tag deleted since the
  // mapping was saved leaves its lines untagged rather than dangling).
  const mappedTagIds = [...new Set(descMappings.flatMap(m => (m.tagId ? [m.tagId] : [])))];
  const liveTagIds = new Set(mappedTagIds.length > 0
    ? (await executor.select({ id: tags.id }).from(tags)
        .where(and(eq(tags.tenantId, tenantId), inArray(tags.id, mappedTagIds)))).map(t => t.id)
    : []);

  const previews: PayrollJEPreview[] = [];

  for (const [date, dateEntries] of groups) {
    const payPeriod = dateEntries[0]?.memo ? extractPayPeriod(dateEntries[0].memo) : null;
    const { totalDebits, totalCredits, difference, balanced } = checkBalance(dateEntries);

    const lines = dateEntries.map(e => {
      const mapping = descMap.get(e.description);
      const acct = mapping ? acctMap.get(mapping.accountId) : null;
      return {
        lineType: e.description,
        description: e.description,
        accountId: mapping?.accountId || null,
        accountName: acct?.name || null,
        accountNumber: acct?.accountNumber || null,
        debit: e.debit.gt(0) ? e.debit.toFixed(2) : '0.00',
        credit: e.credit.gt(0) ? e.credit.toFixed(2) : '0.00',
        tagId: mapping?.tagId && liveTagIds.has(mapping.tagId) ? mapping.tagId : null,
      };
    });

    const memo = payPeriod
      ? `Payroll — ${payPeriod.start} to ${payPeriod.end} — ${providerName}`
      : `Payroll — ${date} — ${providerName}`;

    previews.push({
      date,
      memo,
      lines,
      totalDebits,
      totalCredits,
      difference,
      isBalanced: balanced,
    });
  }

  previews.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { previews };
}

// ── Post Mode B JEs ──

export async function postModeBJE(
  tenantId: string,
  sessionId: string,
  userId: string,
  forcePost = false,
  companyId?: string,
  tags?: PayrollPostTags,
  opts: { previewToken?: string; discardEmployeeDetail?: boolean } = {},
) {
  // One database transaction with the session locked (U-244); see
  // postPayrollSession. Mode B keeps its old rule: no validated status needed.
  return postPayrollSession(tenantId, sessionId, userId, {
    forcePost,
    companyId,
    tags,
    previewToken: opts.previewToken,
    discardEmployeeDetail: opts.discardEmployeeDetail,
    mode: 'prebuilt_je',
    requireValidated: false,
    generate: async (tx) => (await generateModeBJE(tenantId, sessionId, tx)).previews,
    unmappedNoun: 'descriptions',
  });
}
// ── Post Checks ──

export async function postChecks(
  tenantId: string,
  sessionId: string,
  bankAccountId: string,
  clearingAccountId: string,
  checkIds: string[],
  userId: string,
  companyId?: string,
) {
  await importService.getSession(tenantId, sessionId);

  // Verify both accounts exist
  const acctIds = [bankAccountId, clearingAccountId];
  const foundAccts = await db.select({ id: accounts.id }).from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), inArray(accounts.id, acctIds)));
  if (foundAccts.length < 2) {
    const foundIds = new Set(foundAccts.map(a => a.id));
    if (!foundIds.has(bankAccountId)) throw AppError.notFound('Bank account not found');
    if (!foundIds.has(clearingAccountId)) throw AppError.notFound('Clearing account not found');
  }

  const checks = await db.select().from(payrollCheckRegisterRows)
    .where(and(
      eq(payrollCheckRegisterRows.sessionId, sessionId),
      inArray(payrollCheckRegisterRows.id, checkIds),
    ));

  const postedCount = { employee: 0, contractor: 0, tax_payment: 0 };
  let actualPosted = 0;

  for (const check of checks) {
    if (check.posted) continue;

    // DR Payroll Clearing (reduce liability) → CR Bank (cash out)
    const txn = await ledger.postTransaction(tenantId, {
      txnType: 'check' as any,
      txnDate: check.checkDate,
      memo: `Payroll: ${check.payeeName}${check.memo ? ` — ${check.memo}` : ''}`,
      source: 'payroll_import',
      sourceId: sessionId,
      lines: [
        {
          accountId: clearingAccountId,
          debit: check.amount,
          credit: '0',
          description: `Payroll disbursement: ${check.payeeName}`,
        },
        {
          accountId: bankAccountId,
          debit: '0',
          credit: check.amount,
          description: check.payeeName,
        },
      ],
    }, userId, companyId);

    await db.update(payrollCheckRegisterRows)
      .set({ posted: true, transactionId: txn.id })
      .where(eq(payrollCheckRegisterRows.id, check.id));

    actualPosted++;
    if (check.checkType) postedCount[check.checkType as keyof typeof postedCount]++;
  }

  await auditLog(tenantId, 'create', 'payroll_check_post', sessionId, null,
    { posted: actualPosted, breakdown: postedCount }, userId);

  return { posted: actualPosted, breakdown: postedCount };
}
