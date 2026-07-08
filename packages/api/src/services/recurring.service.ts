// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { eq, and, lte, sql } from 'drizzle-orm';
import DecimalLib from 'decimal.js';
const Decimal = DecimalLib.default || DecimalLib;
import { db } from '../db/index.js';
import { recurringSchedules, transactions, journalLines, accounts } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import * as ledger from './ledger.service.js';
import * as billService from './bill.service.js';
import * as invoiceService from './invoice.service.js';
import { incCounter, recordSchedulerTick } from '../utils/metrics.js';
import { log } from '../utils/logger.js';
import { withSchedulerLock } from '../utils/scheduler-lock.js';

export function calculateNextOccurrence(current: string, frequency: string, interval: number): string {
  // Date arithmetic uses UTC getters/setters so the schedule advances by
  // calendar days/months in UTC regardless of the container's local TZ.
  // Without this, a container in non-UTC TZ would drift schedules by up
  // to 24h every time it crossed a DST boundary or a tenant in a
  // different TZ rolled the date.
  const d = new Date(current);
  switch (frequency) {
    case 'daily': d.setUTCDate(d.getUTCDate() + interval); break;
    case 'weekly': d.setUTCDate(d.getUTCDate() + 7 * interval); break;
    // Bi-weekly = every two weeks. `interval` still multiplies (interval 2 =
    // every 4 weeks) so it composes like the other cadences.
    case 'biweekly': d.setUTCDate(d.getUTCDate() + 14 * interval); break;
    // Semi-monthly = twice a month on the 1st and the 15th (the standard
    // interpretation). It ignores `interval` — it's inherently twice monthly.
    // From any date: on/after the 15th → the 1st of next month; otherwise the
    // 15th of the current month. Using the 1st/15th anchors keeps every date
    // valid (no month-length overflow) and converges after the first posting,
    // which always lands on the user-chosen start date.
    case 'semimonthly':
      if (d.getUTCDate() >= 15) d.setUTCMonth(d.getUTCMonth() + 1, 1);
      else d.setUTCDate(15);
      break;
    case 'monthly': d.setUTCMonth(d.getUTCMonth() + interval); break;
    case 'quarterly': d.setUTCMonth(d.getUTCMonth() + 3 * interval); break;
    case 'annually': d.setUTCFullYear(d.getUTCFullYear() + interval); break;
    default: d.setUTCMonth(d.getUTCMonth() + interval);
  }
  return d.toISOString().split('T')[0]!;
}

export async function create(tenantId: string, templateTransactionId: string, schedule: {
  frequency: string; intervalValue?: number; mode?: string; startDate: string; endDate?: string; name?: string;
}, userId?: string) {
  const [sched] = await db.insert(recurringSchedules).values({
    tenantId,
    name: schedule.name?.trim() || null,
    templateTransactionId,
    frequency: schedule.frequency,
    intervalValue: schedule.intervalValue || 1,
    mode: schedule.mode || 'auto',
    startDate: schedule.startDate,
    endDate: schedule.endDate || null,
    nextOccurrence: schedule.startDate,
    isActive: true,
  }).returning();

  if (sched) await auditLog(tenantId, 'create', 'recurring_schedule', sched.id, null, sched, userId);
  return sched;
}

export async function list(tenantId: string, opts: { limit?: number; offset?: number } = {}) {
  // Cap the result set to avoid shipping an unbounded list to the UI. 500 is
  // well past what any real bookkeeper has; the few operators who cross it
  // can paginate with `offset` or filter via scheduling-frequency.
  // Return ALL statuses (active, paused, archived) so the UI can filter/sort
  // them — paused plans were previously invisible. The scheduler uses its own
  // isActive query (processAllDue), so this only affects the management list.
  const where = eq(recurringSchedules.tenantId, tenantId);
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);

  const data = await db.select().from(recurringSchedules).where(where)
    .orderBy(recurringSchedules.nextOccurrence)
    .limit(limit).offset(offset);

  const totalRows = await db.select({ total: sql<number>`COUNT(*)::int` })
    .from(recurringSchedules).where(where);
  return { data, total: totalRows[0]?.total ?? 0, limit, offset };
}

export async function getById(tenantId: string, id: string) {
  const sched = await db.query.recurringSchedules.findFirst({
    where: and(eq(recurringSchedules.tenantId, tenantId), eq(recurringSchedules.id, id)),
  });
  if (!sched) throw AppError.notFound('Recurring schedule not found');
  return sched;
}

