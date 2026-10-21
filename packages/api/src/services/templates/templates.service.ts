// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Templates (memorized transactions) without posting — U-62, templates-v1.
 *
 * A template is a draft of a check, expense, deposit, transfer, journal
 * entry or daily-sales entry, with an optional schedule ("remind" or
 * "auto"). Saving one posts nothing. Every query is scoped to the tenant
 * AND the company; another tenant's or company's template reads as 404.
 *
 * Lock order (shared with the runner, occurrences.service.ts): template row
 * -> schedule row -> (companies / accounts rows taken by posting). Writes
 * take the template FOR UPDATE; a write carries the `version` it read and
 * a mismatch is 409 STALE.
 *
 * Template names, memos and amounts are never logged; audit rows carry ids.
 */

import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { TemplateDraft, TemplateDraftKind, TemplateScheduleInput } from '@kis-books/shared';
import { db, type DbOrTx, type Tx } from '../../db/index.js';
import {
  recurringSchedules, templateGroups, templateTransactionLines, templateTransactions,
  templateTransactionTags, transactions,
} from '../../db/schema/index.js';
import { AppError } from '../../utils/errors.js';
import { auditLog } from '../../middleware/audit.js';
import {
  assertDraftRefsInScope, draftHeader, draftToRows, draftTotal, draftWarnings, parseDraft, rowsToDraft, withoutMissing,
} from './draft.js';
import { loadSource, snapshotForCreate, snapshotTransaction } from './snapshot.js';
import { autoUnsupported } from './replay.js';

export type TemplateRow = typeof templateTransactions.$inferSelect;
export type ScheduleRow = typeof recurringSchedules.$inferSelect;

/** Minutes after which a claim the legacy path never finished is shown as NEEDS_CHECK. */
export const CLAIM_STALE_MINUTES = 10;

/** An auto schedule's next date may be at most this many days before today (security review M2). */
export const AUTO_BACKDATE_MAX_DAYS = 366;

/**
 * Test clock for the backdate check: tests use fixed 2026 dates, so they pin
 * "today". Only honoured when NODE_ENV is 'test'; production uses CURRENT_DATE.
 */
export const __scheduleClock: { today?: string } = {};

// ── Errors ─────────────────────────────────────────────────────────

function nameTaken(): AppError {
  return AppError.conflict('A template with this name already exists. Choose another name.', 'TEMPLATE_NAME_TAKEN');
}

function stale(version: number): AppError {
  return AppError.conflict('This template was changed since you opened it. Reload it and make your change again.', 'STALE', { version });
}

export function templateNotFound(): AppError {
  return AppError.notFound('Template not found');
}

function pgCode(err: unknown): { code?: string; constraint?: string } {
  let e: unknown = err;
  for (let i = 0; i < 3 && e && typeof e === 'object'; i++) {
    const rec = e as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (typeof rec.code === 'string' && /^[0-9A-Z]{5}$/.test(rec.code)) {
      return { code: rec.code, constraint: typeof rec.constraint === 'string' ? rec.constraint : undefined };
    }
    e = rec.cause;
  }
  return {};
}

function isUnique(err: unknown, constraint: string): boolean {
  const p = pgCode(err);
  return p.code === '23505' && p.constraint === constraint;
}

// ── Reads ──────────────────────────────────────────────────────────

const scope = (tenantId: string, companyId: string) =>
  and(eq(templateTransactions.tenantId, tenantId), eq(templateTransactions.companyId, companyId));

export async function lockTemplate(
  tx: Tx, tenantId: string, companyId: string | null, id: string, strength: 'share' | 'update',
): Promise<TemplateRow | null> {
  const conds = [eq(templateTransactions.tenantId, tenantId), eq(templateTransactions.id, id), isNull(templateTransactions.deletedAt)];
  conds.push(companyId ? eq(templateTransactions.companyId, companyId) : isNull(templateTransactions.companyId));
  const [row] = await tx.select().from(templateTransactions).where(and(...conds)).for(strength).limit(1);
  return row ?? null;
}

