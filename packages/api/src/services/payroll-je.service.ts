import { eq, and, ne, inArray } from 'drizzle-orm';
import { PayrollLineType, type PayrollJEPreview, type PayrollJEPreviewLine } from '@kis-books/shared';

interface GenerateJeInput {
  aggregationMode?: 'summary' | 'per_employee';
  accountMappings?: Record<string, string>;
}
import { db } from '../db/index.js';
import {
  payrollImportSessions,
  payrollImportRows,
  payrollAccountMapping,
  payrollCheckRegisterRows,
  accounts,
} from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import * as ledger from './ledger.service.js';
import * as importService from './payroll-import.service.js';

// ── Aggregate payroll rows into JE lines ──

interface AggregatedAmounts {
  gross_wages: number;
  employer_tax: number;
  employer_benefits: number;
  fit: number;
  sit: number;
  local_tax: number;
  ss: number;          // EE + ER
  medicare: number;    // EE + ER
  futa: number;
  suta: number;
  health_ins: number;  // EE + ER
  retirement: number;  // EE + ER (all 401k)
  other_deduction: number;
  net_pay: number;
  contractor_expense: number;
  contractor_payable: number;
}

function n(row: Record<string, any>, key: string): number {
  return Number(row[key] ?? 0);
}

function aggregateRows(mappedRows: Record<string, any>[]): AggregatedAmounts {
  const agg: AggregatedAmounts = {
    gross_wages: 0, employer_tax: 0, employer_benefits: 0,
    fit: 0, sit: 0, local_tax: 0,
    ss: 0, medicare: 0, futa: 0, suta: 0,
    health_ins: 0, retirement: 0, other_deduction: 0,
    net_pay: 0, contractor_expense: 0, contractor_payable: 0,
  };

  for (const row of mappedRows) {
    const isContractor = row['is_contractor'] === true;

    if (isContractor) {
      const pay = n(row, 'contractor_pay') || n(row, 'gross_pay');
      agg.contractor_expense += pay;
      agg.contractor_payable += pay;
      continue;
    }

    agg.gross_wages += n(row, 'gross_pay');
    agg.fit += n(row, 'federal_income_tax');
    agg.sit += n(row, 'state_income_tax');
    agg.local_tax += n(row, 'local_income_tax');
    agg.ss += n(row, 'social_security_ee') + n(row, 'social_security_er');
    agg.medicare += n(row, 'medicare_ee') + n(row, 'medicare_er');
    agg.futa += n(row, 'futa_er');
    agg.suta += n(row, 'suta_er');
    agg.other_deduction += n(row, 'hsa_ee') + n(row, 'other_deduction_ee') + n(row, 'other_benefit_er');
    agg.health_ins += n(row, 'health_insurance_ee') + n(row, 'health_insurance_er');
    agg.retirement += n(row, 'retirement_401k_ee') + n(row, 'roth_401k_ee') + n(row, 'retirement_401k_er');
    agg.net_pay += n(row, 'net_pay');

    agg.employer_tax += n(row, 'social_security_er') + n(row, 'medicare_er') +
      n(row, 'futa_er') + n(row, 'suta_er') + n(row, 'other_er_tax');
    agg.employer_benefits += n(row, 'health_insurance_er') + n(row, 'retirement_401k_er') +
      n(row, 'other_benefit_er');
  }

  return agg;
}

// ── Build JE Lines from Aggregated Amounts ──

