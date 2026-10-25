// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Template occurrences and the recurring catch-up run (U-63,
 * recurring-run-due-v1; "Enter now", skip and resolve for U-62).
 *
 * Exactly once. An occurrence is a (template, date). For every template
 * kind the runner can replay, ONE database transaction:
 *   1. locks the template row (FOR SHARE) and its schedule row (FOR
 *      UPDATE) — two runners, an edit and a "Post now" serialize here, and
 *      the second re-reads the advanced next date;
 *   2. claims the date: INSERT … ON CONFLICT (template_id, occurrence_date)
 *      DO NOTHING — the unique key is the backstop;
 *   3. checks the closed period (auto never posts on or before the lock
 *      date: no password, no override — runWithoutOverride) and that every
 *      account, name and tag still exists, is active and is in scope;
 *   4. posts the draft through the kind's own create service in a SAVEPOINT
 *      (replay.ts). A 4xx refusal rolls back to the savepoint and the date
 *      is recorded as skipped with a reason; anything else rolls the whole
 *      transaction back (nothing claimed, nothing advanced) and the
 *      template is listed in `failed` and retried by the next run;
 *   5. advances the schedule (next date from the anchor, remaining count,
 *      end date) and writes the audit row;
 *   6. commits. Posted ⇔ claimed ⇔ advanced: a crash anywhere leaves the
 *      occurrence fully undone and the next run posts it once.
 *
 * Lock order everywhere: (run advisory lock) → template → schedule →
 * companies / accounts rows taken by posting.
 *
 * 'legacy' templates whose source transaction templates can't hold
 * (invoice, bill...) still post through the old clone code, which opens
 * its own transactions. Their occurrence is claimed ('claiming') and the
 * schedule advanced in a first transaction, posted, then recorded in a
 * second; a failed post deletes the claim and restores the date. A claim a
 * crash left behind for more than CLAIM_STALE_MINUTES is listed as
 * skipped / NEEDS_CHECK, never silently lost or posted again.
 *
 * Authority (security review H1): an auto run posts only while the
 * template's owner (last editor, else creator) still holds 'recurring' and
 * the kind's write permission (permissions.ts); else the date is skipped
 * with reason PERMISSION. Ownerless pre-0225 templates post as before.
 *
 * Bounds (M2, L5): one run posts or skips at most CATCH_UP_CAP dates per
 * schedule; the rest stay due for the next run and the schedule is listed
 * in `skipped` with reason CATCH_UP_CAPPED (nothing is recorded or lost).
 * Open skipped dates are listed up to SKIPPED_LIST_CAP with a total; due
 * reminders up to REMINDER_SCHEDULES_CAP schedules of REMINDER_COUNT_CAP
 * dates each, with a truncated flag. The server tick handles at most
 * SERVER_TICK_CAP occurrences per tick.
 *
 * Money stays exact (decimal strings from the stored draft into the same
 * builders as a live create). Names, memos and amounts are never logged.
 */

import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { nextRecurrenceDate, type TemplateDraft } from '@kis-books/shared';
import { db, type Tx } from '../../db/index.js';
import {
  accounts, contacts, recurringSchedules, tags, templateOccurrences, templateTransactions, transactions,
} from '../../db/schema/index.js';
import { AppError } from '../../utils/errors.js';
import { auditLog } from '../../middleware/audit.js';
import { log } from '../../utils/logger.js';
import { checkLockDate } from '../ledger.service.js';
import * as ledger from '../ledger.service.js';
import { runWithoutOverride } from '../lock-context.js';
import { postLegacyClone } from '../recurring.service.js';
import { draftRefs, draftTotal } from './draft.js';
import { ownerMayPost, templateResource, type OwnerPermissionCache } from './permissions.js';
import { autoUnsupported, replayDraft } from './replay.js';
import {
  CLAIM_STALE_MINUTES, adoptOrphanSchedules, legacyDraft, lockSchedule, lockTemplate, templateDraft, templateNotFound,
  type ScheduleRow, type TemplateRow,
} from './templates.service.js';

/** Reasons recorded on a skipped occurrence. */
export type SkipReason =
  | 'CLOSED_PERIOD' | 'INVALID_ACCOUNT' | 'INVALID_CONTACT' | 'INVALID_TAG' | 'TEMPLATE_SOURCE_MISSING'
  | 'CHECK_NUMBER' | 'VALIDATION' | 'AUTO_UNSUPPORTED' | 'NEEDS_CHECK' | 'PERMISSION';

/** Test hooks: only honoured when NODE_ENV is 'test' (see testHook). */
export const __testHooks: {
  /** Inside the replay savepoint, after the posting (auto runs only). */
  inReplay?: (info: { templateId: string; date: string }) => void | Promise<void>;
  /** After the replay, outside the savepoint, inside the occurrence transaction. */
  afterReplay?: (info: { templateId: string; date: string }) => void | Promise<void>;
} = {};

export interface Actor {
  tenantId: string;
  /** The request's company; NULL only for tenant-wide legacy templates on the server tick. */
  companyId: string | null;
  userId?: string;
}

/** Called only under NODE_ENV=test, so a stray assignment can't change production runs. */
function testHook(name: keyof typeof __testHooks) {
  return process.env['NODE_ENV'] === 'test' ? __testHooks[name] : undefined;
}

const REMINDER_DATES_CAP = 24;
/** Due dates counted per reminder schedule; `truncated` when reached. */
export const REMINDER_COUNT_CAP = 400;
/** Reminder schedules listed per call; `remindersTruncated` when more are due. */
export const REMINDER_SCHEDULES_CAP = 500;
/** Dates one run posts or skips per schedule; the rest wait for the next run (CATCH_UP_CAPPED). */
export const CATCH_UP_CAP = 31;
/** Open skipped dates listed per response; `skippedTotal` counts them all. */
export const SKIPPED_LIST_CAP = 200;
/** Occurrences the server tick handles per tick across every tenant. */
export const SERVER_TICK_CAP = 5000;

// ── Small helpers ──────────────────────────────────────────────────

function occurrenceTaken(): AppError {
  return AppError.conflict('This date was already entered, skipped or posted.', 'OCCURRENCE_TAKEN');
}

function occurrenceNotDue(): AppError {
  return AppError.badRequest('This date is not the template’s next date or an open skipped date.', 'OCCURRENCE_NOT_DUE');
}

function scheduleLive(s: ScheduleRow | null): s is ScheduleRow {
  return !!s && s.isActive === true && !s.archivedAt;
}

async function currentDate(tx: Tx | typeof db): Promise<{ today: string; tomorrow: string }> {
  const r = await tx.execute(sql`SELECT CURRENT_DATE::text AS today, (CURRENT_DATE + 1)::text AS tomorrow`);
  const row = (r.rows as Array<{ today: string; tomorrow: string }>)[0]!;
  return row;
}

