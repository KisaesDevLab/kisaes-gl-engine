// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

import { eq, and } from 'drizzle-orm';
import type { PayrollValidationMessage, PayrollValidationSummary } from '@kis-books/shared';
import { MODE_B_COLUMN_CONFIGS } from '@kis-books/shared';
import { db } from '../db/index.js';
import { payrollImportSessions, payrollImportRows, payrollImportErrors, accounts } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { readPayrollMoney, parseDate, PAYROLL_AMOUNT_ERRORS_KEY } from './payroll-parse.service.js';
import * as importService from './payroll-import.service.js';
import { grossOf, rowPayDate } from './payroll-je.service.js';
import { glRowAmounts } from './payroll-modeb.service.js';
import DecimalLib from 'decimal.js';

const Decimal = DecimalLib.default || DecimalLib;

// ── SSN Pattern Scanner ──

const SSN_PATTERN = /\b\d{3}-\d{2}-\d{4}\b/;

function scanForSSN(rawData: Record<string, any>): boolean {
  for (const value of Object.values(rawData)) {
    if (typeof value === 'string' && SSN_PATTERN.test(value)) return true;
  }
  return false;
}

// ── Validation Rules ──

const AMOUNT_ERROR_TEXT: Record<string, string> = {
  AMOUNT_INVALID: 'is not a number',
  AMOUNT_PRECISION: 'has more than 2 decimal places',
};

