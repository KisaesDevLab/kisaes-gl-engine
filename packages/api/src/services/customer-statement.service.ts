// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Customer statements (U-112 amended, U-140; customer-statement-v1,
 * customer-statement-send-v1, idempotency-customer-statements-v1).
 *
 * Every figure comes from the A/R open-items helper (ar-open-items.ts), so a
 * statement's aging is the client's row of the A/R aging summary (Q-177)
 * and its amount due is the client's A/R balance as of the date. Exact
 * Decimal arithmetic; amounts out are 2-place strings.
 *
 *   open_item       lines = the client's open items as of asOf; running
 *                   balance over the open amounts; amountDue = aging total.
 *   balance_forward openingBalance = Σ items as of start - 1 day; lines =
 *                   each posted transaction dated start..asOf with its own
 *                   A/R amount for the client; running balance from the
 *                   opening.
 *   transaction     the same lines without the forward row (the opening is
 *                   the "Previous balance" in the header).
 *
 * A run stores one numbered snapshot per client (the `statement` counter):
 * display data only, no ids (S10), so a reprint or a later Outbox send is
 * identical. Names, addresses and emails are never logged.
 */

import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import DecimalLib from 'decimal.js';
import { db, type DbOrTx, type Tx } from '../db/index.js';
import {
  contacts, customerStatementRuns, customerStatements, customerStatementSendEvents, customerStatementEmailQueue,
} from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import { arOpenItemsAsOf, ageOpenItems, daysBetween, type OpenItem } from './ar-open-items.js';
import { addressLinesFromParts } from './check-address.js';
import * as documentNumbers from './document-number.service.js';
import { claimIdempotency, recordIdempotentEntity } from './idempotency.service.js';

const Decimal = DecimalLib.default || DecimalLib;
type DecimalValue = InstanceType<typeof Decimal>;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const m2 = (d: DecimalValue | string) => new Decimal(d).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);

export type StatementFormat = 'open_item' | 'balance_forward' | 'transaction';

export interface StatementLine {
  date: string; txnId: string; txnType: string; number: string | null; description: string;
  dueDate?: string; amount: string; open?: string; balance: string;
}

export interface CustomerStatement {
  contact: { id: string; name: string; address: string[]; email?: string };
  asOf: string; format: StatementFormat; start?: string; openingBalance?: string;
  lines: StatementLine[];
  aging: { current: string; days1to30: string; days31to60: string; days61to90: string; over90: string; total: string };
  amountDue: string;
  difference: string;
}

const TYPE_LABEL: Record<string, string> = {
  invoice: 'Invoice', credit_memo: 'Credit memo', customer_payment: 'Payment', customer_refund: 'Refund',
  returned_payment: 'Bounced payment', journal_entry: 'Journal entry', cash_sale: 'Sales receipt',
};
const describeTxn = (type: string, number: string | null) => `${TYPE_LABEL[type] ?? 'Adjustment'}${number ? ` ${number}` : ''}`;

