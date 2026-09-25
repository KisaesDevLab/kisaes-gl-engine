// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  buildAccrualSchedule, type AccrualKind, type AccrualMethod,
} from '@kis-books/shared';
import { db } from '../db/index.js';
import { accrualSchedules, accrualEntries, accounts, transactions } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import * as journalEntries from './journal-entry.service.js';
import * as ledger from './ledger.service.js';

// Close Review → Accruals. A schedule spreads one amount across months; each
// month is an entry that posts a journal entry ONLY when the reviewer clicks
// Post (never automatically). Months before the schedule's post-from month
// are "catch-up" entries posted in that month.

export interface ScheduleInput {
  companyId: string | null;
  kind: AccrualKind;
  description: string;
  contactId?: string | null;
  sourceTransactionId?: string | null;
  balanceAccountId: string;
  recognitionAccountId: string;
  totalAmount: string;
  startDate: string;
  months: number;
  method: AccrualMethod;
  /** Month catch-up entries post in; defaults to the start month. */
  postFrom?: string | null;
}

const firstOfMonth = (d: string) => `${d.slice(0, 7)}-01`;
function monthEnd(periodStart: string): string {
  const [y, m] = periodStart.split('-').map(Number);
  return new Date(Date.UTC(y!, m!, 0)).toISOString().slice(0, 10);
}

async function assertAccounts(tenantId: string, ids: string[]) {
  const rows = await db.select({ id: accounts.id }).from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), inArray(accounts.id, ids)));
  if (rows.length !== new Set(ids).size) throw AppError.badRequest('One of the accounts was not found.');
}

function entriesFor(input: ScheduleInput) {
  const lines = buildAccrualSchedule({
    totalAmount: input.totalAmount, startDate: input.startDate, months: input.months, method: input.method,
  });
  const postFrom = firstOfMonth(input.postFrom || input.startDate);
  return {
    postFrom,
    entries: lines.map((l) => ({
      periodStart: l.periodStart,
      postPeriod: l.periodStart < postFrom ? postFrom : l.periodStart,
      amount: l.amount,
      isCatchUp: l.periodStart < postFrom,
    })),
  };
}

export async function createSchedule(tenantId: string, input: ScheduleInput, userId?: string) {
  if (!input.description.trim()) throw AppError.badRequest('Describe what this schedule is for.');
  await assertAccounts(tenantId, [input.balanceAccountId, input.recognitionAccountId]);
  let built;
  try { built = entriesFor(input); } catch (e) { throw AppError.badRequest(e instanceof Error ? e.message : String(e)); }
  return db.transaction(async (tx) => {
    const [s] = await tx.insert(accrualSchedules).values({
      tenantId,
      companyId: input.companyId,
      kind: input.kind,
      description: input.description.trim(),
      contactId: input.contactId ?? null,
      sourceTransactionId: input.sourceTransactionId ?? null,
      balanceAccountId: input.balanceAccountId,
      recognitionAccountId: input.recognitionAccountId,
      totalAmount: input.totalAmount,
      startDate: input.startDate,
      months: input.months,
      method: input.method,
      postFrom: built.postFrom,
      createdBy: userId ?? null,
    }).returning();
    await tx.insert(accrualEntries).values(built.entries.map((e) => ({ tenantId, scheduleId: s!.id, ...e })));
    await auditLog(tenantId, 'create', 'accrual_schedule', s!.id, null, { kind: input.kind, total: input.totalAmount, months: input.months }, userId);
    return s!;
  });
}

async function getSchedule(tenantId: string, id: string) {
  const [s] = await db.select().from(accrualSchedules)
    .where(and(eq(accrualSchedules.tenantId, tenantId), eq(accrualSchedules.id, id))).limit(1);
  if (!s) throw AppError.notFound('Schedule not found');
  return s;
}