function buildJELines(
  agg: AggregatedAmounts,
  accountMap: Map<string, { id: string; name: string; number: string | null }>,
): PayrollJEPreviewLine[] {
  const lines: PayrollJEPreviewLine[] = [];
  const r = (n: number) => Math.round(n * 100) / 100;

  const addLine = (lineType: string, desc: string, debit: number, credit: number) => {
    if (r(debit) === 0 && r(credit) === 0) return;
    const acct = accountMap.get(lineType);
    lines.push({
      lineType,
      description: desc,
      accountId: acct?.id || null,
      accountName: acct?.name || null,
      accountNumber: acct?.number || null,
      debit: r(debit).toFixed(2),
      credit: r(credit).toFixed(2),
    });
  };

  // DEBITS
  addLine(PayrollLineType.GROSS_WAGES_EXPENSE, 'Gross Wages Expense', agg.gross_wages, 0);
  addLine(PayrollLineType.EMPLOYER_TAX_EXPENSE, 'Employer Payroll Tax Expense', agg.employer_tax, 0);
  if (agg.employer_benefits > 0) addLine(PayrollLineType.EMPLOYER_BENEFITS_EXPENSE, 'Employer Benefits Expense', agg.employer_benefits, 0);
  if (agg.contractor_expense > 0) addLine(PayrollLineType.CONTRACTOR_EXPENSE, 'Contractor Expense', agg.contractor_expense, 0);

  // CREDITS
  if (agg.fit > 0) addLine(PayrollLineType.FIT_PAYABLE, 'Federal Income Tax Payable', 0, agg.fit);
  if (agg.sit > 0 || agg.local_tax > 0) addLine(PayrollLineType.SIT_PAYABLE, 'State/Local Tax Payable', 0, agg.sit + agg.local_tax);
  if (agg.ss > 0) addLine(PayrollLineType.SS_PAYABLE, 'Social Security Payable', 0, agg.ss);
  if (agg.medicare > 0) addLine(PayrollLineType.MEDICARE_PAYABLE, 'Medicare Payable', 0, agg.medicare);
  if (agg.futa > 0) addLine(PayrollLineType.FUTA_PAYABLE, 'FUTA Payable', 0, agg.futa);
  if (agg.suta > 0) addLine(PayrollLineType.SUTA_PAYABLE, 'SUTA Payable', 0, agg.suta);
  if (agg.health_ins > 0) addLine(PayrollLineType.HEALTH_INS_PAYABLE, 'Health Insurance Payable', 0, agg.health_ins);
  if (agg.retirement > 0) addLine(PayrollLineType.RETIREMENT_PAYABLE, 'Retirement (401k) Payable', 0, agg.retirement);
  if (agg.other_deduction > 0) addLine(PayrollLineType.OTHER_DEDUCTION_PAYABLE, 'Other Deductions Payable', 0, agg.other_deduction);
  addLine(PayrollLineType.PAYROLL_CLEARING, 'Payroll Clearing / Cash', 0, agg.net_pay);
  if (agg.contractor_payable > 0) addLine(PayrollLineType.CONTRACTOR_PAYABLE, 'Contractor Payable / Cash', 0, agg.contractor_payable);

  return lines;
}

// ── Get Account Map ──

async function getAccountMap(tenantId: string, companyId: string | null, overrides?: Record<string, string>) {
  const map = new Map<string, { id: string; name: string; number: string | null }>();

  // Load saved mappings
  if (companyId) {
    const mappings = await db.select().from(payrollAccountMapping)
      .where(and(
        eq(payrollAccountMapping.tenantId, tenantId),
        eq(payrollAccountMapping.companyId, companyId),
      ));

    const acctIds = mappings.map(m => m.accountId);
    if (acctIds.length > 0) {
      const accts = await db.select({ id: accounts.id, name: accounts.name, accountNumber: accounts.accountNumber })
        .from(accounts).where(inArray(accounts.id, acctIds));
      const acctLookup = new Map(accts.map(a => [a.id, a]));
      for (const m of mappings) {
        const acct = acctLookup.get(m.accountId);
        if (acct) map.set(m.lineType, { id: acct.id, name: acct.name, number: acct.accountNumber });
      }
    }
  }

  // Apply overrides
  if (overrides) {
    const overrideIds = Object.values(overrides);
    if (overrideIds.length > 0) {
      const accts = await db.select({ id: accounts.id, name: accounts.name, accountNumber: accounts.accountNumber })
        .from(accounts).where(inArray(accounts.id, overrideIds));
      const acctLookup = new Map(accts.map(a => [a.id, a]));
      for (const [lineType, accountId] of Object.entries(overrides)) {
        const acct = acctLookup.get(accountId);
        if (acct) map.set(lineType, { id: acct.id, name: acct.name, number: acct.accountNumber });
      }
    }
  }

  return map;
}

// ── Generate JE Preview ──

