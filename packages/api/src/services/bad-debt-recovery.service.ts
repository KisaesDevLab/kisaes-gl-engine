// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Recovered bad debts (U-154; bad-debt-recovery-v1, idempotency-recovery-v1).
 *
 * "Record a recovered bad debt": an amount x of an invoice's write-offs is
 * collectible again. One bad_debt_recovery transaction dated `date`:
 *
 *   Dr A/R x (the client), Cr the write-off account x - x_t,
 *   Cr Sales Tax Payable x_t
 *
 * and the invoice reopens by x (its balance due goes up); the owner then
 * receives the payment normally (Q-P23q). x_t is the SSUTA bad-debt tax
 * owed again, per tax item by running total over the invoice's write-offs:
 * x_t_i = round2(w_i x X_cum / W) - what earlier recoveries took, where W is
 * the live write-off of the invoice, w_i its stored bad-debt tax (none when
 * the write-off was posted with the switch off) and X_cum the recovered
 * amount so far including this one. The tax is stored as rows kind
 * 'recovery' (accrual only; the cash virtual ledger leaves recoveries out,
 * Q-SPF3). x is taken from the write-off rows oldest first
 * (write_off_recoveries); a row counts while its recovery is posted.
 *
 * Errors: 404 invoice of another company; 409 RECOVERY_EXCEEDS_WRITE_OFF
 * {available}; 400 RECOVERY_DATE_INVALID (before the invoice or a write-off
 * it takes back). Void (POST /transactions/:id/void) gives the invoice its
 * write-off back: 409 RECOVERY_IN_USE once the reopened balance was paid.
 * While a recovery is live the payment that wrote the amount off can't be
 * bounced, voided or edited (409 WRITE_OFF_RECOVERED, Q-P23x).
 */

import { and, eq, sql } from 'drizzle-orm';
import DecimalLib from 'decimal.js';
import { db, type DbOrTx, type Tx } from '../db/index.js';
import { accounts, transactions, transactionTaxLines, writeOffRecoveries, contacts } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import * as ledger from './ledger.service.js';
import { lockInvoices, lockPayments, moveInvoicePaid } from './payment.service.js';
import { rowCompanyId } from './sales-tax.service.js';

const BaseDecimal = DecimalLib.default || DecimalLib;
const Decimal = BaseDecimal.clone({ precision: 40, rounding: BaseDecimal.ROUND_HALF_UP });
type DecimalValue = InstanceType<typeof Decimal>;
type TxnRow = typeof transactions.$inferSelect;
const D0 = () => new Decimal(0);
const d = (v: unknown) => new Decimal(v === null || v === undefined || v === '' ? '0' : String(v));
const r2 = (x: DecimalValue) => x.toDecimalPlaces(2, BaseDecimal.ROUND_HALF_UP);
const m2 = (x: DecimalValue) => r2(x).toFixed(2);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RecoveryInput { invoiceId: string; date: string; amount: string; memo?: string }

interface WriteOffApp {
  id: string; paymentId: string; invoiceId: string; writeOff: DecimalValue; accountId: string | null; paymentDate: string; recovered: DecimalValue;
}

