// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

import { eq, and, ne, inArray, sql } from 'drizzle-orm';
import DecimalLib from 'decimal.js';
import {
  PayrollLineType,
  PROVIDER_DISPLAY_NAMES,
  type PayrollJEPreview,
  type PayrollJEPreviewLine,
  type PayrollLineTagInput,
} from '@kis-books/shared';

/** Department name (as in the file) → tag id or null (U-246). */
export type DepartmentTagMap = Record<string, string | null>;

interface GenerateJeInput {
  aggregationMode?: 'summary' | 'per_employee';
  accountMappings?: Record<string, string>;
  departmentTagMap?: DepartmentTagMap;
}
import { db } from '../db/index.js';
import type { DbOrTx, Tx } from '../db/index.js';
import { transactionWithRetry } from '../db/transaction.js';
import { claimIdempotency } from './idempotency.service.js';
import { createHash } from 'crypto';
import {
  payrollImportSessions,
  payrollImportRows,
  payrollImportErrors,
  payrollAccountMapping,
  payrollCheckRegisterRows,
  accounts,
  transactionTags,
  transactions,
} from '../db/schema/index.js';
import { env } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import * as ledger from './ledger.service.js';
import * as importService from './payroll-import.service.js';
import { assertTagsInTenant } from './tags.service.js';
import { readPayrollMoney } from './payroll-parse.service.js';

const Decimal = DecimalLib.default || DecimalLib;
type Dec = InstanceType<typeof Decimal>;

// ── Aggregate payroll rows into JE lines ──
//
// Every amount is an exact Decimal from the file cell to the ledger line
// (U-250). Nothing is rounded or plugged: an entry that does not balance is
// refused at post time with its date and difference.

interface AggregatedAmounts {
  gross_wages: Dec;
  employer_tax: Dec;
  employer_benefits: Dec;
  fit: Dec;
  sit: Dec;
  local_tax: Dec;
  ss: Dec;          // EE + ER
  medicare: Dec;    // EE + ER
  futa: Dec;
  suta: Dec;
  other_tax: Dec;   // other EE tax + other ER tax (U-243)
  health_ins: Dec;  // EE + ER (+ dental/vision EE)
  retirement: Dec;  // EE + ER (all 401k)
  other_deduction: Dec;
  reimbursement: Dec;
  net_pay: Dec;
  contractor_expense: Dec;
  contractor_payable: Dec;
}

function n(row: Record<string, any>, key: string): Dec {
  return readPayrollMoney(row[key]);
}

/** Gross pay is optional: a file that carries only net pay (a check
 *  register, say) books gross = net with no withholdings. */
export function grossOf(row: Record<string, any>): Dec {
  const g = row['gross_pay'];
  return g === undefined || g === null || g === '' ? n(row, 'net_pay') : n(row, 'gross_pay');
}

function emptyAgg(): AggregatedAmounts {
  const z = () => new Decimal(0);
  return {
    gross_wages: z(), employer_tax: z(), employer_benefits: z(),
    fit: z(), sit: z(), local_tax: z(),
    ss: z(), medicare: z(), futa: z(), suta: z(), other_tax: z(),
    health_ins: z(), retirement: z(), other_deduction: z(),
    reimbursement: z(),
    net_pay: z(), contractor_expense: z(), contractor_payable: z(),
  };
}

