// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

/**
 * Saved report definitions (memorized reports) and their groups — U-118,
 * capability report-defs-v1, migration 0274 (ClientLedger P28 PR-F; ADD-03
 * Q-310 / Q-312).
 *
 * Every query is scoped to the tenant AND the company; another tenant's or
 * company's row (or a deleted one) reads as 404. Saved reports are visible
 * to everyone with report access; only the author, an owner or a super
 * admin changes or deletes one (403 NOT_AUTHOR, checked by the route ahead
 * of idempotent()). Writes take the row FOR UPDATE and compare the
 * `version` the caller read: 409 STALE_VERSION {current} on a mismatch.
 *
 * A definition is {schemaVersion: 1, kind: 'standard', reportKey, options},
 * at most 64 KB as JSON (413 DEFINITION_TOO_LARGE). Entity ids may appear
 * only at the fixed option paths below, so tenant archives remap them
 * (plan.ts classifies definition_json as contains-ids); a uuid anywhere
 * else is 400 DEFINITION_INVALID. Ids at those paths must be rows of this
 * tenant visible to this company.
 *
 * Names are never logged; audit rows carry ids, kind, reportKey and
 * versions.
 */

import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db, type Tx } from '../db/index.js';
import {
  accounts, budgets, contacts, items, reportDefinitionGroups, reportDefinitions, tagGroups, tags, users,
  type ReportDefinitionKind,
} from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog, auditLogMany } from '../middleware/audit.js';
import { claimAndRecord } from './idempotency.service.js';

export type DefinitionRow = typeof reportDefinitions.$inferSelect;
export type GroupRow = typeof reportDefinitionGroups.$inferSelect;

/** Largest definition accepted, in bytes of its JSON text. */
export const MAX_DEFINITION_BYTES = 64 * 1024;
export const REPORT_KEY_RE = /^[a-z0-9_]{1,64}$/;
/** Most ids one filter list may hold. */
export const MAX_FILTER_IDS = 1000;
const MAX_DEPTH = 16;

const UUID_TOKEN_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

// ── Errors ─────────────────────────────────────────────────────────

export function stale(current: number): AppError {
  return AppError.conflict('This report was changed since you opened it. Reload it and make your change again.', 'STALE_VERSION', { current });
}

function nameTaken(what: 'report' | 'group'): AppError {
  return AppError.conflict(
    what === 'report' ? 'A saved report with this name already exists. Choose another name.' : 'A group with this name already exists. Choose another name.',
    'NAME_TAKEN',
  );
}

export function definitionNotFound(): AppError {
  return AppError.notFound('Saved report not found');
}

export function groupNotFound(): AppError {
  return AppError.notFound('Report group not found');
}

function invalid(message: string, path: string): AppError {
  return AppError.badRequest(message, 'DEFINITION_INVALID', { path });
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

// ── Definition validation ──────────────────────────────────────────

export interface ReportDefinition {
  schemaVersion: 1;
  kind: ReportDefinitionKind;
  reportKey: string;
  options: Record<string, unknown>;
}

const definitionShape = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('standard'),
  reportKey: z.string().regex(REPORT_KEY_RE),
  options: z.record(z.unknown()).default({}),
}).strict();

type IdKind = 'accounts' | 'contacts' | 'tags' | 'items' | 'tagGroups' | 'budgets';
/** The ids a definition names, by path. */
export type DefinitionRefs = Array<{ kind: IdKind; path: string; ids: string[] }>;

/** The only places an entity id may appear (tenant archives remap them). */
const ID_LIST_PATHS: Record<string, IdKind> = {
  'options.filters.accountIds': 'accounts',
  'options.filters.contactIds': 'contacts',
  'options.filters.tagIds': 'tags',
  'options.filters.itemIds': 'items',
};
const ID_SCALAR_PATHS: Record<string, IdKind> = {
  'options.tagSplit.tagGroupId': 'tagGroups',
  // The tag group whose tags become the report's columns (P28 compare=by_tag).
  'options.columnTagGroupId': 'tagGroups',
  'options.budgetId': 'budgets',
};

const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Object.prototype.toString.call(v) === '[object Object]';
}