export async function lockSchedule(tx: Tx, tenantId: string, templateId: string): Promise<ScheduleRow | null> {
  const [row] = await tx.select().from(recurringSchedules)
    .where(and(eq(recurringSchedules.tenantId, tenantId), eq(recurringSchedules.templateId, templateId)))
    .for('update').limit(1);
  return row ?? null;
}

async function loadParts(exec: DbOrTx, tenantId: string, ids: string[]) {
  if (ids.length === 0) return { lines: new Map<string, Array<typeof templateTransactionLines.$inferSelect>>(), tags: new Map<string, string[]>() };
  const lineRows = await exec.select().from(templateTransactionLines)
    .where(and(eq(templateTransactionLines.tenantId, tenantId), inArray(templateTransactionLines.templateId, ids)))
    .orderBy(asc(templateTransactionLines.lineOrder));
  const tagRows = await exec.select().from(templateTransactionTags)
    .where(and(eq(templateTransactionTags.tenantId, tenantId), inArray(templateTransactionTags.templateId, ids)));
  const lines = new Map<string, Array<typeof templateTransactionLines.$inferSelect>>();
  for (const l of lineRows) lines.set(l.templateId, [...(lines.get(l.templateId) ?? []), l]);
  const tags = new Map<string, string[]>();
  for (const t of tagRows) tags.set(t.templateId, [...(tags.get(t.templateId) ?? []), t.tagId]);
  return { lines, tags };
}

/**
 * The template as a draft. A 'legacy' template converts in memory when its
 * source transaction can be read as one of the template kinds; otherwise
 * null (it posts through the old clone path).
 */
export async function templateDraft(exec: DbOrTx, tpl: TemplateRow): Promise<TemplateDraft | null> {
  if (tpl.kind !== 'legacy') {
    const { lines, tags } = await loadParts(exec, tpl.tenantId, [tpl.id]);
    return rowsToDraft(tpl, lines.get(tpl.id) ?? [], tags.get(tpl.id) ?? []);
  }
  return legacyDraft(exec, tpl);
}

export async function legacyDraft(exec: DbOrTx, tpl: TemplateRow): Promise<TemplateDraft | null> {
  if (!tpl.sourceTransactionId) return null;
  const src = await loadSource(exec, tpl.tenantId, tpl.companyId, tpl.sourceTransactionId);
  if (!src || src.status !== 'posted') return null;
  const snap = await snapshotTransaction(exec, tpl.tenantId, src);
  return snap.kind === 'draft' ? snap.draft : null;
}

export function presentSchedule(s: ScheduleRow | null | undefined) {
  if (!s || s.archivedAt) return null;
  return {
    id: s.id,
    mode: s.mode === 'auto' ? 'auto' : 'remind',
    frequency: s.frequency,
    intervalValue: s.intervalValue ?? 1,
    nextDate: s.nextOccurrence,
    endDate: s.endDate ?? null,
    remainingCount: s.remainingCount ?? null,
    isActive: s.isActive === true,
    lastPostedAt: s.lastPostedAt ?? null,
  };
}

async function occurrenceStats(exec: DbOrTx, tenantId: string, ids: string[]) {
  const out = new Map<string, { lastEnteredDate: string | null; openSkipped: number }>();
  if (ids.length === 0) return out;
  const res = await exec.execute(sql`
    SELECT template_id,
           MAX(occurrence_date) FILTER (WHERE status IN ('posted', 'entered'))::text AS last_entered,
           COUNT(*) FILTER (WHERE status = 'skipped'
             OR (status = 'claiming' AND created_at < now() - make_interval(mins => ${CLAIM_STALE_MINUTES})))::int AS open_skipped
    FROM template_occurrences
    WHERE tenant_id = ${tenantId} AND template_id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})
    GROUP BY template_id
  `);
  for (const r of res.rows as Array<{ template_id: string; last_entered: string | null; open_skipped: number }>) {
    out.set(r.template_id, { lastEnteredDate: r.last_entered, openSkipped: Number(r.open_skipped) });
  }
  return out;
}