function firstOfMonth(d: string): string { return `${d.slice(0, 7)}-01`; }
function dayBefore(d: string): string {
  return new Date(Date.parse(d + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
}

async function loadCustomer(executor: DbOrTx, tenantId: string, contactId: string, companyId?: string) {
  if (!UUID_RE.test(contactId)) throw AppError.notFound('Customer not found');
  const [c] = await executor.select().from(contacts).where(and(eq(contacts.tenantId, tenantId), eq(contacts.id, contactId))).limit(1);
  if (!c || (companyId && c.companyId && c.companyId !== companyId)) throw AppError.notFound('Customer not found');
  return c;
}

/** GET /reports/customer-statement: one client's statement as of a date. */
export async function buildCustomerStatement(
  executor: DbOrTx, tenantId: string, companyId: string | undefined,
  q: { contactId: string; asOf: string; format?: StatementFormat; start?: string },
): Promise<CustomerStatement> {
  const c = await loadCustomer(executor, tenantId, q.contactId, companyId);
  const format = q.format ?? 'open_item';
  const items = await arOpenItemsAsOf(executor, { tenantId, companyId, asOf: q.asOf, contactIds: [c.id] });
  const aging = ageOpenItems(items, q.asOf);
  const contact = {
    id: c.id, name: c.displayName,
    address: addressLinesFromParts(c.billingLine1, c.billingLine2, c.billingCity, c.billingState, c.billingZip),
    ...(c.email ? { email: c.email } : {}),
  };
  const agingOut = { ...aging.buckets, total: aging.total };
  if (format === 'open_item') {
    let running = new Decimal(0);
    const lines = [...items].sort((a, b) => a.date.localeCompare(b.date) || (a.number ?? '').localeCompare(b.number ?? '') || a.txnId.localeCompare(b.txnId))
      .map((it: OpenItem) => {
        running = running.plus(it.open);
        return {
          date: it.date, txnId: it.txnId, txnType: it.txnType, number: it.number, description: describeTxn(it.txnType, it.number),
          ...(it.dueDate ? { dueDate: it.dueDate } : {}), amount: it.original, open: it.open, balance: running.toFixed(2),
        };
      });
    return { contact, asOf: q.asOf, format, lines, aging: agingOut, amountDue: aging.total, difference: aging.difference };
  }
  const start = q.start ?? firstOfMonth(q.asOf);
  if (start > q.asOf) throw AppError.badRequest('start must be on or before asOf', 'VALIDATION_ERROR');
  const before = await arOpenItemsAsOf(executor, { tenantId, companyId, asOf: dayBefore(start), contactIds: [c.id] });
  const opening = before.reduce((s, i) => s.plus(i.openExact), new Decimal(0));
  const scope = companyId ? sql`AND (t.company_id = ${companyId} OR t.company_id IS NULL)` : sql``;
  const res = await executor.execute(sql`
    SELECT t.id, t.txn_type, t.txn_number, t.reference_number, to_char(t.txn_date, 'YYYY-MM-DD') AS d,
      to_char(t.due_date, 'YYYY-MM-DD') AS due, SUM(jl.debit - jl.credit)::text AS amount
    FROM journal_lines jl
    JOIN transactions t ON t.id = jl.transaction_id AND t.tenant_id = jl.tenant_id
    JOIN accounts a ON a.id = jl.account_id AND a.tenant_id = jl.tenant_id
    WHERE jl.tenant_id = ${tenantId} AND t.status = 'posted' AND a.system_tag = 'accounts_receivable'
      AND COALESCE(jl.contact_id, t.contact_id) = ${c.id} ${scope}
      AND t.txn_date >= ${start}::date AND t.txn_date <= ${q.asOf}::date
    GROUP BY t.id
    HAVING SUM(jl.debit - jl.credit) <> 0
    ORDER BY t.txn_date, t.txn_number NULLS FIRST, t.id
  `);
  let running = opening;
  const lines = (res.rows as Array<Record<string, unknown>>).map((r) => {
    const amount = new Decimal(String(r['amount']));
    running = running.plus(amount);
    const type = String(r['txn_type']);
    const number = (r['txn_number'] as string | null) ?? (r['reference_number'] as string | null) ?? null;
    return {
      date: String(r['d']), txnId: String(r['id']), txnType: type, number, description: describeTxn(type, number),
      ...(type === 'invoice' ? { dueDate: (r['due'] as string | null) ?? String(r['d']) } : {}),
      amount: m2(amount), balance: m2(running),
    };
  });
  return {
    contact, asOf: q.asOf, format, start, openingBalance: m2(opening), lines, aging: agingOut,
    amountDue: aging.total, difference: aging.difference,
  };
}

/** GET /reports/customer-statements: the batch picker, one row per client with A/R as of asOf. */
export async function listStatementCandidates(
  tenantId: string, companyId: string | undefined,
  q: { asOf: string; minDaysOverdue?: number; openOnly?: boolean; limit?: number; offset?: number },
) {
  const items = await arOpenItemsAsOf(db, { tenantId, companyId, asOf: q.asOf });
  const by = new Map<string, OpenItem[]>();
  for (const it of items) if (it.contactId) by.set(it.contactId, [...(by.get(it.contactId) ?? []), it]);
  const scope = companyId ? sql`AND (c.company_id = ${companyId} OR c.company_id IS NULL)` : sql``;
  const custRes = await db.execute(sql`
    SELECT c.id, c.display_name, (c.email IS NOT NULL AND c.email <> '') AS has_email
    FROM contacts c WHERE c.tenant_id = ${tenantId} AND c.contact_type IN ('customer', 'both') AND c.is_active = true ${scope}
    ORDER BY c.display_name, c.id
  `);
  const last = await db.execute(sql`
    SELECT DISTINCT ON (contact_id) contact_id, to_char(as_of, 'YYYY-MM-DD') AS d, number
    FROM customer_statements WHERE tenant_id = ${tenantId} ${companyId ? sql`AND company_id = ${companyId}` : sql``}
    ORDER BY contact_id, created_at DESC
  `);
  const lastBy = new Map((last.rows as Array<{ contact_id: string; d: string; number: string }>).map((r) => [r.contact_id, { date: r.d, number: r.number }]));
  const openOnly = q.openOnly !== false;
  const minDays = q.minDaysOverdue ?? 0;
  const rows = (custRes.rows as Array<{ id: string; display_name: string; has_email: boolean }>).map((c) => {
    const mine = by.get(c.id) ?? [];
    const amountDue = mine.reduce((s, i) => s.plus(i.open), new Decimal(0));
    const overdue = mine.filter((i) => new Decimal(i.open).greaterThan(0) && i.dueDate)
      .map((i) => daysBetween(i.dueDate!, q.asOf));
    const oldest = Math.max(0, ...overdue);
    return {
      contactId: c.id, name: c.display_name, amountDue: amountDue.toFixed(2), oldestDaysOverdue: oldest, hasEmail: c.has_email === true,
      ...(lastBy.get(c.id) ? { lastStatement: lastBy.get(c.id)! } : {}),
    };
  }).filter((r) => (!openOnly || !new Decimal(r.amountDue).isZero()) && r.oldestDaysOverdue >= minDays);
  const limit = Math.min(Math.max(q.limit ?? 200, 1), 1000);
  const offset = Math.max(q.offset ?? 0, 0);
  return { data: rows.slice(offset, offset + limit), total: rows.length };
}

/** The snapshot of a statement: display data only, no ids (S10). */
function snapshotOf(st: CustomerStatement, number: string) {
  const { id: _id, ...contact } = st.contact;
  void _id;
  return {
    number, contact, asOf: st.asOf, format: st.format,
    ...(st.start ? { start: st.start } : {}), ...(st.openingBalance !== undefined ? { openingBalance: st.openingBalance } : {}),
    lines: st.lines.map(({ txnId: _t, ...l }) => { void _t; return l; }),
    aging: st.aging, amountDue: st.amountDue, difference: st.difference,
  };
}

export const MAX_STATEMENT_CONTACTS = 500;

/**
 * POST /customer-statement-runs: one numbered snapshot per client, in one
 * database transaction; no GL effect, no closing check. The idempotency
 * entity is the run; a replay rebuilds the response from it.
 */
export async function createStatementRun(
  tenantId: string, companyId: string | undefined,
  input: { asOf: string; format?: StatementFormat; start?: string; contactIds: string[] }, userId?: string,
) {
  if (input.contactIds.length > MAX_STATEMENT_CONTACTS) {
    throw AppError.badRequest(`At most ${MAX_STATEMENT_CONTACTS} clients per run.`, 'TOO_MANY_CONTACTS', { max: MAX_STATEMENT_CONTACTS });
  }
  if (!companyId) throw AppError.badRequest('A company is required', 'VALIDATION_ERROR');
  const runId = await db.transaction(async (tx) => {
    await claimIdempotency(tx);
    const format = input.format ?? 'open_item';
    const [run] = await tx.insert(customerStatementRuns).values({
      tenantId, companyId, asOf: input.asOf, format,
      startDate: format === 'open_item' ? null : (input.start ?? firstOfMonth(input.asOf)), createdBy: userId ?? null,
    }).returning({ id: customerStatementRuns.id });
    await recordIdempotentEntity(tx, 'customer_statement_run', run!.id);
    for (const contactId of [...new Set(input.contactIds)]) {
      const st = await buildCustomerStatement(tx, tenantId, companyId, { contactId, asOf: input.asOf, format, start: input.start });
      const { txnNumber } = await documentNumbers.claim(tenantId, 'statement', companyId, tx);
      await tx.insert(customerStatements).values({
        tenantId, runId: run!.id, companyId, contactId, number: txnNumber, asOf: input.asOf,
        amountDue: new Decimal(st.amountDue).toFixed(4), snapshot: snapshotOf(st, txnNumber),
      });
    }
    await auditLog(tenantId, 'create', 'customer_statement_run', run!.id, null,
      { via: 'statement_run', count: input.contactIds.length, asOf: input.asOf, format }, userId, tx);
    return run!.id;
  });
  return getRunResult(tenantId, runId, companyId);
}

/** The run response, rebuilt from the stored rows (replays). */
export async function getRunResult(tenantId: string, runId: string, companyId?: string) {
  const rows = await db.select().from(customerStatements)
    .where(and(eq(customerStatements.tenantId, tenantId), eq(customerStatements.runId, runId),
      ...(companyId ? [eq(customerStatements.companyId, companyId)] : [])))
    .orderBy(asc(customerStatements.number), asc(customerStatements.id));
  return {
    runId,
    statements: rows.map((r) => ({ statementId: r.id, contactId: r.contactId, number: r.number, amountDue: m2(r.amountDue) })),
  };
}

async function loadStatement(executor: DbOrTx, tenantId: string, id: string, companyId?: string, lock = false) {
  if (!UUID_RE.test(id)) throw AppError.notFound('Statement not found');
  const q = executor.select().from(customerStatements)
    .where(and(eq(customerStatements.tenantId, tenantId), eq(customerStatements.id, id),
      ...(companyId ? [eq(customerStatements.companyId, companyId)] : [])));
  const [row] = lock ? await (q as unknown as { for: (m: 'update') => typeof q }).for('update').limit(1) : await q.limit(1);
  if (!row) throw AppError.notFound('Statement not found');
  return row;
}

async function sendHistory(executor: DbOrTx, tenantId: string, id: string) {
  return executor.select({
    id: customerStatementSendEvents.id, method: customerStatementSendEvents.method, recipients: customerStatementSendEvents.recipients,
    sentAt: customerStatementSendEvents.sentAt, userId: customerStatementSendEvents.userId,
  }).from(customerStatementSendEvents)
    .where(and(eq(customerStatementSendEvents.tenantId, tenantId), eq(customerStatementSendEvents.customerStatementId, id)))
    .orderBy(asc(customerStatementSendEvents.sentAt), asc(customerStatementSendEvents.id));
}

/** GET /customer-statements/:id: the snapshot, its number and its send history. */
export async function getStatement(tenantId: string, id: string, companyId?: string) {
  const row = await loadStatement(db, tenantId, id, companyId);
  return {
    id: row.id, runId: row.runId, contactId: row.contactId, number: row.number, asOf: row.asOf, amountDue: m2(row.amountDue),
    createdAt: row.createdAt.toISOString(), snapshot: row.snapshot, sendHistory: await sendHistory(db, tenantId, id),
  };
}

/** GET /customer-statements?contactId=: a client's statements, newest first. */
export async function listStatements(tenantId: string, companyId: string | undefined, contactId?: string) {
  const rows = await db.select().from(customerStatements)
    .where(and(eq(customerStatements.tenantId, tenantId),
      ...(companyId ? [eq(customerStatements.companyId, companyId)] : []),
      ...(contactId ? [eq(customerStatements.contactId, contactId)] : [])))
    .orderBy(desc(customerStatements.createdAt), desc(customerStatements.number)).limit(500);
  const ids = rows.map((r) => r.id);
  const sent = ids.length === 0 ? [] : await db.select({ id: customerStatementSendEvents.customerStatementId, at: customerStatementSendEvents.sentAt })
    .from(customerStatementSendEvents).where(and(eq(customerStatementSendEvents.tenantId, tenantId), inArray(customerStatementSendEvents.customerStatementId, ids)));
  const lastSent = new Map<string, Date>();
  for (const s of sent) if (!lastSent.has(s.id) || lastSent.get(s.id)! < s.at) lastSent.set(s.id, s.at);
  return {
    data: rows.map((r) => ({
      id: r.id, runId: r.runId, contactId: r.contactId, number: r.number, asOf: r.asOf, amountDue: m2(r.amountDue),
      createdAt: r.createdAt.toISOString(), lastSentAt: lastSent.get(r.id)?.toISOString() ?? null,
    })),
  };
}

async function recordStatementSend(
  tx: Tx, tenantId: string, row: { id: string; companyId: string },
  event: { method: 'printed' | 'email' | 'pdf'; recipients?: string[] }, userId?: string,
) {
  const recipients = event.method === 'email' ? [...new Set((event.recipients ?? []).map((a) => a.trim()))] : [];
  const [ev] = await tx.insert(customerStatementSendEvents).values({
    tenantId, companyId: row.companyId, customerStatementId: row.id, method: event.method, recipients, userId: userId ?? null,
  }).returning({ id: customerStatementSendEvents.id });
  await auditLog(tenantId, 'update', 'customer_statement', row.id, null,
    { via: 'record_sent', method: event.method, recipientCount: recipients.length, sendEventId: ev!.id }, userId, tx);
}

/** POST /customer-statements/:id/sent: Mark as sent (printing counts as sent, Q-P20e). */
export async function markStatementSent(
  tenantId: string, id: string, input: { method: 'printed' | 'email' | 'pdf'; recipients?: string[] }, userId?: string, companyId?: string,
) {
  await db.transaction(async (tx) => {
    await claimIdempotency(tx);
    const row = await loadStatement(tx, tenantId, id, companyId, true);
    await recordIdempotentEntity(tx, 'customer_statement', id);
    await recordStatementSend(tx, tenantId, row, input, userId);
  });
  return getStatement(tenantId, id, companyId);
}

export interface StatementEmailInput {
  to: string[]; cc: string[]; bcc: string[]; subject: string; body: string; pdfFileName: string; pdfBase64: string; outboxId?: string;
}

/**
 * POST /customer-statements/:id/email: sends the client-made PDF of the
 * snapshot through the company's mail server (U-127 rules: SMTP_NOT_CONFIGURED,
 * SMTP_SEND_FAILED, ATTACHMENT_TOO_LARGE), records the send and removes the
 * Outbox row when outboxId is given.
 */
export async function emailStatement(tenantId: string, id: string, input: StatementEmailInput, userId?: string, companyId?: string) {
  // Another company's (or a missing) statement is 404 before the mail
  // server settings are looked at.
  await loadStatement(db, tenantId, id, companyId, false);
  const mail = await import('./invoice-email.service.js');
  await mail.sendFormEmail(tenantId, companyId, input, async (tx) => {
    const row = await loadStatement(tx, tenantId, id, companyId, true);
    if (input.outboxId) {
      const [q] = await tx.select({ id: customerStatementEmailQueue.id }).from(customerStatementEmailQueue)
        .where(and(eq(customerStatementEmailQueue.tenantId, tenantId), eq(customerStatementEmailQueue.id, input.outboxId),
          eq(customerStatementEmailQueue.customerStatementId, id))).for('update').limit(1);
      if (!q) throw new AppError(404, 'That message is no longer in the Outbox', 'OUTBOX_ITEM_NOT_FOUND');
    }
    await recordIdempotentEntity(tx, 'customer_statement', id);
    return async (recipients: string[]) => {
      await recordStatementSend(tx, tenantId, row, { method: 'email', recipients }, userId);
      if (input.outboxId) {
        await tx.delete(customerStatementEmailQueue).where(and(eq(customerStatementEmailQueue.tenantId, tenantId), eq(customerStatementEmailQueue.id, input.outboxId)));
        await auditLog(tenantId, 'delete', 'customer_statement_email_queue', input.outboxId, null, { via: 'sent', customerStatementId: id }, userId, tx);
      }
    };
  });
  return getStatement(tenantId, id, companyId);
}

/** POST /customer-statements/:id/email-later: a message in the Outbox (the PDF is made when it is sent). */
export async function queueStatementEmail(
  tenantId: string, id: string, input: { to: string[]; cc: string[]; bcc: string[]; subject: string; body: string }, userId?: string, companyId?: string,
) {
  const itemId = await db.transaction(async (tx) => {
    await claimIdempotency(tx);
    const row = await loadStatement(tx, tenantId, id, companyId, true);
    const [item] = await tx.insert(customerStatementEmailQueue).values({
      tenantId, companyId: row.companyId, customerStatementId: id,
      toAddresses: input.to.map((a) => a.trim()), ccAddresses: input.cc.map((a) => a.trim()), bccAddresses: input.bcc.map((a) => a.trim()),
      subject: input.subject.replace(/[\r\n]+/g, ' ').trim(), body: input.body, userId: userId ?? null,
    }).returning({ id: customerStatementEmailQueue.id });
    await recordIdempotentEntity(tx, 'form_email_queue', item!.id);
    await auditLog(tenantId, 'create', 'customer_statement_email_queue', item!.id, null, {
      via: 'email_later', customerStatementId: id, recipientCount: input.to.length + input.cc.length + input.bcc.length,
    }, userId, tx);
    return item!.id;
  });
  const mail = await import('./invoice-email.service.js');
  return mail.getEmailQueueItem(tenantId, itemId, companyId);
}
