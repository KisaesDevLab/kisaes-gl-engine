// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { eq, and, sql, getTableColumns } from 'drizzle-orm';
import { nextRecurrenceDate } from '@kis-books/shared';
import DecimalLib from 'decimal.js';
const Decimal = DecimalLib.default || DecimalLib;
import { db } from '../db/index.js';
import { recurringSchedules, accounts, templateTransactions } from '../db/schema/index.js';
import { templateForSchedule } from './templates/templates.service.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import * as ledger from './ledger.service.js';
import * as billService from './bill.service.js';
import * as invoiceService from './invoice.service.js';
import { incCounter, recordSchedulerTick } from '../utils/metrics.js';
import { log } from '../utils/logger.js';
import { withSchedulerLock } from '../utils/scheduler-lock.js';

/**
 * Next date after `current` (U-63: shared nextRecurrenceDate). Monthly,
 * quarterly and annual cadences count from `anchor` (default `current`) and
 * clamp to the month's last day: Jan 31 -> Feb 28 -> Mar 31.
 */
export function calculateNextOccurrence(current: string, frequency: string, interval: number, anchor?: string | null): string {
  return nextRecurrenceDate(current, frequency, interval, anchor ?? current);
}

/**
 * A schedule made from a posted transaction (web "Make recurring", API v2).
 * Since 0225 every schedule posts a template: the transaction is snapshotted
 * into one (a draft when it reads as a check, expense, deposit, transfer or
 * journal entry, else 'legacy'), then the schedule is created for it. The
 * response row is the schedule plus templateId and templateName.
 */
export async function create(tenantId: string, templateTransactionId: string, schedule: {
  frequency: string; intervalValue?: number; mode?: string; startDate: string; endDate?: string | null; name?: string | null;
}, userId?: string) {
  const sched = await db.transaction(async (tx) => {
    const tpl = await templateForSchedule(tx, tenantId, templateTransactionId, schedule.name ?? null, userId);
    const [row] = await tx.insert(recurringSchedules).values({
      tenantId,
      companyId: tpl.companyId,
      name: schedule.name?.trim() || null,
      templateTransactionId,
      templateId: tpl.id,
      frequency: schedule.frequency,
      intervalValue: schedule.intervalValue || 1,
      mode: schedule.mode || 'auto',
      startDate: schedule.startDate,
      endDate: schedule.endDate || null,
      nextOccurrence: schedule.startDate,
      isActive: true,
    }).returning();
    return row ? { ...row, templateName: tpl.name } : undefined;
  });

  if (sched) await auditLog(tenantId, 'create', 'recurring_schedule', sched.id, null, sched, userId);
  return sched;
}

export const RECURRING_SORT_KEYS = ['name', 'frequency', 'mode', 'nextOccurrence', 'lastPostedAt', 'status'] as const;
export type RecurringSortKey = (typeof RECURRING_SORT_KEYS)[number];

// Status is derived (archived_at → archived, is_active → active, else
// paused); sort it in that display order so the header matches the badge.
function recurringOrderExpr(key: RecurringSortKey) {
  switch (key) {
    case 'name': return sql`LOWER(COALESCE(${recurringSchedules.name}, ''))`;
    case 'frequency': return sql`${recurringSchedules.frequency}`;
    case 'mode': return sql`${recurringSchedules.mode}`;
    case 'lastPostedAt': return sql`${recurringSchedules.lastPostedAt}`;
    case 'status': return sql`CASE WHEN ${recurringSchedules.archivedAt} IS NOT NULL THEN 2 WHEN ${recurringSchedules.isActive} THEN 0 ELSE 1 END`;
    case 'nextOccurrence':
    default: return sql`${recurringSchedules.nextOccurrence}`;
  }
}

