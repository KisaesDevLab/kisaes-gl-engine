// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Tax Estimator estimated-tax payment ledger (Phase 10b, MODULE.md "Payments", Q34).
//
//   ledger = stored rows (tax_est_payments: manual entries, prior-year overpayments,
//            pinned GL rows) for the year (scenario_id NULL) + the scenario's own rows
//          + LIVE GL rows: lines on accounts treated `estimated_tax_payment` and tied to
//            this taxpayer, in every linked company whose tenant is in the caller's
//            scope (D1), read on a CASH basis (R1 F4) over the year's ATTRIBUTION
//            window (R3-02, MODULE.md "Safe harbor ... Payments"):
//              start = the day after the PRIOR year's Q4 cutoff (Jan 1 – Jan 31 of the
//                      tax year belongs to the prior year's January installment),
//              end   = this year's Q4 cutoff = the later of the last installment due
//                      date and the Q4 file-and-pay date (Jan 31 of the next year when
//                      neither parameter is usable).
//            Consecutive windows never overlap, so one GL transaction is credited to
//            exactly one tax year by default. A payment made between the Q4 cutoff and
//            the return due date (a late Q4 / extension payment) is credited to the NEXT
//            year unless a stored row pins it: a stored row for ANY year carrying the
//            transaction id removes it from every other year's live read, and one
//            transaction can be pinned to one tax year only (409 TE_PAYMENT_OTHER_YEAR).
//   dedupe = a stored row with the same transaction id supersedes every GL row of that
//            transaction in its year, whatever the jurisdiction (R3-11; a corrected
//            jurisdiction is warned), so a pin that mirrors a booked payment is never
//            counted twice.
//
// Reads books only through the report builder (buildAccountDetailReport); its own SQL
// touches estimator rows, always pinned to the firm and to in-scope tenants.
import { and, asc, eq, inArray, isNull, ne, or } from 'drizzle-orm';
import DecimalLib from 'decimal.js';
import type {
  CreatePaymentInput, UpdatePaymentInput, EstimatePaymentDTO, EstimatePaymentSourceDTO, LinkDTO, PaymentLedgerDTO, TaxEstimatorWarning,
} from '@kis-books/shared';
import { db, type DbOrTx } from '../../db/index.js';
import { taxEstPayments } from '../../db/schema/tax-estimator-estimate.js';
import { taxEstAccountTreatments } from '../../db/schema/tax-estimator-entities.js';
import { transactions } from '../../db/schema/index.js';
import { buildAccountDetailReport } from '../report.service.js';
import { AppError } from '../../utils/errors.js';
import { isTenantInScope, type FirmScope } from './firm-scope.service.js';
import { getParameters } from './tax-parameters.service.js';
import { listLinks } from './taxpayers.service.js';
import {
  auditYears, loadScenarioForFirm, loadTaxpayerForFirm, scenarioNotFound, tenantNotManaged, type Actor,
} from './year-access.js';

const Decimal = DecimalLib.default || DecimalLib;
type Dec = InstanceType<typeof Decimal>;
const ZERO = new Decimal(0);
const s4 = (d: Dec) => d.toFixed(4);
const dec = (x: string | number | null | undefined) => new Decimal(x ?? 0);

const ALL_ACCOUNT_TYPES = ['asset', 'liability', 'equity', 'revenue', 'cogs', 'expense', 'other_revenue', 'other_expense'];
const FEDERAL = 'federal';
const RETURN_DUE_DATE_KEY = 'return_due_date';
const DUE_DATES_KEY = 'installments.due_dates';
const Q4_FILE_AND_PAY_KEY = 'installments.q4_file_and_pay_date';

type PaymentRow = typeof taxEstPayments.$inferSelect;

export const paymentNotFound = () => new AppError(404, 'Payment not found', 'TE_PAYMENT_NOT_FOUND');

const isoDate = (v: unknown): string => {
  if (typeof v === 'string') return v.slice(0, 10);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
};
const lineDebit = (l: { debit: number; debitExact?: string }) => dec(l.debitExact ?? l.debit);
const lineCredit = (l: { credit: number; creditExact?: string }) => dec(l.creditExact ?? l.credit);