/** Change a schedule's terms. Allowed only while nothing has posted. */
export async function updateSchedule(tenantId: string, id: string, input: Omit<ScheduleInput, 'companyId'>, userId?: string) {
  const s = await getSchedule(tenantId, id);
  if (s.status !== 'active') {
    throw AppError.badRequest(`This schedule is ${s.status}. Create a new schedule instead.`, 'ACCRUAL_NOT_ACTIVE');
  }
  await assertAccounts(tenantId, [input.balanceAccountId, input.recognitionAccountId]);
  let built;
  try { built = entriesFor({ ...input, companyId: s.companyId }); } catch (e) { throw AppError.badRequest(e instanceof Error ? e.message : String(e)); }
  await db.transaction(async (tx) => {
    // Lock the schedule and every entry first, then decide. A Post racing
    // this edit either committed before (we see it and refuse) or waits on
    // the lock and then finds its draft gone — never a deleted posted entry.
    const [locked] = await tx.execute(sql`SELECT status FROM accrual_schedules WHERE id = ${id} FOR UPDATE`).then((r) => r.rows as Array<{ status: string }>);
    if (locked?.status !== 'active') throw AppError.badRequest('This schedule is no longer active.', 'ACCRUAL_NOT_ACTIVE');
    const current = await tx.execute(sql`SELECT status FROM accrual_entries WHERE schedule_id = ${id} FOR UPDATE`);
    if ((current.rows as Array<{ status: string }>).some((r) => r.status === 'posted')) {
      throw AppError.badRequest('Entries from this schedule have already posted. Cancel its future entries and create a new schedule instead.', 'ACCRUAL_LOCKED');
    }
    await tx.update(accrualSchedules).set({
      kind: input.kind, description: input.description.trim(), contactId: input.contactId ?? null,
      balanceAccountId: input.balanceAccountId, recognitionAccountId: input.recognitionAccountId,
      totalAmount: input.totalAmount, startDate: input.startDate, months: input.months, method: input.method,
      postFrom: built.postFrom, updatedAt: new Date(),
    }).where(eq(accrualSchedules.id, id));
    await tx.delete(accrualEntries).where(eq(accrualEntries.scheduleId, id));
    await tx.insert(accrualEntries).values(built.entries.map((e) => ({ tenantId, scheduleId: id, ...e })));
  });
  await auditLog(tenantId, 'update', 'accrual_schedule', id, { total: s.totalAmount, months: s.months }, { total: input.totalAmount, months: input.months }, userId);
  return getSchedule(tenantId, id);
}

/** Delete a schedule that has never posted. */
export async function deleteSchedule(tenantId: string, id: string, userId?: string) {
  await getSchedule(tenantId, id);
  await db.transaction(async (tx) => {
    // Same locking as updateSchedule: never cascade-delete an entry that a
    // concurrent Post just booked.
    await tx.execute(sql`SELECT id FROM accrual_schedules WHERE id = ${id} FOR UPDATE`);
    const current = await tx.execute(sql`SELECT status FROM accrual_entries WHERE schedule_id = ${id} FOR UPDATE`);
    if ((current.rows as Array<{ status: string }>).some((r) => r.status === 'posted')) {
      throw AppError.badRequest('This schedule has posted entries. Stop it instead.', 'ACCRUAL_LOCKED');
    }
    await tx.delete(accrualSchedules).where(eq(accrualSchedules.id, id));
  });
  await auditLog(tenantId, 'delete', 'accrual_schedule', id, null, null, userId);
}

/** Stop a schedule: remaining drafts are cancelled; posted entries stay. */
export async function cancelSchedule(tenantId: string, id: string, userId?: string) {
  await getSchedule(tenantId, id);
  await db.transaction(async (tx) => {
    await tx.update(accrualEntries).set({ status: 'cancelled' })
      .where(and(eq(accrualEntries.scheduleId, id), eq(accrualEntries.status, 'draft')));
    await tx.update(accrualSchedules).set({ status: 'cancelled', updatedAt: new Date() }).where(eq(accrualSchedules.id, id));
  });
  await auditLog(tenantId, 'update', 'accrual_schedule', id, null, { action: 'cancel' }, userId);
}

export async function listSchedules(tenantId: string, companyId: string | null) {
  const rows = await db.execute(sql`
    SELECT s.*, ba.name AS balance_account_name, ra.name AS recognition_account_name,
      COALESCE(SUM(e.amount) FILTER (WHERE e.status = 'posted'), 0)::text AS posted_amount,
      COUNT(e.id) FILTER (WHERE e.status = 'posted')::int AS posted_count,
      COUNT(e.id) FILTER (WHERE e.status = 'draft')::int AS draft_count
    FROM accrual_schedules s
    LEFT JOIN accounts ba ON ba.id = s.balance_account_id
    LEFT JOIN accounts ra ON ra.id = s.recognition_account_id
    LEFT JOIN accrual_entries e ON e.schedule_id = s.id
    WHERE s.tenant_id = ${tenantId}
      ${companyId ? sql`AND (s.company_id = ${companyId} OR s.company_id IS NULL)` : sql``}
    GROUP BY s.id, ba.name, ra.name
    ORDER BY s.status = 'active' DESC, s.start_date DESC
  `);
  return rows.rows;
}