export async function list(tenantId: string, opts: {
  limit?: number; offset?: number;
  // Server-side column sort — the list paginates, so the page must be cut
  // from the sorted set. Default: next occurrence ascending (the schedule).
  sortBy?: RecurringSortKey; sortDir?: 'asc' | 'desc';
} = {}) {
  // Cap the result set to avoid shipping an unbounded list to the UI. 500 is
  // well past what any real bookkeeper has; the few operators who cross it
  // can paginate with `offset` or filter via scheduling-frequency.
  // Return ALL statuses (active, paused, archived) so the UI can filter/sort
  // them — paused plans were previously invisible. The scheduler uses its own
  // isActive query (processAllDue), so this only affects the management list.
  const where = eq(recurringSchedules.tenantId, tenantId);
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);

  const dir = (opts.sortDir ?? 'asc') === 'asc' ? sql`ASC` : sql`DESC`;
  // templateName (0225): the template the schedule posts — the only label a
  // desktop-made schedule (templateTransactionId NULL) has.
  const data = await db.select({ ...getTableColumns(recurringSchedules), templateName: templateTransactions.name })
    .from(recurringSchedules)
    .leftJoin(templateTransactions, and(
      eq(templateTransactions.id, recurringSchedules.templateId),
      eq(templateTransactions.tenantId, recurringSchedules.tenantId),
    ))
    .where(where)
    .orderBy(
      sql`${recurringOrderExpr(opts.sortBy ?? 'nextOccurrence')} ${dir} NULLS LAST`,
      sql`${recurringSchedules.nextOccurrence} ASC`,
      sql`${recurringSchedules.id} ASC`,
    )
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

/**
 * Edit a schedule. `expectedUpdatedAt` (U-66, recurring-guard-v1) is the
 * updatedAt the caller last read: when given, the update applies only if
 * the stored updated_at still equals it (to the millisecond, as JSON carries
 * it), else 409 STALE_SCHEDULE and nothing changes. Checked in the UPDATE
 * itself, so two concurrent edits can't both pass.
 */
export async function update(tenantId: string, id: string, input: {
  name?: string | null; frequency?: string; intervalValue?: number; mode?: string;
  startDate?: string; endDate?: string | null;
  expectedUpdatedAt?: string;
}, userId?: string) {
  // One database transaction: the row is read FOR UPDATE, so the audit
  // "before" image is the row the guarded UPDATE replaces.
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(recurringSchedules)
      .where(and(eq(recurringSchedules.tenantId, tenantId), eq(recurringSchedules.id, id)))
      .for('update')
      .limit(1);
    if (!before) throw AppError.notFound('Recurring schedule not found');
    // Explicit field pick — never spread the caller's object into .set(), so
    // no route can smuggle tenantId/companyId/nextOccurrence/isActive through.
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (input.frequency !== undefined) patch['frequency'] = input.frequency;
    if (input.intervalValue !== undefined) patch['intervalValue'] = input.intervalValue;
    if (input.mode !== undefined) patch['mode'] = input.mode;
    if (input.startDate !== undefined) patch['startDate'] = input.startDate;
    if (input.endDate !== undefined) patch['endDate'] = input.endDate;
    if (input.name !== undefined) patch['name'] = (typeof input.name === 'string' && input.name.trim()) || null;
    // Moving the start date before anything has posted drags nextOccurrence with
    // it (otherwise the next run would still fire on the old start date).
    if (input.startDate && !before.lastPostedAt) patch['nextOccurrence'] = input.startDate;
    const conds = [eq(recurringSchedules.tenantId, tenantId), eq(recurringSchedules.id, id)];
    if (input.expectedUpdatedAt !== undefined) {
      conds.push(sql`date_trunc('milliseconds', ${recurringSchedules.updatedAt}) = ${input.expectedUpdatedAt}::timestamptz`);
    }
    const [updated] = await tx.update(recurringSchedules)
      .set(patch)
      .where(and(...conds))
      .returning();
    if (!updated && input.expectedUpdatedAt !== undefined) {
      throw AppError.conflict(
        'This recurring schedule was changed by someone else since you opened it. Reload it and make your change again.',
        'STALE_SCHEDULE',
        { updatedAt: before.updatedAt },
      );
    }
    if (!updated) throw AppError.notFound('Recurring schedule not found');
    // Whoever changes the schedule (mode, cadence) owns its auto runs: they
    // post only while this user holds the kind's permission (templates/permissions.ts).
    if (userId && updated.templateId) {
      await tx.update(templateTransactions).set({ updatedBy: userId })
        .where(and(eq(templateTransactions.tenantId, tenantId), eq(templateTransactions.id, updated.templateId)));
    }
    await auditLog(tenantId, 'update', 'recurring_schedule', updated.id, before, updated, userId, tx);
    return updated;
  });
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

