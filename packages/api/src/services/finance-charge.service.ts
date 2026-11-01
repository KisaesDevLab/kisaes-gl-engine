// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Finance charges (U-141; finance-charges-v1, idempotency-finance-charges-v1;
 * Q-P22a, Q-P22g, Q-P22p, Q-P22s).
 *
 *   Assessment date d; period = d's calendar month (YYYY-MM).
 *   Base: each open invoice of the client as of d (the open-items helper's
 *   cent open), finance-charge invoices only when compounding is on.
 *   t = the invoice's latest through date over live assessments, whatever d
 *   is (B2). days = d - max(dueDate, t); days <= 0 charges nothing; with no
 *   t, the invoice is chargeable only when d - dueDate > grace days.
 *   amount = round2(open x rate / 100 x days / 365), half up (365 every year).
 *   Client charge = Σ amounts; 0 < Σ < minimum adds one adjustment line.
 *   Clients whose A/R as of d is <= 0.00 are skipped (in_credit); inactive
 *   clients are skipped; a client with open credits is shown unticked
 *   (hasOpenCredits, Q-P22s).
 *
 * Assess is all-or-nothing in one database transaction: the clients'
 * invoices are locked in id order, the rows recomputed and compared with
 * expectedCharge exactly, the run, assessments and sources inserted (a
 * partial unique index allows one live assessment per client and month)
 * and one finance-charge invoice posted per client: dated and due d, one
 * line per source invoice plus the minimum adjustment, all to the income
 * account, non-taxable. Voiding that invoice frees the period and its days.
 */

import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import DecimalLib from 'decimal.js';
import { db, type DbOrTx, type Tx } from '../db/index.js';
import { accounts, companies, contacts, transactions, financeChargeRuns, financeChargeAssessments, financeChargeSources } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import * as ledger from './ledger.service.js';
import * as documentNumbers from './document-number.service.js';
import { claimIdempotency, recordIdempotentEntity } from './idempotency.service.js';
import { arOpenItemsAsOf, daysBetween, type OpenItem } from './ar-open-items.js';

const Decimal = DecimalLib.default || DecimalLib;
type DecimalValue = InstanceType<typeof Decimal>;
const r2 = (d: DecimalValue) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
export const MAX_ASSESS_CONTACTS = 500;

export interface FinanceChargeSettings {
  annualRate: string | null; minimum: string; graceDays: number; onFinanceCharges: boolean;
  incomeAccountId: string | null; printLater: boolean;
}

export async function loadSettings(executor: DbOrTx, tenantId: string, companyId?: string): Promise<FinanceChargeSettings> {
  const [c] = await executor.select().from(companies)
    .where(and(eq(companies.tenantId, tenantId), ...(companyId ? [eq(companies.id, companyId)] : []))).limit(1);
  if (!c) throw AppError.notFound('Company not found');
  return {
    annualRate: c.financeChargeAnnualRate == null ? null : new Decimal(c.financeChargeAnnualRate).toFixed(4).replace(/\.?0+$/, ''),
    minimum: new Decimal(c.financeChargeMinimum ?? '0').toFixed(2),
    graceDays: c.financeChargeGraceDays ?? 0,
    onFinanceCharges: c.financeChargeOnFinanceCharges === true,
    incomeAccountId: c.financeChargeIncomeAccountId ?? null,
    printLater: c.financeChargePrintLater !== false,
  };
}

export interface ChargeSource { invoiceId: string; number: string | null; dueDate: string; open: string; fromDate: string; days: number; amount: string }
export interface ChargeRow {
  contactId: string; name: string; overdueBalance: string; charge: string; sources: ChargeSource[];
  minimumAdjustment?: string; alreadyAssessed?: { invoiceId: string; number: string | null };
  skippedReason?: 'in_credit' | 'inactive'; hasOpenCredits?: string; ticked: boolean;
}