/** The live write-off rows of invoices (own rows of posted, unbounced payments), oldest first, with what posted recoveries took. */
async function writeOffApps(executor: DbOrTx, tenantId: string, invoiceIds: string[]): Promise<WriteOffApp[]> {
  if (invoiceIds.length === 0) return [];
  const res = await executor.execute(sql`
    SELECT pa.id, pa.payment_id, pa.invoice_id, pa.write_off_amount::text AS w, pa.write_off_account_id,
      to_char(p.txn_date, 'YYYY-MM-DD') AS pay_date,
      COALESCE((SELECT SUM(r.amount) FROM write_off_recoveries r
        JOIN transactions rt ON rt.id = r.recovery_txn_id AND rt.tenant_id = r.tenant_id AND rt.status = 'posted'
        WHERE r.tenant_id = pa.tenant_id AND r.application_id = pa.id), 0)::text AS recovered
    FROM payment_applications pa
    JOIN transactions p ON p.id = pa.payment_id AND p.tenant_id = pa.tenant_id AND p.status = 'posted' AND p.txn_type = 'customer_payment'
    WHERE pa.tenant_id = ${tenantId} AND pa.voided_at IS NULL AND pa.reversed_by_txn_id IS NULL AND pa.write_off_amount > 0
      AND pa.invoice_id IN (${sql.join(invoiceIds.map((id) => sql`${id}::uuid`), sql`, `)})
    ORDER BY pa.invoice_id, p.txn_date, pa.created_at, pa.id`);
  return (res.rows as Array<Record<string, string>>).map((r) => ({
    id: r['id']!, paymentId: r['payment_id']!, invoiceId: r['invoice_id']!, writeOff: d(r['w']), accountId: r['write_off_account_id'] ?? null,
    paymentDate: r['pay_date']!, recovered: d(r['recovered']),
  }));
}

interface ItemKey { salesTaxId: string | null; taxItemId: string | null; agencyId: string | null; rate: string | null }
interface ItemTax extends ItemKey { tax: DecimalValue; base: DecimalValue }
const keyOf = (k: ItemKey) => `${k.salesTaxId ?? '-'}|${k.taxItemId ?? '-'}|${k.agencyId ?? '-'}|${k.rate ?? '-'}`;

/** Bad-debt tax stored for these rows on their payments (w_i, positive), and what posted recoveries of the invoice took back. */
async function itemTaxes(executor: DbOrTx, tenantId: string, invoiceId: string, apps: WriteOffApp[]) {
  const bad = new Map<string, ItemTax>();
  if (apps.length > 0) {
    const res = await executor.execute(sql`
      SELECT r.sales_tax_id, r.tax_item_id, r.agency_id, r.rate::text AS rate, (-SUM(r.tax))::text AS tax, (-SUM(r.base))::text AS base
      FROM transaction_tax_lines r
      WHERE r.tenant_id = ${tenantId} AND r.kind = 'bad_debt' AND r.transaction_id = (SELECT pa.payment_id FROM payment_applications pa WHERE pa.id = r.application_id)
        AND r.application_id IN (${sql.join(apps.map((a) => sql`${a.id}::uuid`), sql`, `)})
      GROUP BY r.sales_tax_id, r.tax_item_id, r.agency_id, r.rate`);
    for (const r of res.rows as Array<Record<string, string | null>>) {
      const k = { salesTaxId: r['sales_tax_id'] ?? null, taxItemId: r['tax_item_id'] ?? null, agencyId: r['agency_id'] ?? null, rate: r['rate'] ?? null };
      bad.set(keyOf(k), { ...k, tax: d(r['tax']), base: d(r['base']) });
    }
  }
  const prev = new Map<string, ItemTax>();
  const res = await executor.execute(sql`
    SELECT r.sales_tax_id, r.tax_item_id, r.agency_id, r.rate::text AS rate, SUM(r.tax)::text AS tax, SUM(r.base)::text AS base
    FROM transaction_tax_lines r
    JOIN transactions t ON t.id = r.transaction_id AND t.tenant_id = r.tenant_id AND t.status = 'posted'
    WHERE r.tenant_id = ${tenantId} AND r.kind = 'recovery' AND r.invoice_id = ${invoiceId}
    GROUP BY r.sales_tax_id, r.tax_item_id, r.agency_id, r.rate`);
  for (const r of res.rows as Array<Record<string, string | null>>) {
    const k = { salesTaxId: r['sales_tax_id'] ?? null, taxItemId: r['tax_item_id'] ?? null, agencyId: r['agency_id'] ?? null, rate: r['rate'] ?? null };
    prev.set(keyOf(k), { ...k, tax: d(r['tax']), base: d(r['base']) });
  }
  return { bad, prev };
}