async function runLock(tx: Tx, actor: Actor) {
  // One runner per company at a time: concurrent runs (two app instances,
  // the LAN host and a client, the server tick) post one after the other,
  // so two postings of the same run never wait on each other's rows.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`recurring-run:${actor.tenantId}:${actor.companyId ?? ''}`}, 0))`);
}

/**
 * Moves the schedule past `date` when `date` is its next date: next date
 * from the anchor, one fewer remaining (when `consumed`), inactive once the
 * count reaches 0 or the next date passes the end date.
 */
async function advance(tx: Tx, sched: ScheduleRow, date: string, opts: { consumed: boolean; posted: boolean }) {
  if (sched.nextOccurrence !== date) return null;
  const next = nextRecurrenceDate(date, sched.frequency, sched.intervalValue ?? 1, sched.anchorDate ?? sched.startDate);
  const remaining = sched.remainingCount === null ? null : Math.max(0, sched.remainingCount - (opts.consumed ? 1 : 0));
  const ended = remaining === 0 || (sched.endDate !== null && next > sched.endDate);
  await tx.update(recurringSchedules).set({
    nextOccurrence: next,
    remainingCount: remaining,
    isActive: !ended,
    updatedAt: new Date(),
    ...(opts.posted ? { lastPostedAt: new Date() } : {}),
  }).where(and(eq(recurringSchedules.tenantId, sched.tenantId), eq(recurringSchedules.id, sched.id)));
  return { next, remaining, wasActive: sched.isActive === true, wasRemaining: sched.remainingCount };
}

async function deactivate(tx: Tx, sched: ScheduleRow) {
  await tx.update(recurringSchedules).set({ isActive: false, updatedAt: new Date() })
    .where(and(eq(recurringSchedules.tenantId, sched.tenantId), eq(recurringSchedules.id, sched.id)));
}

/** Marks a posting as made from the template (and its schedule). */
async function markProvenance(tx: Tx, tenantId: string, txnId: string, sched: ScheduleRow | null, templateId: string) {
  await tx.update(transactions).set({
    isRecurring: sched !== null,
    recurringScheduleId: sched?.id ?? null,
    source: sched ? 'recurring' : 'template',
    sourceId: templateId,
  }).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, txnId)));
}

async function auditOccurrence(
  tx: Tx, tenantId: string, occurrenceId: string | null, info: { templateId: string; date: string; status: string; reason?: string | null; transactionId?: string | null },
  userId?: string,
) {
  await auditLog(tenantId, 'create', 'recurring_occurrence', occurrenceId ?? info.templateId, null, {
    templateId: info.templateId, date: info.date, status: info.status, reason: info.reason ?? null, transactionId: info.transactionId ?? null,
  }, userId, tx);
}

const inScope = (rowCompanyId: string | null, companyId: string | null) =>
  !companyId || rowCompanyId === null || rowCompanyId === companyId;

/** Every reference still exists, is active and is in scope; else the reason. */
async function refsProblem(tx: Tx, tenantId: string, companyId: string | null, td: TemplateDraft): Promise<SkipReason | null> {
  const refs = draftRefs(td);
  if (refs.accountIds.length) {
    const rows = await tx.select({ id: accounts.id, companyId: accounts.companyId, isActive: accounts.isActive }).from(accounts)
      .where(and(eq(accounts.tenantId, tenantId), inArray(accounts.id, refs.accountIds)));
    if (rows.length !== refs.accountIds.length || rows.some((r) => r.isActive === false || !inScope(r.companyId, companyId))) return 'INVALID_ACCOUNT';
  }
  if (refs.contactIds.length) {
    const rows = await tx.select({ id: contacts.id, companyId: contacts.companyId, isActive: contacts.isActive }).from(contacts)
      .where(and(eq(contacts.tenantId, tenantId), inArray(contacts.id, refs.contactIds)));
    if (rows.length !== refs.contactIds.length || rows.some((r) => r.isActive === false || !inScope(r.companyId, companyId))) return 'INVALID_CONTACT';
  }
  if (refs.tagIds.length) {
    const rows = await tx.select({ id: tags.id, companyId: tags.companyId, isActive: tags.isActive }).from(tags)
      .where(and(eq(tags.tenantId, tenantId), inArray(tags.id, refs.tagIds)));
    if (rows.length !== refs.tagIds.length || rows.some((r) => r.isActive === false || !inScope(r.companyId, companyId))) return 'INVALID_TAG';
  }
  return null;
}

/** True when `date` is in a closed period for an actor that holds no password or override. */
async function closedForRunner(tx: Tx, tenantId: string, companyId: string | null, date: string): Promise<boolean> {
  try {
    await checkLockDate(tx, tenantId, date, companyId, { userType: 'client', overrideConfirmed: false });
    return false;
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 423) return true;
    throw err;
  }
}

/** A create service's 4xx refusal as a skip reason. */
function reasonFor(err: AppError): SkipReason {
  if (err.statusCode === 423) return 'CLOSED_PERIOD';
  if (err.statusCode === 409 && /check/i.test(err.message)) return 'CHECK_NUMBER';
  if (/account/i.test(err.message)) return 'INVALID_ACCOUNT';
  if (/tag/i.test(err.message)) return 'INVALID_TAG';
  if (/contact|name|customer|vendor/i.test(err.message)) return 'INVALID_CONTACT';
  return 'VALIDATION';
}

async function sourceUsable(tx: Tx, tpl: TemplateRow): Promise<boolean> {
  if (!tpl.sourceTransactionId) return false;
  const [src] = await tx.select({ status: transactions.status, companyId: transactions.companyId }).from(transactions)
    .where(and(eq(transactions.tenantId, tpl.tenantId), eq(transactions.id, tpl.sourceTransactionId))).limit(1);
  return !!src && src.status === 'posted' && inScope(src.companyId, tpl.companyId);
}

async function lockOccurrence(tx: Tx, tenantId: string, templateId: string, date: string) {
  const [row] = await tx.select().from(templateOccurrences).where(and(
    eq(templateOccurrences.tenantId, tenantId), eq(templateOccurrences.templateId, templateId), eq(templateOccurrences.occurrenceDate, date),
  )).for('update').limit(1);
  return row ?? null;
}

function claimIsStale(row: { status: string; createdAt: Date | null }): boolean {
  return row.status === 'claiming' && !!row.createdAt && Date.now() - row.createdAt.getTime() > CLAIM_STALE_MINUTES * 60_000;
}

// ── One auto occurrence ────────────────────────────────────────────