export async function scheduleEntries(tenantId: string, id: string) {
  await getSchedule(tenantId, id);
  return db.select().from(accrualEntries).where(eq(accrualEntries.scheduleId, id)).orderBy(asc(accrualEntries.periodStart));
}

/** Entries that post in one month (drafts to post, posted to review). */
export async function entriesForMonth(tenantId: string, companyId: string | null, periodStart: string) {
  const rows = await db.execute(sql`
    SELECT e.*, s.description, s.kind, s.balance_account_id, s.recognition_account_id,
      ba.name AS balance_account_name, ra.name AS recognition_account_name
    FROM accrual_entries e
    JOIN accrual_schedules s ON s.id = e.schedule_id
    LEFT JOIN accounts ba ON ba.id = s.balance_account_id
    LEFT JOIN accounts ra ON ra.id = s.recognition_account_id
    WHERE e.tenant_id = ${tenantId}
      AND e.post_period = ${firstOfMonth(periodStart)}::date
      AND e.status IN ('draft', 'posted')
      ${companyId ? sql`AND (s.company_id = ${companyId} OR s.company_id IS NULL)` : sql``}
    ORDER BY e.status, s.description, e.period_start
  `);
  return rows.rows;
}

function journalLines(kind: string, balanceAccountId: string, recognitionAccountId: string, amount: string, memo: string) {
  // Debit side, credit side.
  const [dr, cr] = kind === 'deferred_revenue'
    ? [balanceAccountId, recognitionAccountId]
    : [recognitionAccountId, balanceAccountId];
  return [
    { accountId: dr, debit: amount, credit: '0', description: memo, isTaxable: false, taxRate: '0', taxAmount: '0' },
    { accountId: cr, debit: '0', credit: amount, description: memo, isTaxable: false, taxRate: '0', taxAmount: '0' },
  ];
}

/**
 * Post one draft entry as a journal entry dated the last day of its posting
 * month. The draft is CLAIMED first with a conditional update (draft →
 * posted), so two concurrent Posts (a row click during Post all, two
 * reviewers) cannot both book it: the loser gets "already posted". If the
 * journal entry then fails (e.g. a locked period), the claim is released.
 */
export async function postEntry(tenantId: string, entryId: string, userId?: string) {
  const [row] = await db.select({ e: accrualEntries, s: accrualSchedules }).from(accrualEntries)
    .innerJoin(accrualSchedules, eq(accrualSchedules.id, accrualEntries.scheduleId))
    .where(and(eq(accrualEntries.tenantId, tenantId), eq(accrualEntries.id, entryId))).limit(1);
  if (!row) throw AppError.notFound('Entry not found');
  if (row.e.status !== 'draft') throw AppError.badRequest('Only draft entries can be posted.');

  const claimed = await db.update(accrualEntries)
    .set({ status: 'posted', postedBy: userId ?? null, postedAt: new Date() })
    .where(and(eq(accrualEntries.id, entryId), eq(accrualEntries.status, 'draft')))
    .returning({ id: accrualEntries.id });
  if (claimed.length === 0) throw AppError.badRequest('This entry was just posted by someone else.', 'ACCRUAL_ALREADY_POSTED');

  let transactionId: string | null = null;
  if (Number(row.e.amount) !== 0) {
    const period = String(row.e.periodStart).slice(0, 7);
    const memo = `${row.s.description} — ${period}${row.e.isCatchUp ? ' (catch-up)' : ''}`;
    try {
      const txn = await journalEntries.createJournalEntry(tenantId, {
        txnDate: monthEnd(String(row.e.postPeriod)),
        memo: `Accrual: ${memo}`,
        basis: 'both',
        lines: journalLines(row.s.kind, row.s.balanceAccountId, row.s.recognitionAccountId, String(row.e.amount), memo),
      }, userId, row.s.companyId ?? undefined);
      transactionId = txn.id;
    } catch (err) {
      await db.update(accrualEntries).set({ status: 'draft', postedBy: null, postedAt: null })
        .where(and(eq(accrualEntries.id, entryId), eq(accrualEntries.status, 'posted'), sql`${accrualEntries.transactionId} IS NULL`));
      throw err;
    }
    await db.update(accrualEntries).set({ transactionId }).where(eq(accrualEntries.id, entryId));
  }
  await maybeComplete(row.s.id);
  await auditLog(tenantId, 'update', 'accrual_entry', entryId, { status: 'draft' }, { status: 'posted', transactionId }, userId);
  return { transactionId };
}