/**
 * The pre-0225 clone path, kept for 'legacy' templates whose source
 * transaction templates can't hold (invoice, bill, cash sale...): reads the
 * source transaction and posts a copy dated `sched.nextOccurrence` through
 * the type's own service. It posts in its own transaction(s); the runner
 * (templates/occurrences.service.ts) claims the occurrence before and
 * records it after, so a crash in between shows as NEEDS_CHECK instead of
 * being lost or posted twice.
 */
export async function postLegacyClone(
  tenantId: string,
  sched: { id: string; templateTransactionId: string; nextOccurrence: string },
) {
  let txn;
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
    // Exact decimal (U-64): the template's stored amount, all 4 places.
    const expenseLines = template.lines
      .filter((l) => new Decimal(l.debit || '0').greaterThan(0) && (!apAccount || l.accountId !== apAccount.id))
      .map((l) => ({
        accountId: l.accountId,
        amount: new Decimal(l.debit).toFixed(4),
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
      // A custom-terms discount comes along (U-86); fixed codes carry theirs.
      ...(template.paymentTerms === 'custom' && template.discountPercent && template.discountDays != null
        ? { discountPercent: template.discountPercent, discountDays: template.discountDays }
        : {}),
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
      .filter((l) => new Decimal(l.credit || '0').greaterThan(0)
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
      // U-64: the line's name, and its billable mark — a new occurrence's
      // billable line starts 'unbilled' (ledger billableColumns).
      contactId: l.contactId ?? null,
      isBillable: l.isBillable === true,
    }));

    txn = await ledger.postTransaction(tenantId, {
      txnType: template.txnType as any,
      txnDate: sched.nextOccurrence,
      contactId: template.contactId || undefined,
      memo: template.memo || undefined,
      total: template.total || undefined,
      // A journal entry's reporting basis and adjusting flag carry over.
      basis: (template.basis as 'cash' | 'accrual' | 'both' | null) ?? 'both',
      isAdjusting: template.isAdjusting === true,
      // U-64: provenance — which schedule posted it.
      recurringScheduleId: sched.id,
      source: 'recurring',
      sourceId: sched.id,
      lines,
    }, undefined, template.companyId || undefined);
  }

  return txn;
}

/**
 * Post the schedule's next occurrence now (web "Post now", API v2, MCP,
 * bank-feed match-apply). Same function as the catch-up runner, so the
 * occurrence is claimed, posted and advanced exactly once (U-63).
 */
export async function postNext(tenantId: string, scheduleId: string) {
  const sched = await getById(tenantId, scheduleId);
  const { postScheduleNow } = await import('./templates/occurrences.service.js');
  return postScheduleNow(tenantId, sched);
}

/**
 * Server hourly tick: the catch-up run (runDue) for every tenant and company
 * with an auto schedule due today — the same idempotent function the
 * desktop app calls through POST /recurring/run-due (U-63).
 */
export async function processAllDue() {
  const { processAllDueSchedules } = await import('./templates/occurrences.service.js');
  return processAllDueSchedules();
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

/**
 * Hourly session prune without the recurring tick (desktop: the app drives
 * the recurring run through POST /recurring/run-due, U-63).
 */
export function startSessionPruneScheduler(): void {
  const runPrune = async () => {
    try {
      const prune = await withSchedulerLock('session-prune', pruneExpiredSessions);
      if (prune && prune.pruned > 0) {
        log.info({ component: 'session-prune', event: 'pruned', count: prune.pruned });
        incCounter('session_prune_total', 'Total expired sessions pruned', undefined, prune.pruned);
      }
    } catch (err: unknown) {
      log.error({ component: 'session-prune', event: 'cycle_error', message: err instanceof Error ? err.message : String(err) });
    }
  };
  setTimeout(() => { void runPrune(); }, RECURRING_INITIAL_DELAY_MS).unref();
  setInterval(() => { void runPrune(); }, RECURRING_CHECK_INTERVAL_MS).unref();
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