/** The rows of a preview / an assess, on the caller's executor. */
async function computeRows(
  executor: DbOrTx, tenantId: string, companyId: string | undefined, d: string, settings: FinanceChargeSettings, contactIds?: string[],
): Promise<ChargeRow[]> {
  const period = d.slice(0, 7);
  const items = await arOpenItemsAsOf(executor, { tenantId, companyId, asOf: d, contactIds });
  const byContact = new Map<string, OpenItem[]>();
  for (const it of items) if (it.contactId) byContact.set(it.contactId, [...(byContact.get(it.contactId) ?? []), it]);
  const ids = contactIds ?? [...byContact.keys()];
  if (ids.length === 0) return [];
  const people = await executor.select({ id: contacts.id, name: contacts.displayName, isActive: contacts.isActive, companyId: contacts.companyId })
    .from(contacts).where(and(eq(contacts.tenantId, tenantId), inArray(contacts.id, ids)));
  const through = new Map<string, string>();
  const invoiceIds = items.filter((i) => i.kind === 'invoice').map((i) => i.txnId);
  if (invoiceIds.length > 0) {
    const res = await executor.execute(sql`
      SELECT s.invoice_id, to_char(MAX(s.through_date), 'YYYY-MM-DD') AS t
      FROM finance_charge_sources s JOIN finance_charge_assessments a ON a.id = s.assessment_id AND a.voided_at IS NULL
      WHERE s.tenant_id = ${tenantId} AND s.invoice_id IN (${sql.join(invoiceIds.map((id) => sql`${id}::uuid`), sql`, `)})
      GROUP BY s.invoice_id`);
    for (const r of res.rows as Array<{ invoice_id: string; t: string }>) through.set(r.invoice_id, r.t);
  }
  const assessed = new Map<string, { invoiceId: string; number: string | null }>();
  const ares = await executor.execute(sql`
    SELECT a.contact_id, a.invoice_id, t.txn_number FROM finance_charge_assessments a
    LEFT JOIN transactions t ON t.id = a.invoice_id AND t.tenant_id = a.tenant_id
    WHERE a.tenant_id = ${tenantId} ${companyId ? sql`AND a.company_id = ${companyId}` : sql``}
      AND a.period = ${period} AND a.voided_at IS NULL`);
  for (const r of ares.rows as Array<{ contact_id: string; invoice_id: string; txn_number: string | null }>) {
    assessed.set(r.contact_id, { invoiceId: r.invoice_id, number: r.txn_number });
  }
  const rate = new Decimal(settings.annualRate ?? '0');
  const minimum = new Decimal(settings.minimum);
  return people.filter((p) => !companyId || !p.companyId || p.companyId === companyId)
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    .map((p) => {
      const mine = byContact.get(p.id) ?? [];
      const total = mine.reduce((s, i) => s.plus(i.openExact), new Decimal(0));
      const credits = mine.filter((i) => new Decimal(i.open).isNegative()).reduce((s, i) => s.plus(i.open), new Decimal(0)).negated();
      const overdue = mine.filter((i) => i.kind === 'invoice' && new Decimal(i.open).greaterThan(0) && i.dueDate! < d)
        .reduce((s, i) => s.plus(i.open), new Decimal(0));
      const row: ChargeRow = { contactId: p.id, name: p.name, overdueBalance: overdue.toFixed(2), charge: '0.00', sources: [], ticked: false };
      if (assessed.has(p.id)) row.alreadyAssessed = assessed.get(p.id)!;
      if (p.isActive === false) { row.skippedReason = 'inactive'; return row; }
      if (!total.greaterThan(0)) { row.skippedReason = 'in_credit'; return row; }
      let sum = new Decimal(0);
      for (const it of mine) {
        if (it.kind !== 'invoice' || !new Decimal(it.open).greaterThan(0)) continue;
        if (it.isFinanceCharge && !settings.onFinanceCharges) continue;
        const due = it.dueDate ?? it.date;
        const t = through.get(it.txnId);
        const from = t && t > due ? t : due;
        const days = daysBetween(from, d);
        if (days <= 0) continue;
        if (!t && days <= settings.graceDays) continue;
        const amount = r2(new Decimal(it.open).times(rate).dividedBy(100).times(days).dividedBy(365));
        sum = sum.plus(amount);
        row.sources.push({ invoiceId: it.txnId, number: it.number, dueDate: due, open: it.open, fromDate: from, days, amount: amount.toFixed(2) });
      }
      let charge = sum;
      if (sum.greaterThan(0) && sum.lessThan(minimum)) {
        row.minimumAdjustment = minimum.minus(sum).toFixed(2);
        charge = minimum;
      }
      row.charge = charge.toFixed(2);
      if (credits.greaterThan(0)) row.hasOpenCredits = credits.toFixed(2);
      row.ticked = charge.greaterThan(0) && !row.hasOpenCredits && !row.alreadyAssessed;
      return row;
    });
}

/** POST /finance-charges/preview: posts nothing; problems RATE_NOT_SET / INCOME_ACCOUNT_NOT_SET, never 4xx. */
export async function previewFinanceCharges(tenantId: string, companyId: string | undefined, input: { assessmentDate: string; contactIds?: string[] }) {
  const settings = await loadSettings(db, tenantId, companyId);
  const problems: Array<{ code: 'RATE_NOT_SET' | 'INCOME_ACCOUNT_NOT_SET' }> = [];
  if (settings.annualRate === null) problems.push({ code: 'RATE_NOT_SET' });
  if (!settings.incomeAccountId) problems.push({ code: 'INCOME_ACCOUNT_NOT_SET' });
  const rows = settings.annualRate === null ? [] : await computeRows(db, tenantId, companyId, input.assessmentDate, settings, input.contactIds);
  const ticked = rows.filter((r) => r.ticked);
  return {
    period: input.assessmentDate.slice(0, 7), settings, rows,
    totals: { count: ticked.length, charge: ticked.reduce((s, r) => s.plus(r.charge), new Decimal(0)).toFixed(2) },
    problems,
  };
}

