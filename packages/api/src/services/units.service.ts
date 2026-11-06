// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Units of measure (U-161, units-of-measure-v1, Q-P24i).
 *
 * A unit set has a base unit (on unit_sets) and other units
 * (unit_set_units), each with a fixed factor = base units per unit. Items
 * name a set and default purchase / sale units (NULL = the base unit). Every
 * item line may name a unit (journal_lines.unit_id, NULL = base): quantity
 * and unitPrice stay in the entered unit, so the line amount
 * round2(quantity x unitPrice) never changes, and the ledger core stores
 * base_quantity = round4(quantity x factor), half away from zero at 40
 * digits (Q-P24v). Costing, on hand and reports read base quantities
 * (inventory-costing.service baseQuantity). A unit named on any line keeps
 * its factor and set (409 UNIT_IN_USE, Q-P24w); new units can be added; an
 * item's set changes only while no line names the item.
 *
 * Locks: a posting share-locks the units its lines name (resolveLineUnits,
 * before the costing lock); a unit-set edit locks its unit rows FOR UPDATE
 * before it checks use, and an item edit that changes the set locks the old
 * set's unit rows before the item row, so a change waits for any posting
 * that names a unit and then sees its lines.
 */

import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { CreateUnitSetInput, UpdateUnitSetInput } from '@kis-books/shared';
import { db, type DbOrTx, type Tx } from '../db/index.js';
import { items, unitSetUnits, unitSets } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import { Decimal, type Dec } from '../utils/inventory-walk.js';
import { assertNotStale } from './ledger.service.js';
import { claimIdempotency, recordIdempotentEntity } from './idempotency.service.js';

/** round4 half away from zero (Q-P24v). */
const round4 = (v: Dec) => v.toDecimalPlaces(4, Decimal.ROUND_HALF_UP);

export interface UnitRecord { id: string; name: string; abbreviation: string | null; factor: string }
export interface UnitSetRecord {
  id: string; name: string; baseUnitName: string; baseUnitAbbreviation: string | null; isActive: boolean;
  units: UnitRecord[]; inUse: boolean; updatedAt: string;
}

async function companyOf(executor: DbOrTx, tenantId: string, companyId?: string | null): Promise<string> {
  if (companyId) return companyId;
  const r = await executor.execute(sql`SELECT id FROM companies WHERE tenant_id = ${tenantId} ORDER BY created_at, id LIMIT 1`);
  const row = r.rows[0] as { id: string } | undefined;
  if (!row) throw AppError.notFound('Company not found');
  return row.id;
}

/** The units of `unitIds` that any journal line names (any status: a void or deleted line keeps its unit). */
async function unitsInUse(executor: DbOrTx, tenantId: string, unitIds: readonly string[]): Promise<Set<string>> {
  if (unitIds.length === 0) return new Set();
  const r = await executor.execute(sql`
    SELECT DISTINCT unit_id::text AS id FROM journal_lines
    WHERE tenant_id = ${tenantId} AND unit_id IN (${sql.join(unitIds.map((u) => sql`${u}::uuid`), sql`, `)})`);
  return new Set((r.rows as Array<{ id: string }>).map((x) => x.id));
}

async function setRecord(executor: DbOrTx, tenantId: string, set: typeof unitSets.$inferSelect): Promise<UnitSetRecord> {
  const units = await executor.select().from(unitSetUnits)
    .where(and(eq(unitSetUnits.tenantId, tenantId), eq(unitSetUnits.unitSetId, set.id))).orderBy(asc(unitSetUnits.sortOrder), asc(unitSetUnits.id));
  const used = await unitsInUse(executor, tenantId, units.map((u) => u.id));
  const named = await executor.select({ id: items.id }).from(items).where(and(eq(items.tenantId, tenantId), eq(items.unitSetId, set.id))).limit(1);
  return {
    id: set.id, name: set.name, baseUnitName: set.baseUnitName, baseUnitAbbreviation: set.baseUnitAbbreviation ?? null, isActive: set.isActive,
    units: units.map((u) => ({ id: u.id, name: u.name, abbreviation: u.abbreviation ?? null, factor: new Decimal(u.factor).toFixed(6) })),
    inUse: used.size > 0 || named.length > 0, updatedAt: set.updatedAt.toISOString(),
  };
}