export async function update(tenantId: string, id: string, input: {
  name?: string | null; frequency?: string; intervalValue?: number; mode?: string;
  startDate?: string; endDate?: string | null;
}, userId?: string) {
  const before = await db.query.recurringSchedules.findFirst({
    where: and(eq(recurringSchedules.tenantId, tenantId), eq(recurringSchedules.id, id)),
  });
  if (!before) throw AppError.notFound('Recurring schedule not found');
  const patch: Record<string, unknown> = { ...input, updatedAt: new Date() };
  if (input.name !== undefined) patch['name'] = (typeof input.name === 'string' && input.name.trim()) || null;
  // Moving the start date before anything has posted drags nextOccurrence with
  // it (otherwise the next run would still fire on the old start date).
  if (input.startDate && !before.lastPostedAt) patch['nextOccurrence'] = input.startDate;
  const [updated] = await db.update(recurringSchedules)
    .set(patch)
    .where(and(eq(recurringSchedules.tenantId, tenantId), eq(recurringSchedules.id, id)))
    .returning();
  if (!updated) throw AppError.notFound('Recurring schedule not found');
  await auditLog(tenantId, 'update', 'recurring_schedule', updated.id, before ?? null, updated, userId);
  return updated;
}

export async function deactivate(tenantId: string, id: string, userId?: string) {
  const before = await db.query.recurringSchedules.findFirst({
    where: and(eq(recurringSchedules.tenantId, tenantId), eq(recurringSchedules.id, id)),
  });
  await db.update(recurringSchedules)
    .set({ isActive: false, updatedAt: new Date() })
    .where(and(eq(recurringSchedules.tenantId, tenantId), eq(recurringSchedules.id, id)));
  if (before) {
    await auditLog(tenantId, 'update', 'recurring_schedule', id, before, { ...before, isActive: false }, userId);
  }
}

// Archive a PAUSED plan (hide from the active list without deleting it). Only a
// paused (is_active=false) plan may be archived — active plans must be stopped
// first, mirroring how the UI gates the action.
export async function archive(tenantId: string, id: string, userId?: string) {
  const before = await getById(tenantId, id);
  if (before.isActive) throw AppError.badRequest('Stop (pause) the plan before archiving it.');
  const [updated] = await db.update(recurringSchedules)
    .set({ archivedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(recurringSchedules.tenantId, tenantId), eq(recurringSchedules.id, id)))
    .returning();
  await auditLog(tenantId, 'update', 'recurring_schedule', id, before, updated ?? null, userId);
  return updated;
}

export async function unarchive(tenantId: string, id: string, userId?: string) {
  const before = await getById(tenantId, id);
  const [updated] = await db.update(recurringSchedules)
    .set({ archivedAt: null, updatedAt: new Date() })
    .where(and(eq(recurringSchedules.tenantId, tenantId), eq(recurringSchedules.id, id)))
    .returning();
  await auditLog(tenantId, 'update', 'recurring_schedule', id, before, updated ?? null, userId);
  return updated;
}

