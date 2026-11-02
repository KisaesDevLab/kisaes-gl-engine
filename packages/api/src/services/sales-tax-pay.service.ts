// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Pay Sales Tax (U-150; sales-tax-pay-v1, idempotency-sales-tax-pay-v1).
 *
 * A payment is one transaction of type `sales_tax_payment` to an agency:
 * per tax item Dr Sales Tax Payable (amount - adjustment; a credit when that
 * is negative), each adjustment on its account (a negative adjustment, such
 * as a timely-filing discount, is a credit), Cr the bank for the total.
 * Paid and adjustment lines (sales_tax_payment_lines) carry the figures the
 * liability report and owed read. Owed for Pay (S1) = the rows counted on
 * the company basis dated on or before throughDate + every live adjustment
 * - every live paid and opening line, whatever their date; it is checked
 * against the caller's expectedOwed under a lock on the agency row (409
 * SALES_TAX_OWED_CHANGED), so two payments can't pay the same tax. No edit
 * (Q-P23h): void it (POST /transactions/:id/void) and pay again.
 *
 * A payment made some other way (a check or journal entry debiting Sales
 * Tax Payable) is linked to an agency by paid lines on that transaction.
 * "Mark paid through" records tax paid before the books were set up as
 * opening lines (no GL).
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import DecimalLib from 'decimal.js';
import { db, type DbOrTx, type Tx } from '../db/index.js';
import {
  accounts, contacts, salesTaxAgencies, salesTaxItems, salesTaxPaymentLines, salesTaxPayments, transactions, journalLines,
} from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import { claimIdempotency, recordIdempotentEntity } from './idempotency.service.js';
import * as ledger from './ledger.service.js';
import * as checks from './check.service.js';
import { salesTaxOwed, companyBasis } from './sales-tax-report.service.js';

const BaseDecimal = DecimalLib.default || DecimalLib;
const Decimal = BaseDecimal.clone({ precision: 40, rounding: BaseDecimal.ROUND_HALF_UP });
type DecimalValue = InstanceType<typeof Decimal>;
const D0 = () => new Decimal(0);
const m2 = (d: DecimalValue) => d.toFixed(2);
const SIGNED_CENTS = /^-?\d{1,13}(\.\d{1,2})?$/;

export type PayMethod = 'check' | 'electronic';

export interface PayInput {
  agencyId: string;
  throughDate: string;
  date: string;
  bankAccountId: string;
  method: PayMethod;
  /** Omitted: every item of the agency at owed + its adjustments. */
  lines?: Array<{ taxItemId: string; amount: string; expectedOwed?: string }>;
  /** amount: signed, 2 places; negative lowers what is paid (a timely-filing discount). */
  adjustments?: Array<{ taxItemId: string; accountId: string; amount: string; reason: string }>;
  printLater?: boolean;
  checkNumber?: number;
  memo?: string;
  /** The total owed of the payment's items as previewed (required to pay). */
  expectedOwed?: string;
}

interface PlanLine { taxItemId: string; name: string; owed: DecimalValue; adjustment: DecimalValue; amount: DecimalValue }
interface Problem { code: string; message: string; details?: Record<string, unknown> }

function money(v: string, field: string): DecimalValue {
  if (typeof v !== 'string' || !SIGNED_CENTS.test(v)) {
    throw AppError.badRequest(`${field} must be an amount with at most 2 decimal places`, 'VALIDATION_ERROR', { field });
  }
  return new Decimal(v);
}

async function loadAgency(executor: DbOrTx, tenantId: string, companyId: string, id: string, lock = false) {
  const q = executor.select().from(salesTaxAgencies)
    .where(and(eq(salesTaxAgencies.tenantId, tenantId), eq(salesTaxAgencies.companyId, companyId), eq(salesTaxAgencies.id, id))).limit(1);
  const [row] = lock ? await q.for('update') : await q;
  if (!row) throw AppError.notFound('Sales tax agency not found');
  return row;
}