async function loadSet(executor: DbOrTx, tenantId: string, id: string, companyId: string, lock = false) {
  const q = executor.select().from(unitSets).where(and(eq(unitSets.tenantId, tenantId), eq(unitSets.id, id))).limit(1);
  const [row] = lock ? await q.for('update') : await q;
  if (!row || row.companyId !== companyId) throw AppError.notFound('Unit set not found');
  return row;
}

function assertDistinctNames(baseUnitName: string, units: ReadonlyArray<{ name: string }>) {
  const seen = new Set([baseUnitName.trim().toLowerCase()]);
  units.forEach((u, i) => {
    const k = u.name.trim().toLowerCase();
    if (seen.has(k)) throw AppError.badRequest(`units[${i}].name is used twice in this unit set`, 'VALIDATION_ERROR', { field: `units[${i}].name` });
    seen.add(k);
  });
}

async function assertNameFree(executor: DbOrTx, tenantId: string, companyId: string, name: string, exceptId?: string) {
  const r = await executor.execute(sql`SELECT id::text AS id FROM unit_sets WHERE tenant_id = ${tenantId} AND company_id = ${companyId} AND lower(name) = lower(${name}) LIMIT 1`);
  const row = r.rows[0] as { id: string } | undefined;
  if (row && row.id !== exceptId) throw AppError.conflict('A unit set with this name already exists', 'DUPLICATE_NAME');
}

export async function listUnitSets(tenantId: string, companyId?: string): Promise<{ data: UnitSetRecord[]; total: number }> {
  const co = await companyOf(db, tenantId, companyId);
  const sets = await db.select().from(unitSets).where(and(eq(unitSets.tenantId, tenantId), eq(unitSets.companyId, co))).orderBy(asc(unitSets.name), asc(unitSets.id));
  const data = [];
  for (const s of sets) data.push(await setRecord(db, tenantId, s));
  return { data, total: data.length };
}

export async function getUnitSet(tenantId: string, id: string, companyId?: string, executor: DbOrTx = db): Promise<UnitSetRecord> {
  const co = await companyOf(executor, tenantId, companyId);
  return setRecord(executor, tenantId, await loadSet(executor, tenantId, id, co));
}

/** POST /unit-sets. */
export async function createUnitSet(tenantId: string, input: CreateUnitSetInput, userId?: string, companyId?: string): Promise<UnitSetRecord> {
  assertDistinctNames(input.baseUnitName, input.units);
  if (input.units.some((u) => u.id)) throw AppError.badRequest('A new unit set takes no unit ids', 'VALIDATION_ERROR', { field: 'units' });
  return db.transaction(async (tx) => {
    await claimIdempotency(tx);
    const co = await companyOf(tx, tenantId, companyId);
    await assertNameFree(tx, tenantId, co, input.name);
    const [set] = await tx.insert(unitSets).values({
      tenantId, companyId: co, name: input.name, baseUnitName: input.baseUnitName, baseUnitAbbreviation: input.baseUnitAbbreviation ?? null,
    }).returning();
    if (input.units.length > 0) {
      await tx.insert(unitSetUnits).values(input.units.map((u, i) => ({
        tenantId, companyId: co, unitSetId: set!.id, name: u.name, abbreviation: u.abbreviation ?? null, factor: u.factor, sortOrder: i,
      })));
    }
    await recordIdempotentEntity(tx, 'unit_set', set!.id);
    const rec = await setRecord(tx, tenantId, set!);
    await auditLog(tenantId, 'create', 'unit_set', set!.id, null, { name: rec.name, units: rec.units.length }, userId, tx);
    return rec;
  });
}

/**
 * PUT /unit-sets/:id: the set row and its unit rows are locked (FOR UPDATE,
 * so a posting naming one of its units finishes first); expectedUpdatedAt
 * that no longer matches is 409 STALE. `units` is the whole list: a kept
 * unit (by id) named on any line can't change its factor or be removed
 * (409 UNIT_IN_USE); names and abbreviations may change; new units are added.
 * A unit an item names as its default can't be removed (409 UNIT_IN_USE).
 */