export async function generateJE(
  tenantId: string,
  sessionId: string,
  options: GenerateJeInput,
): Promise<{ previews: PayrollJEPreview[] }> {
  const session = await importService.getSession(tenantId, sessionId);

  const rows = await db.select().from(payrollImportRows)
    .where(and(
      eq(payrollImportRows.sessionId, sessionId),
      eq(payrollImportRows.validationStatus, 'valid'),
    ))
    .orderBy(payrollImportRows.rowNumber);

  // Also include warning rows
  const warningRows = await db.select().from(payrollImportRows)
    .where(and(
      eq(payrollImportRows.sessionId, sessionId),
      eq(payrollImportRows.validationStatus, 'warning'),
    ))
    .orderBy(payrollImportRows.rowNumber);

  const allRows = [...rows, ...warningRows];
  if (allRows.length === 0) throw AppError.badRequest('No valid rows to generate JE from');

  const accountMap = await getAccountMap(tenantId, session.companyId, options.accountMappings);
  const mappedData = allRows.map(r => (r.mappedData || r.rawData) as Record<string, any>);

  if (options.aggregationMode === 'per_employee') {
    // Group by employee
    const byEmployee = new Map<string, Record<string, any>[]>();
    for (const row of mappedData) {
      const name = String(row['employee_name'] || 'Unknown');
      const existing = byEmployee.get(name) || [];
      existing.push(row);
      byEmployee.set(name, existing);
    }

    const previews: PayrollJEPreview[] = [];
    for (const [empName, empRows] of byEmployee) {
      const agg = aggregateRows(empRows);
      const lines = buildJELines(agg, accountMap);
      const checkDate = (empRows[0] as any)?.check_date || session.checkDate || '';
      const totalDebits = lines.reduce((s, l) => s + parseFloat(l.debit), 0);
      const totalCredits = lines.reduce((s, l) => s + parseFloat(l.credit), 0);

      previews.push({
        date: checkDate,
        memo: `Payroll — ${empName} — ${session.payPeriodStart || ''} to ${session.payPeriodEnd || ''}`,
        lines,
        totalDebits: totalDebits.toFixed(2),
        totalCredits: totalCredits.toFixed(2),
        isBalanced: Math.abs(totalDebits - totalCredits) < 0.01,
      });
    }
    return { previews };
  }

  // Summary mode (default)
  const agg = aggregateRows(mappedData);
  const lines = buildJELines(agg, accountMap);
  const checkDate = (mappedData[0] as any)?.check_date || session.checkDate || '';
  const totalDebits = lines.reduce((s, l) => s + parseFloat(l.debit), 0);
  const totalCredits = lines.reduce((s, l) => s + parseFloat(l.credit), 0);

  // Rounding reconciliation — adjust payroll clearing to force balance
  if (Math.abs(totalDebits - totalCredits) > 0 && Math.abs(totalDebits - totalCredits) < 0.10) {
    const clearingLine = lines.find(l => l.lineType === PayrollLineType.PAYROLL_CLEARING);
    if (clearingLine) {
      const diff = totalDebits - totalCredits;
      clearingLine.credit = (parseFloat(clearingLine.credit) + diff).toFixed(2);
    }
  }

  const finalDebits = lines.reduce((s, l) => s + parseFloat(l.debit), 0);
  const finalCredits = lines.reduce((s, l) => s + parseFloat(l.credit), 0);

  const preview: PayrollJEPreview = {
    date: checkDate,
    memo: `Payroll — ${session.payPeriodStart || ''} to ${session.payPeriodEnd || ''} — ${(session.metadata as any)?.detectedProvider || 'Import'}`,
    lines,
    totalDebits: finalDebits.toFixed(2),
    totalCredits: finalCredits.toFixed(2),
    isBalanced: Math.abs(finalDebits - finalCredits) < 0.01,
  };

  return { previews: [preview] };
}

// ── Pay Period Overlap Check ──

export async function checkPayrollPeriodOverlap(tenantId: string, session: typeof payrollImportSessions.$inferSelect) {
  const conditions = [
    eq(payrollImportSessions.tenantId, tenantId),
    eq(payrollImportSessions.status, 'posted'),
    ne(payrollImportSessions.id, session.id),
  ];
  if (session.companyId) {
    conditions.push(eq(payrollImportSessions.companyId, session.companyId));
  }

  const posted = await db.select({
    id: payrollImportSessions.id,
    payPeriodStart: payrollImportSessions.payPeriodStart,
    payPeriodEnd: payrollImportSessions.payPeriodEnd,
    checkDate: payrollImportSessions.checkDate,
    originalFilename: payrollImportSessions.originalFilename,
    createdAt: payrollImportSessions.createdAt,
  })
    .from(payrollImportSessions)
    .where(and(...conditions));

  const overlaps: Array<{
    sessionId: string;
    filename: string;
    payPeriod: string;
    postedDate: string;
  }> = [];

  for (const prior of posted) {
    let isOverlap = false;

    // Check date overlap: if either session's check date falls within the other's pay period
    if (session.checkDate && prior.checkDate && session.checkDate === prior.checkDate) {
      isOverlap = true;
    }
    // Check pay period overlap
    if (session.payPeriodStart && session.payPeriodEnd && prior.payPeriodStart && prior.payPeriodEnd) {
      if (session.payPeriodStart <= prior.payPeriodEnd && session.payPeriodEnd >= prior.payPeriodStart) {
        isOverlap = true;
      }
    }
    // If no pay period set, fall back to check date within ±3 days
    if (!isOverlap && session.checkDate && prior.checkDate) {
      const daysDiff = Math.abs(
        (new Date(session.checkDate).getTime() - new Date(prior.checkDate).getTime()) / (1000 * 60 * 60 * 24)
      );
      if (daysDiff <= 3) isOverlap = true;
    }

    if (isOverlap) {
      overlaps.push({
        sessionId: prior.id,
        filename: prior.originalFilename,
        payPeriod: prior.payPeriodStart && prior.payPeriodEnd
          ? `${prior.payPeriodStart} to ${prior.payPeriodEnd}`
          : prior.checkDate || 'unknown',
        postedDate: prior.createdAt ? new Date(prior.createdAt).toLocaleDateString() : 'unknown',
      });
    }
  }

  return overlaps;
}