/** The company's tax items paid to the agency (current agency). */
async function agencyItems(executor: DbOrTx, tenantId: string, companyId: string, agencyId: string) {
  return executor.select({ id: salesTaxItems.id, name: salesTaxItems.name }).from(salesTaxItems)
    .where(and(eq(salesTaxItems.tenantId, tenantId), eq(salesTaxItems.companyId, companyId), eq(salesTaxItems.agencyId, agencyId),
      eq(salesTaxItems.kind, 'item'))).orderBy(salesTaxItems.createdAt, salesTaxItems.id);
}

async function assertBankAccount(executor: DbOrTx, tenantId: string, companyId: string, accountId: string) {
  const [acct] = await executor.select().from(accounts).where(and(eq(accounts.tenantId, tenantId), eq(accounts.id, accountId))).limit(1);
  const bankish = !!acct && acct.accountType === 'asset'
    && !['payments_clearing', 'accounts_receivable', 'customer_deposits'].includes(acct.systemTag ?? '')
    && ['bank', 'checking', 'savings', 'cash', 'cash_on_hand', 'money_market'].includes(acct.detailType ?? '');
  if (!acct || ledger.inOtherCompany(acct, companyId) || !bankish || acct.isActive === false) {
    throw AppError.badRequest('Choose the bank account the tax is paid from.', 'VALIDATION_ERROR', { field: 'bankAccountId' });
  }
}

/** An adjustment posts to an ordinary income or expense account of the company (not a control, bank or tax account). */
async function assertAdjustmentAccounts(executor: DbOrTx, tenantId: string, companyId: string, ids: string[]) {
  if (ids.length === 0) return;
  const rows = await executor.select().from(accounts).where(and(eq(accounts.tenantId, tenantId), inArray(accounts.id, [...new Set(ids)])));
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const id of ids) {
    const a = byId.get(id);
    const ok = !!a && a.isActive !== false && !ledger.inOtherCompany(a, companyId)
      && ['revenue', 'other_revenue', 'expense', 'other_expense', 'cost_of_goods_sold'].includes(a.accountType)
      && !a.systemTag;
    if (!ok) throw AppError.badRequest('Choose an income or expense account for the adjustment.', 'ADJUSTMENT_ACCOUNT_INVALID', { accountId: id });
  }
}

/**
 * The payment's lines and problems (preview and pay share it): owed per
 * item of the agency through throughDate (S1), the adjustments by item, the
 * amounts (sent, else owed + adjustments).
 */