/** Post every draft for the month. Stops at the first failure (e.g. a locked period). */
export async function postAllForMonth(tenantId: string, companyId: string | null, periodStart: string, userId?: string) {
  const rows = (await entriesForMonth(tenantId, companyId, periodStart)) as Array<{ id: string; status: string }>;
  let posted = 0;
  for (const r of rows.filter((x) => x.status === 'draft')) {
    await postEntry(tenantId, r.id, userId);
    posted++;
  }
  return { posted };
}

/** Void the journal entry and put the entry back to draft. */
export async function unpostEntry(tenantId: string, entryId: string, userId?: string) {
  const [e] = await db.select().from(accrualEntries)
    .where(and(eq(accrualEntries.tenantId, tenantId), eq(accrualEntries.id, entryId))).limit(1);
  if (!e) throw AppError.notFound('Entry not found');
  if (e.status !== 'posted') throw AppError.badRequest('Only posted entries can be unposted.');
  if (e.transactionId) {
    // Someone may already have voided the journal entry from the register;
    // that must not leave the entry stuck as posted.
    const [txn] = await db.select({ status: transactions.status }).from(transactions)
      .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, e.transactionId))).limit(1);
    if (txn && txn.status !== 'void') {
      await ledger.voidTransaction(tenantId, e.transactionId, 'Accrual entry unposted from Close Review', userId);
    }
  }
  await db.update(accrualEntries).set({ status: 'draft', transactionId: null, postedBy: null, postedAt: null })
    .where(and(eq(accrualEntries.id, entryId), eq(accrualEntries.status, 'posted')));
  await db.update(accrualSchedules).set({ status: 'active', updatedAt: new Date() })
    .where(and(eq(accrualSchedules.id, e.scheduleId), eq(accrualSchedules.status, 'completed')));
  await auditLog(tenantId, 'update', 'accrual_entry', entryId, { status: 'posted' }, { status: 'draft' }, userId);
}

async function maybeComplete(scheduleId: string) {
  const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(accrualEntries)
    .where(and(eq(accrualEntries.scheduleId, scheduleId), eq(accrualEntries.status, 'draft')));
  if (Number(r?.n ?? 0) === 0) {
    await db.update(accrualSchedules).set({ status: 'completed', updatedAt: new Date() })
      .where(and(eq(accrualSchedules.id, scheduleId), eq(accrualSchedules.status, 'active')));
  }
}

// ── Candidates ─────────────────────────────────────────────────────────

const PREPAID_WORDS = '(annual|yearly|12[- ]?month|twelve month|policy|premium|insurance|retainer|subscription|renewal|term|deposit)';