function toStoredDTO(r: PaymentRow): EstimatePaymentDTO {
  return {
    id: r.id, stored: true, taxpayerId: r.taxpayerId, taxYear: r.taxYear, scenarioId: r.scenarioId,
    jurisdiction: r.jurisdiction, date: r.paymentDate ? isoDate(r.paymentDate) : null, amount: r.amount,
    source: r.source as EstimatePaymentSourceDTO, tenantId: r.tenantId, transactionId: r.transactionId, memo: r.memo,
    accountName: null, companyName: null, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
  };
}

/** Audit shape: amounts and dates are bookkeeping data, not return information. */
const auditShape = (r: PaymentRow) => toStoredDTO(r);

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isIso = (v: unknown): v is string => typeof v === 'string' && ISO_DATE.test(v);

/** The day after an ISO date (UTC). */
function nextDay(d: string): string {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
}

/**
 * Q4 cutoff of `taxYear` (R3-02): the latest of the last individual installment due date
 * and the Q4 file-and-pay date that falls in the NEXT calendar year; GL payments dated
 * after Dec 31 and on or before it are the year's January (Q4) installment. Defaults to
 * Jan 31 of the next year when neither parameter is usable.
 */
async function q4Cutoff(taxYear: number): Promise<{ date: string; returnDueDate: string | null; defaulted: boolean }> {
  const params = await getParameters(taxYear);
  const val = (k: string) => params.parameters.find((p) => p.key === k)?.value;
  const nextYear = `${taxYear}-12-31`;
  const due = val(DUE_DATES_KEY);
  const candidates = [
    ...(Array.isArray(due) ? due.slice(-1) : []),
    val(Q4_FILE_AND_PAY_KEY),
  ].filter((d): d is string => isIso(d) && d > nextYear);
  const rdd = val(RETURN_DUE_DATE_KEY);
  const returnDueDate = isIso(rdd) ? rdd : null;
  if (candidates.length === 0) return { date: `${taxYear + 1}-01-31`, returnDueDate, defaulted: true };
  return { date: candidates.sort()[candidates.length - 1]!, returnDueDate, defaulted: false };
}

/**
 * GL attribution window of a tax year (R3-02): (prior year's Q4 cutoff, this year's Q4
 * cutoff]. Consecutive years' windows never overlap. `returnDueDate` is informational
 * (penalty accrual end); payments after the Q4 cutoff belong to the next year unless pinned.
 */
export async function paymentWindow(taxYear: number): Promise<{ start: string; end: string; returnDueDate: string | null; warning: TaxEstimatorWarning | null }> {
  const [prev, cur] = await Promise.all([q4Cutoff(taxYear - 1), q4Cutoff(taxYear)]);
  const start = nextDay(prev.date);
  return {
    start, end: cur.date, returnDueDate: cur.returnDueDate,
    warning: cur.defaulted || prev.defaulted
      ? { code: 'TE_PAYMENT_WINDOW_DEFAULTED', severity: 'warning', message: `No usable Q4 installment date for ${cur.defaulted ? taxYear : taxYear - 1}; January 31 was used as the Q4 cutoff. GL payments are credited to ${taxYear} from ${start} through ${cur.date}.` }
      : null,
  };
}

/**
 * Live GL payments for one taxpayer: every in-scope linked company's lines on accounts
 * treated `estimated_tax_payment` with this taxpayer as the payment target. Lines of one
 * transaction on one jurisdiction are summed (one row per (transaction, jurisdiction)).
 */