async function planPayment(executor: DbOrTx, tenantId: string, companyId: string, input: PayInput) {
  const agency = await loadAgency(executor, tenantId, companyId, input.agencyId);
  const items = await agencyItems(executor, tenantId, companyId, input.agencyId);
  const names = new Map(items.map((i) => [i.id, i.name]));
  // Setup order (as the liability report lists them).
  const order = (id: string) => { const k = items.findIndex((i) => i.id === id); return k < 0 ? items.length : k; };
  const owedAll = await salesTaxOwed(tenantId, companyId, input.throughDate, {});
  const owed = new Map<string, DecimalValue>();
  for (const a of owedAll.agencies) {
    if (a.agencyId !== input.agencyId) continue;
    for (const it of a.items) {
      owed.set(it.taxItemId, (owed.get(it.taxItemId) ?? D0()).plus(it.owed));
      if (!names.has(it.taxItemId)) names.set(it.taxItemId, it.name);
    }
  }
  const forAgency = (id: string, field: string) => {
    if (!names.has(id)) throw AppError.badRequest('That tax item is not paid to this agency.', 'TAX_ITEM_NOT_FOR_AGENCY', { taxItemId: id, field });
  };
  const adjustments = (input.adjustments ?? []).map((a, k) => {
    forAgency(a.taxItemId, `adjustments[${k}].taxItemId`);
    if (!a.reason || !String(a.reason).trim()) throw AppError.badRequest('Give a reason for each adjustment.', 'VALIDATION_ERROR', { field: `adjustments[${k}].reason` });
    return { ...a, value: money(a.amount, `adjustments[${k}].amount`) };
  });
  await assertAdjustmentAccounts(executor, tenantId, companyId, adjustments.map((a) => a.accountId));
  const adjBy = new Map<string, DecimalValue>();
  for (const a of adjustments) adjBy.set(a.taxItemId, (adjBy.get(a.taxItemId) ?? D0()).plus(a.value));

  const sent = new Map<string, { amount: DecimalValue; expectedOwed?: string }>();
  for (const [k, l] of (input.lines ?? []).entries()) {
    forAgency(l.taxItemId, `lines[${k}].taxItemId`);
    if (sent.has(l.taxItemId)) throw AppError.badRequest('A tax item is listed twice.', 'VALIDATION_ERROR', { field: `lines[${k}].taxItemId` });
    sent.set(l.taxItemId, { amount: money(l.amount, `lines[${k}].amount`), expectedOwed: l.expectedOwed });
  }
  // Lines sent: only those items (and any with an adjustment); else every item owed.
  const ids = [...new Set([...(input.lines ? [] : owed.keys()), ...adjBy.keys(), ...sent.keys()])]
    .sort((a, b) => order(a) - order(b));
  const lines: PlanLine[] = [];
  for (const id of ids) {
    const o = owed.get(id) ?? D0();
    const adj = adjBy.get(id) ?? D0();
    const amount = input.lines ? sent.get(id)?.amount ?? D0() : o.plus(adj);
    if (o.isZero() && adj.isZero() && amount.isZero() && !sent.has(id)) continue;
    lines.push({ taxItemId: id, name: names.get(id) ?? '', owed: o, adjustment: adj, amount });
  }

  const problems: Problem[] = [];
  for (const l of lines) {
    if (l.amount.greaterThan(l.owed.plus(l.adjustment))) {
      problems.push({ code: 'AMOUNT_MORE_THAN_OWED', message: `${l.name}: the amount is more than what is owed.`, details: { taxItemId: l.taxItemId } });
    }
  }
  // Tax owed with no agency to pay it to: legacy items with no agency, or unassigned tax.
  const legacy = owedAll.agencies.filter((a) => a.agencyId === null).reduce((s, a) => s.plus(a.total), D0()).plus(owedAll.unassigned);
  if (!legacy.isZero()) {
    problems.push({ code: 'LEGACY_UNASSIGNED', message: 'Some sales tax has no agency yet; give its tax items an agency to pay it.', details: { amount: m2(legacy) } });
  }
  if (input.method === 'check') {
    const [v] = await executor.select().from(contacts).where(and(eq(contacts.tenantId, tenantId), eq(contacts.id, agency.vendorId))).limit(1);
    if (!v?.billingLine1) problems.push({ code: 'NO_VENDOR_ADDRESS', message: 'The agency has no mailing address for the check.' });
  }
  return { agency, lines, adjustments, problems, sent };
}

const lineOut = (l: PlanLine) => ({
  taxItemId: l.taxItemId, name: l.name, owed: m2(l.owed), adjustment: m2(l.adjustment), amount: m2(l.amount), expectedOwed: m2(l.owed),
});

/** POST /sales-tax/payments/preview: posts nothing. */
export async function previewPayment(tenantId: string, companyId: string, input: PayInput) {
  const p = await planPayment(db, tenantId, companyId, input);
  return {
    agencyId: input.agencyId, throughDate: input.throughDate, basis: await companyBasis(tenantId, companyId),
    lines: p.lines.map(lineOut),
    owed: m2(p.lines.reduce((s, l) => s.plus(l.owed), D0())),
    // What POST /sales-tax/payments takes as expectedOwed, byte for byte (the UI never adds it up).
    expectedOwed: m2(p.lines.reduce((s, l) => s.plus(l.owed), D0())),
    total: m2(p.lines.reduce((s, l) => s.plus(l.amount), D0())),
    problems: p.problems,
  };
}

async function stpAccountId(executor: DbOrTx, tenantId: string): Promise<string> {
  const [row] = await executor.select({ id: accounts.id }).from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), eq(accounts.systemTag, 'sales_tax_payable'))).limit(1);
  if (!row) throw AppError.badRequest('This company has no Sales Tax Payable account.', 'VALIDATION_ERROR');
  return row.id;
}