async function present(exec: DbOrTx, tenantId: string, rows: TemplateRow[], withDraft: boolean) {
  const ids = rows.map((r) => r.id);
  const { lines, tags } = await loadParts(exec, tenantId, ids);
  const schedules = ids.length
    ? await exec.select().from(recurringSchedules)
      .where(and(eq(recurringSchedules.tenantId, tenantId), inArray(recurringSchedules.templateId, ids)))
    : [];
  const schedBy = new Map(schedules.map((s) => [s.templateId!, s]));
  const groupIds = [...new Set(rows.map((r) => r.groupId).filter((g): g is string => !!g))];
  const groups = groupIds.length
    ? await exec.select().from(templateGroups).where(and(eq(templateGroups.tenantId, tenantId), inArray(templateGroups.id, groupIds)))
    : [];
  const groupBy = new Map(groups.map((g) => [g.id, g.name]));
  const stats = await occurrenceStats(exec, tenantId, ids);

  const out = [];
  for (const r of rows) {
    const td = r.kind === 'legacy' ? await legacyDraft(exec, r) : rowsToDraft(r, lines.get(r.id) ?? [], tags.get(r.id) ?? []);
    let total = td ? draftTotal(td) : null;
    if (!td && r.sourceTransactionId) {
      const [src] = await exec.select({ total: transactions.total }).from(transactions)
        .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, r.sourceTransactionId))).limit(1);
      total = src?.total ?? null;
    }
    const header = draftHeader(td);
    const st = stats.get(r.id);
    out.push({
      id: r.id,
      name: r.name,
      kind: r.kind,
      draftKind: td?.kind ?? null,
      clientForm: r.clientForm ?? null,
      groupId: r.groupId ?? null,
      groupName: r.groupId ? groupBy.get(r.groupId) ?? null : null,
      accountId: header.accountId,
      contactId: header.contactId,
      total,
      schedule: presentSchedule(schedBy.get(r.id)),
      lastEnteredDate: st?.lastEnteredDate ?? null,
      openSkipped: st?.openSkipped ?? 0,
      legacy: r.kind === 'legacy',
      sourceTransactionId: r.sourceTransactionId ?? null,
      version: r.version,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      ...(withDraft ? { draft: td?.draft ?? null } : {}),
    });
  }
  return out;
}

export async function listTemplates(tenantId: string, companyId: string, opts: {
  groupId?: string; kind?: string; limit?: number; offset?: number;
} = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);
  const conds = [scope(tenantId, companyId), isNull(templateTransactions.deletedAt)];
  if (opts.groupId) conds.push(eq(templateTransactions.groupId, opts.groupId));
  if (opts.kind) conds.push(eq(templateTransactions.kind, opts.kind as TemplateRow['kind']));
  const where = and(...conds);
  const rows = await db.select().from(templateTransactions).where(where)
    .orderBy(sql`lower(${templateTransactions.name})`, asc(templateTransactions.id)).limit(limit).offset(offset);
  const [{ n } = { n: 0 }] = await db.select({ n: sql<number>`COUNT(*)::int` }).from(templateTransactions).where(where);
  return { templates: await present(db, tenantId, rows, false), total: Number(n) };
}

export async function getTemplate(tenantId: string, companyId: string, id: string) {
  const [row] = await db.select().from(templateTransactions)
    .where(and(scope(tenantId, companyId), eq(templateTransactions.id, id), isNull(templateTransactions.deletedAt))).limit(1);
  if (!row) throw templateNotFound();
  const [t] = await present(db, tenantId, [row], true);
  return t!;
}

/** The live template of the company (no lock), for the route's permission check; 404 otherwise. */
export async function templateRowForAccess(tenantId: string, companyId: string, id: string): Promise<TemplateRow> {
  const [row] = await db.select().from(templateTransactions)
    .where(and(scope(tenantId, companyId), eq(templateTransactions.id, id), isNull(templateTransactions.deletedAt))).limit(1);
  if (!row) throw templateNotFound();
  return row;
}