function validateRow(mapped: Record<string, any>, rowNumber: number, sessionCheckDate?: string | null): PayrollValidationMessage[] {
  const r = mapped as any;
  const msgs: PayrollValidationMessage[] = [];

  // Money cells that did not parse (U-250): field and code only, never the
  // cell text. The field is then missing rather than silently 0.
  const amountErrors = (Array.isArray(mapped[PAYROLL_AMOUNT_ERRORS_KEY]) ? mapped[PAYROLL_AMOUNT_ERRORS_KEY] : []) as Array<{ field: string; code: string }>;
  for (const e of amountErrors) {
    msgs.push({
      field: e.field,
      code: e.code,
      message: `The amount in "${e.field}" ${AMOUNT_ERROR_TEXT[e.code] ?? 'is not valid'} (row ${rowNumber})`,
      severity: 'error',
    });
  }
  const badAmount = new Set(amountErrors.map(e => e.field));

  // A row without its own check date takes the date given at upload (U-242).
  const checkDate = rowPayDate(r, sessionCheckDate);

  // MISSING_REQUIRED — gross pay is optional (it defaults to net pay, see
  // grossOf in payroll-je.service), so net pay is the only amount required.
  for (const field of ['employee_name', 'check_date', 'net_pay']) {
    if (badAmount.has(field)) continue;
    const val = field === 'check_date' ? checkDate : mapped[field];
    if (val === undefined || val === null || val === '' || (typeof val === 'number' && isNaN(val))) {
      msgs.push({
        field,
        code: 'MISSING_REQUIRED',
        message: `Required field "${field}" is missing (row ${rowNumber})`,
        severity: 'error',
      });
    }
  }

  // INVALID_DATE
  if (checkDate && !/^\d{4}-\d{2}-\d{2}$/.test(checkDate)) {
    msgs.push({ field: 'check_date', code: 'INVALID_DATE', message: `Invalid date format: "${checkDate}" (row ${rowNumber})`, severity: 'error' });
  } else if (checkDate) {
    const d = new Date(checkDate);
    if (isNaN(d.getTime())) {
      msgs.push({ field: 'check_date', code: 'INVALID_DATE', message: `Unparseable date: "${checkDate}" (row ${rowNumber})`, severity: 'error' });
    } else if (d > new Date()) {
      msgs.push({ field: 'check_date', code: 'INVALID_DATE', message: `Future date: "${checkDate}" (row ${rowNumber})`, severity: 'error' });
    }

    // STALE_DATE
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
    if (d < ninetyDaysAgo) {
      msgs.push({ field: 'check_date', code: 'STALE_DATE', message: `Check date is more than 90 days ago (row ${rowNumber})`, severity: 'warning' });
    }
  }

  const m = (key: string) => readPayrollMoney(r[key]);
  const grossPay = grossOf(r);
  const netPay = m('net_pay');
  const isContractor = r.is_contractor === true;

  // NEGATIVE_GROSS
  if (grossPay.lt(0)) {
    msgs.push({ field: 'gross_pay', code: 'NEGATIVE_GROSS', message: `Negative gross pay: ${grossPay.toFixed(2)} (row ${rowNumber})`, severity: 'error' });
  }

  // NET_EXCEEDS_GROSS
  if (!isContractor && netPay.gt(grossPay) && grossPay.gt(0)) {
    msgs.push({ field: 'net_pay', code: 'NET_EXCEEDS_GROSS', message: `Net pay (${netPay.toFixed(2)}) exceeds gross pay (${grossPay.toFixed(2)}) (row ${rowNumber})`, severity: 'error' });
  }

  // ZERO_NET_PAY
  if (netPay.isZero() && grossPay.gt(0)) {
    msgs.push({ field: 'net_pay', code: 'ZERO_NET_PAY', message: `Net pay is $0 (row ${rowNumber})`, severity: 'warning' });
  }

  // BALANCE_MISMATCH — exact (U-250); still a warning.
  if (grossPay.gt(0) && !isContractor) {
    const withholdings = m('federal_income_tax').plus(m('state_income_tax')).plus(m('local_income_tax'))
      .plus(m('social_security_ee')).plus(m('medicare_ee')).plus(m('other_ee_tax'));
    const deductions = m('health_insurance_ee').plus(m('dental_vision_ee')).plus(m('retirement_401k_ee'))
      .plus(m('roth_401k_ee')).plus(m('hsa_ee')).plus(m('other_deduction_ee'));
    const expected = grossPay.minus(withholdings).minus(deductions);
    if (!expected.eq(netPay)) {
      msgs.push({
        field: 'net_pay',
        code: 'BALANCE_MISMATCH',
        message: `Gross (${grossPay.toFixed(2)}) − withholdings (${withholdings.toFixed(2)}) − deductions (${deductions.toFixed(2)}) = ${expected.toFixed(2)}, but net is ${netPay.toFixed(2)} (row ${rowNumber})`,
        severity: 'warning',
      });
    }
  }

  // LARGE_AMOUNT
  const amountFields = [
    'gross_pay', 'net_pay', 'federal_income_tax', 'state_income_tax',
    'social_security_ee', 'medicare_ee', 'social_security_er', 'medicare_er',
  ];
  for (const f of amountFields) {
    const v = m(f);
    if (v.abs().gt(50000)) {
      msgs.push({ field: f, code: 'LARGE_AMOUNT', message: `${f} is ${v.toFixed(2)} — unusually large (row ${rowNumber})`, severity: 'warning' });
    }
  }

  return msgs.map(msg => ({ ...msg, rowNumber }));
}
// ── Dispatch: validate based on import mode ──

export async function dispatchValidation(tenantId: string, sessionId: string): Promise<PayrollValidationSummary> {
  const session = await importService.getSession(tenantId, sessionId);
  if (session.importMode === 'prebuilt_je') {
    return validateModeBSession(tenantId, sessionId);
  }
  if (session.importMode === 'check_register') {
    // Checks are parsed at upload and their accounts resolved at post time;
    // there is no employee-level mapping to validate.
    return { totalRows: session.rowCount ?? 0, validRows: session.rowCount ?? 0, warningRows: 0, errorRows: 0, messages: [] };
  }
  return validateSession(tenantId, sessionId);
}

// ── Validate Session (Mode A) ──