/** POST /sales-tax/payments: 201 {id, number, checkNumber, printStatus, total}. */
export async function paySalesTax(tenantId: string, companyId: string, input: PayInput, userId?: string) {
  if (input.method !== 'check' && input.method !== 'electronic') throw AppError.badRequest('method must be check or electronic', 'VALIDATION_ERROR', { field: 'method' });
  if (input.expectedOwed === undefined) throw AppError.badRequest('expectedOwed (the owed total as previewed) is required', 'VALIDATION_ERROR', { field: 'expectedOwed' });
  const expected = money(input.expectedOwed, 'expectedOwed');
  // A check with no number waits in the print queue (as refunds, Q-P22d).
  const printLater = input.method === 'check' && (input.printLater === true || input.checkNumber === undefined);
  if (input.method === 'check' && printLater && input.checkNumber !== undefined) {
    throw AppError.badRequest('A check printed later is numbered when it prints.', 'CHECK_NO_OR_PRINT_LATER', { field: 'checkNumber' });
  }
  return db.transaction(async (tx) => {
    await claimIdempotency(tx);
    // The agency lock: payments to one agency serialize, so owed read here is current.
    await loadAgency(tx, tenantId, companyId, input.agencyId, true);
    await assertBankAccount(tx, tenantId, companyId, input.bankAccountId);
    const p = await planPayment(tx, tenantId, companyId, input);
    const owedNow = p.lines.reduce((s, l) => s.plus(l.owed), D0());
    const lineChanged = p.lines.some((l) => {
      const e = p.sent.get(l.taxItemId)?.expectedOwed;
      return e !== undefined && !money(e, 'lines[].expectedOwed').equals(l.owed);
    });
    if (!owedNow.equals(expected) || lineChanged) {
      throw AppError.conflict('The sales tax owed changed since the preview; review the amounts and try again.', 'SALES_TAX_OWED_CHANGED', {
        owed: m2(owedNow), lines: p.lines.map(lineOut),
      });
    }
    const total = p.lines.reduce((s, l) => s.plus(l.amount), D0());
    if (!total.greaterThan(0)) throw AppError.badRequest('The payment total must be more than 0.00.', 'PAYMENT_TOTAL_NOT_POSITIVE', { total: m2(total) });

    let checkNumber: number | null = null;
    if (input.method === 'check' && !printLater) {
      await checks.lockCheckCounter(tx, tenantId, companyId);
      await checks.assertCheckNumberRangeFree(tx, tenantId, input.bankAccountId, input.checkNumber!, input.checkNumber!);
      await checks.advanceCheckCounterPast(tx, tenantId, input.bankAccountId, input.checkNumber!, companyId);
      checkNumber = input.checkNumber!;
    }

    const stp = await stpAccountId(tx, tenantId);
    const journal: ledger.PostTransactionInput['lines'] = [];
    for (const l of p.lines) {
      const net = l.amount.minus(l.adjustment);
      if (net.isZero()) continue;
      journal.push({ accountId: stp, debit: net.greaterThan(0) ? net.toFixed(4) : '0', credit: net.lessThan(0) ? net.negated().toFixed(4) : '0', description: l.name });
    }
    for (const a of p.adjustments) {
      if (a.value.isZero()) continue;
      journal.push({ accountId: a.accountId, debit: a.value.greaterThan(0) ? a.value.toFixed(4) : '0', credit: a.value.lessThan(0) ? a.value.negated().toFixed(4) : '0', description: a.reason });
    }
    journal.push({ accountId: input.bankAccountId, debit: '0', credit: total.toFixed(4) });

    const posted = await ledger.postTransaction(tenantId, {
      txnType: 'sales_tax_payment',
      txnDate: input.date,
      contactId: p.agency.vendorId,
      memo: input.memo ?? `Sales tax through ${input.throughDate}`,
      total: total.toFixed(4),
      paymentMethod: input.method === 'check' ? 'check' : 'ach',
      lines: journal,
    } as ledger.PostTransactionInput, userId, companyId, tx);
    if (input.method === 'check') {
      await tx.update(transactions).set({ isCheck: true, printStatus: printLater ? 'queue' : 'hand_written', checkNumber })
        .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, posted.id)));
    }
    await tx.insert(salesTaxPayments).values({
      transactionId: posted.id, tenantId, companyId, agencyId: input.agencyId, throughDate: input.throughDate, method: input.method,
    });
    const paid = p.lines.filter((l) => !l.amount.isZero()).map((l) => ({
      tenantId, companyId, transactionId: posted.id, taxItemId: l.taxItemId, agencyId: input.agencyId, kind: 'paid',
      lineDate: input.date, amount: l.amount.toFixed(4),
    }));
    const adj = p.adjustments.filter((a) => !a.value.isZero()).map((a) => ({
      tenantId, companyId, transactionId: posted.id, taxItemId: a.taxItemId, agencyId: input.agencyId, kind: 'adjustment',
      lineDate: input.date, amount: a.value.toFixed(4), accountId: a.accountId, reason: String(a.reason).slice(0, 255),
    }));
    if (paid.length + adj.length) await tx.insert(salesTaxPaymentLines).values([...paid, ...adj]);
    await recordIdempotentEntity(tx, 'transaction', posted.id);
    await auditLog(tenantId, 'create', 'sales_tax_payment', posted.id, null, {
      agencyId: input.agencyId, throughDate: input.throughDate, method: input.method, lines: paid.length, adjustments: adj.length,
    }, userId, tx);
    return {
      id: posted.id, number: posted.txnNumber ?? null, checkNumber, printStatus: input.method === 'check' ? (printLater ? 'queue' : 'hand_written') : null,
      total: m2(total),
    };
  });
}