/**
 * Checks the shape, size and id paths of a definition; returns it with the
 * ids it names, by kind. Throws 413 DEFINITION_TOO_LARGE or 400
 * DEFINITION_INVALID {path}.
 */
export function parseDefinition(raw: unknown): { definition: ReportDefinition; refs: DefinitionRefs } {
  if (raw === undefined || raw === null) throw invalid('A definition is required.', 'definition');
  const text = JSON.stringify(raw);
  if (Buffer.byteLength(text, 'utf8') > MAX_DEFINITION_BYTES) {
    throw new AppError(413, 'This saved report is too large to store.', 'DEFINITION_TOO_LARGE', { limit: MAX_DEFINITION_BYTES });
  }
  const parsed = definitionShape.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const path = ['definition', ...issue.path].join('.');
    throw invalid(`The saved report is not valid: ${issue.message}.`, path);
  }
  const definition = parsed.data as ReportDefinition;
  const refs: DefinitionRefs = [];

  const walk = (v: unknown, path: string, depth: number): void => {
    if (depth > MAX_DEPTH) throw invalid('The saved report is nested too deeply.', path);
    const list = ID_LIST_PATHS[path];
    if (list) {
      if (!Array.isArray(v) || v.length > MAX_FILTER_IDS || v.some((x) => typeof x !== 'string' || !uuidRe.test(x))) {
        throw invalid(`${path} must be a list of at most ${MAX_FILTER_IDS} ids.`, path);
      }
      refs.push({ kind: list, path, ids: [...new Set((v as string[]).map((x) => x.toLowerCase()))] });
      return;
    }
    const scalar = ID_SCALAR_PATHS[path];
    if (scalar) {
      if (v === null) return;
      if (typeof v !== 'string' || !uuidRe.test(v)) throw invalid(`${path} must be an id or null.`, path);
      refs.push({ kind: scalar, path, ids: [v.toLowerCase()] });
      return;
    }
    if (typeof v === 'string') {
      if (UUID_TOKEN_RE.test(v)) throw invalid('Ids may appear only in the filter, tag split and budget options.', path);
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((x, i) => walk(x, `${path}.${i}`, depth + 1));
      return;
    }
    if (isPlainObject(v)) {
      for (const [k, x] of Object.entries(v)) {
        if (UUID_TOKEN_RE.test(k)) throw invalid('Ids may appear only in the filter, tag split and budget options.', `${path}.${k}`);
        walk(x, `${path}.${k}`, depth + 1);
      }
    }
  };
  walk(definition.options, 'options', 0);
  return { definition, refs };
}

const REF_TABLES = { accounts, contacts, tags, items, tagGroups, budgets } as const;

/** Every id must be a row of this tenant, shared or of this company. */
async function assertRefsInScope(tx: Tx, tenantId: string, companyId: string, refs: DefinitionRefs): Promise<void> {
  for (const { kind, path, ids } of refs) {
    if (ids.length === 0) continue;
    const table = REF_TABLES[kind];
    const rows = await tx.select({ id: table.id, companyId: table.companyId }).from(table)
      .where(and(eq(table.tenantId, tenantId), inArray(table.id, ids)));
    if (rows.length !== ids.length || rows.some((r) => r.companyId !== null && r.companyId !== companyId)) {
      throw invalid('The saved report names something that is not in this company.', path);
    }
  }
}

// ── Reads ──────────────────────────────────────────────────────────

const defScope = (tenantId: string, companyId: string) =>
  and(eq(reportDefinitions.tenantId, tenantId), eq(reportDefinitions.companyId, companyId), isNull(reportDefinitions.deletedAt));

const groupScope = (tenantId: string, companyId: string) =>
  and(eq(reportDefinitionGroups.tenantId, tenantId), eq(reportDefinitionGroups.companyId, companyId), isNull(reportDefinitionGroups.deletedAt));

export interface Viewer { userId?: string; userRole?: string; isSuperAdmin?: boolean }

/** Q-310: the author, an owner or a super admin. */
export function canEdit(row: Pick<DefinitionRow, 'createdBy'>, viewer: Viewer): boolean {
  return !!viewer.isSuperAdmin || viewer.userRole === 'owner' || (!!viewer.userId && row.createdBy === viewer.userId);
}