function assessedError(contactIds: string[]): AppError {
  return AppError.conflict('Already charged for this month. Void that finance-charge invoice to charge again.',
    'FINANCE_CHARGE_ASSESSED', { contactIds });
}

/** POST /finance-charges/assess (see the module comment). */
export async function assessFinanceCharges(
  tenantId: string, companyId: string | undefined,
  input: { assessmentDate: string; contacts: Array<{ contactId: string; expectedCharge: string }> }, userId?: string,
) {
  if (!companyId) throw AppError.badRequest('A company is required', 'VALIDATION_ERROR');
  if (input.contacts.length > MAX_ASSESS_CONTACTS) {
    throw AppError.badRequest(`At most ${MAX_ASSESS_CONTACTS} clients per call.`, 'TOO_MANY_CONTACTS', { max: MAX_ASSESS_CONTACTS });
  }
  const d = input.assessmentDate;
  const period = d.slice(0, 7);
  try {
    const runId = await db.transaction(async (tx) => {
      await claimIdempotency(tx);
      const settings = await loadSettings(tx, tenantId, companyId);
      if (settings.annualRate === null || !settings.incomeAccountId) {
        throw AppError.badRequest('Set the finance-charge rate and income account first.', 'FINANCE_CHARGE_NOT_SET_UP');
      }
      await ledger.checkLockDate(tx, tenantId, d, companyId, undefined, { txnId: null as never, oldDate: null, newDate: d });
      const ids = [...new Set(input.contacts.map((c) => c.contactId))];
      // Lock the clients' invoices in id order (the lock order), then recompute under the locks.
      await tx.execute(sql`
        SELECT id FROM transactions WHERE tenant_id = ${tenantId} AND txn_type = 'invoice' AND status = 'posted'
          AND contact_id IN (${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)})
        ORDER BY id FOR UPDATE`);
      const rows = await computeRows(tx, tenantId, companyId, d, settings, ids);
      const byId = new Map(rows.map((r) => [r.contactId, r]));
      const missing = ids.filter((id) => !byId.has(id));
      if (missing.length > 0) throw AppError.notFound('Customer not found');
      const already = ids.filter((id) => byId.get(id)!.alreadyAssessed);
      if (already.length > 0) throw assessedError(already);
      for (const c of input.contacts) {
        const row = byId.get(c.contactId)!;
        if (!new Decimal(row.charge).equals(c.expectedCharge)) {
          throw AppError.conflict('The finance charge changed since the preview. Preview again.', 'FINANCE_CHARGE_CHANGED',
            { contactId: c.contactId, charge: row.charge });
        }
      }
      const [run] = await tx.insert(financeChargeRuns).values({ tenantId, companyId, assessmentDate: d, period, createdBy: userId ?? null })
        .returning({ id: financeChargeRuns.id });
      await recordIdempotentEntity(tx, 'finance_charge_run', run!.id);
      const [ar] = await tx.select({ id: accounts.id }).from(accounts)
        .where(and(eq(accounts.tenantId, tenantId), eq(accounts.systemTag, 'accounts_receivable'))).limit(1);
      for (const c of input.contacts) {
        const row = byId.get(c.contactId)!;
        const charge = new Decimal(row.charge);
        if (!charge.greaterThan(0)) continue;
        const { txnNumber } = await documentNumbers.numberForNew(tenantId, 'invoice', undefined, { companyId, executor: tx });
        const lines: ledger.PostTransactionInput['lines'] = [
          { accountId: ar!.id, debit: charge.toFixed(4), credit: '0' },
          ...row.sources.map((s) => ({
            accountId: settings.incomeAccountId!, debit: '0', credit: new Decimal(s.amount).toFixed(4),
            description: `Finance charge on invoice ${s.number ?? ''}, ${s.days} days`.replace(' ,', ','),
            quantity: '1', unitPrice: new Decimal(s.amount).toFixed(4), isTaxable: false,
          })),
          ...(row.minimumAdjustment ? [{
            accountId: settings.incomeAccountId!, debit: '0', credit: new Decimal(row.minimumAdjustment).toFixed(4),
            description: 'Minimum finance charge', quantity: '1', unitPrice: new Decimal(row.minimumAdjustment).toFixed(4), isTaxable: false,
          }] : []),
        ];
        const inv = await ledger.postTransaction(tenantId, {
          txnType: 'invoice', txnNumber, printLater: settings.printLater, txnDate: d, dueDate: d, contactId: c.contactId,
          memo: `Finance charge ${period}`, paymentTerms: 'due_on_receipt',
          subtotal: charge.toFixed(4), taxAmount: '0', total: charge.toFixed(4), balanceDue: charge.toFixed(4), amountPaid: '0',
          status: 'posted', invoiceStatus: 'draft', lines,
        } as ledger.PostTransactionInput, userId, companyId, tx);
        await tx.update(transactions).set({ isFinanceCharge: true }).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, inv.id)));
        const [a] = await tx.insert(financeChargeAssessments).values({
          tenantId, runId: run!.id, companyId, contactId: c.contactId, period, assessmentDate: d, invoiceId: inv.id,
        }).returning({ id: financeChargeAssessments.id });
        if (row.sources.length > 0) {
          await tx.insert(financeChargeSources).values(row.sources.map((s) => ({
            tenantId, assessmentId: a!.id, companyId, invoiceId: s.invoiceId, open: new Decimal(s.open).toFixed(4),
            fromDate: s.fromDate, throughDate: d, days: s.days, amount: new Decimal(s.amount).toFixed(4),
          })));
        }
      }
      await auditLog(tenantId, 'create', 'finance_charge_run', run!.id, null, { via: 'assess', period, count: input.contacts.length }, userId, tx);
      return run!.id;
    });
    return runResult(tenantId, runId, companyId);
  } catch (e) {
    // The partial unique index is the last line of defence against a race.
    if ((e as { code?: string })?.code === '23505' && String((e as { constraint?: string }).constraint ?? (e as Error).message).includes('uq_fc_assessment_live')) {
      throw assessedError(input.contacts.map((c) => c.contactId));
    }
    throw e;
  }
}