type AutoOutcome =
  | { status: 'not_due' }
  | { status: 'legacy' }
  | { status: 'already'; date: string }
  | { status: 'posted'; occurrenceId: string; date: string; transactionId: string }
  | { status: 'skipped'; occurrenceId: string; date: string; reason: SkipReason };

async function autoStep(actor: Actor, templateId: string, asOf: string, runId: string, owners: OwnerPermissionCache): Promise<AutoOutcome> {
  return db.transaction(async (tx): Promise<AutoOutcome> => {
    await runLock(tx, actor);
    const tpl = await lockTemplate(tx, actor.tenantId, actor.companyId, templateId, 'share');
    if (!tpl) return { status: 'not_due' };
    const sched = await lockSchedule(tx, actor.tenantId, tpl.id);
    if (!scheduleLive(sched) || sched.mode !== 'auto' || sched.nextOccurrence > asOf) return { status: 'not_due' };
    const date = sched.nextOccurrence;
    if (sched.remainingCount === 0 || (sched.endDate !== null && date > sched.endDate)) {
      await deactivate(tx, sched);
      return { status: 'not_due' };
    }

    const td = tpl.kind === 'legacy' ? await legacyDraft(tx, tpl) : await templateDraft(tx, tpl);
    const sourceOk = td !== null || (tpl.kind === 'legacy' && await sourceUsable(tx, tpl));
    if (td === null && sourceOk) return { status: 'legacy' };

    const [claim] = await tx.insert(templateOccurrences).values({
      tenantId: actor.tenantId, companyId: tpl.companyId, templateId: tpl.id, scheduleId: sched.id,
      occurrenceDate: date, status: 'posted', runId, createdBy: actor.userId ?? null,
    }).onConflictDoNothing({ target: [templateOccurrences.templateId, templateOccurrences.occurrenceDate] })
      .returning({ id: templateOccurrences.id });
    if (!claim) {
      // The owner moved the next date back over a date already handled.
      await advance(tx, sched, date, { consumed: false, posted: false });
      return { status: 'already', date };
    }

    const skip = async (reason: SkipReason): Promise<AutoOutcome> => {
      await tx.update(templateOccurrences).set({ status: 'skipped', reason })
        .where(and(eq(templateOccurrences.tenantId, actor.tenantId), eq(templateOccurrences.id, claim.id)));
      await advance(tx, sched, date, { consumed: true, posted: false });
      await auditOccurrence(tx, actor.tenantId, claim.id, { templateId: tpl.id, date, status: 'skipped', reason }, actor.userId);
      return { status: 'skipped', occurrenceId: claim.id, date, reason };
    };

    if (td === null) return skip('TEMPLATE_SOURCE_MISSING');
    if (!(await ownerMayPost(actor.tenantId, tpl, await templateResource(tx, tpl), owners))) return skip('PERMISSION');
    if (td.kind === 'daily_sales') return skip('AUTO_UNSUPPORTED');
    if (await closedForRunner(tx, actor.tenantId, tpl.companyId, date)) return skip('CLOSED_PERIOD');
    const problem = await refsProblem(tx, actor.tenantId, tpl.companyId, td);
    if (problem) return skip(problem);

    let transactionId: string;
    try {
      transactionId = await tx.transaction(async (sp) => {
        const r = await replayDraft(sp, actor.tenantId, tpl.companyId, actor.userId, td, date);
        await markProvenance(sp, actor.tenantId, r.id, sched, tpl.id);
        const inReplay = testHook('inReplay');
        if (inReplay) await inReplay({ templateId: tpl.id, date });
        return r.id;
      });
    } catch (err) {
      if (err instanceof AppError && err.statusCode >= 400 && err.statusCode < 500) return skip(reasonFor(err));
      throw err;
    }
    const afterReplay = testHook('afterReplay');
    if (afterReplay) await afterReplay({ templateId: tpl.id, date });

    await tx.update(templateOccurrences).set({ status: 'posted', transactionId, resolvedAt: new Date() })
      .where(and(eq(templateOccurrences.tenantId, actor.tenantId), eq(templateOccurrences.id, claim.id)));
    await advance(tx, sched, date, { consumed: true, posted: true });
    await auditOccurrence(tx, actor.tenantId, claim.id, { templateId: tpl.id, date, status: 'posted', transactionId }, actor.userId);
    return { status: 'posted', occurrenceId: claim.id, date, transactionId };
  });
}

// ── Legacy clone path (invoice, bill, ...) ─────────────────────────

interface LegacyClaim {
  tpl: TemplateRow;
  sched: ScheduleRow | null;
  date: string;
  occurrenceId: string | null;
  prevStatus: 'skipped' | null;
  advanced: { next: string; remaining: number | null; wasActive: boolean; wasRemaining: number | null } | null;
}

type LegacyOutcome = AutoOutcome | { status: 'entered'; occurrenceId: string | null; date: string; transactionId: string };

/**
 * Two-phase post for a legacy template (see the header). `mode` 'auto'
 * handles the schedule's next date when due by `asOf`; 'manual' the date the
 * caller resolved (manualDate rules).
 */