/** GET /sales-tax/payments/:id: a Pay Sales Tax payment or a linked payment; 404 otherwise or for another company's. */
export async function getPayment(tenantId: string, companyId: string, id: string) {
  const [t] = await db.select().from(transactions).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, id))).limit(1);
  if (!t || ledger.inOtherCompany(t, companyId) || t.status === 'deleted') throw AppError.notFound('Sales tax payment not found');
  const [head] = await db.select().from(salesTaxPayments).where(and(eq(salesTaxPayments.tenantId, tenantId), eq(salesTaxPayments.transactionId, id))).limit(1);
  const lines = await db.select().from(salesTaxPaymentLines).where(and(eq(salesTaxPaymentLines.tenantId, tenantId), eq(salesTaxPaymentLines.transactionId, id)));
  if (!head && lines.length === 0) throw AppError.notFound('Sales tax payment not found');
  const itemIds = [...new Set(lines.map((l) => l.taxItemId).filter((v): v is string => !!v))];
  const names = itemIds.length === 0 ? new Map<string, string>() : new Map((await db.select({ id: salesTaxItems.id, name: salesTaxItems.name }).from(salesTaxItems)
    .where(and(eq(salesTaxItems.tenantId, tenantId), inArray(salesTaxItems.id, itemIds)))).map((r) => [r.id, r.name]));
  const bank = await db.execute(sql`
    SELECT jl.account_id FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
    WHERE jl.tenant_id = ${tenantId} AND jl.transaction_id = ${id} AND jl.is_void_reversal = false AND jl.credit > 0 AND a.account_type = 'asset'
    ORDER BY jl.line_order LIMIT 1`);
  const agencyId = head?.agencyId ?? lines.find((l) => l.agencyId)?.agencyId ?? null;
  const out = lines.map((l) => ({
    taxItemId: l.taxItemId, name: l.taxItemId ? names.get(l.taxItemId) ?? '' : '', kind: l.kind, amount: m2(new Decimal(l.amount)),
    accountId: l.accountId ?? null, reason: l.reason ?? null,
  }));
  return {
    id: t.id, date: t.txnDate, number: t.txnNumber ?? null, status: t.status, agencyId,
    throughDate: head?.throughDate ?? null, method: head?.method ?? null, linked: !head,
    bankAccountId: (bank.rows as Array<{ account_id: string }>)[0]?.account_id ?? null,
    total: m2(new Decimal(t.total ?? '0')), checkNumber: t.checkNumber ?? null, printStatus: t.printStatus ?? null,
    lines: out,
    // What a check stub lists (cl-print): each item paid, then each adjustment.
    stubLines: [
      ...out.filter((l) => l.kind === 'paid').map((l) => ({ label: l.name, amount: l.amount })),
      ...out.filter((l) => l.kind === 'adjustment').map((l) => ({ label: l.reason ?? 'Adjustment', amount: l.amount })),
    ],
  };
}