/** Draft for "Use" (opens the normal form): missing references nulled and listed. Posts nothing. */
export async function getDraftForUse(tenantId: string, companyId: string, id: string) {
  const [row] = await db.select().from(templateTransactions)
    .where(and(scope(tenantId, companyId), eq(templateTransactions.id, id), isNull(templateTransactions.deletedAt))).limit(1);
  if (!row) throw templateNotFound();
  const td = await templateDraft(db, row);
  if (!td) return { kind: row.kind, clientForm: row.clientForm ?? null, draft: null, warnings: [] };
  const warnings = await draftWarnings(db, tenantId, companyId, td);
  const missing = new Set(warnings.filter((w) => w.code === 'NOT_FOUND').map((w) => w.id));
  return {
    kind: td.kind,
    clientForm: row.clientForm ?? null,
    draft: missing.size ? withoutMissing(td, missing) : td.draft,
    warnings: warnings.map((w) => ({ field: w.field, code: w.code, id: w.id })),
  };
}

// ── Writes ─────────────────────────────────────────────────────────

async function assertGroup(tx: Tx, tenantId: string, companyId: string, groupId: string | null | undefined) {
  if (!groupId) return;
  const [g] = await tx.select({ id: templateGroups.id }).from(templateGroups).where(and(
    eq(templateGroups.tenantId, tenantId), eq(templateGroups.id, groupId), eq(templateGroups.companyId, companyId),
  )).limit(1);
  if (!g) throw AppError.badRequest('The template group was not found in this company', 'VALIDATION_ERROR');
}

async function writeDraftRows(tx: Tx, tpl: { id: string; tenantId: string; companyId: string | null }, td: TemplateDraft) {
  const rows = draftToRows(td);
  await tx.delete(templateTransactionLines)
    .where(and(eq(templateTransactionLines.tenantId, tpl.tenantId), eq(templateTransactionLines.templateId, tpl.id)));
  await tx.delete(templateTransactionTags)
    .where(and(eq(templateTransactionTags.tenantId, tpl.tenantId), eq(templateTransactionTags.templateId, tpl.id)));
  if (rows.lines.length) {
    await tx.insert(templateTransactionLines).values(rows.lines.map((l) => ({
      ...l, tenantId: tpl.tenantId, companyId: tpl.companyId, templateId: tpl.id,
    })));
  }
  if (rows.tagIds.length) {
    await tx.insert(templateTransactionTags).values(rows.tagIds.map((tagId) => ({ tenantId: tpl.tenantId, templateId: tpl.id, tagId })));
  }
  return rows.header;
}

function canAuto(kind: string, draftKind: TemplateDraftKind | null): boolean {
  if (kind === 'daily_sales' || draftKind === 'daily_sales') return false;
  return true;
}

/**
 * Creates, changes or removes the template's schedule (one per template).
 * `null` archives it ("Don't remind me"); the same row is reused if a
 * schedule is set again. Setting a new next date also sets the anchor.
 */