export async function postNext(tenantId: string, scheduleId: string) {
  const sched = await getById(tenantId, scheduleId);
  const claimedOccurrence = sched.nextOccurrence;
  const nextOcc = calculateNextOccurrence(sched.nextOccurrence, sched.frequency, sched.intervalValue ?? 1);
  const isExpired = sched.endDate && new Date(nextOcc) > new Date(sched.endDate);

  // Claim this occurrence atomically. The UPDATE only succeeds if the
  // schedule is still on the occurrence we read above — if another
  // worker (or a manual trigger racing with the scheduler) already
  // advanced it, our UPDATE affects zero rows and we bail without
  // posting a duplicate transaction. This is the conditional-UPDATE
  // claim pattern from the prior audit, applied to recurring jobs.
  //
  // We update next_occurrence and last_posted_at here BEFORE posting
  // the ledger transaction, so any failure to post leaves the schedule
  // slightly ahead of where it "should" be — the user can manually
  // back it up or skip the occurrence. That's less bad than the
  // alternative, which is double-posting after a retry.
  const [claimed] = await db.update(recurringSchedules)
    .set({
      nextOccurrence: nextOcc,
      lastPostedAt: new Date(),
      isActive: !isExpired,
      updatedAt: new Date(),
    })
    .where(and(
      eq(recurringSchedules.tenantId, tenantId),
      eq(recurringSchedules.id, scheduleId),
      eq(recurringSchedules.nextOccurrence, claimedOccurrence),
      eq(recurringSchedules.isActive, true),
    ))
    .returning();

  if (!claimed) {
    // Another worker already advanced this schedule, or it was deactivated.
    throw AppError.conflict(
      `Recurring schedule ${scheduleId} is not on occurrence ${claimedOccurrence} ` +
      `(either already posted by another worker, or deactivated).`,
      'RECURRING_ALREADY_CLAIMED',
    );
  }

  let txn;
  try {
  // Get template transaction
  const template = await ledger.getTransaction(tenantId, sched.templateTransactionId);

  if (template.txnType === 'bill') {
    // Bills need bill-specific fields (bill_status, due_date, balance_due,
    // bill number) — route through bill.service.createBill so all those
    // fields get set correctly. Reconstruct the bill input from the
    // template's expense lines (the debit side; the credit line is AP).
    const apAccount = await db.query.accounts.findFirst({
      where: and(eq(accounts.tenantId, tenantId), eq(accounts.systemTag, 'accounts_payable')),
    });
    const expenseLines = template.lines
      .filter((l) => parseFloat(l.debit) > 0 && (!apAccount || l.accountId !== apAccount.id))
      .map((l) => ({
        accountId: l.accountId,
        amount: parseFloat(l.debit).toFixed(2),
        description: l.description || undefined,
        // ADR 0XX §7.2 — carry the template line's tag onto each
        // generated instance so segment-scoped recurrences keep their
        // tag trail intact.
        tagId: l.tagId ?? null,
      }));

    if (expenseLines.length === 0) {
      throw AppError.internal('Recurring bill template has no expense lines');
    }

    txn = await billService.createBill(tenantId, {
      contactId: template.contactId || '',
      txnDate: sched.nextOccurrence,
      paymentTerms: template.paymentTerms || undefined,
      termsDays: template.termsDays ?? undefined,
      vendorInvoiceNumber: template.vendorInvoiceNumber || undefined,
      memo: template.memo || undefined,
      lines: expenseLines,
    }, undefined, template.companyId || undefined);
  } else if (template.txnType === 'invoice') {
    // Invoices need a real invoice document (number, status, due date, balance
    // due, line items) — route through invoice.service.createInvoice so each
    // occurrence is a first-class, sendable/collectible invoice, not just GL
    // lines. Reconstruct the line items from the template's REVENUE lines (the
    // credit side, excluding the A/R and Sales-Tax-Payable system postings);
    // createInvoice recomputes tax + AR and assigns a fresh number/due date.
    const [arAccount, taxAccount] = await Promise.all([
      db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.systemTag, 'accounts_receivable')) }),
      db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.systemTag, 'sales_tax_payable')) }),
    ]);
    const revenueLines = template.lines
      .filter((l) => parseFloat(l.credit) > 0
        && l.accountId !== arAccount?.id
        && l.accountId !== taxAccount?.id)
      .map((l) => {
        // Preserve quantity when present and derive unitPrice so qty*price ==
        // the original line total exactly; otherwise fall back to qty 1 @ total.
        const credit = new Decimal(l.credit);
        const qty = l.quantity && new Decimal(l.quantity).greaterThan(0) ? new Decimal(l.quantity) : null;
        return {
          accountId: l.accountId,
          description: l.description || undefined,
          quantity: qty ? l.quantity! : '1',
          unitPrice: qty ? credit.div(qty).toFixed(4) : credit.toFixed(4),
          isTaxable: l.isTaxable ?? false,
          taxRate: l.taxRate ?? '0',
          tagId: l.tagId ?? null,
        };
      });

    if (revenueLines.length === 0) {
      throw AppError.internal('Recurring invoice template has no revenue lines');
    }

    txn = await invoiceService.createInvoice(tenantId, {
      contactId: template.contactId || '',
      txnDate: sched.nextOccurrence,
      paymentTerms: template.paymentTerms || undefined,
      memo: template.memo || undefined,
      lines: revenueLines,
    }, undefined, template.companyId || undefined);
  } else {
    // Generic clone path for other transaction types.
    const lines = template.lines.map((l) => ({
      accountId: l.accountId,
      debit: l.debit,
      credit: l.credit,
      description: l.description || undefined,
      // ADR 0XX §7.2 — preserve per-line tag on every recurring instance.
      tagId: l.tagId ?? null,
    }));

    txn = await ledger.postTransaction(tenantId, {
      txnType: template.txnType as any,
      txnDate: sched.nextOccurrence,
      contactId: template.contactId || undefined,
      memo: template.memo || undefined,
      total: template.total || undefined,
      lines,
    }, undefined, template.companyId || undefined);
  }

  } catch (err) {
    // The claim advanced next_occurrence BEFORE posting (double-post
    // protection). If the post then fails — most commonly a lock date
    // covering the occurrence — the occurrence used to be silently lost
    // forever. Since nothing was posted, roll the claim back (guarded on
    // next_occurrence still being our advanced value so we never stomp a
    // concurrent manual fix) and rethrow; the next scheduler cycle
    // retries, and the failure stays visible in processAllDue's log.
    try {
      await db.update(recurringSchedules)
        .set({ nextOccurrence: claimedOccurrence, isActive: true, updatedAt: new Date() })
        .where(and(
          eq(recurringSchedules.tenantId, tenantId),
          eq(recurringSchedules.id, scheduleId),
          eq(recurringSchedules.nextOccurrence, nextOcc),
        ));
    } catch (revertErr) {
      console.error(`[Recurring] Failed to roll back claim for schedule ${scheduleId}:`, revertErr);
    }
    throw err;
  }

  // Schedule was already claimed + advanced at the top of this function.
  // `claimed` contains the post-claim row, unused here but referenced
  // so `void` keeps TypeScript quiet about the unused binding.
  void claimed;
  return txn;
}