// ── Post JE ──

export async function postJE(
  tenantId: string,
  sessionId: string,
  userId: string,
  forcePost = false,
  aggregationMode: 'summary' | 'per_employee' = 'summary',
  companyId?: string,
) {
  const session = await importService.getSession(tenantId, sessionId);
  if (session.status === 'posted') throw AppError.badRequest('Session already posted');
  if (session.status !== 'validated') throw AppError.badRequest('Session must be validated before posting');

  await importService.checkDuplicateFileHash(tenantId, session);

  if (!forcePost) {
    const overlaps = await checkPayrollPeriodOverlap(tenantId, session);
    if (overlaps.length > 0) {
      return { overlaps, requiresConfirmation: true };
    }
  }

  const { previews } = await generateJE(tenantId, sessionId, { aggregationMode });
  const postedIds: string[] = [];

  for (const preview of previews) {
    // Verify all lines have account mappings
    const unmapped = preview.lines.filter(l => !l.accountId);
    if (unmapped.length > 0) {
      throw AppError.badRequest(
        `Missing account mappings for: ${unmapped.map(l => l.description).join(', ')}. Configure payroll account mappings first.`
      );
    }

    if (!preview.isBalanced) {
      throw AppError.badRequest(`JE does not balance: debits ${preview.totalDebits} ≠ credits ${preview.totalCredits}`);
    }

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
    }, userId, companyId);

    postedIds.push(txn.id);
  }

  // Update session
  const updateData: any = {
    status: 'posted',
    updatedAt: new Date(),
  };

  if (postedIds.length === 1) {
    updateData.journalEntryId = postedIds[0];
  } else {
    updateData.journalEntryIds = postedIds;
  }
  updateData.jeCount = postedIds.length;

  await db.update(payrollImportSessions)
    .set(updateData)
    .where(eq(payrollImportSessions.id, sessionId));

  await auditLog(tenantId, 'create', 'payroll_import_post', sessionId, null,
    { mode: 'employee_level', jeCount: postedIds.length, journalEntryIds: postedIds }, userId);

  return { journalEntryIds: postedIds, count: postedIds.length };
}

// ── Reverse JE ──

export async function reverseJE(tenantId: string, sessionId: string, reason: string, userId: string) {
  const session = await importService.getSession(tenantId, sessionId);
  if (session.status !== 'posted') throw AppError.badRequest('Can only reverse posted imports');

  const jeIds: string[] = [];
  if (session.journalEntryId) jeIds.push(session.journalEntryId);
  if (session.journalEntryIds && Array.isArray(session.journalEntryIds)) {
    jeIds.push(...(session.journalEntryIds as string[]));
  }

  // Also collect check transaction IDs
  const checkRows = await db.select({ transactionId: payrollCheckRegisterRows.transactionId })
    .from(payrollCheckRegisterRows)
    .where(and(
      eq(payrollCheckRegisterRows.sessionId, sessionId),
      eq(payrollCheckRegisterRows.posted, true),
    ));
  for (const row of checkRows) {
    if (row.transactionId && !jeIds.includes(row.transactionId)) {
      jeIds.push(row.transactionId);
    }
  }

  if (jeIds.length === 0) throw AppError.badRequest('No journal entries to reverse');

  // Void each JE
  for (const jeId of jeIds) {
    await ledger.voidTransaction(tenantId, jeId, `Reversal of payroll import: ${reason}`, userId);
  }

  // Mark checks as unposted
  if (checkRows.length > 0) {
    await db.update(payrollCheckRegisterRows)
      .set({ posted: false, transactionId: null })
      .where(eq(payrollCheckRegisterRows.sessionId, sessionId));
  }

  await db.update(payrollImportSessions)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(eq(payrollImportSessions.id, sessionId));

  await auditLog(tenantId, 'update', 'payroll_import_reverse', sessionId,
    { status: 'posted' }, { status: 'cancelled', reason, reversedCount: jeIds.length }, userId);

  return { reversed: jeIds.length, journalEntryIds: jeIds };
}