function aggregateRows(mappedRows: Record<string, any>[]): AggregatedAmounts {
  const agg = emptyAgg();

  for (const row of mappedRows) {
    const isContractor = row['is_contractor'] === true;

    if (isContractor) {
      const contractorPay = n(row, 'contractor_pay');
      const pay = contractorPay.isZero() ? grossOf(row) : contractorPay;
      agg.contractor_expense = agg.contractor_expense.plus(pay);
      agg.contractor_payable = agg.contractor_payable.plus(pay);
      continue;
    }

    agg.gross_wages = agg.gross_wages.plus(grossOf(row));
    agg.fit = agg.fit.plus(n(row, 'federal_income_tax'));
    agg.sit = agg.sit.plus(n(row, 'state_income_tax'));
    agg.local_tax = agg.local_tax.plus(n(row, 'local_income_tax'));
    agg.ss = agg.ss.plus(n(row, 'social_security_ee')).plus(n(row, 'social_security_er'));
    agg.medicare = agg.medicare.plus(n(row, 'medicare_ee')).plus(n(row, 'medicare_er'));
    agg.futa = agg.futa.plus(n(row, 'futa_er'));
    agg.suta = agg.suta.plus(n(row, 'suta_er'));
    agg.other_tax = agg.other_tax.plus(n(row, 'other_ee_tax')).plus(n(row, 'other_er_tax'));
    agg.other_deduction = agg.other_deduction.plus(n(row, 'hsa_ee')).plus(n(row, 'other_deduction_ee')).plus(n(row, 'other_benefit_er'));
    agg.health_ins = agg.health_ins.plus(n(row, 'health_insurance_ee')).plus(n(row, 'health_insurance_er')).plus(n(row, 'dental_vision_ee'));
    agg.retirement = agg.retirement.plus(n(row, 'retirement_401k_ee')).plus(n(row, 'roth_401k_ee')).plus(n(row, 'retirement_401k_er'));
    agg.reimbursement = agg.reimbursement.plus(n(row, 'reimbursement_ee'));
    agg.net_pay = agg.net_pay.plus(n(row, 'net_pay'));

    agg.employer_tax = agg.employer_tax
      .plus(n(row, 'social_security_er')).plus(n(row, 'medicare_er'))
      .plus(n(row, 'futa_er')).plus(n(row, 'suta_er')).plus(n(row, 'other_er_tax'));
    agg.employer_benefits = agg.employer_benefits
      .plus(n(row, 'health_insurance_er')).plus(n(row, 'retirement_401k_er')).plus(n(row, 'other_benefit_er'));
  }

  return agg;
}

// ── Build JE Lines from Aggregated Amounts ──

/** One department's share of a date's rows (U-246). */
interface DepartmentAgg {
  department: string | null;
  tagId: string | null;
  agg: AggregatedAmounts;
}

function buildJELines(
  agg: AggregatedAmounts,
  accountMap: Map<string, { id: string; name: string; number: string | null }>,
  departments?: DepartmentAgg[],
): PayrollJEPreviewLine[] {
  const lines: PayrollJEPreviewLine[] = [];

  const addLine = (
    lineType: string,
    desc: string,
    debit: Dec,
    credit: Dec,
    split?: { department: string | null; tagId: string | null },
  ) => {
    if (debit.isZero() && credit.isZero()) return;
    const acct = accountMap.get(lineType);
    const line: PayrollJEPreviewLine = {
      lineType,
      description: desc,
      accountId: acct?.id || null,
      accountName: acct?.name || null,
      accountNumber: acct?.number || null,
      debit: debit.toFixed(2),
      credit: credit.toFixed(2),
    };
    if (split) {
      line.department = split.department;
      line.tagId = split.tagId;
    }
    lines.push(line);
  };

  // Expense lines split by department when a department map was sent;
  // liability, clearing and contractor-payable lines never split, so net pay
  // stays one bank line per date (the exact per-line bank match needs it).
  const addExpense = (lineType: string, desc: string, pick: (a: AggregatedAmounts) => Dec) => {
    if (!departments) {
      addLine(lineType, desc, pick(agg), new Decimal(0));
      return;
    }
    for (const d of departments) {
      addLine(lineType, desc, pick(d.agg), new Decimal(0), { department: d.department, tagId: d.tagId });
    }
  };
  const zero = new Decimal(0);

  // DEBITS — subtract reimbursements from gross wages (they're non-taxable pass-through, not wage expense)
  addExpense(PayrollLineType.GROSS_WAGES_EXPENSE, 'Gross Wages Expense', a => a.gross_wages.minus(a.reimbursement));
  addExpense(PayrollLineType.EMPLOYER_TAX_EXPENSE, 'Employer Payroll Tax Expense', a => a.employer_tax);
  if (agg.employer_benefits.gt(0)) addExpense(PayrollLineType.EMPLOYER_BENEFITS_EXPENSE, 'Employer Benefits Expense', a => a.employer_benefits);
  if (agg.reimbursement.gt(0)) addExpense(PayrollLineType.REIMBURSEMENT_EXPENSE, 'Employee Reimbursements', a => a.reimbursement);
  if (agg.contractor_expense.gt(0)) addExpense(PayrollLineType.CONTRACTOR_EXPENSE, 'Contractor Expense', a => a.contractor_expense);

  // CREDITS
  if (agg.fit.gt(0)) addLine(PayrollLineType.FIT_PAYABLE, 'Federal Income Tax Payable', zero, agg.fit);
  if (agg.sit.gt(0) || agg.local_tax.gt(0)) addLine(PayrollLineType.SIT_PAYABLE, 'State/Local Tax Payable', zero, agg.sit.plus(agg.local_tax));
  if (agg.ss.gt(0)) addLine(PayrollLineType.SS_PAYABLE, 'Social Security Payable', zero, agg.ss);
  if (agg.medicare.gt(0)) addLine(PayrollLineType.MEDICARE_PAYABLE, 'Medicare Payable', zero, agg.medicare);
  if (agg.futa.gt(0)) addLine(PayrollLineType.FUTA_PAYABLE, 'FUTA Payable', zero, agg.futa);
  if (agg.suta.gt(0)) addLine(PayrollLineType.SUTA_PAYABLE, 'SUTA Payable', zero, agg.suta);
  if (agg.other_tax.gt(0)) addLine(PayrollLineType.OTHER_TAX_PAYABLE, 'Other Payroll Taxes Payable', zero, agg.other_tax);
  if (agg.health_ins.gt(0)) addLine(PayrollLineType.HEALTH_INS_PAYABLE, 'Health Insurance Payable', zero, agg.health_ins);
  if (agg.retirement.gt(0)) addLine(PayrollLineType.RETIREMENT_PAYABLE, 'Retirement (401k) Payable', zero, agg.retirement);
  if (agg.other_deduction.gt(0)) addLine(PayrollLineType.OTHER_DEDUCTION_PAYABLE, 'Other Deductions Payable', zero, agg.other_deduction);
  addLine(PayrollLineType.PAYROLL_CLEARING, 'Payroll Clearing / Cash', zero, agg.net_pay);
  if (agg.contractor_payable.gt(0)) addLine(PayrollLineType.CONTRACTOR_PAYABLE, 'Contractor Payable / Cash', zero, agg.contractor_payable);

  return lines;
}