function toApi(r: DefinitionRow, createdByName: string | null, viewer: Viewer) {
  return {
    id: r.id,
    groupId: r.groupId,
    name: r.name,
    kind: r.kind,
    definition: r.definitionJson,
    version: r.version,
    createdBy: r.createdBy,
    createdByName,
    canEdit: canEdit(r, viewer),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export async function listDefinitions(tenantId: string, companyId: string, viewer: Viewer, opts: { groupId?: string | 'none'; kind?: ReportDefinitionKind } = {}) {
  const conds = [defScope(tenantId, companyId)];
  if (opts.groupId === 'none') conds.push(isNull(reportDefinitions.groupId));
  else if (opts.groupId) conds.push(eq(reportDefinitions.groupId, opts.groupId));
  if (opts.kind) conds.push(eq(reportDefinitions.kind, opts.kind));
  const rows = await db.select({ d: reportDefinitions, createdByName: users.displayName })
    .from(reportDefinitions)
    .leftJoin(users, eq(users.id, reportDefinitions.createdBy))
    .where(and(...conds))
    .orderBy(sql`lower(${reportDefinitions.name})`, asc(reportDefinitions.id));
  return rows.map((r) => toApi(r.d, r.createdByName ?? null, viewer));
}

export async function getDefinition(tenantId: string, companyId: string, id: string, viewer: Viewer) {
  const [r] = await db.select({ d: reportDefinitions, createdByName: users.displayName })
    .from(reportDefinitions)
    .leftJoin(users, eq(users.id, reportDefinitions.createdBy))
    .where(and(defScope(tenantId, companyId), eq(reportDefinitions.id, id)))
    .limit(1);
  if (!r) throw definitionNotFound();
  return toApi(r.d, r.createdByName ?? null, viewer);
}

/** The live row of this company, for the route's access check; 404 otherwise. */
export async function definitionForAccess(tenantId: string, companyId: string, id: string): Promise<DefinitionRow> {
  const [r] = await db.select().from(reportDefinitions).where(and(defScope(tenantId, companyId), eq(reportDefinitions.id, id))).limit(1);
  if (!r) throw definitionNotFound();
  return r;
}

async function lockDefinition(tx: Tx, tenantId: string, companyId: string, id: string): Promise<DefinitionRow> {
  const [r] = await tx.select().from(reportDefinitions)
    .where(and(defScope(tenantId, companyId), eq(reportDefinitions.id, id))).for('update').limit(1);
  if (!r) throw definitionNotFound();
  return r;
}

async function assertGroup(tx: Tx, tenantId: string, companyId: string, groupId: string | null | undefined): Promise<void> {
  if (!groupId) return;
  const [g] = await tx.select({ id: reportDefinitionGroups.id }).from(reportDefinitionGroups)
    .where(and(groupScope(tenantId, companyId), eq(reportDefinitionGroups.id, groupId))).for('share').limit(1);
  if (!g) throw AppError.badRequest('The group was not found in this company.', 'VALIDATION_ERROR', { field: 'groupId' });
}

const auditShape = (r: Pick<DefinitionRow, 'kind' | 'version' | 'groupId' | 'definitionJson'>) => ({
  kind: r.kind, reportKey: (r.definitionJson as { reportKey?: unknown }).reportKey ?? null, groupId: r.groupId, version: r.version,
});

// ── Writes ─────────────────────────────────────────────────────────

export async function createDefinition(tenantId: string, companyId: string, viewer: Viewer, input: {
  name: string; groupId?: string | null; kind?: ReportDefinitionKind; definition: unknown;
}) {
  const { definition, refs } = parseDefinition(input.definition);
  if (input.kind !== undefined && input.kind !== definition.kind) throw invalid('kind must match definition.kind.', 'kind');
  try {
    const id = await db.transaction(async (tx) => {
      await assertGroup(tx, tenantId, companyId, input.groupId);
      await assertRefsInScope(tx, tenantId, companyId, refs);
      const [row] = await tx.insert(reportDefinitions).values({
        tenantId, companyId, groupId: input.groupId ?? null, name: input.name, kind: definition.kind,
        definitionJson: definition as unknown as Record<string, unknown>,
        createdBy: viewer.userId ?? null, updatedBy: viewer.userId ?? null,
      }).returning();
      await claimAndRecord(tx, 'report_definition', row!.id);
      await auditLog(tenantId, 'create', 'report_definition', row!.id, null, auditShape(row!), viewer.userId, tx);
      return row!.id;
    });
    return getDefinition(tenantId, companyId, id, viewer);
  } catch (err) {
    if (isUnique(err, 'uq_report_definitions_name')) throw nameTaken('report');
    throw err;
  }
}

export async function updateDefinition(tenantId: string, companyId: string, viewer: Viewer, id: string, input: {
  version: number; name?: string; groupId?: string | null; kind?: ReportDefinitionKind; definition?: unknown;
}) {
  const parsed = input.definition !== undefined ? parseDefinition(input.definition) : null;
  try {
    await db.transaction(async (tx) => {
      const row = await lockDefinition(tx, tenantId, companyId, id);
      if (!canEdit(row, viewer)) throw notAuthor();
      if (row.version !== input.version) throw stale(row.version);
      if (parsed && parsed.definition.kind !== row.kind) throw invalid('A saved report cannot change its kind.', 'definition.kind');
      if (input.kind !== undefined && input.kind !== row.kind) throw invalid('A saved report cannot change its kind.', 'kind');
      if (input.groupId !== undefined) await assertGroup(tx, tenantId, companyId, input.groupId);
      if (parsed) await assertRefsInScope(tx, tenantId, companyId, parsed.refs);
      const [next] = await tx.update(reportDefinitions).set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.groupId !== undefined ? { groupId: input.groupId } : {}),
        ...(parsed ? { definitionJson: parsed.definition as unknown as Record<string, unknown> } : {}),
        version: row.version + 1, updatedBy: viewer.userId ?? null, updatedAt: new Date(),
      }).where(and(eq(reportDefinitions.tenantId, tenantId), eq(reportDefinitions.id, id))).returning();
      await claimAndRecord(tx, 'report_definition', id);
      await auditLog(tenantId, 'update', 'report_definition', id, auditShape(row), auditShape(next!), viewer.userId, tx);
    });
    return getDefinition(tenantId, companyId, id, viewer);
  } catch (err) {
    if (isUnique(err, 'uq_report_definitions_name')) throw nameTaken('report');
    throw err;
  }
}