/** Recovered tax per item for a recovery bringing the cumulative recovered amount to xCum of W (running total). */
function recoveredTax(bad: Map<string, ItemTax>, prev: Map<string, ItemTax>, W: DecimalValue, xCum: DecimalValue): ItemTax[] {
  if (!W.greaterThan(0)) return [];
  const out: ItemTax[] = [];
  for (const [k, b] of bad) {
    const p = prev.get(k);
    const tax = r2(b.tax.times(xCum).dividedBy(W)).minus(p?.tax ?? 0);
    const base = r2(b.base.times(xCum).dividedBy(W)).minus(p?.base ?? 0);
    if (!tax.isZero() || !base.isZero()) out.push({ ...b, tax, base });
  }
  return out;
}

function invoiceNotFound(): AppError { return AppError.notFound('Invoice not found'); }

/** The write-offs of a client's invoices (or one invoice) that can be recovered. GET /payments/write-offs. */
export async function listWriteOffs(
  tenantId: string, companyId: string | undefined, q: { customerId?: string; invoiceId?: string; includeRecovered?: boolean },
) {
  if (q.customerId) {
    if (!UUID_RE.test(q.customerId)) throw AppError.notFound('Customer not found');
    const [c] = await db.select({ id: contacts.id, companyId: contacts.companyId }).from(contacts)
      .where(and(eq(contacts.tenantId, tenantId), eq(contacts.id, q.customerId))).limit(1);
    if (!c || ledger.inOtherCompany(c, companyId)) throw AppError.notFound('Customer not found');
  }
  if (q.invoiceId && !UUID_RE.test(q.invoiceId)) throw invoiceNotFound();
  const res = await db.execute(sql`
    SELECT DISTINCT i.id, i.txn_number, to_char(i.txn_date, 'YYYY-MM-DD') AS txn_date, i.contact_id, i.balance_due::text AS balance_due,
      COALESCE(c.display_name, '') AS customer_name
    FROM payment_applications pa
    JOIN transactions i ON i.id = pa.invoice_id AND i.tenant_id = pa.tenant_id AND i.status = 'posted' AND i.txn_type = 'invoice'
    LEFT JOIN contacts c ON c.id = i.contact_id AND c.tenant_id = i.tenant_id
    WHERE pa.tenant_id = ${tenantId} AND pa.write_off_amount > 0 AND pa.voided_at IS NULL AND pa.reversed_by_txn_id IS NULL
      AND ${companyId ? sql`(i.company_id = ${companyId} OR i.company_id IS NULL)` : sql`TRUE`}
      AND ${q.customerId ? sql`i.contact_id = ${q.customerId}` : sql`TRUE`}
      AND ${q.invoiceId ? sql`i.id = ${q.invoiceId}` : sql`TRUE`}`);
  const invs = res.rows as Array<Record<string, string | null>>;
  const apps = await writeOffApps(db, tenantId, invs.map((r) => r['id']!));
  const data = [];
  for (const inv of invs) {
    const mine = apps.filter((a) => a.invoiceId === inv['id']);
    if (mine.length === 0) continue;
    const writtenOff = mine.reduce((s, a) => s.plus(a.writeOff), D0());
    const recovered = mine.reduce((s, a) => s.plus(a.recovered), D0());
    const { bad, prev } = await itemTaxes(db, tenantId, inv['id']!, mine);
    const writeOffTax = [...bad.values()].reduce((s, b) => s.plus(b.tax), D0());
    const recoveredTaxSoFar = [...prev.values()].reduce((s, b) => s.plus(b.tax), D0());
    const recoverable = writtenOff.minus(recovered);
    if (!q.includeRecovered && !recoverable.greaterThan(0)) continue;
    data.push({
      invoiceId: inv['id'], invoiceNumber: inv['txn_number'] ?? null, invoiceDate: inv['txn_date'], customerId: inv['contact_id'],
      customerName: inv['customer_name'] ?? '',
      writeOffDate: mine.reduce((m, a) => (a.paymentDate > m ? a.paymentDate : m), mine[0]!.paymentDate),
      firstWriteOffDate: mine[0]!.paymentDate,
      writtenOff: m2(writtenOff), writeOffTax: m2(writeOffTax), recovered: m2(recovered), recoveredTax: m2(recoveredTaxSoFar),
      recoverable: m2(recoverable), balanceDue: m2(d(inv['balance_due'])),
    });
  }
  data.sort((a, b) => String(a.invoiceDate).localeCompare(String(b.invoiceDate)) || String(a.invoiceNumber ?? '').localeCompare(String(b.invoiceNumber ?? ''))
    || String(a.invoiceId).localeCompare(String(b.invoiceId)));
  return { data };
}