export async function updateUnitSet(tenantId: string, id: string, input: UpdateUnitSetInput, userId?: string, companyId?: string): Promise<UnitSetRecord> {
  return db.transaction(async (tx) => {
    await claimIdempotency(tx);
    const co = await companyOf(tx, tenantId, companyId);
    const set = await loadSet(tx, tenantId, id, co, true);
    assertNotStale(set, input.expectedUpdatedAt, 'This unit set');
    const before = await setRecord(tx, tenantId, set);
    const current = await tx.select().from(unitSetUnits)
      .where(and(eq(unitSetUnits.tenantId, tenantId), eq(unitSetUnits.unitSetId, id))).orderBy(asc(unitSetUnits.id)).for('update');
    if (input.name !== undefined && input.name.toLowerCase() !== set.name.toLowerCase()) await assertNameFree(tx, tenantId, co, input.name, id);
    const baseName = input.baseUnitName ?? set.baseUnitName;
    if (input.units) {
      assertDistinctNames(baseName, input.units);
      const byId = new Map(current.map((u) => [u.id, u]));
      const used = await unitsInUse(tx, tenantId, current.map((u) => u.id));
      const keptIds = new Set<string>();
      input.units.forEach((u, i) => {
        if (!u.id) return;
        const old = byId.get(u.id);
        if (!old) throw AppError.badRequest(`units[${i}].id is not a unit of this set`, 'VALIDATION_ERROR', { field: `units[${i}].id` });
        keptIds.add(u.id);
        if (used.has(u.id) && !new Decimal(old.factor).equals(new Decimal(u.factor))) {
          throw AppError.conflict(`The unit ${old.name} is on transactions, so its factor can't change. Add a new unit instead.`, 'UNIT_IN_USE', { unitId: u.id });
        }
      });
      const removed = current.filter((u) => !keptIds.has(u.id));
      const removedUsed = removed.filter((u) => used.has(u.id));
      if (removedUsed.length > 0) {
        throw AppError.conflict(`The unit ${removedUsed[0]!.name} is on transactions, so it can't be removed.`, 'UNIT_IN_USE', { unitId: removedUsed[0]!.id });
      }
      if (removed.length > 0) {
        const ids = removed.map((u) => u.id);
        const defaults = await tx.execute(sql`SELECT id::text AS id FROM items WHERE tenant_id = ${tenantId}
          AND (default_purchase_unit_id IN (${sql.join(ids.map((u) => sql`${u}::uuid`), sql`, `)}) OR default_sale_unit_id IN (${sql.join(ids.map((u) => sql`${u}::uuid`), sql`, `)})) LIMIT 1`);
        if (defaults.rows.length > 0) {
          throw AppError.conflict('An item uses this unit as its default purchase or sale unit, so it can\'t be removed.', 'UNIT_IN_USE',
            { itemId: (defaults.rows[0] as { id: string }).id });
        }
        await tx.delete(unitSetUnits).where(and(eq(unitSetUnits.tenantId, tenantId), inArray(unitSetUnits.id, ids)));
      }
      for (const [i, u] of input.units.entries()) {
        if (u.id) {
          await tx.update(unitSetUnits).set({ name: u.name, abbreviation: u.abbreviation ?? null, factor: u.factor, sortOrder: i, updatedAt: new Date() })
            .where(and(eq(unitSetUnits.tenantId, tenantId), eq(unitSetUnits.id, u.id)));
        } else {
          await tx.insert(unitSetUnits).values({ tenantId, companyId: co, unitSetId: id, name: u.name, abbreviation: u.abbreviation ?? null, factor: u.factor, sortOrder: i });
        }
      }
    } else if (input.baseUnitName !== undefined) {
      assertDistinctNames(baseName, current);
    }
    const [updated] = await tx.update(unitSets).set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.baseUnitName !== undefined ? { baseUnitName: input.baseUnitName } : {}),
      ...(input.baseUnitAbbreviation !== undefined ? { baseUnitAbbreviation: input.baseUnitAbbreviation ?? null } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      updatedAt: new Date(),
    }).where(and(eq(unitSets.tenantId, tenantId), eq(unitSets.id, id))).returning();
    const rec = await setRecord(tx, tenantId, updated!);
    await auditLog(tenantId, 'update', 'unit_set', id,
      { name: before.name, units: before.units.map((u) => ({ id: u.id, factor: u.factor })) },
      { name: rec.name, units: rec.units.map((u) => ({ id: u.id, factor: u.factor })) }, userId, tx);
    return rec;
  });
}

