import { eq, and } from 'drizzle-orm';
import type { PayrollValidationMessage, PayrollValidationSummary } from '@kis-books/shared';
import { db } from '../db/index.js';
import { payrollImportSessions, payrollImportRows, payrollImportErrors, accounts } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import * as importService from './payroll-import.service.js';

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

  const rows = await db.select().from(payrollImportRows)
    .where(eq(payrollImportRows.sessionId, sessionId))
    .orderBy(payrollImportRows.rowNumber);

  let validRows = 0;
  let warningRows = 0;
  let errorRows = 0;
  const allMessages: PayrollValidationMessage[] = [];
  const employeeNames = new Map<string, number>();

  for (const row of rows) {
    const mapped = (row.mappedData || row.rawData) as Record<string, any>;
    const msgs = validateRow(mapped, row.rowNumber);

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

  // DUPLICATE_FILE check
  const metadata = session.metadata as any;
  if (metadata?.isDuplicate) {
    allMessages.push({
      field: 'file',
      code: 'DUPLICATE_FILE',
      message: 'This file has been imported before (matching SHA-256 hash)',
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
  const rows = await db.select().from(payrollImportRows)
    .where(eq(payrollImportRows.sessionId, sessionId))
    .orderBy(payrollImportRows.rowNumber);

  const messages: PayrollValidationMessage[] = [];
  const dateGroups = new Map<string, { debits: number; credits: number }>();

  for (const row of rows) {
    const raw = row.rawData as Record<string, string>;
    const date = raw['Date'] || raw['date'] || '';
    const debit = parseFloat(String(raw['Debit'] || '0').replace(/[$,]/g, '')) || 0;
    const credit = parseFloat(String(raw['Credit'] || '0').replace(/[$,]/g, '')) || 0;

    if (date) {
      const group = dateGroups.get(date) || { debits: 0, credits: 0 };
      group.debits += debit;
      group.credits += credit;
      dateGroups.set(date, group);
    }
  }

  let errorCount = 0;
  for (const [date, group] of dateGroups) {
    if (Math.abs(group.debits - group.credits) > 0.01) {
      messages.push({
        field: 'balance',
        code: 'BALANCE_MISMATCH',
        message: `Date group ${date}: debits (${group.debits.toFixed(2)}) ≠ credits (${group.credits.toFixed(2)})`,
        severity: 'error',
      });
      errorCount++;
    }
  }

  const status = errorCount > 0 ? 'failed' : 'validated';
  await db.update(payrollImportSessions)
    .set({ status, errorCount, updatedAt: new Date() })
    .where(eq(payrollImportSessions.id, sessionId));

  return {
    totalRows: rows.length,
    validRows: rows.length - errorCount,
    warningRows: 0,
    errorRows: errorCount,
    messages,
  };
}