/** POST /payments/write-off-recoveries: 201 RecoveryRecord. */
export async function recordRecovery(tenantId: string, input: RecoveryInput, userId?: string, companyId?: string) {
  let x: DecimalValue;
  try { x = new Decimal(String(input.amount)); } catch { throw AppError.badRequest('amount must be a decimal amount', 'VALIDATION_ERROR', { field: 'amount' }); }
  if (!x.isFinite() || !x.greaterThan(0) || !x.equals(r2(x))) {
    throw AppError.badRequest('Enter an amount above 0.00 with at most 2 decimal places.', 'VALIDATION_ERROR', { field: 'amount' });
  }
  if (!UUID_RE.test(input.invoiceId)) throw invoiceNotFound();
  return db.transaction(async (tx) => {
    // Lock order: the payments that wrote it off (id order), then the invoice (E-B1).
    const before = await writeOffApps(tx, tenantId, [input.invoiceId]);
    const locked = await lockPayments(tx, tenantId, before.map((a) => a.paymentId));
    const inv = (await lockInvoices(tx, tenantId, [input.invoiceId])).get(input.invoiceId);
    if (!inv || inv.txnType !== 'invoice' || inv.status === 'deleted' || ledger.inOtherCompany(inv, companyId)) throw invoiceNotFound();
    if (inv.status !== 'posted') throw AppError.badRequest('This invoice is void.', 'VALIDATION_ERROR');
    const apps = await writeOffApps(tx, tenantId, [input.invoiceId]);
    if (apps.some((a) => !locked.has(a.paymentId))) {
      throw AppError.conflict('This invoice changed while the recovery was being saved. Reload it and try again.', 'STALE', { invoiceId: inv.id });
    }
    const W = apps.reduce((s, a) => s.plus(a.writeOff), D0());
    const xPrev = apps.reduce((s, a) => s.plus(a.recovered), D0());
    const available = W.minus(xPrev);
    if (x.greaterThan(available)) {
      throw AppError.conflict(
        `Only ${m2(available)} of the amount written off on this invoice can be recovered.`,
        'RECOVERY_EXCEEDS_WRITE_OFF', { invoiceId: inv.id, available: m2(available) },
      );
    }
    // Oldest write-off first.
    const alloc: Array<{ app: WriteOffApp; amount: DecimalValue }> = [];
    let left = x;
    for (const a of apps) {
      if (!left.greaterThan(0)) break;
      const take = Decimal.min(left, a.writeOff.minus(a.recovered));
      if (!take.greaterThan(0)) continue;
      alloc.push({ app: a, amount: take });
      left = left.minus(take);
    }
    const latest = alloc.reduce((m, a) => (a.app.paymentDate > m ? a.app.paymentDate : m), inv.txnDate);
    if (input.date < latest) {
      throw AppError.badRequest('A recovery can’t be dated before the invoice or the write-off it takes back.', 'RECOVERY_DATE_INVALID',
        { earliestDate: latest });
    }
    const { bad, prev } = await itemTaxes(tx, tenantId, inv.id, apps);
    const items = recoveredTax(bad, prev, W, xPrev.plus(x));
    const xt = items.reduce((s, i) => s.plus(i.tax), D0());

    const sys = await tx.select({ id: accounts.id, tag: accounts.systemTag }).from(accounts)
      .where(and(eq(accounts.tenantId, tenantId), sql`${accounts.systemTag} IN ('accounts_receivable', 'sales_tax_payable')`));
    const ar = sys.find((s) => s.tag === 'accounts_receivable')?.id;
    const stp = sys.find((s) => s.tag === 'sales_tax_payable')?.id;
    if (!ar) throw AppError.internal('AR account not found');
    // The write-off accounts get x less the tax, taken off them in allocation order.
    const credits = new Map<string, DecimalValue>();
    for (const a of alloc) {
      if (!a.app.accountId) throw AppError.internal('Write-off account missing on an application');
      credits.set(a.app.accountId, (credits.get(a.app.accountId) ?? D0()).plus(a.amount));
    }
    let taxLeft = xt;
    for (const [acct, amt] of credits) {
      const off = Decimal.min(amt, Decimal.max(taxLeft, 0));
      credits.set(acct, amt.minus(off));
      taxLeft = taxLeft.minus(off);
    }
    const lines = [
      { accountId: ar, debit: x.toFixed(4), credit: '0', contactId: inv.contactId ?? undefined },
      ...[...credits.entries()].filter(([, v]) => v.greaterThan(0)).map(([accountId, v]) => ({ accountId, debit: '0', credit: v.toFixed(4) })),
    ];
    if (!xt.isZero()) {
      if (!stp) throw AppError.internal('Sales Tax Payable account not found');
      lines.push(xt.greaterThan(0) ? { accountId: stp, debit: '0', credit: xt.toFixed(4) } : { accountId: stp, debit: xt.negated().toFixed(4), credit: '0' });
    }
    const scope = companyId ?? inv.companyId ?? undefined;
    const rec = await ledger.postTransaction(tenantId, {
      txnType: 'bad_debt_recovery',
      txnDate: input.date,
      contactId: inv.contactId ?? undefined,
      memo: input.memo?.trim() || `Recovered bad debt${inv.txnNumber ? ` on invoice ${inv.txnNumber}` : ''}`,
      total: x.toFixed(4),
      lines,
    }, userId, scope, tx);

    const co = await rowCompanyId(tx, tenantId, scope);
    if (!co) throw AppError.internal('Company not found');
    await tx.insert(writeOffRecoveries).values(alloc.map((a) => ({
      tenantId, companyId: co, applicationId: a.app.id, invoiceId: inv.id, recoveryTxnId: rec.id, amount: a.amount.toFixed(4),
    })));
    if (items.length > 0) {
      await tx.insert(transactionTaxLines).values(items.map((i) => ({
        tenantId, companyId: co, transactionId: rec.id, kind: 'recovery', eventDate: input.date, salesTaxId: i.salesTaxId, taxItemId: i.taxItemId,
        agencyId: i.agencyId, invoiceId: inv.id, rate: i.rate, base: i.base.toFixed(4), tax: i.tax.toFixed(4),
      })));
    }
    // The invoice reopens by x (Q-P23q).
    await moveInvoicePaid(tx, tenantId, inv, x.negated());
    await auditLog(tenantId, 'create', 'bad_debt_recovery', rec.id, null, {
      invoiceId: inv.id, date: input.date, amount: x.toFixed(4), recoveredTax: xt.toFixed(4),
      applications: alloc.map((a) => ({ applicationId: a.app.id, paymentId: a.app.paymentId, amount: a.amount.toFixed(4) })),
    }, userId, tx);
    return recoveryRecord(tx, tenantId, rec.id, companyId);
  });
}

