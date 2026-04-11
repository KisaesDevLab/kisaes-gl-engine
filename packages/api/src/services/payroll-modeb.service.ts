import { eq, and, inArray } from 'drizzle-orm';
import type { PayrollJEPreview, PayrollCheckRow } from '@kis-books/shared';
import { TAX_AGENCY_PATTERNS } from '@kis-books/shared';
import { db } from '../db/index.js';
import {
  payrollImportSessions,
  payrollImportRows,
  payrollCheckRegisterRows,
  payrollDescriptionAccountMap,
  accounts,
} from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import { parseCurrency, parseDate, parseFile, detectHeaderRow, detectProvider } from './payroll-parse.service.js';
import * as ledger from './ledger.service.js';
import * as importService from './payroll-import.service.js';

// ── Mode B: Parse GLEntries.csv ──

interface GLEntryRow {
  date: string;
  reference: string;
  description: string;
  debit: number;
  credit: number;
  memo: string;
}

export function parseGLEntries(rows: Record<string, string>[]): GLEntryRow[] {
  return rows
    .filter(r => r['Description'] || r['description'])
    .map(r => ({
      date: parseDate(r['Date'] || r['date'] || '') || '',
      reference: r['Reference'] || r['reference'] || '',
      description: (r['Description'] || r['description'] || '').trim(),
      debit: parseCurrency(r['Debit'] || r['debit']),
      credit: parseCurrency(r['Credit'] || r['credit']),
      memo: (r['Memo'] || r['memo'] || '').trim(),
    }))
    .filter(r => r.description && (r.debit > 0 || r.credit > 0));
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

export function extractPayPeriod(memo: string): { start: string; end: string } | null {
  const match = memo.match(/Period:\s*(\d{2}\/\d{2}\/\d{4})\s*to\s*(\d{2}\/\d{2}\/\d{4})/i);
  if (!match) return null;
  const start = parseDate(match[1]!);
  const end = parseDate(match[2]!);
  if (!start || !end) return null;
  return { start, end };
}

// ── Balance Check ──

export function checkBalance(entries: GLEntryRow[]): { totalDebits: number; totalCredits: number; balanced: boolean } {
  let totalDebits = 0;
  let totalCredits = 0;
  for (const e of entries) {
    totalDebits += e.debit;
    totalCredits += e.credit;
  }
  return {
    totalDebits: Math.round(totalDebits * 100) / 100,
    totalCredits: Math.round(totalCredits * 100) / 100,
    balanced: Math.abs(totalDebits - totalCredits) < 0.01,
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

      return {
        sessionId,
        rowNumber: i + 1,
        checkNumber: checkNumber || null,
        checkDate,
        payeeName,
        amount: Math.round(amount * 100) / 100 + '',
        memo: memo || null,
        checkType: classifyCheck(payeeName, memo),
        posted: false,
      };
    })
    .filter(r => r.payeeName && r.checkDate);

  if (checkRows.length > 0) {
    for (let i = 0; i < checkRows.length; i += 500) {
      await db.insert(payrollCheckRegisterRows).values(checkRows.slice(i, i + 500) as any);
    }
  }

  return checkRows.length;
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
    posted: r.posted ?? false,
    transactionId: r.transactionId,
  }));
}

// ── Generate Mode B JE Preview ──