/** DELETE /unit-sets/:id: only while no item names the set and no line names its units (409 UNIT_IN_USE). */
export async function deleteUnitSet(tenantId: string, id: string, userId?: string, companyId?: string) {
  return db.transaction(async (tx) => {
    const co = await companyOf(tx, tenantId, companyId);
    const set = await loadSet(tx, tenantId, id, co, true);
    const units = await tx.select({ id: unitSetUnits.id }).from(unitSetUnits)
      .where(and(eq(unitSetUnits.tenantId, tenantId), eq(unitSetUnits.unitSetId, id))).orderBy(asc(unitSetUnits.id)).for('update');
    const named = await tx.select({ id: items.id }).from(items).where(and(eq(items.tenantId, tenantId), eq(items.unitSetId, id))).limit(1);
    if (named.length > 0 || (await unitsInUse(tx, tenantId, units.map((u) => u.id))).size > 0) {
      throw AppError.conflict('Items or transactions use this unit set. Make it inactive instead.', 'UNIT_IN_USE', { unitSetId: id });
    }
    await tx.delete(unitSetUnits).where(and(eq(unitSetUnits.tenantId, tenantId), eq(unitSetUnits.unitSetId, id)));
    await tx.delete(unitSets).where(and(eq(unitSets.tenantId, tenantId), eq(unitSets.id, id)));
    await auditLog(tenantId, 'delete', 'unit_set', id, { name: set.name }, null, userId, tx);
    return { id, deleted: true };
  });
}

// ─── Items ───────────────────────────────────────────────────────────

/**
 * An item's unit fields (U-161), on create or edit: unitSetId an active set
 * of the company, the default units units of that set (or null = base).
 * 400 VALIDATION_ERROR with details.field otherwise.
 */
export async function assertItemUnits(executor: DbOrTx, tenantId: string, companyId: string | null | undefined,
  next: { unitSetId?: string | null; defaultPurchaseUnitId?: string | null; defaultSaleUnitId?: string | null }) {
  const bad = (message: string, field: string) => AppError.badRequest(message, 'VALIDATION_ERROR', { field });
  if (!next.unitSetId) {
    if (next.defaultPurchaseUnitId) throw bad('A default purchase unit needs a unit set', 'defaultPurchaseUnitId');
    if (next.defaultSaleUnitId) throw bad('A default sale unit needs a unit set', 'defaultSaleUnitId');
    return;
  }
  const co = await companyOf(executor, tenantId, companyId);
  const [set] = await executor.select().from(unitSets).where(and(eq(unitSets.tenantId, tenantId), eq(unitSets.id, next.unitSetId))).limit(1);
  if (!set || set.companyId !== co || !set.isActive) throw bad('unitSetId is not an active unit set of this company', 'unitSetId');
  for (const field of ['defaultPurchaseUnitId', 'defaultSaleUnitId'] as const) {
    const unitId = next[field];
    if (!unitId) continue;
    const [u] = await executor.select({ setId: unitSetUnits.unitSetId }).from(unitSetUnits)
      .where(and(eq(unitSetUnits.tenantId, tenantId), eq(unitSetUnits.id, unitId))).limit(1);
    if (!u || u.setId !== next.unitSetId) throw bad(`${field} is not a unit of the item's unit set`, field);
  }
}

/**
 * Before an item edit that changes unitSetId (before the item row lock):
 * locks the old set's unit rows, so a posting naming one of them finishes
 * first, then refuses the change while any line names the item (409
 * UNIT_IN_USE, Q-P24w).
 */
export async function lockForSetChange(tx: Tx, tenantId: string, oldSetId: string | null) {
  if (!oldSetId) return;
  await tx.select({ id: unitSetUnits.id }).from(unitSetUnits)
    .where(and(eq(unitSetUnits.tenantId, tenantId), eq(unitSetUnits.unitSetId, oldSetId))).orderBy(asc(unitSetUnits.id)).for('update');
}