/** A recovery as the routes return it (GET, create and replay). */
export async function recoveryRecord(executor: DbOrTx, tenantId: string, id: string, companyId?: string) {
  if (!UUID_RE.test(id)) throw AppError.notFound('Recovery not found');
  const [t] = await executor.select().from(transactions).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, id))).limit(1);
  if (!t || t.txnType !== 'bad_debt_recovery' || t.status === 'deleted' || ledger.inOtherCompany(t, companyId)) throw AppError.notFound('Recovery not found');
  const rows = await executor.select().from(writeOffRecoveries).where(and(eq(writeOffRecoveries.tenantId, tenantId), eq(writeOffRecoveries.recoveryTxnId, id)));
  const invoiceId = rows[0]?.invoiceId ?? null;
  const [inv] = invoiceId
    ? await executor.select().from(transactions).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, invoiceId))).limit(1)
    : [];
  const tax = await executor.select().from(transactionTaxLines)
    .where(and(eq(transactionTaxLines.tenantId, tenantId), eq(transactionTaxLines.transactionId, id), eq(transactionTaxLines.kind, 'recovery')))
    .orderBy(transactionTaxLines.createdAt, transactionTaxLines.id);
  const balance = d(inv?.balanceDue);
  return {
    id: t.id,
    txnType: 'bad_debt_recovery' as const,
    status: t.status,
    date: t.txnDate,
    customerId: t.contactId,
    invoiceId,
    invoiceNumber: inv?.txnNumber ?? null,
    amount: m2(d(t.total)),
    recoveredTax: m2(tax.reduce((s, r) => s.plus(d(r.tax)), D0())),
    taxLines: tax.map((r) => ({ taxItemId: r.taxItemId, agencyId: r.agencyId, rate: r.rate === null ? null : d(r.rate).toFixed(6), base: m2(d(r.base)), tax: m2(d(r.tax)) })),
    invoiceBalanceDue: m2(balance.greaterThan(0) ? balance : D0()),
    memo: t.memo,
    updatedAt: t.updatedAt ? t.updatedAt.toISOString() : null,
  };
}