export interface LinkInput { transactionId: string; agencyId: string; lines: Array<{ taxItemId: string; amount: string }> }

/**
 * POST /sales-tax/payments/link: a check or journal entry that debited Sales
 * Tax Payable becomes a payment to the agency (paid lines on it, no new GL).
 */
export async function linkPayment(tenantId: string, companyId: string, input: LinkInput, userId?: string) {
  return db.transaction(async (tx) => {
    await claimIdempotency(tx);
    await loadAgency(tx, tenantId, companyId, input.agencyId, true);
    const [t] = await tx.select().from(transactions).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, input.transactionId)))
      .for('update').limit(1);
    if (!t || ledger.inOtherCompany(t, companyId) || t.status === 'deleted') throw AppError.notFound('Transaction not found');
    if (t.status !== 'posted' || t.txnType === 'sales_tax_payment') {
      throw AppError.badRequest('Only a posted check or journal entry that paid Sales Tax Payable can be linked.', 'NOT_STP_PAYMENT');
    }
    const existing = await tx.select({ id: salesTaxPaymentLines.id }).from(salesTaxPaymentLines)
      .where(and(eq(salesTaxPaymentLines.tenantId, tenantId), eq(salesTaxPaymentLines.transactionId, t.id))).limit(1);
    if (existing.length) throw AppError.conflict('This transaction is already linked to a sales tax agency.', 'ALREADY_LINKED');
    const stp = await tx.execute(sql`
      SELECT COALESCE(SUM(jl.debit - jl.credit), 0)::text AS d FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id AND a.tenant_id = jl.tenant_id
      WHERE jl.tenant_id = ${tenantId} AND jl.transaction_id = ${t.id} AND jl.is_void_reversal = false AND a.system_tag = 'sales_tax_payable'`);
    const paidStp = new Decimal((stp.rows as Array<{ d: string }>)[0]?.d ?? '0');
    if (!paidStp.greaterThan(0)) throw AppError.badRequest('That transaction did not pay Sales Tax Payable.', 'NOT_STP_PAYMENT');
    const items = new Set((await agencyItems(tx, tenantId, companyId, input.agencyId)).map((i) => i.id));
    let sum = D0();
    const seen = new Set<string>();
    const rows = input.lines.map((l, k) => {
      if (!items.has(l.taxItemId)) throw AppError.badRequest('That tax item is not paid to this agency.', 'TAX_ITEM_NOT_FOR_AGENCY', { taxItemId: l.taxItemId });
      if (seen.has(l.taxItemId)) throw AppError.badRequest('A tax item is listed twice.', 'VALIDATION_ERROR', { field: `lines[${k}].taxItemId` });
      seen.add(l.taxItemId);
      const v = money(l.amount, `lines[${k}].amount`);
      sum = sum.plus(v);
      return { tenantId, companyId, transactionId: t.id, taxItemId: l.taxItemId, agencyId: input.agencyId, kind: 'paid', lineDate: t.txnDate, amount: v.toFixed(4) };
    });
    if (!sum.equals(paidStp)) {
      throw AppError.badRequest(`The lines (${m2(sum)}) must add up to what the transaction paid to Sales Tax Payable (${m2(paidStp)}).`,
        'LINK_TOTAL_MISMATCH', { expected: m2(paidStp), total: m2(sum) });
    }
    // A link changes what a closed period's report says was paid: closing password.
    await ledger.checkLockDate(tx, tenantId, t.txnDate, t.companyId ?? companyId, undefined, { txnId: t.id, oldDate: t.txnDate, newDate: t.txnDate });
    if (rows.length) await tx.insert(salesTaxPaymentLines).values(rows.filter((r) => !new Decimal(r.amount).isZero()));
    await tx.update(transactions).set({ updatedAt: new Date() }).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, t.id)));
    await recordIdempotentEntity(tx, 'transaction', t.id);
    await auditLog(tenantId, 'create', 'sales_tax_payment_link', t.id, null, { agencyId: input.agencyId, lines: rows.length }, userId, tx);
    return { transactionId: t.id, agencyId: input.agencyId, total: m2(sum) };
  });
}