export async function validateSession(tenantId: string, sessionId: string): Promise<PayrollValidationSummary> {
  const session = await importService.getSession(tenantId, sessionId);
  const metadata = session.metadata as any;
  const provider = metadata?.detectedProvider || null;

  const rows = await db.select().from(payrollImportRows)
    .where(eq(payrollImportRows.sessionId, sessionId))
    .orderBy(payrollImportRows.rowNumber);

  let validRows = 0;
  let warningRows = 0;
  let errorRows = 0;
  const allMessages: PayrollValidationMessage[] = [];
  const employeeNames = new Map<string, number>();
  let ssnDetected = false;
  const rowDates = new Set<string>();

  // Gusto missing column tracking
  let gustoTaxColumnsAllZero = true;

  for (const row of rows) {
    const mapped = (row.mappedData || row.rawData) as Record<string, any>;
    const msgs = validateRow(mapped, row.rowNumber, session.checkDate);
    const ownDate = mapped['check_date'];
    if (ownDate !== undefined && ownDate !== null && String(ownDate).trim() !== '') rowDates.add(String(ownDate).trim());

    // SSN scan
    if (!ssnDetected) {
      const raw = row.rawData as Record<string, any>;
      if (scanForSSN(raw)) ssnDetected = true;
    }

    // Gusto: track if tax columns have any non-zero values
    if (provider === 'gusto' && gustoTaxColumnsAllZero) {
      const taxFields = ['federal_income_tax', 'social_security_ee', 'medicare_ee'];
      for (const f of taxFields) {
        if (!readPayrollMoney(mapped[f]).isZero()) { gustoTaxColumnsAllZero = false; break; }
      }
    }

    // DUPLICATE_EMPLOYEE check
    const empName = String(mapped['employee_name'] || '').toLowerCase().trim();
    if (empName) {
      const prev = employeeNames.get(empName);
      if (prev) {
        msgs.push({
          field: 'employee_name',
          code: 'DUPLICATE_EMPLOYEE',
          message: `"${mapped['employee_name']}" also appears on row ${prev}`,
          severity: 'warning',
        });
      } else {
        employeeNames.set(empName, row.rowNumber);
      }
    }

    const hasError = msgs.some(m => m.severity === 'error');
    const hasWarning = msgs.some(m => m.severity === 'warning');
    const status = hasError ? 'error' : hasWarning ? 'warning' : 'valid';

    if (hasError) errorRows++;
    else if (hasWarning) warningRows++;
    else validRows++;

    allMessages.push(...msgs);

    await db.update(payrollImportRows)
      .set({
        validationStatus: status,
        validationMessages: msgs.length > 0 ? msgs : null,
      })
      .where(eq(payrollImportRows.id, row.id));
  }

  // SSN detected error
  if (ssnDetected) {
    allMessages.unshift({
      field: 'file',
      code: 'SSN_DETECTED',
      message: 'This file appears to contain Social Security numbers. Remove SSN columns before uploading.',
      severity: 'error',
    });
    errorRows++;
  }

  // Gusto: missing tax columns warning
  if (provider === 'gusto' && gustoTaxColumnsAllZero && rows.length > 0) {
    allMessages.push({
      field: 'file',
      code: 'GUSTO_MISSING_COLUMNS',
      message: 'Tax withholding columns appear empty. When exporting from Gusto, check all boxes under "Extra Details" (Earnings, Employee taxes, Employer taxes, Deductions, Benefits, Reimbursements).',
      severity: 'warning',
    });
  }

  // CHECK_DATE_NOT_IN_FILE: the rows carry their own pay dates and the date
  // given at upload is none of them (U-242). Each date posts its own entry.
  if (session.checkDate && rowDates.size > 0 && !rowDates.has(session.checkDate)) {
    allMessages.push({
      field: 'check_date',
      code: 'CHECK_DATE_NOT_IN_FILE',
      message: `The pay date given at upload (${session.checkDate}) is not one of the pay dates in the file. Each pay date in the file posts its own entry.`,
      severity: 'warning',
    });
  }

  // DUPLICATE_FILE check
  if (metadata?.isDuplicate) {
    allMessages.push({
      field: 'file',
      code: 'DUPLICATE_FILE',
      message: 'This file has been imported before (matching SHA-256 hash)',
      severity: 'warning',
    });
  }

  // DUPLICATE_BY_KEY check
  if (metadata?.isDuplicateByKey) {
    allMessages.push({
      field: 'file',
      code: 'DUPLICATE_BY_KEY',
      message: 'A payroll import with matching data (same provider, dates, and amounts) has already been posted.',
      severity: 'warning',
    });
  }

  // Update session
  const newStatus = errorRows > 0 ? 'failed' : 'validated';
  await db.update(payrollImportSessions)
    .set({
      status: newStatus,
      errorCount: errorRows,
      updatedAt: new Date(),
    })
    .where(eq(payrollImportSessions.id, sessionId));

  return {
    totalRows: rows.length,
    validRows,
    warningRows,
    errorRows,
    messages: allMessages,
  };
}