export async function writeSchedule(
  tx: Tx, tpl: TemplateRow, input: TemplateScheduleInput | null | undefined, draftKind: TemplateDraftKind | null, userId?: string,
) {
  if (input === undefined) return;
  const existing = await lockSchedule(tx, tpl.tenantId, tpl.id);
  if (input === null) {
    if (existing && !existing.archivedAt) {
      await tx.update(recurringSchedules).set({ isActive: false, archivedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(recurringSchedules.tenantId, tpl.tenantId), eq(recurringSchedules.id, existing.id)));
      await auditLog(tpl.tenantId, 'update', 'recurring_schedule', existing.id, { isActive: existing.isActive }, { isActive: false, archived: true }, userId, tx);
    }
    return;
  }
  if (input.mode === 'auto' && (!canAuto(tpl.kind, draftKind) || (tpl.kind === 'legacy' && draftKind === null && !tpl.sourceTransactionId))) {
    throw autoUnsupported();
  }
  if (input.endDate && input.endDate < input.nextDate) {
    throw AppError.badRequest('The end date must be on or after the next date', 'VALIDATION_ERROR');
  }
  const mode = input.mode === 'auto' ? 'auto' : 'reminder';
  // An auto schedule never starts a catch-up of more than a year: a next
  // date more than AUTO_BACKDATE_MAX_DAYS before today is refused when it is
  // set, moved or switched to auto (an unchanged backlog stays editable).
  const setsAutoDate = mode === 'auto'
    && (!existing || existing.archivedAt !== null || existing.mode !== 'auto' || existing.nextOccurrence !== input.nextDate);
  if (setsAutoDate) {
    const pinned = process.env['NODE_ENV'] === 'test' ? __scheduleClock.today : undefined;
    const r = await tx.execute(pinned
      ? sql`SELECT (${pinned}::date - ${AUTO_BACKDATE_MAX_DAYS}::int)::text AS earliest`
      : sql`SELECT (CURRENT_DATE - ${AUTO_BACKDATE_MAX_DAYS}::int)::text AS earliest`);
    const earliest = (r.rows as Array<{ earliest: string }>)[0]!.earliest;
    if (input.nextDate < earliest) {
      throw new AppError(400,
        `An automatic schedule can't start more than ${AUTO_BACKDATE_MAX_DAYS} days ago. Choose a later next date, or use a reminder.`,
        'VALIDATION_ERROR', { field: 'schedule.nextDate', earliest },
      );
    }
  }
  const fields = {
    name: tpl.name,
    frequency: input.frequency,
    intervalValue: input.intervalValue,
    mode,
    endDate: input.endDate ?? null,
    remainingCount: input.remainingCount ?? null,
    isActive: true,
    archivedAt: null,
    updatedAt: new Date(),
  };
  if (existing) {
    const moved = existing.nextOccurrence !== input.nextDate || existing.archivedAt !== null;
    await tx.update(recurringSchedules).set({
      ...fields,
      ...(moved ? { nextOccurrence: input.nextDate, anchorDate: input.nextDate } : {}),
      ...(moved && !existing.lastPostedAt ? { startDate: input.nextDate } : {}),
    }).where(and(eq(recurringSchedules.tenantId, tpl.tenantId), eq(recurringSchedules.id, existing.id)));
    await auditLog(tpl.tenantId, 'update', 'recurring_schedule', existing.id, null, { templateId: tpl.id, mode, frequency: input.frequency }, userId, tx);
  } else {
    const [s] = await tx.insert(recurringSchedules).values({
      tenantId: tpl.tenantId,
      companyId: tpl.companyId,
      templateId: tpl.id,
      templateTransactionId: null,
      startDate: input.nextDate,
      nextOccurrence: input.nextDate,
      anchorDate: input.nextDate,
      ...fields,
    }).returning({ id: recurringSchedules.id });
    await auditLog(tpl.tenantId, 'create', 'recurring_schedule', s!.id, null, { templateId: tpl.id, mode, frequency: input.frequency }, userId, tx);
  }
}

export async function createTemplate(tenantId: string, companyId: string, userId: string | undefined, input: {
  name: string; groupId?: string | null; kind: TemplateDraftKind; clientForm?: string | null; draft: unknown;
  schedule?: TemplateScheduleInput | null;
}) {
  const td = parseDraft(input.kind, input.draft);
  try {
    const id = await db.transaction(async (tx) => {
      await assertGroup(tx, tenantId, companyId, input.groupId);
      await assertDraftRefsInScope(tx, tenantId, companyId, td);
      const [tpl] = await tx.insert(templateTransactions).values({
        tenantId, companyId, name: input.name, groupId: input.groupId ?? null, kind: td.kind,
        clientForm: input.clientForm ?? null, createdBy: userId ?? null,
      }).returning();
      const header = await writeDraftRows(tx, tpl!, td);
      const [withHeader] = await tx.update(templateTransactions).set(header)
        .where(and(eq(templateTransactions.tenantId, tenantId), eq(templateTransactions.id, tpl!.id))).returning();
      await writeSchedule(tx, withHeader!, input.schedule, td.kind, userId);
      await auditLog(tenantId, 'create', 'template_transaction', tpl!.id, null, { kind: td.kind }, userId, tx);
      return tpl!.id;
    });
    return getTemplate(tenantId, companyId, id);
  } catch (err) {
    if (isUnique(err, 'uq_template_transactions_name')) throw nameTaken();
    throw err;
  }
}

/**
 * "Save as Template" from a posted transaction. Kinds templates can't hold
 * (invoice, bill...) become a 'legacy' template that replays through the
 * old clone path.
 */