export async function candidates(tenantId: string, companyId: string | null, periodStart: string, periodEnd: string, minAmount = 1000) {
  const ps = firstOfMonth(periodStart);
  const pe = periodEnd.slice(0, 10);
  const companyCond = companyId ? sql`AND t.company_id = ${companyId}` : sql``;

  // Debits to prepaid / fixed-asset style accounts and credits to deferred
  // revenue in the month that no schedule covers yet.
  const unscheduled = await db.execute(sql`
    SELECT t.id AS transaction_id, t.txn_date, t.memo, c.display_name AS payee, a.id AS account_id, a.name AS account_name,
      jl.debit::text AS debit, jl.credit::text AS credit,
      CASE WHEN a.name ILIKE '%deferred%' OR a.name ILIKE '%unearned%' THEN 'deferred_revenue'
           WHEN a.detail_type = 'fixed_asset' THEN 'fixed_asset'
           ELSE 'prepaid' END AS suggested_kind
    FROM journal_lines jl
    JOIN transactions t ON t.id = jl.transaction_id AND t.status = 'posted' AND t.txn_type <> 'journal_entry'
    JOIN accounts a ON a.id = jl.account_id
    LEFT JOIN contacts c ON c.id = t.contact_id
    WHERE jl.tenant_id = ${tenantId} ${companyCond}
      AND t.txn_date >= ${ps}::date AND t.txn_date < ${pe}::date
      AND (
        (COALESCE(jl.debit,0) > 0 AND (a.name ILIKE '%prepaid%' OR a.detail_type = 'fixed_asset'))
        OR (COALESCE(jl.credit,0) > 0 AND (a.name ILIKE '%deferred%' OR a.name ILIKE '%unearned%'))
      )
      AND NOT EXISTS (SELECT 1 FROM accrual_schedules s WHERE s.tenant_id = ${tenantId} AND s.source_transaction_id = t.id)
    ORDER BY GREATEST(COALESCE(jl.debit,0), COALESCE(jl.credit,0)) DESC
    LIMIT 100
  `);

  // Large expenses whose memo or payee suggests a term purchase that may
  // belong on the balance sheet (annual insurance, a yearly subscription).
  const possiblePrepaids = await db.execute(sql`
    SELECT t.id AS transaction_id, t.txn_date, t.memo, t.total::text AS total, c.display_name AS payee,
      a.id AS account_id, a.name AS account_name
    FROM transactions t
    JOIN journal_lines jl ON jl.transaction_id = t.id AND COALESCE(jl.debit,0) > 0
    JOIN accounts a ON a.id = jl.account_id AND a.account_type IN ('expense', 'other_expense')
    LEFT JOIN contacts c ON c.id = t.contact_id
    WHERE t.tenant_id = ${tenantId} ${companyCond}
      AND t.status = 'posted'
      AND t.txn_date >= ${ps}::date AND t.txn_date < ${pe}::date
      AND t.total >= ${minAmount}
      AND (COALESCE(t.memo,'') ~* ${PREPAID_WORDS} OR COALESCE(c.display_name,'') ~* ${PREPAID_WORDS} OR a.name ~* '(insurance|subscription|software|license)')
      AND NOT EXISTS (SELECT 1 FROM accrual_schedules s WHERE s.tenant_id = ${tenantId} AND s.source_transaction_id = t.id)
    ORDER BY t.total DESC
    LIMIT 50
  `);

  // Vendors billed in at least 3 of the 4 prior months with nothing this
  // month: a missing bill may need an accrued expense.
  const missingRecurring = await db.execute(sql`
    WITH hist AS (
      SELECT t.contact_id, COUNT(DISTINCT date_trunc('month', t.txn_date)) AS months,
        AVG(t.total)::numeric(19,2)::text AS avg_amount
      FROM transactions t
      WHERE t.tenant_id = ${tenantId} ${companyCond}
        AND t.status = 'posted' AND t.contact_id IS NOT NULL
        AND t.txn_type IN ('expense', 'bill', 'check')
        AND t.txn_date >= (${ps}::date - INTERVAL '4 months') AND t.txn_date < ${ps}::date
      GROUP BY t.contact_id
      HAVING COUNT(DISTINCT date_trunc('month', t.txn_date)) >= 3
    )
    SELECT h.contact_id, c.display_name AS payee, h.months::int AS months, h.avg_amount
    FROM hist h
    JOIN contacts c ON c.id = h.contact_id
    WHERE NOT EXISTS (
      SELECT 1 FROM transactions t2
      WHERE t2.tenant_id = ${tenantId} AND t2.contact_id = h.contact_id AND t2.status = 'posted'
        AND t2.txn_date >= ${ps}::date AND t2.txn_date < ${pe}::date
    )
    ORDER BY h.avg_amount::numeric DESC
    LIMIT 50
  `);

  return {
    unscheduled: unscheduled.rows,
    possiblePrepaids: possiblePrepaids.rows,
    missingRecurring: missingRecurring.rows,
  };
}

// ── Tie-out ────────────────────────────────────────────────────────────

/**
 * Per balance account used by schedules: the ledger balance at month end vs
 * what the schedules say should still be there. A difference means an
 * unscheduled item, a missed posting, or a schedule that needs fixing.
 */