export async function processAllDue() {
  // Use Postgres CURRENT_DATE rather than a Node-side toISOString() — the
  // API / worker container runs in UTC, but the recurring schedules are
  // compared against txn_date (a DATE column that Postgres treats as a
  // calendar day in the session TZ). CURRENT_DATE stays consistent with
  // however Postgres is configured. Using it avoids the off-by-one that
  // toISOString() introduces near UTC midnight.
  const todayRow = await db.execute(sql`SELECT CURRENT_DATE::text AS today`);
  const today = (todayRow.rows as { today: string }[])[0]?.today ?? new Date().toISOString().split('T')[0]!;

  const dueSchedules = await db.select().from(recurringSchedules)
    .where(and(
      eq(recurringSchedules.isActive, true),
      eq(recurringSchedules.mode, 'auto'),
      lte(recurringSchedules.nextOccurrence, today),
    ));

  let processed = 0;
  for (const sched of dueSchedules) {
    try {
      await postNext(sched.tenantId, sched.id);
      processed++;
    } catch (err) {
      console.error(`[Recurring] Failed to post schedule ${sched.id}:`, err);
    }
  }

  return { processed, total: dueSchedules.length };
}

// In-process scheduler. Auto-mode recurring schedules must post on their
// nextOccurrence date; without this, users set a schedule to auto and the
// transactions silently never land in the ledger. Runs in the api boot
// process alongside backup-scheduler; the worker container stays a no-op
// until the BullMQ infrastructure in Phase 9 replaces this.
const RECURRING_CHECK_INTERVAL_MS = 60 * 60 * 1000; // hourly
const RECURRING_INITIAL_DELAY_MS = 2 * 60 * 1000; // 2 minutes after boot

/**
 * Delete expired session rows. Each login + each refresh inserts a new
 * sessions row; old rows are only cleaned up when a user explicitly logs
 * out or runs through a password reset. Without periodic cleanup the
 * sessions table grows unbounded for the lifetime of the install.
 */
async function pruneExpiredSessions(): Promise<{ pruned: number }> {
  const { sessions } = await import('../db/schema/index.js');
  const result = await db.delete(sessions)
    .where(sql`${sessions.expiresAt} < NOW() - INTERVAL '1 day'`)
    .returning({ id: sessions.id });
  return { pruned: result.length };
}

export function startRecurringScheduler(): void {
  console.log('[Recurring Scheduler] Registered (checks hourly, first check in 2 min)');

  const runCycle = async () => {
    const started = Date.now();
    try {
      // Advisory-lock the cycle so that when multiple API instances run
      // (horizontal scale, or a rolling deploy with a moment of overlap)
      // only one processes the tick. Correctness is already guaranteed by
      // postNext's conditional-UPDATE claim pattern — this just avoids
      // wasting DB scans on every instance.
      const result = await withSchedulerLock('recurring-scheduler', processAllDue);
      if (result && result.processed > 0) {
        log.info({ component: 'recurring-scheduler', event: 'cycle_posted', processed: result.processed, total: result.total });
        incCounter('recurring_posted_total', 'Total recurring transactions posted', undefined, result.processed);
      }

      // Piggyback the session prune on the same hourly tick — cheap to run,
      // keeps the sessions table bounded. Uses its own lock so a slow tick
      // on recurring doesn't block the prune next time around.
      const prune = await withSchedulerLock('session-prune', pruneExpiredSessions);
      if (prune && prune.pruned > 0) {
        log.info({ component: 'session-prune', event: 'pruned', count: prune.pruned });
        incCounter('session_prune_total', 'Total expired sessions pruned', undefined, prune.pruned);
      }
      recordSchedulerTick('recurring', Date.now() - started, 'ok');
    } catch (err: any) {
      log.error({ component: 'recurring-scheduler', event: 'cycle_error', message: err.message });
      recordSchedulerTick('recurring', Date.now() - started, 'error');
    }
  };

  setTimeout(() => { runCycle(); }, RECURRING_INITIAL_DELAY_MS);
  setInterval(() => { runCycle(); }, RECURRING_CHECK_INTERVAL_MS);
}