export async function createFromTransaction(tenantId: string, companyId: string, userId: string | undefined, input: {
  transactionId: string; name: string; groupId?: string | null; clientForm?: string | null; schedule?: TemplateScheduleInput | null;
}) {
  try {
    const id = await db.transaction(async (tx) => {
      await assertGroup(tx, tenantId, companyId, input.groupId);
      const { txn, snap } = await snapshotForCreate(tx, tenantId, companyId, input.transactionId);
      const kind = snap.kind === 'draft' ? snap.draft.kind : 'legacy';
      const [tpl] = await tx.insert(templateTransactions).values({
        tenantId, companyId, name: input.name, groupId: input.groupId ?? null, kind,
        clientForm: input.clientForm ?? null, sourceTransactionId: txn.id, createdBy: userId ?? null,
      }).returning();
      let row = tpl!;
      if (snap.kind === 'draft') {
        await assertDraftRefsInScope(tx, tenantId, companyId, snap.draft);
        const header = await writeDraftRows(tx, row, snap.draft);
        [row] = await tx.update(templateTransactions).set(header)
          .where(and(eq(templateTransactions.tenantId, tenantId), eq(templateTransactions.id, row.id))).returning() as [TemplateRow];
      }
      await writeSchedule(tx, row, input.schedule, snap.kind === 'draft' ? snap.draft.kind : null, userId);
      await auditLog(tenantId, 'create', 'template_transaction', row.id, null, { kind, sourceTransactionId: txn.id }, userId, tx);
      return row.id;
    });
    return getTemplate(tenantId, companyId, id);
  } catch (err) {
    if (isUnique(err, 'uq_template_transactions_name')) throw nameTaken();
    throw err;
  }
}

export async function updateTemplate(tenantId: string, companyId: string, userId: string | undefined, id: string, input: {
  version: number; name?: string; groupId?: string | null; clientForm?: string | null; draft?: unknown;
  schedule?: TemplateScheduleInput | null;
}) {
  try {
    await db.transaction(async (tx) => {
      const tpl = await lockTemplate(tx, tenantId, companyId, id, 'update');
      if (!tpl) throw templateNotFound();
      if (tpl.version !== input.version) throw stale(tpl.version);
      if (input.groupId !== undefined) await assertGroup(tx, tenantId, companyId, input.groupId);

      // A legacy template whose source reads as a template kind converts now.
      let kind = tpl.kind;
      let td: TemplateDraft | null = null;
      if (tpl.kind === 'legacy') {
        td = await legacyDraft(tx, tpl);
        if (td) kind = td.kind;
      }
      if (input.draft !== undefined) {
        if (kind === 'legacy') {
          throw new AppError(400, 'This template was made from a transaction templates can’t hold; its lines can’t be edited here.',
            'TEMPLATE_FIELD_NOT_ALLOWED', { field: 'draft' });
        }
        td = parseDraft(kind as TemplateDraftKind, input.draft);
      }
      const patch: Partial<typeof templateTransactions.$inferInsert> = {
        version: tpl.version + 1, updatedAt: new Date(), kind,
        // The last editor owns the template's auto runs (permissions.ts).
        ...(userId ? { updatedBy: userId } : {}),
      };
      if (td) {
        await assertDraftRefsInScope(tx, tenantId, companyId, td);
        Object.assign(patch, await writeDraftRows(tx, tpl, td));
      }
      if (input.name !== undefined) patch.name = input.name;
      if (input.groupId !== undefined) patch.groupId = input.groupId;
      if (input.clientForm !== undefined) patch.clientForm = input.clientForm;
      const [updated] = await tx.update(templateTransactions).set(patch)
        .where(and(eq(templateTransactions.tenantId, tenantId), eq(templateTransactions.id, id))).returning();
      if (input.name !== undefined) {
        await tx.update(recurringSchedules).set({ name: input.name })
          .where(and(eq(recurringSchedules.tenantId, tenantId), eq(recurringSchedules.templateId, id)));
      }
      const draftKind = td?.kind ?? (kind === 'legacy' ? null : (kind as TemplateDraftKind));
      await writeSchedule(tx, updated!, input.schedule, draftKind, userId);
      await auditLog(tenantId, 'update', 'template_transaction', id, { version: tpl.version }, { version: tpl.version + 1, kind }, userId, tx);
    });
  } catch (err) {
    if (isUnique(err, 'uq_template_transactions_name')) throw nameTaken();
    throw err;
  }
  return getTemplate(tenantId, companyId, id);
}