export async function tieOut(tenantId: string, companyId: string | null, periodEnd: string) {
  const pe = periodEnd.slice(0, 10);
  const rows = await db.execute(sql`
    WITH sched AS (
      SELECT s.balance_account_id, s.kind,
        SUM(s.total_amount) FILTER (WHERE s.start_date < ${pe}::date AND s.status <> 'cancelled') AS scheduled_total,
        SUM((SELECT COALESCE(SUM(e.amount), 0) FROM accrual_entries e
             WHERE e.schedule_id = s.id AND e.status = 'posted' AND e.post_period < ${pe}::date)) AS recognized
      FROM accrual_schedules s
      WHERE s.tenant_id = ${tenantId}
        ${companyId ? sql`AND (s.company_id = ${companyId} OR s.company_id IS NULL)` : sql``}
      GROUP BY s.balance_account_id, s.kind
    )
    SELECT a.id AS account_id, a.name AS account_name, a.account_type, sc.kind,
      COALESCE(sc.scheduled_total, 0)::text AS scheduled_total,
      COALESCE(sc.recognized, 0)::text AS recognized,
      (SELECT COALESCE(SUM(COALESCE(jl.debit,0) - COALESCE(jl.credit,0)), 0)
         FROM journal_lines jl JOIN transactions t ON t.id = jl.transaction_id AND t.status = 'posted'
         WHERE jl.account_id = a.id AND jl.tenant_id = ${tenantId} AND t.txn_date < ${pe}::date)::text AS ledger_net
    FROM sched sc JOIN accounts a ON a.id = sc.balance_account_id
    ORDER BY a.name
  `);
  return (rows.rows as Array<{ account_id: string; account_name: string; account_type: string; kind: string; scheduled_total: string; recognized: string; ledger_net: string }>)
    .map((r) => {
      // Asset-side schedules (prepaid) carry a debit balance; liability-side
      // (deferred revenue, accrued expense, accumulated depreciation) a credit.
      const ledgerBalance = r.kind === 'prepaid' ? Number(r.ledger_net) : -Number(r.ledger_net);
      const expected = r.kind === 'accrued_expense' || r.kind === 'fixed_asset'
        ? Number(r.recognized)
        : Number(r.scheduled_total) - Number(r.recognized);
      return {
        accountId: r.account_id,
        accountName: r.account_name,
        kind: r.kind,
        ledgerBalance: ledgerBalance.toFixed(2),
        scheduleBalance: expected.toFixed(2),
        difference: (ledgerBalance - expected).toFixed(2),
      };
    });
}

// ── CSV import ─────────────────────────────────────────────────────────

/**
 * Import existing schedules taken over from another system. Columns:
 * kind, description, balance account number, recognition account number,
 * start month (YYYY-MM or YYYY-MM-DD), remaining amount, remaining months,
 * method (optional). The remaining amount is spread from the start month.
 */
export async function importCsv(tenantId: string, companyId: string | null, csv: string, userId?: string) {
  const lines = csv.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) throw AppError.badRequest('The file has no rows.');
  const split = (l: string) => l.match(/("([^"]|"")*"|[^,]*)(,|$)/g)!.map((c) => c.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"').trim()).slice(0, -1);
  const acctRows = await db.select({ id: accounts.id, number: accounts.accountNumber }).from(accounts).where(eq(accounts.tenantId, tenantId));
  const byNumber = new Map(acctRows.filter((a) => a.number).map((a) => [String(a.number), a.id]));
  const created: string[] = [];
  const errors: Array<{ row: number; error: string }> = [];
  // A header row is optional: skip the first line only when its first cell
  // is not a schedule kind.
  const KINDS = ['prepaid', 'deferred_revenue', 'accrued_expense', 'fixed_asset'];
  const firstRow = KINDS.includes((split(lines[0]!)[0] ?? '').toLowerCase()) ? 0 : 1;
  if (firstRow >= lines.length) throw AppError.badRequest('The file has no rows.');
  for (let i = firstRow; i < lines.length; i++) {
    const [kind, description, balNo, recNo, start, amount, months, method] = split(lines[i]!);
    try {
      if (!['prepaid', 'deferred_revenue', 'accrued_expense', 'fixed_asset'].includes(kind ?? '')) throw new Error(`Unknown kind "${kind}"`);
      const bal = byNumber.get(balNo ?? ''); const rec = byNumber.get(recNo ?? '');
      if (!bal || !rec) throw new Error('Account number not found');
      const startDate = /^\d{4}-\d{2}$/.test(start ?? '') ? `${start}-01` : (start ?? '');
      const s = await createSchedule(tenantId, {
        companyId, kind: kind as AccrualKind, description: description ?? '', balanceAccountId: bal, recognitionAccountId: rec,
        totalAmount: String(Number((amount ?? '').replace(/[$,]/g, ''))), startDate, months: Number(months),
        method: (method && ['full_month', 'mid_month', 'actual_days'].includes(method) ? method : 'full_month') as AccrualMethod,
      }, userId);
      created.push(s.id);
    } catch (e) {
      errors.push({ row: i + 1, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { created: created.length, errors };
}