/** POST /sales-tax/payments/:id/unlink: drops a linked payment's paid lines (not a Pay Sales Tax payment: void that). */
export async function unlinkPayment(tenantId: string, companyId: string, id: string, userId?: string) {
  return db.transaction(async (tx) => {
    await claimIdempotency(tx);
    const [t] = await tx.select().from(transactions).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, id))).for('update').limit(1);
    if (!t || ledger.inOtherCompany(t, companyId) || t.status === 'deleted') throw AppError.notFound('Transaction not found');
    if (t.txnType === 'sales_tax_payment') throw AppError.badRequest('Void a sales tax payment instead.', 'NOT_LINKED');
    const lines = await tx.select().from(salesTaxPaymentLines).where(and(eq(salesTaxPaymentLines.tenantId, tenantId), eq(salesTaxPaymentLines.transactionId, id)));
    if (lines.length === 0) throw AppError.badRequest('This transaction is not linked to a sales tax agency.', 'NOT_LINKED');
    await ledger.checkLockDate(tx, tenantId, t.txnDate, t.companyId ?? companyId, undefined, { txnId: t.id, oldDate: t.txnDate, newDate: t.txnDate });
    await tx.delete(salesTaxPaymentLines).where(and(eq(salesTaxPaymentLines.tenantId, tenantId), eq(salesTaxPaymentLines.transactionId, id)));
    await tx.update(transactions).set({ updatedAt: new Date() }).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, t.id)));
    await recordIdempotentEntity(tx, 'transaction', t.id);
    await auditLog(tenantId, 'delete', 'sales_tax_payment_link', t.id, { agencyId: lines[0]!.agencyId, lines: lines.length }, null, userId, tx);
    return { transactionId: t.id, unlinked: lines.length };
  });
}

/**
 * POST /sales-tax/payments/mark-paid-through (review B2): tax of the agency
 * owed through a date was paid before these books (or outside them): an
 * opening line per item for what is owed, no GL. Idempotency-Key.
 */
export async function markPaidThrough(tenantId: string, companyId: string, input: { agencyId: string; throughDate: string; reason?: string }, userId?: string) {
  return db.transaction(async (tx) => {
    await claimIdempotency(tx);
    await loadAgency(tx, tenantId, companyId, input.agencyId, true);
    const owed = await salesTaxOwed(tenantId, companyId, input.throughDate, { agencyId: input.agencyId });
    const items = owed.agencies.flatMap((a) => a.items).filter((i) => new Decimal(i.owed).greaterThan(0));
    const reason = (input.reason?.trim() || `Marked paid through ${input.throughDate}`).slice(0, 255);
    if (items.length) {
      await tx.insert(salesTaxPaymentLines).values(items.map((i) => ({
        tenantId, companyId, transactionId: null, taxItemId: i.taxItemId, agencyId: input.agencyId, kind: 'opening',
        lineDate: input.throughDate, amount: new Decimal(i.owed).toFixed(4), reason,
      })));
    }
    const total = items.reduce((s, i) => s.plus(i.owed), D0());
    await recordIdempotentEntity(tx, 'sales_tax_agency', input.agencyId);
    await auditLog(tenantId, 'create', 'sales_tax_mark_paid', input.agencyId, null, { throughDate: input.throughDate, items: items.length, total: m2(total) }, userId, tx);
    return { agencyId: input.agencyId, throughDate: input.throughDate, lines: items.map((i) => ({ taxItemId: i.taxItemId, name: i.name, amount: i.owed })), total: m2(total) };
  });
}

export type { Tx };
export { journalLines as _journalLines };