/** Soft delete; the schedule stops. Posted transactions and the occurrence log stay. */
export async function deleteTemplate(tenantId: string, companyId: string, userId: string | undefined, id: string, version: number) {
  await db.transaction(async (tx) => {
    const tpl = await lockTemplate(tx, tenantId, companyId, id, 'update');
    if (!tpl) throw templateNotFound();
    if (tpl.version !== version) throw stale(tpl.version);
    await tx.update(templateTransactions).set({ deletedAt: new Date(), version: tpl.version + 1, updatedAt: new Date() })
      .where(and(eq(templateTransactions.tenantId, tenantId), eq(templateTransactions.id, id)));
    const sched = await lockSchedule(tx, tenantId, id);
    if (sched) {
      await tx.update(recurringSchedules).set({ isActive: false, updatedAt: new Date() })
        .where(and(eq(recurringSchedules.tenantId, tenantId), eq(recurringSchedules.id, sched.id)));
    }
    await auditLog(tenantId, 'delete', 'template_transaction', id, { version: tpl.version }, null, userId, tx);
  });
}

// ── Groups ─────────────────────────────────────────────────────────

const groupScope = (tenantId: string, companyId: string) =>
  and(eq(templateGroups.tenantId, tenantId), eq(templateGroups.companyId, companyId));

function groupNameTaken(): AppError {
  return AppError.conflict('A group with this name already exists.', 'TEMPLATE_GROUP_NAME_TAKEN');
}

export async function listGroups(tenantId: string, companyId: string) {
  const groups = await db.select().from(templateGroups).where(groupScope(tenantId, companyId))
    .orderBy(sql`lower(${templateGroups.name})`, asc(templateGroups.id));
  const counts = await db.select({ groupId: templateTransactions.groupId, n: sql<number>`COUNT(*)::int` })
    .from(templateTransactions)
    .where(and(scope(tenantId, companyId), isNull(templateTransactions.deletedAt)))
    .groupBy(templateTransactions.groupId);
  const by = new Map(counts.map((c) => [c.groupId, Number(c.n)]));
  return groups.map((g) => ({ id: g.id, name: g.name, templateCount: by.get(g.id) ?? 0 }));
}

export async function createGroup(tenantId: string, companyId: string, userId: string | undefined, name: string) {
  try {
    const [g] = await db.insert(templateGroups).values({ tenantId, companyId, name }).returning();
    await auditLog(tenantId, 'create', 'template_group', g!.id, null, { id: g!.id }, userId);
    return { id: g!.id, name: g!.name, templateCount: 0 };
  } catch (err) {
    if (isUnique(err, 'uq_template_groups_name')) throw groupNameTaken();
    throw err;
  }
}

export async function updateGroup(tenantId: string, companyId: string, userId: string | undefined, id: string, name: string) {
  try {
    const [g] = await db.update(templateGroups).set({ name, updatedAt: new Date() })
      .where(and(groupScope(tenantId, companyId), eq(templateGroups.id, id))).returning();
    if (!g) throw AppError.notFound('Template group not found');
    await auditLog(tenantId, 'update', 'template_group', id, null, { id }, userId);
    return { id: g.id, name: g.name };
  } catch (err) {
    if (isUnique(err, 'uq_template_groups_name')) throw groupNameTaken();
    throw err;
  }
}

/** Deletes the group; its templates move to no group (ON DELETE SET NULL). */
export async function deleteGroup(tenantId: string, companyId: string, userId: string | undefined, id: string) {
  const [g] = await db.delete(templateGroups).where(and(groupScope(tenantId, companyId), eq(templateGroups.id, id))).returning();
  if (!g) throw AppError.notFound('Template group not found');
  await auditLog(tenantId, 'delete', 'template_group', id, { id }, null, userId);
}

// ── Web / API v2 compatibility (POST /recurring) ───────────────────