export async function readGlPayments(
  scope: FirmScope, taxpayerId: string, taxYear: number, links: ReadonlyArray<LinkDTO>, window: { start: string; end: string },
): Promise<{ payments: EstimatePaymentDTO[]; warnings: TaxEstimatorWarning[] }> {
  const warnings: TaxEstimatorWarning[] = [];
  const companies = new Map<string, { tenantId: string; companyId: string; companyName: string | null }>();
  for (const l of links) {
    if (l.outOfScope || !isTenantInScope(scope, l.tenantId)) continue; // D1: never read an out-of-scope tenant
    companies.set(`${l.tenantId}|${l.companyId}`, { tenantId: l.tenantId, companyId: l.companyId, companyName: l.companyName });
  }
  const out: EstimatePaymentDTO[] = [];
  for (const c of companies.values()) {
    const treated = await db.select().from(taxEstAccountTreatments).where(and(
      eq(taxEstAccountTreatments.tenantId, c.tenantId),
      eq(taxEstAccountTreatments.companyId, c.companyId),
      eq(taxEstAccountTreatments.treatment, 'estimated_tax_payment'),
      eq(taxEstAccountTreatments.paymentTaxpayerId, taxpayerId),
    ));
    if (treated.length === 0) continue;
    const byAccount = new Map(treated.map((t) => [t.accountId, t]));
    const detail = await buildAccountDetailReport(c.tenantId, window.start, window.end, {
      title: 'tax-estimator-payment-ledger', accountTypes: ALL_ACCOUNT_TYPES, normalSide: 'debit', companyId: c.companyId,
      accountIds: [...byAccount.keys()], detail: true, basis: 'cash', exactAmounts: true,
    });
    if (!('groups' in detail)) continue;
    const agg = new Map<string, { row: EstimatePaymentDTO; amount: Dec }>();
    for (const g of detail.groups) {
      const t = byAccount.get(g.accountId);
      if (!t) continue;
      if (!t.paymentJurisdiction) {
        warnings.push({ code: 'TE_PAYMENT_JURISDICTION_MISSING', severity: 'warning', message: `Payment account ${g.name} has no jurisdiction; its payments are not credited. Set federal or a state on the treatment.`, details: { accountId: g.accountId } });
        continue;
      }
      for (const line of g.lines) {
        const amount = lineDebit(line).minus(lineCredit(line));
        if (amount.isZero() || !line.transactionId) continue;
        const key = `${line.transactionId}|${t.paymentJurisdiction}`;
        const prev = agg.get(key);
        if (prev) { prev.amount = prev.amount.plus(amount); continue; }
        agg.set(key, {
          amount,
          row: {
            id: `gl:${line.transactionId}`, stored: false, taxpayerId, taxYear, scenarioId: null, jurisdiction: t.paymentJurisdiction,
            date: isoDate(line.date), amount: '0', source: 'gl', tenantId: c.tenantId, transactionId: line.transactionId,
            memo: line.memo || null, accountName: g.name, companyName: c.companyName, createdAt: null, updatedAt: null,
          },
        });
      }
    }
    for (const { row, amount } of agg.values()) {
      if (!amount.isPositive()) {
        warnings.push({ code: 'TE_PAYMENT_NOT_POSITIVE', severity: 'info', message: `A ${row.jurisdiction} payment-account entry on ${row.date} nets to ${s4(amount)} (a refund or reversal); it is not credited as an estimated payment.`, details: { transactionId: row.transactionId } });
        continue;
      }
      out.push({ ...row, amount: s4(amount) });
    }
  }
  out.sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '') || a.jurisdiction.localeCompare(b.jurisdiction));
  return { payments: out, warnings };
}

/** The first individual installment due date of the year (parameter), or null. */
async function firstInstallmentDue(taxYear: number): Promise<string | null> {
  const params = await getParameters(taxYear);
  const due = params.parameters.find((p) => p.key === DUE_DATES_KEY)?.value;
  const first = Array.isArray(due) ? due[0] : null;
  return isIso(first) ? first : null;
}

async function storedRows(scope: FirmScope, taxpayerId: string, taxYear: number, scenarioId: string | null): Promise<PaymentRow[]> {
  return db.select().from(taxEstPayments).where(and(
    eq(taxEstPayments.firmId, scope.firmId),
    eq(taxEstPayments.taxpayerId, taxpayerId),
    eq(taxEstPayments.taxYear, taxYear),
    scenarioId ? or(isNull(taxEstPayments.scenarioId), eq(taxEstPayments.scenarioId, scenarioId)) : isNull(taxEstPayments.scenarioId),
  )).orderBy(asc(taxEstPayments.paymentDate), asc(taxEstPayments.createdAt));
}