async function legacyOccurrence(
  actor: Actor, templateId: string, mode: 'auto' | 'manual',
  opts: { asOf?: string; date?: string; runId?: string; owners?: OwnerPermissionCache },
): Promise<LegacyOutcome> {
  const phase1 = await db.transaction(async (tx): Promise<LegacyClaim | LegacyOutcome> => {
    if (mode === 'auto') await runLock(tx, actor);
    const tpl = await lockTemplate(tx, actor.tenantId, actor.companyId, templateId, 'share');
    if (!tpl) {
      if (mode === 'auto') return { status: 'not_due' };
      throw templateNotFound();
    }
    const sched = await lockSchedule(tx, actor.tenantId, tpl.id);
    let date: string;
    let target: 'insert' | 'from_skipped' | 'none';
    if (mode === 'auto') {
      if (!scheduleLive(sched) || sched.mode !== 'auto' || sched.nextOccurrence > opts.asOf!) return { status: 'not_due' };
      date = sched.nextOccurrence;
      if (sched.remainingCount === 0 || (sched.endDate !== null && date > sched.endDate)) {
        await deactivate(tx, sched);
        return { status: 'not_due' };
      }
      target = 'insert';
    } else {
      ({ date, target } = await manualDate(tx, actor, tpl, sched, opts.date));
    }
    if (!tpl.sourceTransactionId) throw AppError.badRequest('This template has no source transaction', 'TEMPLATE_SOURCE_INVALID');

    let occurrenceId: string | null = null;
    let prevStatus: 'skipped' | null = null;
    if (target === 'insert') {
      const [claim] = await tx.insert(templateOccurrences).values({
        tenantId: actor.tenantId, companyId: tpl.companyId, templateId: tpl.id, scheduleId: sched?.id ?? null,
        occurrenceDate: date, status: 'claiming', runId: opts.runId ?? null, createdBy: actor.userId ?? null,
      }).onConflictDoNothing({ target: [templateOccurrences.templateId, templateOccurrences.occurrenceDate] })
        .returning({ id: templateOccurrences.id });
      if (!claim) {
        if (mode === 'manual') throw occurrenceTaken();
        await advance(tx, sched!, date, { consumed: false, posted: false });
        return { status: 'already', date };
      }
      occurrenceId = claim.id;
    } else if (target === 'from_skipped') {
      const row = await lockOccurrence(tx, actor.tenantId, tpl.id, date);
      await tx.update(templateOccurrences).set({ status: 'claiming', createdAt: new Date() })
        .where(and(eq(templateOccurrences.tenantId, actor.tenantId), eq(templateOccurrences.id, row!.id)));
      occurrenceId = row!.id;
      prevStatus = 'skipped';
    }

    if (mode === 'auto') {
      const reason: SkipReason | null =
        !(await ownerMayPost(actor.tenantId, tpl, await templateResource(tx, tpl), opts.owners)) ? 'PERMISSION'
          : await closedForRunner(tx, actor.tenantId, tpl.companyId, date) ? 'CLOSED_PERIOD'
            : null;
      if (reason) {
        await tx.update(templateOccurrences).set({ status: 'skipped', reason })
          .where(and(eq(templateOccurrences.tenantId, actor.tenantId), eq(templateOccurrences.id, occurrenceId!)));
        await advance(tx, sched!, date, { consumed: true, posted: false });
        await auditOccurrence(tx, actor.tenantId, occurrenceId, { templateId: tpl.id, date, status: 'skipped', reason }, actor.userId);
        return { status: 'skipped', occurrenceId: occurrenceId!, date, reason };
      }
    }
    const advanced = target === 'insert' && scheduleLive(sched)
      ? await advance(tx, sched, date, { consumed: true, posted: false })
      : null;
    return { tpl, sched, date, occurrenceId, prevStatus, advanced };
  });
  if ('status' in phase1) return phase1;
  const { tpl, sched, date, occurrenceId, prevStatus, advanced } = phase1;

  let txn: { id: string };
  try {
    const posted = await postLegacyClone(actor.tenantId, {
      id: sched?.id ?? tpl.id, templateTransactionId: tpl.sourceTransactionId!, nextOccurrence: date,
    });
    if (!posted) throw AppError.internal('The recurring copy posted nothing');
    txn = posted;
  } catch (err) {
    // Nothing posted: release the claim and put the date back.
    await db.transaction(async (tx) => {
      await lockTemplate(tx, actor.tenantId, tpl.companyId, tpl.id, 'share');
      await lockSchedule(tx, actor.tenantId, tpl.id);
      if (occurrenceId && prevStatus === 'skipped') {
        await tx.update(templateOccurrences).set({ status: 'skipped' })
          .where(and(eq(templateOccurrences.tenantId, actor.tenantId), eq(templateOccurrences.id, occurrenceId)));
      } else if (occurrenceId) {
        await tx.delete(templateOccurrences).where(and(
          eq(templateOccurrences.tenantId, actor.tenantId), eq(templateOccurrences.id, occurrenceId), eq(templateOccurrences.status, 'claiming'),
        ));
      }
      if (advanced && sched) {
        await tx.update(recurringSchedules).set({
          nextOccurrence: date, remainingCount: advanced.wasRemaining, isActive: advanced.wasActive, updatedAt: new Date(),
        }).where(and(
          eq(recurringSchedules.tenantId, actor.tenantId), eq(recurringSchedules.id, sched.id),
          eq(recurringSchedules.nextOccurrence, advanced.next),
        ));
      }
    });
    throw err;
  }

  const status = mode === 'auto' ? 'posted' : 'entered';
  await db.transaction(async (tx) => {
    if (occurrenceId) {
      await tx.update(templateOccurrences).set({ status, reason: null, transactionId: txn.id, resolvedAt: new Date() })
        .where(and(eq(templateOccurrences.tenantId, actor.tenantId), eq(templateOccurrences.id, occurrenceId)));
    }
    const live = scheduleLive(sched) && occurrenceId !== null ? sched : null;
    await markProvenance(tx, actor.tenantId, txn.id, live, tpl.id);
    if (live) {
      await tx.update(recurringSchedules).set({ lastPostedAt: new Date() })
        .where(and(eq(recurringSchedules.tenantId, actor.tenantId), eq(recurringSchedules.id, live.id)));
    }
    await auditOccurrence(tx, actor.tenantId, occurrenceId, { templateId: tpl.id, date, status, transactionId: txn.id }, actor.userId);
  });
  if (status === 'posted') return { status, occurrenceId: occurrenceId!, date, transactionId: txn.id };
  return { status, occurrenceId, date, transactionId: txn.id };
}

// ── "Enter now" (manual) ───────────────────────────────────────────

/**
 * The date a manual enter / skip / resolve may take (E2): the schedule's
 * next date (even before it is due — "enter early") or any open skipped
 * date; without a live schedule any date (no occurrence row is written).
 */
async function manualDate(
  tx: Tx, actor: Actor, tpl: TemplateRow, sched: ScheduleRow | null, requested: string | undefined,
): Promise<{ date: string; target: 'insert' | 'from_skipped' | 'none' }> {
  const live = scheduleLive(sched);
  const date = requested ?? (live ? sched.nextOccurrence : (await currentDate(tx)).today);
  const existing = await lockOccurrence(tx, actor.tenantId, tpl.id, date);
  if (existing) {
    if (existing.status === 'skipped') return { date, target: 'from_skipped' };
    throw occurrenceTaken();
  }
  if (live) {
    if (date !== sched.nextOccurrence) throw occurrenceNotDue();
    return { date, target: 'insert' };
  }
  return { date, target: 'none' };
}

export interface EnterResult {
  transactionId: string;
  occurrence: { id: string | null; templateId: string; occurrenceDate: string; status: 'entered' } | null;
}

/**
 * Posts the template now (POST /templates/:id/enter, "Post now"). Runs in
 * the request's closed-period context, so the closing-date password works
 * and writes its closing_date_override audit row.
 */