// ── Validate Mode B (balance check per date group) ──

export async function validateModeBSession(tenantId: string, sessionId: string): Promise<PayrollValidationSummary> {
  const session = await importService.getSession(tenantId, sessionId);
  const metadata = session.metadata as any;
  const provider = metadata?.detectedProvider || 'payroll_relief_gl';
  const columnConfig = MODE_B_COLUMN_CONFIGS[provider] || MODE_B_COLUMN_CONFIGS['payroll_relief_gl']!;

  const rows = await db.select().from(payrollImportRows)
    .where(eq(payrollImportRows.sessionId, sessionId))
    .orderBy(payrollImportRows.rowNumber);

  const messages: PayrollValidationMessage[] = [];
  let warningCount = 0;
  let ssnDetected = false;

  // Minimum row count check
  if (rows.length < 2) {
    messages.push({
      field: 'file',
      code: 'EMPTY_FILE',
      message: 'Mode B import requires at least 2 data rows (1 debit + 1 credit minimum).',
      severity: 'error',
    });
  }

  const dateGroups = new Map<string, { debits: InstanceType<typeof Decimal>; credits: InstanceType<typeof Decimal> }>();
  let amountErrors = 0;
  let dateErrors = 0;
  let toastSaasFeeDetected = false;
  let adpClearingDetected = false;
  let toastAccountIdBlank = true;

  for (const row of rows) {
    const raw = row.rawData as Record<string, string>;

    // SSN scan
    if (!ssnDetected && scanForSSN(raw)) ssnDetected = true;

    // Extract date and amounts using provider-specific columns
    const dateCol = columnConfig.dateColumn;
    const date = raw[dateCol] || raw[dateCol.toLowerCase()] || raw['Date'] || raw['date'] || '';

    // Exact amounts (U-250); a cell that is not a whole-cent number is a row
    // error naming the row, never the cell text.
    const { debit, credit, error } = glRowAmounts(raw, columnConfig);
    if (error) {
      amountErrors++;
      messages.push({
        field: 'amount',
        code: error,
        message: `The amount on row ${row.rowNumber} ${AMOUNT_ERROR_TEXT[error] ?? 'is not valid'}`,
        severity: 'error',
        rowNumber: row.rowNumber,
      });
    }

    // Provider-specific line-level checks
    const descCol = columnConfig.descriptionColumn;
    const desc = (raw[descCol] || raw[descCol.toLowerCase()] || '').toLowerCase();

    // An entry row (a description and an amount, as generate-je reads it)
    // whose date is missing or does not parse is a row error, never silently
    // left out of the entry (payroll-import-review-v1).
    const parsedDate = parseDate(date);
    if (!error && !parsedDate && desc.trim() && (debit.gt(0) || credit.gt(0))) {
      dateErrors++;
      messages.push({
        field: 'date',
        code: 'DATE_INVALID',
        message: `Row ${row.rowNumber} has no date or a date that cannot be read`,
        severity: 'error',
        rowNumber: row.rowNumber,
      });
    }

    if (date) {
      const key = parsedDate || date;
      const group = dateGroups.get(key) || { debits: new Decimal(0), credits: new Decimal(0) };
      group.debits = group.debits.plus(debit);
      group.credits = group.credits.plus(credit);
      dateGroups.set(key, group);
    }

    if (provider === 'toast_je_report') {
      if (desc.includes('service fee') || desc.includes('saas fee')) toastSaasFeeDetected = true;
      const accountIdCol = columnConfig.accountCodeColumn || 'AccountID';
      const accountId = raw[accountIdCol] || raw[accountIdCol.toLowerCase()] || '';
      if (accountId.trim()) toastAccountIdBlank = false;
    }

    if (provider === 'adp_run_gli') {
      if (desc.includes('clearing') || desc.includes('check register')) adpClearingDetected = true;
    }
  }

  // SSN detected
  if (ssnDetected) {
    messages.unshift({
      field: 'file',
      code: 'SSN_DETECTED',
      message: 'This file appears to contain Social Security numbers. Remove SSN columns before uploading.',
      severity: 'error',
    });
  }

  // Tally all errors from the top: SSN, empty file counted here
  let errorCount = 0;
  if (ssnDetected) errorCount++;
  if (rows.length < 2) errorCount++;
  errorCount += amountErrors;
  errorCount += dateErrors;

  // Balance check per date group — exact (U-250)
  let balanceErrors = 0;
  for (const [date, group] of dateGroups) {
    if (!group.debits.eq(group.credits)) {
      messages.push({
        field: 'balance',
        code: 'BALANCE_MISMATCH',
        message: `Date group ${date}: debits (${group.debits.toFixed(2)}) ≠ credits (${group.credits.toFixed(2)})`,
        severity: 'error',
      });
      balanceErrors++;
    }
  }
  errorCount += balanceErrors;

  // Toast: SaaS fee warning
  if (toastSaasFeeDetected) {
    messages.push({
      field: 'file',
      code: 'TOAST_SAAS_FEE',
      message: 'Toast service/SaaS fee line items detected. You may choose to exclude these from the payroll JE and book them separately.',
      severity: 'warning',
    });
    warningCount++;
  }

  // Toast: AccountID blank
  if (provider === 'toast_je_report' && toastAccountIdBlank && rows.length > 0) {
    messages.push({
      field: 'file',
      code: 'TOAST_NO_ACCOUNT_ID',
      message: 'AccountID column is entirely blank. Contact Toast Payroll support to configure GL account codes in the JE Report export.',
      severity: 'error',
    });
    errorCount++;
  }

  // ADP: Clearing account warning
  if (adpClearingDetected) {
    messages.push({
      field: 'file',
      code: 'ADP_CLEARING_ENTRIES',
      message: 'ADP Clearing account entries detected. You may have exported with "Include check register data = Yes". These extra entries may cause the JE to not balance as expected.',
      severity: 'warning',
    });
    warningCount++;
  }

  // Duplicate checks
  if (metadata?.isDuplicate) {
    messages.push({ field: 'file', code: 'DUPLICATE_FILE', message: 'This file has been imported before (matching SHA-256 hash)', severity: 'warning' });
    warningCount++;
  }
  if (metadata?.isDuplicateByKey) {
    messages.push({ field: 'file', code: 'DUPLICATE_BY_KEY', message: 'A payroll import with matching data has already been posted.', severity: 'warning' });
    warningCount++;
  }

  const status = errorCount > 0 ? 'failed' : 'validated';
  await db.update(payrollImportSessions)
    .set({ status, errorCount, updatedAt: new Date() })
    .where(eq(payrollImportSessions.id, sessionId));

  return {
    totalRows: rows.length,
    validRows: rows.length,       // Mode B doesn't validate individual rows — balance is per date-group
    warningRows: warningCount,
    errorRows: errorCount,        // File-level + balance errors
    messages,
  };
}