async function assertScenarioOf(scope: FirmScope, scenarioId: string, taxpayerId: string, taxYear: number, exec: DbOrTx = db) {
  const s = await loadScenarioForFirm(scope, scenarioId, exec);
  if (s.taxpayerId !== taxpayerId || s.taxYear !== taxYear) throw scenarioNotFound();
  return s;
}

/**
 * The effective ledger for (taxpayer, year[, scenario]): stored rows first, then GL rows
 * not superseded by a stored row with the same (jurisdiction, transaction). A stored row
 * that points into a tenant outside the caller's scope is dropped with a warning (D1).
 */
export async function getPaymentLedger(
  scope: FirmScope, taxpayerId: string, taxYear: number, scenarioId: string | null,
  pre?: { links?: ReadonlyArray<LinkDTO>; limit?: number; offset?: number },
): Promise<PaymentLedgerDTO> {
  await loadTaxpayerForFirm(scope, taxpayerId);
  if (scenarioId) await assertScenarioOf(scope, scenarioId, taxpayerId, taxYear);
  const win = await paymentWindow(taxYear);
  const links = pre?.links ?? (await listLinks(scope, taxpayerId, taxYear)).data;
  const warnings: TaxEstimatorWarning[] = win.warning ? [win.warning] : [];

  const stored: EstimatePaymentDTO[] = [];
  for (const r of await storedRows(scope, taxpayerId, taxYear, scenarioId)) {
    if (r.tenantId && !isTenantInScope(scope, r.tenantId)) {
      warnings.push({ code: 'TE_TENANT_NOT_MANAGED', severity: 'warning', message: 'A recorded payment points at a client the firm no longer manages (or you can no longer reach); it is left out.', details: { paymentId: r.id } });
      continue;
    }
    stored.push(toStoredDTO(r));
  }
  const gl = await readGlPayments(scope, taxpayerId, taxYear, links, win);
  warnings.push(...gl.warnings);

  // R3-02: a transaction pinned (stored) under ANOTHER tax year is that year's payment.
  const glTxnIds = [...new Set(gl.payments.map((p) => p.transactionId).filter((t): t is string => !!t))];
  const pinnedElsewhere = new Map<string, number>();
  if (glTxnIds.length > 0) {
    const rows = await db.select({ transactionId: taxEstPayments.transactionId, taxYear: taxEstPayments.taxYear }).from(taxEstPayments).where(and(
      eq(taxEstPayments.firmId, scope.firmId), eq(taxEstPayments.taxpayerId, taxpayerId),
      ne(taxEstPayments.taxYear, taxYear), inArray(taxEstPayments.transactionId, glTxnIds),
    ));
    for (const r of rows) if (r.transactionId) pinnedElsewhere.set(r.transactionId, r.taxYear);
  }
  const live = gl.payments.filter((p) => {
    const other = p.transactionId ? pinnedElsewhere.get(p.transactionId) : undefined;
    if (other === undefined) return true;
    warnings.push({ code: 'TE_PAYMENT_PINNED_OTHER_YEAR', severity: 'info', message: `A ${p.jurisdiction} payment of ${p.amount} on ${p.date} is recorded for tax year ${other}; it is not credited to ${taxYear}.`, details: { transactionId: p.transactionId, taxYear: other } });
    return false;
  });
  // Ambiguous by date: after the prior year's Q4 cutoff but before this year's first
  // installment — usually a late prior-year payment or an extension payment. Credited here
  // by the attribution rule; say so.
  const firstDue = await firstInstallmentDue(taxYear);
  for (const p of live) {
    if (p.date && firstDue && p.date < firstDue) {
      warnings.push({ code: 'TE_PAYMENT_YEAR_ASSUMED', severity: 'info', message: `A ${p.jurisdiction} payment of ${p.amount} on ${p.date} falls after the ${taxYear - 1} Q4 cutoff and before the first ${taxYear} installment; it is credited to ${taxYear}. If it was a late ${taxYear - 1} payment, record it under ${taxYear - 1}.`, details: { transactionId: p.transactionId } });
    }
  }

  // R3-11: a stored row supersedes EVERY GL row of its transaction (whatever the jurisdiction).
  const storedByTxn = new Map<string, EstimatePaymentDTO>();
  for (const p of stored) if (p.transactionId) storedByTxn.set(p.transactionId, p);
  const duplicatesDropped = live.filter((p) => p.transactionId && storedByTxn.has(p.transactionId));
  for (const d of duplicatesDropped) {
    const s = storedByTxn.get(d.transactionId!)!;
    if (s.jurisdiction !== d.jurisdiction) {
      warnings.push({ code: 'TE_PAYMENT_JURISDICTION_CHANGED', severity: 'info', message: `A payment booked to a ${d.jurisdiction} payment account on ${d.date} is recorded as ${s.jurisdiction}; the recorded jurisdiction is used.`, details: { transactionId: d.transactionId, booked: d.jurisdiction, recorded: s.jurisdiction } });
    }
  }
  const payments = [...stored, ...live.filter((p) => !(p.transactionId && storedByTxn.has(p.transactionId)))];

  const totals: Record<string, string> = {};
  const sums = new Map<string, Dec>();
  for (const p of payments) sums.set(p.jurisdiction, (sums.get(p.jurisdiction) ?? ZERO).plus(dec(p.amount)));
  for (const [j, v] of sums) totals[j] = s4(v);
  const offset = pre?.offset ?? 0;
  const limit = pre?.limit ?? Math.max(payments.length, 1);
  return {
    taxpayerId, taxYear, scenarioId, window: { start: win.start, end: win.end, returnDueDate: win.returnDueDate },
    payments: pre?.limit === undefined && pre?.offset === undefined ? payments : payments.slice(offset, offset + limit),
    total: payments.length, limit, offset, duplicatesDropped, totals, warnings,
  };
}