/** The assess response, rebuilt from the run (replays, S12). */
export async function runResult(tenantId: string, runId: string, companyId?: string) {
  const [run] = await db.select().from(financeChargeRuns).where(and(eq(financeChargeRuns.tenantId, tenantId), eq(financeChargeRuns.id, runId))).limit(1);
  if (!run || (companyId && run.companyId !== companyId)) throw AppError.notFound('Finance charge run not found');
  const rows = await db.execute(sql`
    SELECT a.contact_id, a.invoice_id, t.txn_number, t.total::text AS total FROM finance_charge_assessments a
    JOIN transactions t ON t.id = a.invoice_id AND t.tenant_id = a.tenant_id
    WHERE a.tenant_id = ${tenantId} AND a.run_id = ${runId} ORDER BY t.txn_number, a.id`);
  return {
    runId, period: run.period,
    invoices: (rows.rows as Array<Record<string, unknown>>).map((r) => ({
      contactId: String(r['contact_id']), invoiceId: String(r['invoice_id']), number: (r['txn_number'] as string | null) ?? null,
      total: new Decimal(String(r['total'])).toFixed(2),
    })),
  };
}

/** GET /finance-charges?period=: assessments of the company, newest first. */
export async function listAssessments(tenantId: string, companyId: string | undefined, period?: string) {
  const rows = await db.execute(sql`
    SELECT a.id, a.run_id, a.contact_id, a.period, to_char(a.assessment_date, 'YYYY-MM-DD') AS d, a.invoice_id, t.txn_number,
      t.total::text AS total, (a.voided_at IS NOT NULL) AS voided
    FROM finance_charge_assessments a JOIN transactions t ON t.id = a.invoice_id AND t.tenant_id = a.tenant_id
    WHERE a.tenant_id = ${tenantId} ${companyId ? sql`AND a.company_id = ${companyId}` : sql``} ${period ? sql`AND a.period = ${period}` : sql``}
    ORDER BY a.assessment_date DESC, a.created_at DESC LIMIT 2000`);
  return {
    data: (rows.rows as Array<Record<string, unknown>>).map((r) => ({
      assessmentId: String(r['id']), runId: String(r['run_id']), contactId: String(r['contact_id']), period: String(r['period']),
      date: String(r['d']), invoiceId: String(r['invoice_id']), number: (r['txn_number'] as string | null) ?? null,
      total: new Decimal(String(r['total'])).toFixed(2), voided: r['voided'] === true,
    })),
  };
}

/**
 * The finance-charge branch of voidTransactionInTx (after its guards):
 * voiding the invoice marks its assessment void, so the period and the
 * charged-through days are free again.
 */
export async function releaseAssessmentForVoidInTx(tx: Tx, tenantId: string, invoiceId: string): Promise<void> {
  await tx.update(financeChargeAssessments).set({ voidedAt: new Date() })
    .where(and(eq(financeChargeAssessments.tenantId, tenantId), eq(financeChargeAssessments.invoiceId, invoiceId), isNull(financeChargeAssessments.voidedAt)));
}

void asc;