export function notAuthor(): AppError {
  return AppError.forbidden('Only the person who saved this report, an owner or an administrator can change it. Memorize a copy instead.', 'NOT_AUTHOR');
}

/** Soft delete. */
export async function deleteDefinition(tenantId: string, companyId: string, viewer: Viewer, id: string, version: number) {
  await db.transaction(async (tx) => {
    const row = await lockDefinition(tx, tenantId, companyId, id);
    if (!canEdit(row, viewer)) throw notAuthor();
    if (row.version !== version) throw stale(row.version);
    await tx.update(reportDefinitions).set({ deletedAt: new Date(), version: row.version + 1, updatedBy: viewer.userId ?? null, updatedAt: new Date() })
      .where(and(eq(reportDefinitions.tenantId, tenantId), eq(reportDefinitions.id, id)));
    await auditLog(tenantId, 'delete', 'report_definition', id, auditShape(row), null, viewer.userId, tx);
  });
}

// ── Groups ─────────────────────────────────────────────────────────

function groupToApi(g: GroupRow, definitionCount: number) {
  return { id: g.id, name: g.name, sort: g.sort, version: g.version, definitionCount, updatedAt: g.updatedAt.toISOString() };
}

async function groupCount(tenantId: string, companyId: string, groupId: string): Promise<number> {
  const [r] = await db.select({ n: sql<number>`COUNT(*)::int` }).from(reportDefinitions)
    .where(and(defScope(tenantId, companyId), eq(reportDefinitions.groupId, groupId)));
  return Number(r?.n ?? 0);
}

export async function listGroups(tenantId: string, companyId: string) {
  const groups = await db.select().from(reportDefinitionGroups).where(groupScope(tenantId, companyId))
    .orderBy(asc(reportDefinitionGroups.sort), sql`lower(${reportDefinitionGroups.name})`, asc(reportDefinitionGroups.id));
  const counts = await db.select({ groupId: reportDefinitions.groupId, n: sql<number>`COUNT(*)::int` })
    .from(reportDefinitions).where(defScope(tenantId, companyId)).groupBy(reportDefinitions.groupId);
  const by = new Map(counts.map((c) => [c.groupId, Number(c.n)]));
  return groups.map((g) => groupToApi(g, by.get(g.id) ?? 0));
}