export async function assertSetChangeAllowed(executor: DbOrTx, tenantId: string, itemId: string) {
  const r = await executor.execute(sql`SELECT 1 FROM journal_lines WHERE tenant_id = ${tenantId} AND item_id = ${itemId} LIMIT 1`);
  if (r.rows.length > 0) {
    throw AppError.conflict('This item is on transactions, so its unit set can\'t change. Add units to its set instead.', 'UNIT_IN_USE', { itemId });
  }
}

export interface UnitPrice { unitId: string | null; name: string; abbreviation: string | null; factor: string; unitPrice: string | null }

/**
 * GET /items: `unitPrices` per unit of an item's set, the base unit first
 * (unitId null, factor 1): round4(unitPrice x factor), half away from zero
 * (the default price of a line in that unit; editable). Null for items
 * without a set.
 */
export async function withUnitPrices<T extends { id: string; unitSetId?: string | null; unitPrice?: string | null }>(
  executor: DbOrTx, tenantId: string, rows: T[]): Promise<Array<T & { unitPrices: UnitPrice[] | null }>> {
  const setIds = [...new Set(rows.map((r) => r.unitSetId).filter((v): v is string => !!v))];
  const sets = setIds.length === 0 ? [] : await executor.select().from(unitSets).where(and(eq(unitSets.tenantId, tenantId), inArray(unitSets.id, setIds)));
  const units = setIds.length === 0 ? [] : await executor.select().from(unitSetUnits)
    .where(and(eq(unitSetUnits.tenantId, tenantId), inArray(unitSetUnits.unitSetId, setIds))).orderBy(asc(unitSetUnits.sortOrder), asc(unitSetUnits.id));
  const setById = new Map(sets.map((s) => [s.id, s]));
  return rows.map((r) => {
    const set = r.unitSetId ? setById.get(r.unitSetId) : undefined;
    if (!set) return { ...r, unitPrices: null };
    const price = (f: Dec) => (r.unitPrice === null || r.unitPrice === undefined || r.unitPrice === '' ? null : round4(new Decimal(r.unitPrice).times(f)).toFixed(4));
    return {
      ...r,
      unitPrices: [
        { unitId: null, name: set.baseUnitName, abbreviation: set.baseUnitAbbreviation ?? null, factor: '1.000000', unitPrice: price(new Decimal(1)) },
        ...units.filter((u) => u.unitSetId === set.id).map((u) => ({
          unitId: u.id, name: u.name, abbreviation: u.abbreviation ?? null, factor: new Decimal(u.factor).toFixed(6), unitPrice: price(new Decimal(u.factor)),
        })),
      ],
    };
  });
}

/** The unit (name, factor) of each id, for readers (reorder report, count sheet). */
export async function unitsById(executor: DbOrTx, tenantId: string, ids: readonly (string | null | undefined)[]) {
  const want = [...new Set(ids.filter((v): v is string => !!v))];
  if (want.length === 0) return new Map<string, { id: string; name: string; abbreviation: string | null; factor: Dec; unitSetId: string }>();
  const rows = await executor.select().from(unitSetUnits).where(and(eq(unitSetUnits.tenantId, tenantId), inArray(unitSetUnits.id, want)));
  return new Map(rows.map((u) => [u.id, { id: u.id, name: u.name, abbreviation: u.abbreviation ?? null, factor: new Decimal(u.factor), unitSetId: u.unitSetId }]));
}

/** The base unit name of each set id. */
export async function baseUnits(executor: DbOrTx, tenantId: string, setIds: readonly (string | null | undefined)[]) {
  const want = [...new Set(setIds.filter((v): v is string => !!v))];
  if (want.length === 0) return new Map<string, { name: string; abbreviation: string | null }>();
  const rows = await executor.select().from(unitSets).where(and(eq(unitSets.tenantId, tenantId), inArray(unitSets.id, want)));
  return new Map(rows.map((s) => [s.id, { name: s.baseUnitName, abbreviation: s.baseUnitAbbreviation ?? null }]));
}

export { toBase, resolveLineUnits, UNIT_LINE_NOTE } from './unit-lines.service.js';
