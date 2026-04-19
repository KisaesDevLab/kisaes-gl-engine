// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { eq, and, lte, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { recurringSchedules, transactions, journalLines, accounts } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import * as ledger from './ledger.service.js';
import * as billService from './bill.service.js';

function calculateNextOccurrence(current: string, frequency: string, interval: number): string {
  const d = new Date(current);
  switch (frequency) {
    case 'daily': d.setDate(d.getDate() + interval); break;
    case 'weekly': d.setDate(d.getDate() + 7 * interval); break;
    case 'monthly': d.setMonth(d.getMonth() + interval); break;
    case 'quarterly': d.setMonth(d.getMonth() + 3 * interval); break;
    case 'annually': d.setFullYear(d.getFullYear() + interval); break;
    default: d.setMonth(d.getMonth() + interval);
  }
  return d.toISOString().split('T')[0]!;
}

export async function create(tenantId: string, templateTransactionId: string, schedule: {
  frequency: string; intervalValue?: number; mode?: string; startDate: string; endDate?: string;
}) {
  const [sched] = await db.insert(recurringSchedules).values({
    tenantId,
    templateTransactionId,
    frequency: schedule.frequency,
    intervalValue: schedule.intervalValue || 1,
    mode: schedule.mode || 'auto',
    startDate: schedule.startDate,
    endDate: schedule.endDate || null,
    nextOccurrence: schedule.startDate,
    isActive: true,
  }).returning();

  return sched;
}

export async function list(tenantId: string, limit = 500) {
  // Cap the result set to avoid shipping an unbounded list to the UI. 500 is
  // well past what any real bookkeeper has; the few operators who cross it
  // can filter via scheduling-frequency in a future iteration.
  return db.select().from(recurringSchedules)
    .where(and(eq(recurringSchedules.tenantId, tenantId), eq(recurringSchedules.isActive, true)))
    .orderBy(recurringSchedules.nextOccurrence)
    .limit(limit);
}

export async function getById(tenantId: string, id: string) {
  const sched = await db.query.recurringSchedules.findFirst({
    where: and(eq(recurringSchedules.tenantId, tenantId), eq(recurringSchedules.id, id)),
  });
  if (!sched) throw AppError.notFound('Recurring schedule not found');
  return sched;
}

export async function update(tenantId: string, id: string, input: {
  frequency?: string; intervalValue?: number; mode?: string; endDate?: string | null;
}) {
  const [updated] = await db.update(recurringSchedules)
    .set({ ...input, updatedAt: new Date() })
    .where(and(eq(recurringSchedules.tenantId, tenantId), eq(recurringSchedules.id, id)))
    .returning();
  if (!updated) throw AppError.notFound('Recurring schedule not found');
  return updated;
}

export async function deactivate(tenantId: string, id: string) {
  await db.update(recurringSchedules)
    .set({ isActive: false, updatedAt: new Date() })
    .where(and(eq(recurringSchedules.tenantId, tenantId), eq(recurringSchedules.id, id)));
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

  // Get template transaction
  const template = await ledger.getTransaction(tenantId, sched.templateTransactionId);

  let txn;
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
    try {
      // Advisory-lock the cycle so that when multiple API instances run
      // (horizontal scale, or a rolling deploy with a moment of overlap)
      // only one processes the tick. Correctness is already guaranteed by
      // postNext's conditional-UPDATE claim pattern — this just avoids
      // wasting DB scans on every instance.
      const { withSchedulerLock } = await import('../utils/scheduler-lock.js');
      const result = await withSchedulerLock('recurring-scheduler', processAllDue);
      if (result && result.processed > 0) {
        console.log(`[Recurring Scheduler] Posted ${result.processed}/${result.total} due schedule(s)`);
      }

      // Piggyback the session prune on the same hourly tick — cheap to run,
      // keeps the sessions table bounded. Uses its own lock so a slow tick
      // on recurring doesn't block the prune next time around.
      const prune = await withSchedulerLock('session-prune', pruneExpiredSessions);
      if (prune && prune.pruned > 0) {
        console.log(`[Session Prune] Removed ${prune.pruned} expired session row(s)`);
      }
    } catch (err: any) {
      console.error('[Recurring Scheduler] Cycle error:', err.message);
    }
  };

  setTimeout(() => { runCycle(); }, RECURRING_INITIAL_DELAY_MS);
  setInterval(() => { runCycle(); }, RECURRING_CHECK_INTERVAL_MS);
}