export async function enterTemplate(actor: Actor, templateId: string, opts: { occurrenceDate?: string } = {}): Promise<EnterResult> {
  const result = await db.transaction(async (tx) => {
    const tpl = await lockTemplate(tx, actor.tenantId, actor.companyId, templateId, 'share');
    if (!tpl) throw templateNotFound();
    const sched = await lockSchedule(tx, actor.tenantId, tpl.id);
    const { date, target } = await manualDate(tx, actor, tpl, sched, opts.occurrenceDate);
    const td = await templateDraft(tx, tpl);
    if (!td) {
      if (!(await sourceUsable(tx, tpl))) {
        throw new AppError(400, 'The transaction this template was made from is gone or void.', 'TEMPLATE_SOURCE_MISSING');
      }
      return { legacy: true as const };
    }
    if (td.kind === 'daily_sales') throw autoUnsupported();
    const problem = await refsProblem(tx, actor.tenantId, tpl.companyId, td);
    if (problem) {
      throw new AppError(400, 'An account, name or tag on this template is inactive or no longer exists. Open the template and fix it.', problem);
    }
    const replayed = await replayDraft(tx, actor.tenantId, tpl.companyId, actor.userId, td, date);
    const live = scheduleLive(sched) && target !== 'none' ? sched : null;
    await markProvenance(tx, actor.tenantId, replayed.id, live, tpl.id);
    const afterReplay = testHook('afterReplay');
    if (afterReplay) await afterReplay({ templateId: tpl.id, date });

    let occurrenceId: string | null = null;
    if (target === 'insert') {
      const [row] = await tx.insert(templateOccurrences).values({
        tenantId: actor.tenantId, companyId: tpl.companyId, templateId: tpl.id, scheduleId: sched!.id, occurrenceDate: date,
        status: 'entered', transactionId: replayed.id, createdBy: actor.userId ?? null, resolvedAt: new Date(),
      }).returning({ id: templateOccurrences.id });
      occurrenceId = row!.id;
      await advance(tx, sched!, date, { consumed: true, posted: true });
    } else if (target === 'from_skipped') {
      const row = await lockOccurrence(tx, actor.tenantId, tpl.id, date);
      await tx.update(templateOccurrences).set({ status: 'entered', transactionId: replayed.id, resolvedAt: new Date() })
        .where(and(eq(templateOccurrences.tenantId, actor.tenantId), eq(templateOccurrences.id, row!.id)));
      occurrenceId = row!.id;
    }
    await auditOccurrence(tx, actor.tenantId, occurrenceId, { templateId: tpl.id, date, status: 'entered', transactionId: replayed.id }, actor.userId);
    return {
      legacy: false as const,
      transactionId: replayed.id,
      occurrence: target === 'none' ? null : { id: occurrenceId, templateId: tpl.id, occurrenceDate: date, status: 'entered' as const },
    };
  });
  if (!result.legacy) return { transactionId: result.transactionId, occurrence: result.occurrence };
  const legacy = await legacyOccurrence(actor, templateId, 'manual', { date: opts.occurrenceDate });
  if (legacy.status !== 'entered') throw AppError.internal('Legacy enter did not post');
  return {
    transactionId: legacy.transactionId,
    occurrence: legacy.occurrenceId
      ? { id: legacy.occurrenceId, templateId, occurrenceDate: legacy.date, status: 'entered' }
      : null,
  };
}

/** Skip ("Don't enter it"): the date becomes 'dismissed'; the schedule moves on when it was the next date. */
export async function skipOccurrence(actor: Actor, templateId: string, date: string) {
  return db.transaction(async (tx) => {
    const tpl = await lockTemplate(tx, actor.tenantId, actor.companyId, templateId, 'share');
    if (!tpl) throw templateNotFound();
    const sched = await lockSchedule(tx, actor.tenantId, tpl.id);
    const existing = await lockOccurrence(tx, actor.tenantId, tpl.id, date);
    let id: string;
    if (existing) {
      if (existing.status !== 'skipped' && !claimIsStale(existing)) throw occurrenceTaken();
      await tx.update(templateOccurrences).set({ status: 'dismissed', resolvedAt: new Date() })
        .where(and(eq(templateOccurrences.tenantId, actor.tenantId), eq(templateOccurrences.id, existing.id)));
      id = existing.id;
    } else if (scheduleLive(sched) && sched.nextOccurrence === date) {
      const [row] = await tx.insert(templateOccurrences).values({
        tenantId: actor.tenantId, companyId: tpl.companyId, templateId: tpl.id, scheduleId: sched.id, occurrenceDate: date,
        status: 'dismissed', createdBy: actor.userId ?? null, resolvedAt: new Date(),
      }).returning({ id: templateOccurrences.id });
      id = row!.id;
      await advance(tx, sched, date, { consumed: true, posted: false });
    } else {
      throw occurrenceNotDue();
    }
    await auditOccurrence(tx, actor.tenantId, id, { templateId: tpl.id, date, status: 'dismissed' }, actor.userId);
    return { id, templateId: tpl.id, occurrenceDate: date, status: 'dismissed' as const };
  });
}

/** The transaction type a template of this draft kind posts. */
function expectedTxn(kind: string): { txnType: string; check?: boolean } | null {
  switch (kind) {
    case 'check': return { txnType: 'expense', check: true };
    case 'expense': return { txnType: 'expense', check: false };
    case 'deposit': return { txnType: 'deposit' };
    case 'transfer': return { txnType: 'transfer' };
    case 'journal_entry': return { txnType: 'journal_entry' };
    case 'daily_sales': return { txnType: 'daily_sales' };
    default: return null;
  }
}

function resolveInvalid(message: string): AppError {
  return AppError.badRequest(message, 'OCCURRENCE_RESOLVE_INVALID');
}

/**
 * Resolve ("Open in form", then saved): links a transaction the owner saved
 * through the normal form to the date, which becomes 'entered'.
 */
