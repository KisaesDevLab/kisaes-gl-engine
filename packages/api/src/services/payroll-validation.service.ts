import { eq, and } from 'drizzle-orm';
import type { PayrollValidationMessage, PayrollValidationSummary } from '@kis-books/shared';
import { MODE_B_COLUMN_CONFIGS } from '@kis-books/shared';
import { db } from '../db/index.js';
import { payrollImportSessions, payrollImportRows, payrollImportErrors, accounts } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { parseCurrency } from './payroll-parse.service.js';
import * as importService from './payroll-import.service.js';

// ── SSN Pattern Scanner ──

const SSN_PATTERN = /\b\d{3}-\d{2}-\d{4}\b/;

function scanForSSN(rawData: Record<string, any>): boolean {
  for (const value of Object.values(rawData)) {
    if (typeof value === 'string' && SSN_PATTERN.test(value)) return true;
  }
  return false;
}

// ── Validation Rules ──

function validateRow(mapped: Record<string, any>, rowNumber: number): PayrollValidationMessage[] {
  const r = mapped as any;
  const msgs: PayrollValidationMessage[] = [];

  // MISSING_REQUIRED
  for (const field of ['employee_name', 'check_date', 'gross_pay', 'net_pay']) {
    const val = mapped[field];
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
  const checkDate = String(r.check_date || '');
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

  const grossPay = Number(r.gross_pay ?? 0);
  const netPay = Number(r.net_pay ?? 0);
  const isContractor = r.is_contractor === true;

  // NEGATIVE_GROSS
  if (grossPay < 0) {
    msgs.push({ field: 'gross_pay', code: 'NEGATIVE_GROSS', message: `Negative gross pay: ${grossPay} (row ${rowNumber})`, severity: 'error' });
  }

  // NET_EXCEEDS_GROSS
  if (!isContractor && netPay > grossPay && grossPay > 0) {
    msgs.push({ field: 'net_pay', code: 'NET_EXCEEDS_GROSS', message: `Net pay (${netPay}) exceeds gross pay (${grossPay}) (row ${rowNumber})`, severity: 'error' });
  }

  // ZERO_NET_PAY
  if (netPay === 0 && grossPay > 0) {
    msgs.push({ field: 'net_pay', code: 'ZERO_NET_PAY', message: `Net pay is $0 (row ${rowNumber})`, severity: 'warning' });
  }

  // BALANCE_MISMATCH
  if (grossPay > 0 && !isContractor) {
    const withholdings = (Number(r.federal_income_tax ?? 0)) +
      (Number(r.state_income_tax ?? 0)) +
      (Number(r.local_income_tax ?? 0)) +
      (Number(r.social_security_ee ?? 0)) +
      (Number(r.medicare_ee ?? 0)) +
      (Number(r.other_ee_tax ?? 0));
    const deductions = (Number(r.health_insurance_ee ?? 0)) +
      (Number(r.dental_vision_ee ?? 0)) +
      (Number(r.retirement_401k_ee ?? 0)) +
      (Number(r.roth_401k_ee ?? 0)) +
      (Number(r.hsa_ee ?? 0)) +
      (Number(r.other_deduction_ee ?? 0));
    const expected = grossPay - withholdings - deductions;
    if (Math.abs(expected - netPay) > 0.05) {
      msgs.push({
        field: 'net_pay',
        code: 'BALANCE_MISMATCH',
        message: `Gross (${grossPay}) − withholdings (${withholdings.toFixed(2)}) − deductions (${deductions.toFixed(2)}) = ${expected.toFixed(2)}, but net is ${netPay} (row ${rowNumber})`,
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
    const v = Number(mapped[f] ?? 0);
    if (Math.abs(v) > 50000) {
      msgs.push({ field: f, code: 'LARGE_AMOUNT', message: `${f} is ${v} — unusually large (row ${rowNumber})`, severity: 'warning' });
    }
  }

  return msgs;
}

// ── Dispatch: validate based on import mode ──

export async function dispatchValidation(tenantId: string, sessionId: string): Promise<PayrollValidationSummary> {
  const session = await importService.getSession(tenantId, sessionId);
  if (session.importMode === 'prebuilt_je') {
    return validateModeBSession(tenantId, sessionId);
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

  // Gusto missing column tracking
  let gustoTaxColumnsAllZero = true;

  for (const row of rows) {
    const mapped = (row.mappedData || row.rawData) as Record<string, any>;
    const msgs = validateRow(mapped, row.rowNumber);

    // SSN scan
    if (!ssnDetected) {
      const raw = row.rawData as Record<string, any>;
      if (scanForSSN(raw)) ssnDetected = true;
    }

    // Gusto: track if tax columns have any non-zero values
    if (provider === 'gusto' && gustoTaxColumnsAllZero) {
      const taxFields = ['federal_income_tax', 'social_security_ee', 'medicare_ee'];
      for (const f of taxFields) {
        if (Number(mapped[f] ?? 0) !== 0) { gustoTaxColumnsAllZero = false; break; }
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

  const dateGroups = new Map<string, { debits: number; credits: number }>();
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

    let debit = 0;
    let credit = 0;

    if (columnConfig.amountConvention === 'separate_dr_cr') {
      const drCol = columnConfig.debitColumn || 'Debit';
      const crCol = columnConfig.creditColumn || 'Credit';
      debit = parseCurrency(raw[drCol] || raw[drCol.toLowerCase()]);
      credit = parseCurrency(raw[crCol] || raw[crCol.toLowerCase()]);
    } else if (columnConfig.amountConvention === 'signed_single') {
      const amtCol = columnConfig.amountColumn || 'Amount';
      const val = parseCurrency(raw[amtCol] || raw[amtCol.toLowerCase()]);
      if (val >= 0) debit = val;
      else credit = Math.abs(val);
    } else if (columnConfig.amountConvention === 'category_derived') {
      const amtCol = columnConfig.amountColumn || 'Amount';
      const catCol = columnConfig.accountCategoryColumn || 'Category';
      const amount = Math.abs(parseCurrency(raw[amtCol] || raw[amtCol.toLowerCase()]));
      const category = (raw[catCol] || raw[catCol.toLowerCase()] || '').toLowerCase().trim();
      if (category.startsWith('expense') || category.startsWith('cost')) debit = amount;
      else credit = amount;
    }

    if (date) {
      const group = dateGroups.get(date) || { debits: 0, credits: 0 };
      group.debits += debit;
      group.credits += credit;
      dateGroups.set(date, group);
    }

    // Provider-specific line-level checks
    const descCol = columnConfig.descriptionColumn;
    const desc = (raw[descCol] || raw[descCol.toLowerCase()] || '').toLowerCase();

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

  // Balance check per date group
  let balanceErrors = 0;
  for (const [date, group] of dateGroups) {
    if (Math.abs(group.debits - group.credits) > 0.01) {
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