/** Locks the payments a recovery took write-offs from, before voidTransactionInTx locks the recovery (the lock order). */
export async function lockForRecoveryVoidInTx(tx: Tx, tenantId: string, recoveryId: string): Promise<void> {
  const res = await tx.execute(sql`
    SELECT DISTINCT pa.payment_id FROM write_off_recoveries r JOIN payment_applications pa ON pa.id = r.application_id
    WHERE r.tenant_id = ${tenantId} AND r.recovery_txn_id = ${recoveryId}`);
  await lockPayments(tx, tenantId, (res.rows as Array<{ payment_id: string }>).map((r) => String(r.payment_id)));
}

/**
 * The bad_debt_recovery branch of voidTransactionInTx: the invoice takes
 * the write-off back (amount paid + x). 409 RECOVERY_IN_USE when its
 * balance due is less than x (the reopened balance was paid).
 */
export async function releaseRecoveryForVoidInTx(tx: Tx, tenantId: string, rec: TxnRow, userId?: string): Promise<void> {
  const rows = await tx.select().from(writeOffRecoveries)
    .where(and(eq(writeOffRecoveries.tenantId, tenantId), eq(writeOffRecoveries.recoveryTxnId, rec.id)));
  if (rows.length === 0) return;
  const x = rows.reduce((s, r) => s.plus(d(r.amount)), D0());
  const invoiceId = rows[0]!.invoiceId;
  const inv = (await lockInvoices(tx, tenantId, [invoiceId])).get(invoiceId);
  if (!inv) return;
  const balance = r2(d(inv.balanceDue));
  if (inv.status === 'posted' && balance.lessThan(x)) {
    throw AppError.conflict(
      'The amount this recovery reopened was paid. Void or edit that payment first, then void the recovery.',
      'RECOVERY_IN_USE', { invoiceId, balanceDue: m2(Decimal.max(balance, 0)), amount: m2(x) },
    );
  }
  await moveInvoicePaid(tx, tenantId, inv, x);
  await auditLog(tenantId, 'update', 'bad_debt_recovery', rec.id, { invoiceId, amount: x.toFixed(4) }, { via: 'void' }, userId, tx);
}