export async function resolveOccurrence(actor: Actor, templateId: string, date: string, transactionId: string) {
  return db.transaction(async (tx) => {
    const tpl = await lockTemplate(tx, actor.tenantId, actor.companyId, templateId, 'share');
    if (!tpl) throw templateNotFound();
    const sched = await lockSchedule(tx, actor.tenantId, tpl.id);
    const [txn] = await tx.select().from(transactions)
      .where(and(eq(transactions.tenantId, actor.tenantId), eq(transactions.id, transactionId))).for('update').limit(1);
    // Same company exactly: a company-less template can't link a company's
    // transaction, nor a company's template a company-less one.
    if (!txn || txn.status !== 'posted' || txn.companyId !== tpl.companyId) {
      throw resolveInvalid('The transaction was not found in this company, or it is void or deleted.');
    }
    if (txn.txnDate !== date) throw resolveInvalid('The transaction’s date is not the template date.');
    let kind: string = tpl.kind;
    if (kind === 'legacy') {
      const td = await legacyDraft(tx, tpl);
      if (td) kind = td.kind;
    }
    const expected = expectedTxn(kind);
    const sourceType = kind === 'legacy' && tpl.sourceTransactionId
      ? (await tx.select({ t: transactions.txnType }).from(transactions)
        .where(and(eq(transactions.tenantId, actor.tenantId), eq(transactions.id, tpl.sourceTransactionId))).limit(1))[0]?.t
      : undefined;
    const typeOk = expected
      ? txn.txnType === expected.txnType && (expected.check === undefined || (txn.printStatus !== null) === expected.check)
      : txn.txnType === sourceType;
    if (!typeOk) throw resolveInvalid('The transaction is not of the template’s kind.');
    const [linked] = await tx.select({ id: templateOccurrences.id }).from(templateOccurrences)
      .where(and(eq(templateOccurrences.tenantId, actor.tenantId), eq(templateOccurrences.transactionId, transactionId))).limit(1);
    if (linked) throw resolveInvalid('The transaction is already linked to a template date.');

    const existing = await lockOccurrence(tx, actor.tenantId, tpl.id, date);
    let id: string;
    if (existing) {
      if (existing.status !== 'skipped' && !claimIsStale(existing)) throw occurrenceTaken();
      await tx.update(templateOccurrences).set({ status: 'entered', reason: null, transactionId, resolvedAt: new Date() })
        .where(and(eq(templateOccurrences.tenantId, actor.tenantId), eq(templateOccurrences.id, existing.id)));
      id = existing.id;
    } else if (scheduleLive(sched) && sched.nextOccurrence === date) {
      const [row] = await tx.insert(templateOccurrences).values({
        tenantId: actor.tenantId, companyId: tpl.companyId, templateId: tpl.id, scheduleId: sched.id, occurrenceDate: date,
        status: 'entered', transactionId, createdBy: actor.userId ?? null, resolvedAt: new Date(),
      }).returning({ id: templateOccurrences.id });
      id = row!.id;
      await advance(tx, sched, date, { consumed: true, posted: true });
    } else {
      throw occurrenceNotDue();
    }
    // Provenance changes an existing posting, so it is audited; a posting in
    // a closed period is left as it is (linked, not marked): resolve carries
    // no closing-date password and never edits a closed period.
    if (!(await closedForRunner(tx, actor.tenantId, txn.companyId, txn.txnDate))) {
      await markProvenance(tx, actor.tenantId, transactionId, sched, tpl.id);
      await auditLog(actor.tenantId, 'update', 'transaction', transactionId,
        { isRecurring: txn.isRecurring, recurringScheduleId: txn.recurringScheduleId, source: txn.source, sourceId: txn.sourceId },
        { isRecurring: sched !== null, recurringScheduleId: sched?.id ?? null, source: sched ? 'recurring' : 'template', sourceId: tpl.id },
        actor.userId, tx);
    }
    await auditOccurrence(tx, actor.tenantId, id, { templateId: tpl.id, date, status: 'entered', transactionId }, actor.userId);
    return { id, templateId: tpl.id, occurrenceDate: date, status: 'entered' as const, transactionId };
  });
}

// ── The catch-up run ───────────────────────────────────────────────

const companyCond = (column: string, companyId: string | null) =>
  companyId ? sql`${sql.raw(column)} = ${companyId}` : sql`${sql.raw(column)} IS NULL`;

/** Optional run-due template filter (U-82, run-due-filter-v1). */
export interface RunDueFilter {
  /** Only these templates. */
  templateIds?: string[];
  /** All but these templates. */
  excludeTemplateIds?: string[];
}

function filterCond(filter: RunDueFilter | undefined) {
  const conds = [];
  if (filter?.templateIds) {
    conds.push(filter.templateIds.length === 0
      ? sql`false`
      : sql`rs.template_id IN (${sql.join(filter.templateIds.map((i) => sql`${i}`), sql`, `)})`);
  }
  if (filter?.excludeTemplateIds && filter.excludeTemplateIds.length > 0) {
    conds.push(sql`rs.template_id NOT IN (${sql.join(filter.excludeTemplateIds.map((i) => sql`${i}`), sql`, `)})`);
  }
  return conds.length === 0 ? sql`true` : sql.join(conds, sql` AND `);
}

async function dueAutoSchedules(actor: Actor, asOf: string, filter?: RunDueFilter) {
  const res = await db.execute(sql`
    SELECT rs.template_id
    FROM recurring_schedules rs
    JOIN template_transactions tt ON tt.id = rs.template_id AND tt.tenant_id = rs.tenant_id
    WHERE rs.tenant_id = ${actor.tenantId} AND ${companyCond('tt.company_id', actor.companyId)}
      AND tt.deleted_at IS NULL AND rs.is_active = true AND rs.archived_at IS NULL AND rs.mode = 'auto'
      AND rs.next_occurrence <= ${asOf}::date AND ${filterCond(filter)}
    ORDER BY rs.next_occurrence, rs.id
  `);
  return (res.rows as Array<{ template_id: string }>).map((r) => r.template_id);
}

async function postedInRun(actor: Actor, runId: string) {
  const res = await db.execute(sql`
    SELECT o.template_id, t.name, t.kind, t.client_form, o.occurrence_date::text AS occurrence_date, o.transaction_id,
           COALESCE(x.total, (SELECT SUM(jl.debit) FROM journal_lines jl
                              WHERE jl.tenant_id = x.tenant_id AND jl.transaction_id = x.id AND jl.is_void_reversal = false))::text AS total
    FROM template_occurrences o
    JOIN template_transactions t ON t.id = o.template_id AND t.tenant_id = o.tenant_id
    LEFT JOIN transactions x ON x.id = o.transaction_id AND x.tenant_id = o.tenant_id
    WHERE o.tenant_id = ${actor.tenantId} AND ${companyCond('t.company_id', actor.companyId)}
      AND o.run_id = ${runId} AND o.status = 'posted'
    ORDER BY o.occurrence_date, lower(t.name), o.template_id
  `);
  return (res.rows as Array<Record<string, string | null>>).map((r) => ({
    templateId: r['template_id']!, templateName: r['name']!, kind: r['kind']!, clientForm: r['client_form'] ?? null,
    occurrenceDate: r['occurrence_date']!, transactionId: r['transaction_id']!, total: r['total'] ?? null,
  }));
}

interface SkippedEntry {
  templateId: string; templateName: string; kind: string; clientForm: string | null;
  occurrenceDate: string; reason: string; new: boolean;
}