export async function generateModeBJE(tenantId: string, sessionId: string): Promise<{ previews: PayrollJEPreview[] }> {
  const session = await importService.getSession(tenantId, sessionId);
  const companyId = session.companyId;

  // Get all raw rows
  const rawRows = await db.select().from(payrollImportRows)
    .where(eq(payrollImportRows.sessionId, sessionId))
    .orderBy(payrollImportRows.rowNumber);

  const entries = parseGLEntries(rawRows.map(r => r.rawData as Record<string, string>));
  const groups = groupByDate(entries);

  // Get description→account mappings
  const descMappings = companyId ? await db.select()
    .from(payrollDescriptionAccountMap)
    .where(and(
      eq(payrollDescriptionAccountMap.tenantId, tenantId),
      eq(payrollDescriptionAccountMap.companyId, companyId),
    )) : [];

  const descMap = new Map(descMappings.map(m => [m.sourceDescription, m]));

  // Get account details
  const accountIds = [...new Set(descMappings.map(m => m.accountId))];
  const accts = accountIds.length > 0
    ? await db.select({ id: accounts.id, name: accounts.name, accountNumber: accounts.accountNumber })
        .from(accounts).where(inArray(accounts.id, accountIds))
    : [];
  const acctMap = new Map(accts.map(a => [a.id, a]));

  const previews: PayrollJEPreview[] = [];

  for (const [date, dateEntries] of groups) {
    const payPeriod = dateEntries[0]?.memo ? extractPayPeriod(dateEntries[0].memo) : null;
    const { totalDebits, totalCredits, balanced } = checkBalance(dateEntries);

    const lines = dateEntries.map(e => {
      const mapping = descMap.get(e.description);
      const acct = mapping ? acctMap.get(mapping.accountId) : null;
      return {
        lineType: e.description,
        description: e.description,
        accountId: mapping?.accountId || null,
        accountName: acct?.name || null,
        accountNumber: acct?.accountNumber || null,
        debit: e.debit > 0 ? e.debit.toFixed(2) : '0.00',
        credit: e.credit > 0 ? e.credit.toFixed(2) : '0.00',
      };
    });

    const memo = payPeriod
      ? `Payroll — ${payPeriod.start} to ${payPeriod.end} — Payroll Relief`
      : `Payroll — ${date}`;

    previews.push({
      date,
      memo,
      lines,
      totalDebits: totalDebits.toFixed(2),
      totalCredits: totalCredits.toFixed(2),
      isBalanced: balanced,
    });
  }

  return { previews };
}

// ── Post Mode B JEs ──

export async function postModeBJE(tenantId: string, sessionId: string, userId: string, forcePost = false) {
  const session = await importService.getSession(tenantId, sessionId);
  if (session.status === 'posted') throw AppError.badRequest('Session already posted');

  await importService.checkDuplicateFileHash(tenantId, session);

  if (!forcePost) {
    const { checkPayrollPeriodOverlap } = await import('./payroll-je.service.js');
    const overlaps = await checkPayrollPeriodOverlap(tenantId, session);
    if (overlaps.length > 0) {
      return { overlaps, requiresConfirmation: true };
    }
  }

  const { previews } = await generateModeBJE(tenantId, sessionId);

  // Verify all descriptions are mapped
  for (const preview of previews) {
    const unmapped = preview.lines.filter(l => !l.accountId);
    if (unmapped.length > 0) {
      throw AppError.badRequest(
        `Unmapped descriptions: ${unmapped.map(l => l.description).join(', ')}. Map all descriptions before posting.`
      );
    }
    if (!preview.isBalanced) {
      throw AppError.badRequest(`JE for ${preview.date} does not balance`);
    }
  }

  const postedIds: string[] = [];

  for (const preview of previews) {
    const lines = preview.lines.map(l => ({
      accountId: l.accountId!,
      debit: l.debit !== '0.00' ? l.debit : '0',
      credit: l.credit !== '0.00' ? l.credit : '0',
      description: l.description,
    }));

    const txn = await ledger.postTransaction(tenantId, {
      txnType: 'journal_entry' as any,
      txnDate: preview.date,
      memo: preview.memo,
      source: 'payroll_import',
      sourceId: sessionId,
      lines,
    }, userId);

    postedIds.push(txn.id);
  }

  // Update session
  await db.update(payrollImportSessions)
    .set({
      status: 'posted',
      journalEntryIds: postedIds,
      jeCount: postedIds.length,
      updatedAt: new Date(),
    })
    .where(eq(payrollImportSessions.id, sessionId));

  await auditLog(tenantId, 'create', 'payroll_import_post', sessionId, null,
    { mode: 'prebuilt_je', jeCount: postedIds.length, journalEntryIds: postedIds }, userId);

  return { journalEntryIds: postedIds, count: postedIds.length };
}

// ── Post Checks ──

export async function postChecks(
  tenantId: string,
  sessionId: string,
  bankAccountId: string,
  clearingAccountId: string,
  checkIds: string[],
  userId: string,
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
    }, userId);

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