export async function getGroup(tenantId: string, companyId: string, id: string) {
  const [g] = await db.select().from(reportDefinitionGroups).where(and(groupScope(tenantId, companyId), eq(reportDefinitionGroups.id, id))).limit(1);
  if (!g) throw groupNotFound();
  return groupToApi(g, await groupCount(tenantId, companyId, id));
}

async function lockGroup(tx: Tx, tenantId: string, companyId: string, id: string): Promise<GroupRow> {
  const [g] = await tx.select().from(reportDefinitionGroups)
    .where(and(groupScope(tenantId, companyId), eq(reportDefinitionGroups.id, id))).for('update').limit(1);
  if (!g) throw groupNotFound();
  return g;
}

export async function createGroup(tenantId: string, companyId: string, userId: string | undefined, input: { name: string; sort?: number }) {
  try {
    const id = await db.transaction(async (tx) => {
      const [g] = await tx.insert(reportDefinitionGroups).values({ tenantId, companyId, name: input.name, sort: input.sort ?? 0 }).returning();
      await claimAndRecord(tx, 'report_definition_group', g!.id);
      await auditLog(tenantId, 'create', 'report_definition_group', g!.id, null, { sort: g!.sort, version: 1 }, userId, tx);
      return g!.id;
    });
    return getGroup(tenantId, companyId, id);
  } catch (err) {
    if (isUnique(err, 'uq_report_definition_groups_name')) throw nameTaken('group');
    throw err;
  }
}

export async function updateGroup(tenantId: string, companyId: string, userId: string | undefined, id: string, input: {
  version: number; name?: string; sort?: number;
}) {
  try {
    await db.transaction(async (tx) => {
      const g = await lockGroup(tx, tenantId, companyId, id);
      if (g.version !== input.version) throw stale(g.version);
      await tx.update(reportDefinitionGroups).set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.sort !== undefined ? { sort: input.sort } : {}),
        version: g.version + 1, updatedAt: new Date(),
      }).where(and(eq(reportDefinitionGroups.tenantId, tenantId), eq(reportDefinitionGroups.id, id)));
      await claimAndRecord(tx, 'report_definition_group', id);
      await auditLog(tenantId, 'update', 'report_definition_group', id, { sort: g.sort, version: g.version },
        { sort: input.sort ?? g.sort, version: g.version + 1 }, userId, tx);
    });
    return getGroup(tenantId, companyId, id);
  } catch (err) {
    if (isUnique(err, 'uq_report_definition_groups_name')) throw nameTaken('group');
    throw err;
  }
}

/** Soft delete; its saved reports move to no group (each gets a new version). */
export async function deleteGroup(tenantId: string, companyId: string, userId: string | undefined, id: string, version: number) {
  await db.transaction(async (tx) => {
    const g = await lockGroup(tx, tenantId, companyId, id);
    if (g.version !== version) throw stale(g.version);
    const moved = await tx.update(reportDefinitions).set({
      groupId: null, version: sql`${reportDefinitions.version} + 1`, updatedBy: userId ?? null, updatedAt: new Date(),
    }).where(and(defScope(tenantId, companyId), eq(reportDefinitions.groupId, id)))
      .returning({ id: reportDefinitions.id, version: reportDefinitions.version });
    await tx.update(reportDefinitionGroups).set({ deletedAt: new Date(), version: g.version + 1, updatedAt: new Date() })
      .where(and(eq(reportDefinitionGroups.tenantId, tenantId), eq(reportDefinitionGroups.id, id)));
    await auditLog(tenantId, 'delete', 'report_definition_group', id, { sort: g.sort, version: g.version }, null, userId, tx);
    if (moved.length > 0) {
      await auditLogMany(tenantId, moved.map((m) => ({
        action: 'update' as const, entityType: 'report_definition', entityId: m.id,
        before: { groupId: id, version: m.version - 1 }, after: { groupId: null, version: m.version, reason: 'group_deleted' },
      })), userId, tx);
    }
  });
}