/** Open skipped dates (oldest first, at most SKIPPED_LIST_CAP) and how many there are in all. */
async function openSkipped(actor: Actor, fresh: Set<string>): Promise<{ items: SkippedEntry[]; total: number }> {
  const open = sql`
    FROM template_occurrences o
    JOIN template_transactions t ON t.id = o.template_id AND t.tenant_id = o.tenant_id
    WHERE o.tenant_id = ${actor.tenantId} AND ${companyCond('t.company_id', actor.companyId)} AND t.deleted_at IS NULL
      AND (o.status = 'skipped'
        OR (o.status = 'claiming' AND o.created_at < now() - make_interval(mins => ${CLAIM_STALE_MINUTES})))`;
  const res = await db.execute(sql`
    SELECT o.id, o.template_id, t.name, t.kind, t.client_form, o.occurrence_date::text AS occurrence_date, o.status, o.reason
    ${open}
    ORDER BY o.occurrence_date, lower(t.name), o.id
    LIMIT ${SKIPPED_LIST_CAP}
  `);
  const count = await db.execute(sql`SELECT COUNT(*)::int AS n ${open}`);
  const total = Number((count.rows as Array<{ n: number }>)[0]?.n ?? 0);
  const items = (res.rows as Array<Record<string, string | null>>).map((r) => ({
    templateId: r['template_id']!, templateName: r['name']!, kind: r['kind']!, clientForm: r['client_form'] ?? null,
    occurrenceDate: r['occurrence_date']!,
    reason: r['status'] === 'claiming' ? 'NEEDS_CHECK' : (r['reason'] ?? 'VALIDATION'),
    new: fresh.has(r['id']!),
  }));
  return { items, total };
}

/** Schedules a run stopped at CATCH_UP_CAP that are still due: listed as skipped / CATCH_UP_CAPPED. */
async function cappedEntries(actor: Actor, templateIds: string[], asOf: string): Promise<SkippedEntry[]> {
  if (templateIds.length === 0) return [];
  const res = await db.execute(sql`
    SELECT t.id AS template_id, t.name, t.kind, t.client_form, rs.next_occurrence::text AS occurrence_date
    FROM recurring_schedules rs
    JOIN template_transactions t ON t.id = rs.template_id AND t.tenant_id = rs.tenant_id
    WHERE rs.tenant_id = ${actor.tenantId} AND t.id IN (${sql.join(templateIds.map((i) => sql`${i}`), sql`, `)})
      AND t.deleted_at IS NULL AND rs.is_active = true AND rs.archived_at IS NULL AND rs.mode = 'auto'
      AND rs.next_occurrence <= ${asOf}::date
    ORDER BY rs.next_occurrence, lower(t.name), t.id
  `);
  return (res.rows as Array<Record<string, string | null>>).map((r) => ({
    templateId: r['template_id']!, templateName: r['name']!, kind: r['kind']!, clientForm: r['client_form'] ?? null,
    occurrenceDate: r['occurrence_date']!, reason: 'CATCH_UP_CAPPED', new: true,
  }));
}

async function dueReminders(actor: Actor, asOf: string) {
  const rows = await db.select({ tpl: templateTransactions, sched: recurringSchedules })
    .from(recurringSchedules)
    .innerJoin(templateTransactions, and(
      eq(templateTransactions.id, recurringSchedules.templateId), eq(templateTransactions.tenantId, recurringSchedules.tenantId),
    ))
    .where(and(
      eq(recurringSchedules.tenantId, actor.tenantId),
      actor.companyId ? eq(templateTransactions.companyId, actor.companyId) : sql`${templateTransactions.companyId} IS NULL`,
      sql`${templateTransactions.deletedAt} IS NULL`,
      eq(recurringSchedules.isActive, true),
      sql`${recurringSchedules.archivedAt} IS NULL`,
      eq(recurringSchedules.mode, 'reminder'),
      sql`${recurringSchedules.nextOccurrence} <= ${asOf}::date`,
    ))
    .orderBy(recurringSchedules.nextOccurrence, recurringSchedules.id)
    .limit(REMINDER_SCHEDULES_CAP + 1);
  const truncated = rows.length > REMINDER_SCHEDULES_CAP;
  const out = [];
  for (const { tpl, sched } of rows.slice(0, REMINDER_SCHEDULES_CAP)) {
    const dueDates: string[] = [];
    let count = 0;
    let d = sched.nextOccurrence;
    let left = sched.remainingCount;
    while (d <= asOf && (sched.endDate === null || d <= sched.endDate) && (left === null || left > 0) && count < REMINDER_COUNT_CAP) {
      if (dueDates.length < REMINDER_DATES_CAP) dueDates.push(d);
      count += 1;
      if (left !== null) left -= 1;
      d = nextRecurrenceDate(d, sched.frequency, sched.intervalValue ?? 1, sched.anchorDate ?? sched.startDate);
    }
    if (count === 0) continue;
    const td = await templateDraft(db, tpl);
    out.push({
      templateId: tpl.id, templateName: tpl.name, kind: td?.kind ?? tpl.kind, clientForm: tpl.clientForm ?? null,
      // truncated: dueCount stopped at REMINDER_COUNT_CAP; more dates are due.
      dueDates, dueCount: count, truncated: count >= REMINDER_COUNT_CAP, total: td ? draftTotal(td) : null,
    });
  }
  return { reminders: out, truncated };
}

export interface RunDueResult {
  asOf: string;
  runId: string;
  more: boolean;
  posted: Awaited<ReturnType<typeof postedInRun>>;
  reminders: Awaited<ReturnType<typeof dueReminders>>['reminders'];
  /** More reminder schedules are due than REMINDER_SCHEDULES_CAP. */
  remindersTruncated: boolean;
  /** Open skipped dates (at most SKIPPED_LIST_CAP), then the schedules this run capped (CATCH_UP_CAPPED). */
  skipped: SkippedEntry[];
  /** Every open skipped date plus the capped schedules. */
  skippedTotal: number;
  failed: Array<{ templateId: string; reason: 'INTERNAL' }>;
}

/**
 * POST /recurring/run-due. Posts every due auto occurrence of the tenant's
 * company up to `limit` (each its own database transaction, so progress is
 * durable and a repeat call is harmless). `asOf` is the caller's local
 * date (default CURRENT_DATE; at most one day ahead: 400 RUN_DUE_FUTURE).
 *
 * `templateIds` / `excludeTemplateIds` (U-82, run-due-filter-v1) narrow which
 * auto schedules this call works on; the others are left exactly as they
 * are and stay due. `more` only counts schedules the filter lets through.
 * The runId stays a label: a replay with a different filter posts only what
 * the new filter allows (each template and date still posts at most once),
 * and `posted` lists every post with that runId from any call.
 */
export async function runDue(
  actor: Actor, opts: { asOf?: string; runId?: string; limit?: number } & RunDueFilter = {},
): Promise<RunDueResult> {
  return (await runDueInternal(actor, opts)).result;
}