// ── CRUD (stored rows) ─────────────────────────────────────────────────

interface Merged {
  scenarioId: string | null;
  jurisdiction: string;
  date: string | null;
  amount: string;
  source: EstimatePaymentSourceDTO;
  tenantId: string | null;
  transactionId: string | null;
  memo: string | null;
}

async function validateMerged(scope: FirmScope, exec: DbOrTx, taxpayerId: string, taxYear: number, m: Merged, selfId?: string) {
  if (m.source !== 'prior_year_overpayment' && !m.date) throw AppError.unprocessableEntity('A payment needs a date', 'TE_PAYMENT_DATE_REQUIRED');
  if (m.source === 'gl' && (!m.transactionId || !m.tenantId)) throw AppError.unprocessableEntity('A GL payment needs tenantId and transactionId', 'TE_PAYMENT_GL_REF_REQUIRED');
  if (m.transactionId && !m.tenantId) throw AppError.unprocessableEntity('transactionId needs tenantId', 'TE_PAYMENT_GL_REF_REQUIRED');
  if (m.scenarioId) await assertScenarioOf(scope, m.scenarioId, taxpayerId, taxYear, exec);
  if (m.tenantId) {
    if (!isTenantInScope(scope, m.tenantId)) throw tenantNotManaged();
    if (m.transactionId) {
      const [t] = await exec.select({ id: transactions.id }).from(transactions)
        .where(and(eq(transactions.id, m.transactionId), eq(transactions.tenantId, m.tenantId)));
      if (!t) throw new AppError(404, 'Transaction not found', 'TE_TRANSACTION_NOT_FOUND');
    }
  }
  // R3-02: one booked transaction is credited to ONE tax year.
  if (m.transactionId) {
    const [other] = await exec.select({ taxYear: taxEstPayments.taxYear }).from(taxEstPayments).where(and(
      eq(taxEstPayments.firmId, scope.firmId), eq(taxEstPayments.taxpayerId, taxpayerId),
      eq(taxEstPayments.transactionId, m.transactionId), ne(taxEstPayments.taxYear, taxYear),
      selfId ? ne(taxEstPayments.id, selfId) : undefined,
    )).limit(1);
    if (other) throw new AppError(409, `This transaction is already recorded for tax year ${other.taxYear}`, 'TE_PAYMENT_OTHER_YEAR');
  }
}

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === '23505' || e?.cause?.code === '23505';
}