/** Totals, exact difference and balance flag for a set of preview lines. */
export function previewTotals(lines: Pick<PayrollJEPreviewLine, 'debit' | 'credit'>[]) {
  let debits = new Decimal(0);
  let credits = new Decimal(0);
  for (const l of lines) {
    debits = debits.plus(l.debit);
    credits = credits.plus(l.credit);
  }
  return {
    totalDebits: debits.toFixed(2),
    totalCredits: credits.toFixed(2),
    difference: debits.minus(credits).toFixed(2),
    isBalanced: debits.eq(credits),
  };
}

// ── Get Account Map ──

async function getAccountMap(tenantId: string, companyId: string | null, overrides?: Record<string, string>, executor: DbOrTx = db) {
  const map = new Map<string, { id: string; name: string; number: string | null }>();

  // Load saved mappings
  if (companyId) {
    const mappings = await executor.select().from(payrollAccountMapping)
      .where(and(
        eq(payrollAccountMapping.tenantId, tenantId),
        eq(payrollAccountMapping.companyId, companyId),
      ));

    const acctIds = mappings.map(m => m.accountId);
    if (acctIds.length > 0) {
      const accts = await executor.select({ id: accounts.id, name: accounts.name, accountNumber: accounts.accountNumber })
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
      const accts = await executor.select({ id: accounts.id, name: accounts.name, accountNumber: accounts.accountNumber })
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

// ── Grouping helpers (U-242, U-246) ──

/** A row's pay date: its own check date, else the date given at upload. */
export function rowPayDate(row: Record<string, any>, sessionCheckDate: string | null | undefined): string {
  const own = row['check_date'];
  if (own !== undefined && own !== null && String(own).trim() !== '') return String(own).trim();
  return sessionCheckDate || '';
}

/** A row's department as departmentTagMap keys name it: trimmed, null when blank. */
export function departmentOf(row: Record<string, any>): string | null {
  const d = row['department'];
  if (d === undefined || d === null) return null;
  const s = String(d).trim();
  return s === '' ? null : s;
}

function splitByDepartment(rows: Record<string, any>[], map: DepartmentTagMap): DepartmentAgg[] {
  const groups = new Map<string | null, Record<string, any>[]>();
  for (const row of rows) {
    const dept = departmentOf(row);
    const list = groups.get(dept) ?? [];
    list.push(row);
    groups.set(dept, list);
  }
  // Department ascending (code-unit order, deterministic), blank last.
  const keys = [...groups.keys()].sort((a, b) => {
    if (a === b) return 0;
    if (a === null) return 1;
    if (b === null) return -1;
    return a < b ? -1 : 1;
  });
  return keys.map((department) => ({
    department,
    tagId: department !== null && Object.prototype.hasOwnProperty.call(map, department) ? map[department] ?? null : null,
    agg: aggregateRows(groups.get(department)!),
  }));
}

function summaryMemo(
  session: typeof payrollImportSessions.$inferSelect,
  date: string,
  rows: Record<string, any>[],
): string {
  const provider = session.detectedProvider || (session.metadata as any)?.detectedProvider || null;
  const label = (provider && PROVIDER_DISPLAY_NAMES[provider]) || 'Import';
  let start = session.payPeriodStart || '';
  let end = session.payPeriodEnd || '';
  if (!start || !end) {
    // Fall back to the period the rows of this pay date carry.
    const starts = rows.map(r => String(r['pay_period_start'] ?? '').trim()).filter(Boolean).sort();
    const ends = rows.map(r => String(r['pay_period_end'] ?? '').trim()).filter(Boolean).sort();
    start = starts[0] ?? '';
    end = ends[ends.length - 1] ?? '';
  }
  const period = start && end ? ` ${start}–${end}` : '';
  return `Payroll${period} — ${label} — pay date ${date}`;
}

// ── Generate JE Preview ──

export async function generateJE(
  tenantId: string,
  sessionId: string,
  options: GenerateJeInput,
  // The posting transaction (U-244): the preview is regenerated on it.
  executor: DbOrTx = db,
): Promise<{ previews: PayrollJEPreview[] }> {
  // On the posting transaction when called from post (M5).
  const session = await importService.getSession(tenantId, sessionId, executor);

  const rows = await executor.select().from(payrollImportRows)
    .where(and(
      eq(payrollImportRows.sessionId, sessionId),
      eq(payrollImportRows.validationStatus, 'valid'),
    ))
    .orderBy(payrollImportRows.rowNumber);

  // Also include warning rows
  const warningRows = await executor.select().from(payrollImportRows)
    .where(and(
      eq(payrollImportRows.sessionId, sessionId),
      eq(payrollImportRows.validationStatus, 'warning'),
    ))
    .orderBy(payrollImportRows.rowNumber);

  const allRows = [...rows, ...warningRows];
  if (allRows.length === 0) throw AppError.badRequest('No valid rows to generate JE from');

  const departmentTagMap = options.departmentTagMap;
  if (departmentTagMap) {
    await assertTagsInTenant(tenantId, Object.values(departmentTagMap).filter((t): t is string => !!t));
  }

  const accountMap = await getAccountMap(tenantId, session.companyId, options.accountMappings, executor);
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
      const checkDate = rowPayDate(empRows[0] ?? {}, session.checkDate);

      previews.push({
        date: checkDate,
        memo: `Payroll — ${empName} — ${session.payPeriodStart || ''} to ${session.payPeriodEnd || ''}`,
        lines,
        ...previewTotals(lines),
      });
    }
    return { previews };
  }

  // Summary mode (default): one entry per pay date, ascending (U-242). A
  // row without a date takes the check date given at upload.
  const byDate = new Map<string, Record<string, any>[]>();
  for (const row of mappedData) {
    const date = rowPayDate(row, session.checkDate);
    const list = byDate.get(date) ?? [];
    list.push(row);
    byDate.set(date, list);
  }
  const dates = [...byDate.keys()].sort();

  const previews: PayrollJEPreview[] = dates.map((date) => {
    const dateRows = byDate.get(date)!;
    const agg = aggregateRows(dateRows);
    const departments = departmentTagMap ? splitByDepartment(dateRows, departmentTagMap) : undefined;
    const lines = buildJELines(agg, accountMap, departments);
    return {
      date,
      memo: summaryMemo(session, date, dateRows),
      lines,
      ...previewTotals(lines),
    };
  });

  return { previews };
}

// ── Pay Period Overlap Check ──

const DAY_MS = 24 * 60 * 60 * 1000;

function dayNumber(isoDate: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY_MS;
}

function withinDays(a: string, b: string, days: number): boolean {
  const x = dayNumber(a);
  const y = dayNumber(b);
  return x !== null && y !== null && Math.abs(x - y) <= days;
}

/**
 * Prior posted imports (same company) this one may duplicate. A prior import
 * overlaps when any of its posted entries falls on, or within ±3 days of, any
 * pay date this import would post (`previewDates`, U-242), when the pay
 * periods overlap, or when the upload check dates match within ±3 days.
 * `matchingDates` lists this import's pay dates that hit a prior entry.
 */
export async function checkPayrollPeriodOverlap(
  tenantId: string,
  session: typeof payrollImportSessions.$inferSelect,
  previewDates: string[] = [],
  executor: DbOrTx = db,
) {
  const conditions = [
    eq(payrollImportSessions.tenantId, tenantId),
    eq(payrollImportSessions.status, 'posted'),
    ne(payrollImportSessions.id, session.id),
  ];
  if (session.companyId) {
    conditions.push(eq(payrollImportSessions.companyId, session.companyId));
  }

  const posted = await executor.select({
    id: payrollImportSessions.id,
    payPeriodStart: payrollImportSessions.payPeriodStart,
    payPeriodEnd: payrollImportSessions.payPeriodEnd,
    checkDate: payrollImportSessions.checkDate,
    originalFilename: payrollImportSessions.originalFilename,
    createdAt: payrollImportSessions.createdAt,
  })
    .from(payrollImportSessions)
    .where(and(...conditions));

  // Dates of the entries each prior import still has posted.
  const entryDates = new Map<string, string[]>();
  if (posted.length > 0 && previewDates.length > 0) {
    const txns = await executor.select({ sourceId: transactions.sourceId, txnDate: transactions.txnDate })
      .from(transactions)
      .where(and(
        eq(transactions.tenantId, tenantId),
        eq(transactions.source, 'payroll_import'),
        eq(transactions.status, 'posted'),
        inArray(transactions.sourceId, posted.map(p => p.id)),
      ));
    for (const t of txns) {
      if (!t.sourceId || !t.txnDate) continue;
      const list = entryDates.get(t.sourceId) ?? [];
      list.push(String(t.txnDate));
      entryDates.set(t.sourceId, list);
    }
  }

  const overlaps: Array<{
    sessionId: string;
    filename: string;
    payPeriod: string;
    postedDate: string;
    matchingDates: string[];
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
    if (!isOverlap && session.checkDate && prior.checkDate && withinDays(session.checkDate, prior.checkDate, 3)) {
      isOverlap = true;
    }
    // Every pay date this import would post against the prior's posted entries.
    const priorDates = entryDates.get(prior.id) ?? [];
    const matchingDates = [...new Set(previewDates)].sort()
      .filter(d => priorDates.some(p => withinDays(d, p, 3)));
    if (matchingDates.length > 0) isOverlap = true;

    if (isOverlap) {
      overlaps.push({
        sessionId: prior.id,
        filename: prior.originalFilename,
        payPeriod: prior.payPeriodStart && prior.payPeriodEnd
          ? `${prior.payPeriodStart} to ${prior.payPeriodEnd}`
          : prior.checkDate || 'unknown',
        postedDate: prior.createdAt ? new Date(prior.createdAt).toLocaleDateString() : 'unknown',
        matchingDates,
      });
    }
  }

  return overlaps;
}

// ── Refusals shared by Mode A and Mode B posting (U-250) ──

/**
 * Refuse before anything posts: every line needs an account (422
 * PAYROLL_UNMAPPED, details.lineTypes) and every entry must balance exactly
 * (422 PAYROLL_UNBALANCED, details {date, totalDebits, totalCredits,
 * difference}). Nothing is ever plugged.
 */
export function assertPreviewsPostable(previews: PayrollJEPreview[], unmappedNoun: 'mappings' | 'descriptions' = 'mappings') {
  const unmapped = previews.flatMap(p => p.lines.filter(l => !l.accountId));
  if (unmapped.length > 0) {
    const lineTypes = [...new Set(unmapped.map(l => l.lineType))];
    const names = [...new Set(unmapped.map(l => l.description))].join(', ');
    throw AppError.unprocessableEntity(
      unmappedNoun === 'descriptions'
        ? `Unmapped descriptions: ${names}. Map all descriptions before posting.`
        : `Missing account mappings for: ${names}. Configure payroll account mappings first.`,
      'PAYROLL_UNMAPPED',
      { lineTypes },
    );
  }
  for (const p of previews) {
    if (!p.isBalanced) {
      throw AppError.unprocessableEntity(
        `The payroll entry for ${p.date} does not balance: debits ${p.totalDebits}, credits ${p.totalCredits} (difference ${p.difference}). Check that every amount column in the file is mapped.`,
        'PAYROLL_UNBALANCED',
        { date: p.date, totalDebits: p.totalDebits, totalCredits: p.totalCredits, difference: p.difference },
      );
    }
  }
}

// ── Tags on posted JEs ──

export interface PayrollPostTags {
  /** Stamped on every line unless a line override says otherwise; when
   *  unset, each line keeps the tag its preview line carries (the
   *  description mapping's tag for Mode B). */
  tagId?: string | null;
  /** Per-line overrides, addressed by position in the generated preview. */
  lineTags?: PayrollLineTagInput[];
}

export type PayrollTagResolver = (jeIndex: number, lineIndex: number) => string | null;

/**
 * Validate the tags chosen on the Preview & Post step against the previews
 * regenerated at post time and the tenant's tags, and return a per-line
 * resolver. An override pointing at a JE whose date no longer matches (or a
 * line that no longer exists) means the preview changed under the user, so we
 * refuse instead of tagging the wrong lines.
 */
export async function resolvePayrollPostTags(
  tenantId: string,
  previews: PayrollJEPreview[],
  tags?: PayrollPostTags,
): Promise<PayrollTagResolver> {
  const defaultTagId = tags?.tagId ?? null;
  const overrides = new Map<string, string | null>();
  for (const lt of tags?.lineTags ?? []) {
    const preview = previews[lt.jeIndex];
    if (!preview || preview.date !== lt.date || lt.lineIndex >= preview.lines.length) {
      throw AppError.badRequest('The journal entry preview changed since tags were assigned. Reload the preview and re-apply the tags.');
    }
    overrides.set(`${lt.jeIndex}:${lt.lineIndex}`, lt.tagId);
  }
  const used = [defaultTagId, ...overrides.values()].filter((t): t is string => !!t);
  await assertTagsInTenant(tenantId, used);
  return (jeIndex, lineIndex) => {
    const key = `${jeIndex}:${lineIndex}`;
    if (overrides.has(key)) return overrides.get(key)!;
    return defaultTagId ?? previews[jeIndex]?.lines[lineIndex]?.tagId ?? null;
  };
}

/**
 * With TAGS_SPLIT_LEVEL_V2 on, the ledger derives transaction_tags from the
 * line tags itself. With it off, transaction_tags is still authoritative and
 * the ledger leaves it alone, so the header rows are written here.
 */
export async function stampPayrollHeaderTags(
  tenantId: string,
  companyId: string | null | undefined,
  transactionId: string,
  lineTagIds: Array<string | null>,
  executor: DbOrTx = db,
) {
  if (env.TAGS_SPLIT_LEVEL_V2) return;
  const unique = [...new Set(lineTagIds.filter((t): t is string => !!t))];
  if (unique.length === 0) return;
  await executor.insert(transactionTags).values(
    unique.map((tagId) => ({ tenantId, companyId: companyId ?? null, transactionId, tagId })),
  );
}

// ── Preview token (U-244) ──

/**
 * sha256 of the canonical JSON of what would post:
 * `[date, [lineType, accountId, department, debit, credit, tagId]]` per entry.
 * generate-je returns it; POST /post with a token that no longer matches the
 * regenerated preview is 409 PAYROLL_PREVIEW_CHANGED.
 */
export function previewTokenOf(previews: PayrollJEPreview[]): string {
  const canonical = previews.map(p => [
    p.date,
    p.lines.map(l => [l.lineType, l.accountId ?? null, l.department ?? null, l.debit, l.credit, l.tagId ?? null]),
  ]);
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

// ── Post (U-244 atomic, U-245 closing date, U-251 discard) ──

/** Test seam: runs before each entry posts (to force a failure on entry N). */
export const __payrollPostTestHooks: { beforeEntry?: (jeIndex: number) => Promise<void> | void } = {};

type SessionRow = typeof payrollImportSessions.$inferSelect;

/** Locks the session row for the rest of the posting transaction. */
async function lockSession(tx: Tx, tenantId: string, sessionId: string): Promise<SessionRow> {
  const [session] = await tx.select().from(payrollImportSessions)
    .where(and(eq(payrollImportSessions.tenantId, tenantId), eq(payrollImportSessions.id, sessionId)))
    .for('update').limit(1);
  if (!session) throw AppError.notFound('Import session not found');
  return session;
}

export interface PayrollPostOptions {
  forcePost: boolean;
  companyId?: string;
  tags?: PayrollPostTags;
  previewToken?: string;
  discardEmployeeDetail?: boolean;
  mode: 'employee_level' | 'prebuilt_je';
  /** Mode A refuses a session that is not validated (409 PAYROLL_NOT_READY). */
  requireValidated: boolean;
  /** Regenerates the previews on the posting transaction. */
  generate: (tx: Tx) => Promise<PayrollJEPreview[]>;
  unmappedNoun: 'mappings' | 'descriptions';
}

export type PayrollPostResult =
  | { journalEntryIds: string[]; count: number }
  | { overlaps: Awaited<ReturnType<typeof checkPayrollPeriodOverlap>>; requiresConfirmation: true };

/**
 * Posts every entry of a payroll import in ONE database transaction with the
 * session row locked: either all entries post and the session is marked
 * posted, or nothing changes. A concurrent second post waits on the lock and
 * is then refused 409 PAYROLL_ALREADY_POSTED. Entries dated on or before the
 * closing date take the request's closing password (lockContextMiddleware);
 * one password covers every entry.
 */
export async function postPayrollSession(
  tenantId: string,
  sessionId: string,
  userId: string,
  o: PayrollPostOptions,
): Promise<PayrollPostResult> {
  let discardedFile: string | null = null;
  const result = await transactionWithRetry(async (tx): Promise<PayrollPostResult> => {
    discardedFile = null;
    const session = await lockSession(tx, tenantId, sessionId);
    if (session.status === 'posted') {
      throw AppError.conflict('This payroll import is already posted.', 'PAYROLL_ALREADY_POSTED');
    }
    if (o.requireValidated && session.status !== 'validated') {
      throw AppError.conflict('Session must be validated before posting', 'PAYROLL_NOT_READY', { status: session.status });
    }

    // Two sessions of the same file (or the same provider run) posted at once
    // must not both pass the duplicate check (payroll-import-review-v1): posts
    // in one company take turns from here to the commit, so the second one's
    // duplicate check sees the first one posted (read committed) and is
    // refused 409. Keyed on the session's company, which the check scopes on.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`payroll-post:${tenantId}:${session.companyId ?? ''}`}, 0))`);
    await importService.checkDuplicateFileHash(tenantId, session, tx);

    const previews = await o.generate(tx);

    if (!o.forcePost) {
      const overlaps = await checkPayrollPeriodOverlap(tenantId, session, previews.map(p => p.date), tx);
      // Nothing is written: the caller answers 200 and does not claim the key.
      if (overlaps.length > 0) return { overlaps, requiresConfirmation: true };
    }

    if (o.previewToken && o.previewToken !== previewTokenOf(previews)) {
      throw AppError.conflict('The payroll preview changed since it was generated. Review it again before posting.', 'PAYROLL_PREVIEW_CHANGED');
    }
    assertPreviewsPostable(previews, o.unmappedNoun);

    if (o.discardEmployeeDetail) {
      // Reverse and /checks/post read the check-register rows and the
      // companion file, so a session that has them keeps its detail.
      const [checks] = await tx.select({ id: payrollCheckRegisterRows.id }).from(payrollCheckRegisterRows)
        .where(eq(payrollCheckRegisterRows.sessionId, sessionId)).limit(1);
      if (checks) {
        throw AppError.unprocessableEntity(
          'Employee detail cannot be discarded for an import that has check-register rows.',
          'PAYROLL_DISCARD_UNSUPPORTED',
        );
      }
    }

    const tagFor = await resolvePayrollPostTags(tenantId, previews, o.tags);
    await claimIdempotency(tx);
    const postedIds: string[] = [];

    for (const [jeIndex, preview] of previews.entries()) {
      if (__payrollPostTestHooks.beforeEntry) await __payrollPostTestHooks.beforeEntry(jeIndex);
      const lines = preview.lines.map((l, lineIndex) => ({
        accountId: l.accountId!,
        debit: l.debit !== '0.00' ? l.debit : '0',
        credit: l.credit !== '0.00' ? l.credit : '0',
        description: l.description,
        tagId: tagFor(jeIndex, lineIndex),
      }));

      const txn = await ledger.postTransaction(tenantId, {
        txnType: 'journal_entry' as any,
        txnDate: preview.date,
        memo: preview.memo,
        source: 'payroll_import',
        sourceId: sessionId,
        lines,
      }, userId, o.companyId, tx);
      await stampPayrollHeaderTags(tenantId, o.companyId, txn.id, lines.map(l => l.tagId), tx);
      postedIds.push(txn.id);
    }

    const updateData: Partial<SessionRow> = { status: 'posted', updatedAt: new Date(), jeCount: postedIds.length };
    if (o.mode === 'employee_level' && postedIds.length === 1) updateData.journalEntryId = postedIds[0]!;
    else updateData.journalEntryIds = postedIds;

    if (o.discardEmployeeDetail) {
      // U-251: no employee rows or stored upload survive the post. Hash, key,
      // dates, provider, counts and entry ids stay for duplicate, overlap
      // and Reverse.
      await tx.delete(payrollImportRows).where(eq(payrollImportRows.sessionId, sessionId));
      await tx.delete(payrollImportErrors).where(eq(payrollImportErrors.sessionId, sessionId));
      updateData.filePath = null;
      updateData.detailDiscardedAt = new Date();
      discardedFile = session.filePath;
    }

    await tx.update(payrollImportSessions).set(updateData)
      .where(and(eq(payrollImportSessions.tenantId, tenantId), eq(payrollImportSessions.id, sessionId)));

    await auditLog(tenantId, 'create', 'payroll_import_post', sessionId, null, {
      mode: o.mode,
      jeCount: postedIds.length,
      journalEntryIds: postedIds,
      tagId: o.tags?.tagId ?? null,
      lineTagOverrides: o.tags?.lineTags?.length ?? 0,
      detailDiscarded: !!o.discardEmployeeDetail,
    }, userId, tx);

    return { journalEntryIds: postedIds, count: postedIds.length };
  }, { label: 'payroll_post' });

  // After the commit: the stored upload goes too (best effort).
  if (discardedFile) await importService.discardStoredUpload(discardedFile);
  return result;
}

export async function postJE(
  tenantId: string,
  sessionId: string,
  userId: string,
  forcePost = false,
  aggregationMode: 'summary' | 'per_employee' = 'summary',
  companyId?: string,
  tags?: PayrollPostTags,
  departmentTagMap?: DepartmentTagMap,
  opts: { previewToken?: string; discardEmployeeDetail?: boolean } = {},
): Promise<PayrollPostResult> {
  return postPayrollSession(tenantId, sessionId, userId, {
    forcePost,
    companyId,
    tags,
    previewToken: opts.previewToken,
    discardEmployeeDetail: opts.discardEmployeeDetail,
    mode: 'employee_level',
    requireValidated: true,
    // Regenerate exactly what the preview showed (same department map, so
    // line-tag positions line up).
    generate: async (tx) => (await generateJE(tenantId, sessionId, { aggregationMode, departmentTagMap }, tx)).previews,
    unmappedNoun: 'mappings',
  });
}

// ── Reverse JE ──

/** Entry ids a posted session recorded (Mode A single id, Mode B / multi-date list). */
export function sessionEntryIds(session: Pick<SessionRow, 'journalEntryId' | 'journalEntryIds'>): string[] {
  const ids: string[] = [];
  if (session.journalEntryId) ids.push(session.journalEntryId);
  if (Array.isArray(session.journalEntryIds)) {
    for (const id of session.journalEntryIds as string[]) if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * Voids every entry of a posted import in ONE database transaction with the
 * session row locked (U-244). Not posted (including a second reverse) is 409
 * PAYROLL_NOT_POSTED. Entries in a closed period take the closing password.
 */
export async function reverseJE(tenantId: string, sessionId: string, reason: string, userId: string) {
  return transactionWithRetry(async (tx) => {
    const session = await lockSession(tx, tenantId, sessionId);
    if (session.status !== 'posted') {
      throw AppError.conflict('Only a posted payroll import can be reversed.', 'PAYROLL_NOT_POSTED', { status: session.status });
    }

    const jeIds = sessionEntryIds(session);

    // Also collect check transaction IDs
    const checkRows = await tx.select({ transactionId: payrollCheckRegisterRows.transactionId })
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
    await claimIdempotency(tx);

    // Void each JE that still exists and isn't already void. Transactions
    // removed by the admin date-range delete (or voided by hand) are skipped,
    // so a reversal can still release the import instead of failing.
    const existing = await tx.select({ id: transactions.id, status: transactions.status })
      .from(transactions)
      .where(and(eq(transactions.tenantId, tenantId), inArray(transactions.id, jeIds)));
    const toVoid = existing.filter((t) => t.status !== 'void' && t.status !== 'deleted').map((t) => t.id);
    for (const jeId of toVoid) {
      await ledger.voidTransactionInTx(tx, tenantId, jeId, `Reversal of payroll import: ${reason}`, userId);
    }

    // Mark checks as unposted
    if (checkRows.length > 0) {
      await tx.update(payrollCheckRegisterRows)
        .set({ posted: false, transactionId: null })
        .where(eq(payrollCheckRegisterRows.sessionId, sessionId));
    }

    await tx.update(payrollImportSessions)
      .set({ status: 'cancelled', updatedAt: new Date() })
      .where(and(eq(payrollImportSessions.tenantId, tenantId), eq(payrollImportSessions.id, sessionId)));

    await auditLog(tenantId, 'update', 'payroll_import_reverse', sessionId,
      { status: 'posted' }, { status: 'cancelled', reason, reversedCount: toVoid.length, alreadyGone: jeIds.length - toVoid.length }, userId, tx);

    return { reversed: toVoid.length, journalEntryIds: toVoid };
  }, { label: 'payroll_reverse' });
}