async function runDueInternal(
  actor: Actor, opts: { asOf?: string; runId?: string; limit?: number } & RunDueFilter, owners: OwnerPermissionCache = new Map(),
) {
  const filter: RunDueFilter = { templateIds: opts.templateIds, excludeTemplateIds: opts.excludeTemplateIds };
  const { today, tomorrow } = await currentDate(db);
  const asOf = opts.asOf ?? today;
  if (asOf > tomorrow) {
    throw AppError.badRequest('asOf can’t be later than tomorrow.', 'RUN_DUE_FUTURE');
  }
  const runId = opts.runId ?? randomUUID();
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
  await adoptOrphanSchedules(actor.tenantId);
  let handled = 0;
  let postedNow = 0;
  const fresh = new Set<string>();
  const failed: RunDueResult['failed'] = [];
  const capped = new Set<string>();

  await runWithoutOverride(async () => {
    for (const templateId of await dueAutoSchedules(actor, asOf, filter)) {
      let steps = 0;
      while (handled < limit) {
        if (steps >= CATCH_UP_CAP) {
          capped.add(templateId);
          break;
        }
        let outcome: LegacyOutcome;
        try {
          outcome = await autoStep(actor, templateId, asOf, runId, owners);
          if (outcome.status === 'legacy') outcome = await legacyOccurrence(actor, templateId, 'auto', { asOf, runId, owners });
        } catch (err) {
          failed.push({ templateId, reason: 'INTERNAL' });
          log.error({
            component: 'recurring-run', event: 'occurrence_failed', templateId,
            code: err instanceof AppError ? err.code ?? String(err.statusCode) : (err as { code?: string })?.code ?? 'error',
          });
          break;
        }
        if (outcome.status === 'not_due' || outcome.status === 'legacy') break;
        handled += 1;
        steps += 1;
        if (outcome.status === 'posted') postedNow += 1;
        if (outcome.status === 'skipped') fresh.add(outcome.occurrenceId);
      }
      if (handled >= limit) break;
    }
  });

  // A capped schedule waits for the next run, so it doesn't make `more`.
  const more = handled >= limit && (await dueAutoSchedules(actor, asOf, filter)).some((id) => !capped.has(id));
  const reminders = await dueReminders(actor, asOf);
  const open = await openSkipped(actor, fresh);
  const cappedNow = await cappedEntries(actor, [...capped], asOf);
  const result: RunDueResult = {
    asOf, runId, more,
    posted: await postedInRun(actor, runId),
    reminders: reminders.reminders,
    remindersTruncated: reminders.truncated,
    skipped: [...open.items, ...cappedNow],
    skippedTotal: open.total + cappedNow.length,
    failed,
  };
  return { result, postedNow, handled };
}

/** GET /recurring/attention: due reminders and open skipped dates; changes nothing. */
export async function attention(actor: Actor, asOf?: string) {
  const { today, tomorrow } = await currentDate(db);
  const date = asOf ?? today;
  if (date > tomorrow) throw AppError.badRequest('asOf can’t be later than tomorrow.', 'RUN_DUE_FUTURE');
  const reminders = await dueReminders(actor, date);
  const open = await openSkipped(actor, new Set());
  return {
    asOf: date, reminders: reminders.reminders, remindersTruncated: reminders.truncated,
    skipped: open.items, skippedTotal: open.total,
  };
}

// ── Compatibility: web "Post now" and the server tick ─────────────

/** recurring.service postNext: the schedule's next date, entered now. */
export async function postScheduleNow(tenantId: string, sched: ScheduleRow) {
  if (!sched.isActive) {
    throw AppError.conflict(`Recurring schedule ${sched.id} is not active.`, 'RECURRING_ALREADY_CLAIMED');
  }
  let templateId = sched.templateId;
  if (!templateId) {
    await adoptOrphanSchedules(tenantId);
    const [again] = await db.select({ t: recurringSchedules.templateId }).from(recurringSchedules)
      .where(and(eq(recurringSchedules.tenantId, tenantId), eq(recurringSchedules.id, sched.id))).limit(1);
    templateId = again?.t ?? null;
  }
  if (!templateId) throw AppError.badRequest('This schedule has no template');
  const [tpl] = await db.select().from(templateTransactions)
    .where(and(eq(templateTransactions.tenantId, tenantId), eq(templateTransactions.id, templateId))).limit(1);
  if (!tpl || tpl.deletedAt) throw AppError.notFound('Recurring schedule not found');
  let entered: EnterResult;
  try {
    entered = await enterTemplate({ tenantId, companyId: tpl.companyId }, tpl.id, { occurrenceDate: sched.nextOccurrence });
  } catch (err) {
    if (err instanceof AppError && (err.code === 'OCCURRENCE_TAKEN' || err.code === 'OCCURRENCE_NOT_DUE')) {
      throw AppError.conflict(
        `Recurring schedule ${sched.id} is not on occurrence ${sched.nextOccurrence} (already posted, or deactivated).`,
        'RECURRING_ALREADY_CLAIMED',
      );
    }
    throw err;
  }
  return ledger.getTransaction(tenantId, entered.transactionId);
}

/**
 * Server hourly tick (and the worker): the catch-up run for every tenant
 * and company with an auto schedule due today. Same function as
 * POST /recurring/run-due, as the system actor.
 */
export async function processAllDueSchedules(): Promise<{ processed: number; total: number }> {
  const { today } = await currentDate(db);
  await adoptOrphanSchedules();
  const res = await db.execute(sql`
    SELECT tt.tenant_id, tt.company_id, COUNT(*)::int AS n
    FROM recurring_schedules rs
    JOIN template_transactions tt ON tt.id = rs.template_id AND tt.tenant_id = rs.tenant_id
    WHERE rs.is_active = true AND rs.archived_at IS NULL AND rs.mode = 'auto'
      AND rs.next_occurrence <= ${today}::date AND tt.deleted_at IS NULL
    GROUP BY tt.tenant_id, tt.company_id
  `);
  let processed = 0;
  let total = 0;
  // Global bound per tick: the rest stays due for the next tick.
  let budget = SERVER_TICK_CAP;
  for (const row of res.rows as Array<{ tenant_id: string; company_id: string | null; n: number }>) {
    total += Number(row.n);
    if (budget <= 0) continue;
    const actor: Actor = { tenantId: row.tenant_id, companyId: row.company_id };
    const owners: OwnerPermissionCache = new Map();
    try {
      for (let i = 0; i < 50 && budget > 0; i++) {
        const { result, postedNow, handled } = await runDueInternal(actor, { asOf: today, limit: Math.min(500, budget) }, owners);
        processed += postedNow;
        budget -= handled;
        if (!result.more) break;
      }
    } catch (err) {
      log.error({
        component: 'recurring-run', event: 'scope_failed', tenantId: row.tenant_id,
        code: err instanceof AppError ? err.code ?? String(err.statusCode) : (err as { code?: string })?.code ?? 'error',
      });
    }
  }
  return { processed, total };
}