/** `base`, or `base (2)`, `base (3)`... — the first name no live template of the company has. */
async function uniqueTemplateName(tx: Tx, tenantId: string, companyId: string | null, base: string): Promise<string> {
  const stem = base.slice(0, 240);
  let name = stem;
  for (let n = 2; ; n++) {
    const [clash] = await tx.select({ id: templateTransactions.id }).from(templateTransactions).where(and(
      eq(templateTransactions.tenantId, tenantId),
      companyId ? eq(templateTransactions.companyId, companyId) : isNull(templateTransactions.companyId),
      sql`lower(${templateTransactions.name}) = lower(${name})`,
      isNull(templateTransactions.deletedAt),
    )).limit(1);
    if (!clash) return name;
    name = `${stem} (${n})`;
  }
}

/**
 * Schedules without a template — imported from a tenant archive older than
 * 0225 — each get a 'legacy' template, as 0225 gave the schedules it found
 * (company of the schedule, else of its source transaction, else the
 * tenant's only company). Idempotent; a row another caller is adopting is
 * skipped. Returns how many were adopted.
 */
export async function adoptOrphanSchedules(tenantId?: string): Promise<number> {
  const orphans = await db.select({ id: recurringSchedules.id }).from(recurringSchedules).where(and(
    isNull(recurringSchedules.templateId),
    ...(tenantId ? [eq(recurringSchedules.tenantId, tenantId)] : []),
  )).limit(1000);
  let adopted = 0;
  for (const o of orphans) {
    adopted += await db.transaction(async (tx) => {
      const [row] = await tx.select().from(recurringSchedules)
        .where(and(eq(recurringSchedules.id, o.id), isNull(recurringSchedules.templateId)))
        .for('update', { skipLocked: true }).limit(1);
      if (!row || !row.templateTransactionId) return 0;
      const src = await loadSource(tx, row.tenantId, null, row.templateTransactionId);
      let companyId = row.companyId ?? src?.companyId ?? null;
      if (!companyId) {
        const only = await tx.execute(sql`SELECT CASE WHEN count(*) = 1 THEN min(id::text) END AS id FROM companies WHERE tenant_id = ${row.tenantId}`);
        companyId = (only.rows as Array<{ id: string | null }>)[0]?.id ?? null;
      }
      const base = row.name?.trim() || `Recurring ${(row.createdAt ?? new Date()).toISOString().slice(0, 10)}`;
      const [tpl] = await tx.insert(templateTransactions).values({
        tenantId: row.tenantId, companyId, name: await uniqueTemplateName(tx, row.tenantId, companyId, base),
        kind: 'legacy', sourceTransactionId: row.templateTransactionId,
      }).returning({ id: templateTransactions.id });
      await tx.update(recurringSchedules).set({ templateId: tpl!.id })
        .where(and(eq(recurringSchedules.tenantId, row.tenantId), eq(recurringSchedules.id, row.id)));
      return 1;
    });
  }
  return adopted;
}

/**
 * A template for a schedule made from a posted transaction (POST /recurring
 * with templateTransactionId): the transaction's draft when it reads as one
 * of the template kinds, else 'legacy'. The name is the schedule's (or
 * "Recurring YYYY-MM-DD"), made unique with " (2)", " (3)"...
 */
export async function templateForSchedule(
  tx: Tx, tenantId: string, templateTransactionId: string, scheduleName: string | null, userId?: string,
): Promise<TemplateRow> {
  const src = await loadSource(tx, tenantId, null, templateTransactionId);
  if (!src) throw AppError.notFound('Transaction not found');
  const snap = src.status === 'posted' ? await snapshotTransaction(tx, tenantId, src) : null;
  const companyId = src.companyId;
  const name = await uniqueTemplateName(tx, tenantId, companyId,
    scheduleName?.trim() || `Recurring ${new Date().toISOString().slice(0, 10)}`);
  const kind = snap?.kind === 'draft' ? snap.draft.kind : 'legacy';
  const [tpl] = await tx.insert(templateTransactions).values({
    tenantId, companyId, name, kind, sourceTransactionId: src.id, createdBy: userId ?? null,
  }).returning();
  if (snap?.kind === 'draft') {
    const header = await writeDraftRows(tx, tpl!, snap.draft);
    const [row] = await tx.update(templateTransactions).set(header)
      .where(and(eq(templateTransactions.tenantId, tenantId), eq(templateTransactions.id, tpl!.id))).returning();
    return row!;
  }
  return tpl!;
}