const duplicate = () => new AppError(409, 'This transaction is already recorded for the taxpayer and year', 'TE_PAYMENT_DUPLICATE');

export async function createPayment(
  scope: FirmScope, actor: Actor, taxpayerId: string, taxYear: number, input: CreatePaymentInput,
): Promise<EstimatePaymentDTO> {
  try {
    return await db.transaction(async (tx) => {
      await loadTaxpayerForFirm(scope, taxpayerId, tx);
      const m: Merged = {
        scenarioId: input.scenarioId ?? null, jurisdiction: input.jurisdiction, date: input.date ?? null, amount: input.amount,
        source: input.source, tenantId: input.tenantId ?? null, transactionId: input.transactionId ?? null, memo: input.memo ?? null,
      };
      await validateMerged(scope, tx, taxpayerId, taxYear, m);
      const [row] = await tx.insert(taxEstPayments).values({
        firmId: scope.firmId, taxpayerId, taxYear, scenarioId: m.scenarioId, jurisdiction: m.jurisdiction, paymentDate: m.date,
        amount: m.amount, source: m.source, tenantId: m.tenantId, transactionId: m.transactionId, memo: m.memo, createdBy: actor.userId,
      }).returning();
      if (!row) throw AppError.internal('Payment create failed');
      await auditYears(scope, actor, 'create', 'tax_est_payment', row.id, null, auditShape(row), tx);
      return toStoredDTO(row);
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw duplicate();
    throw err;
  }
}

async function loadPaymentForFirm(scope: FirmScope, paymentId: string, exec: DbOrTx): Promise<PaymentRow> {
  const [row] = await exec.select().from(taxEstPayments)
    .where(and(eq(taxEstPayments.id, paymentId), eq(taxEstPayments.firmId, scope.firmId)));
  if (!row) throw paymentNotFound();
  return row;
}

export async function updatePayment(scope: FirmScope, actor: Actor, paymentId: string, input: UpdatePaymentInput): Promise<EstimatePaymentDTO> {
  try {
    return await db.transaction(async (tx) => {
      const before = await loadPaymentForFirm(scope, paymentId, tx);
      await loadTaxpayerForFirm(scope, before.taxpayerId, tx);
      const m: Merged = {
        scenarioId: input.scenarioId !== undefined ? input.scenarioId : before.scenarioId,
        jurisdiction: input.jurisdiction ?? before.jurisdiction,
        date: input.date !== undefined ? input.date : (before.paymentDate ? isoDate(before.paymentDate) : null),
        amount: input.amount ?? before.amount,
        source: (input.source ?? before.source) as EstimatePaymentSourceDTO,
        tenantId: input.tenantId !== undefined ? input.tenantId : before.tenantId,
        transactionId: input.transactionId !== undefined ? input.transactionId : before.transactionId,
        memo: input.memo !== undefined ? input.memo : before.memo,
      };
      // A row that already points out of scope can only be deleted, never re-pointed or edited (D1).
      if (before.tenantId && !isTenantInScope(scope, before.tenantId)) throw tenantNotManaged();
      await validateMerged(scope, tx, before.taxpayerId, before.taxYear, m, before.id);
      const [row] = await tx.update(taxEstPayments).set({
        scenarioId: m.scenarioId, jurisdiction: m.jurisdiction, paymentDate: m.date, amount: m.amount, source: m.source,
        tenantId: m.tenantId, transactionId: m.transactionId, memo: m.memo, updatedAt: new Date(),
      }).where(eq(taxEstPayments.id, paymentId)).returning();
      if (!row) throw paymentNotFound();
      await auditYears(scope, actor, 'update', 'tax_est_payment', row.id, auditShape(before), auditShape(row), tx);
      return toStoredDTO(row);
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw duplicate();
    throw err;
  }
}

export async function deletePayment(scope: FirmScope, actor: Actor, paymentId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const before = await loadPaymentForFirm(scope, paymentId, tx);
    await tx.delete(taxEstPayments).where(eq(taxEstPayments.id, paymentId));
    await auditYears(scope, actor, 'delete', 'tax_est_payment', paymentId, auditShape(before), null, tx);
  });
}

export { FEDERAL as FEDERAL_JURISDICTION };
