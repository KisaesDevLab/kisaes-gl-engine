// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Tax parameter store (Tax Estimator Phase 1, features/tax-estimator/MODULE.md).
//
// Parameters are GLOBAL reference data (no tenant_id), like tax_codes:
//   tax_parameters          shipped seed rows, re-synced from code at startup
//   tax_parameter_overrides super-admin overrides + provisional rows created
//                           by "create year from prior"
// Effective value per key: override > provisional > shipped seed. A year with
// no rows at all falls back to the latest earlier year, flagged provisional.
//
// Audit: parameters have no tenant, so (like the tax-code seed admin) every
// change is written to audit_log under the all-zero tenant id with entity
// type 'tax_parameter'. The DTO-level operation lives in after_data.op.

import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import {
  expandParameterKeys, getParameterDef, isParameterKey, validateParameterValue,
  rollDateToYear, nextBusinessDay,
  type ParameterSeedRow, type ParameterStatus,
  type TaxParametersDTO, type TaxParameterRowDTO, type TaxParameterYearsDTO,
  type CreateYearFromPriorResult, type TaxParameterDiffRowDTO, type TaxParameterChangeDTO,
} from '@kis-books/shared';
import { db, type DbOrTx } from '../../db/index.js';
import { taxParameters, taxParameterOverrides } from '../../db/schema/tax-estimator.js';
import { auditLog as auditLogTable } from '../../db/schema/audit-log.js';
import { users } from '../../db/schema/auth.js';
import { auditLog } from '../../middleware/audit.js';
import { AppError } from '../../utils/errors.js';
import { FEDERAL_SEEDS } from '../../db/seeds/tax-estimator/federal/index.js';

const ZERO_TENANT = '00000000-0000-0000-0000-000000000000';
const AUDIT_ENTITY = 'tax_parameter';
const MIN_REASON_LEN = 3;
const HOLIDAYS_KEY = 'holidays';

type SeedMap = Readonly<Record<number, readonly ParameterSeedRow[]>>;

interface ResolvedValue {
  value: unknown;
  status: ParameterStatus;
  source: TaxParameterRowDTO['source'];
  citation: string;
  reason: string | null;
  shippedValue?: unknown;
  hasShipped: boolean;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  return ak.length === Object.keys(bo).length && ak.every((k) => k in bo && deepEqual(ao[k], bo[k]));
}

function validateSeedRow(year: number, row: ParameterSeedRow): void {
  const where = `tax parameter seed ${year} '${row.key}'`;
  const def = getParameterDef(row.key);
  if (!isParameterKey(row.key) || !def) throw new Error(`${where}: unknown parameter key`);
  const err = validateParameterValue(def.def.type, row.value);
  if (err) throw new Error(`${where}: ${err}`);
  if (!row.citation || !row.citation.trim()) throw new Error(`${where}: citation is required`);
  if (!['verified', 'unverified', 'provisional'].includes(row.status)) throw new Error(`${where}: invalid status '${row.status}'`);
}

/**
 * Idempotently upsert the shipped seeds into tax_parameters. Never touches
 * tax_parameter_overrides. For each non-empty seed year, rows whose key is no
 * longer in the seed are removed (the code is the source of truth). `seeds`
 * is injectable so tests can sync a fixture.
 */
export async function syncShippedSeeds(seeds: SeedMap = FEDERAL_SEEDS): Promise<{ years: number; rows: number }> {
  // Validate everything before writing anything.
  const plan: Array<[number, readonly ParameterSeedRow[]]> = [];
  for (const [yearStr, rows] of Object.entries(seeds)) {
    const year = Number(yearStr);
    const seen = new Set<string>();
    for (const row of rows) {
      validateSeedRow(year, row);
      if (seen.has(row.key)) throw new Error(`tax parameter seed ${year} '${row.key}': duplicate key`);
      seen.add(row.key);
    }
    if (rows.length > 0) plan.push([year, rows]);
  }
  let total = 0;
  await db.transaction(async (tx) => {
    for (const [year, rows] of plan) {
      for (const row of rows) {
        await tx.insert(taxParameters).values({
          taxYear: year, key: row.key, value: row.value, status: row.status, citation: row.citation,
        }).onConflictDoUpdate({
          target: [taxParameters.taxYear, taxParameters.key],
          set: { value: row.value, status: row.status, citation: row.citation, updatedAt: sql`now()` },
        });
        total++;
      }
      const keep = rows.map((r) => r.key);
      const existing = await tx.select({ key: taxParameters.key }).from(taxParameters).where(eq(taxParameters.taxYear, year));
      const stale = existing.map((e) => e.key).filter((k) => !keep.includes(k));
      if (stale.length > 0) {
        await tx.delete(taxParameters).where(and(eq(taxParameters.taxYear, year), inArray(taxParameters.key, stale)));
      }
    }
  });
  return { years: plan.length, rows: total };
}

async function yearHasRows(exec: DbOrTx, year: number): Promise<boolean> {
  const [a] = await exec.select({ n: sql<number>`count(*)::int` }).from(taxParameters).where(eq(taxParameters.taxYear, year));
  if ((a?.n ?? 0) > 0) return true;
  const [b] = await exec.select({ n: sql<number>`count(*)::int` }).from(taxParameterOverrides).where(eq(taxParameterOverrides.taxYear, year));
  return (b?.n ?? 0) > 0;
}

async function latestYearBefore(exec: DbOrTx, year: number): Promise<number | null> {
  const [a] = await exec.select({ y: sql<number | null>`max(${taxParameters.taxYear})` }).from(taxParameters).where(lt(taxParameters.taxYear, year));
  const [b] = await exec.select({ y: sql<number | null>`max(${taxParameterOverrides.taxYear})` }).from(taxParameterOverrides).where(lt(taxParameterOverrides.taxYear, year));
  const ys = [a?.y, b?.y].filter((y): y is number => typeof y === 'number');
  return ys.length > 0 ? Math.max(...ys) : null;
}

/** Resolve registry keys for a year that has rows. Unknown DB keys are ignored. */
async function resolveYear(exec: DbOrTx, year: number): Promise<Map<string, ResolvedValue>> {
  const seedRows = await exec.select().from(taxParameters).where(eq(taxParameters.taxYear, year));
  const ovRows = await exec.select().from(taxParameterOverrides).where(eq(taxParameterOverrides.taxYear, year));
  const seedBy = new Map(seedRows.map((r) => [r.key, r]));
  const ovBy = new Map(ovRows.map((r) => [r.key, r]));
  const out = new Map<string, ResolvedValue>();
  for (const { key } of expandParameterKeys()) {
    const seed = seedBy.get(key);
    const ov = ovBy.get(key);
    if (ov) {
      const isOverride = ov.status === 'override';
      out.set(key, {
        value: ov.value,
        status: isOverride ? 'unverified' : 'provisional',
        source: isOverride ? 'override' : 'provisional',
        citation: seed?.citation ?? '',
        reason: ov.reason,
        shippedValue: seed && !deepEqual(seed.value, ov.value) ? seed.value : undefined,
        hasShipped: !!seed,
      });
    } else if (seed) {
      out.set(key, {
        value: seed.value, status: seed.status as ParameterStatus, source: 'seed',
        citation: seed.citation, reason: null, hasShipped: true,
      });
    }
  }
  return out;
}

/**
 * Roll every `rollsWithYear` date key from `fromYear` to `toYear`: holidays shift by the
 * year difference, every other date also lands on the next business day after the rolled
 * holidays. Shared by "create year from prior" and the missing-year fallback (R3-04), so a
 * fallback year's calendar is THAT year's calendar, not last year's.
 */
function rollYearDates(resolved: Map<string, ResolvedValue>, fromYear: number, toYear: number): { values: Map<string, unknown>; rolled: string[] } {
  const priorHolidays = resolved.get(HOLIDAYS_KEY)?.value;
  const holidays = Array.isArray(priorHolidays) ? priorHolidays.map((d) => rollDateToYear(String(d), fromYear, toYear)) : [];
  const values = new Map<string, unknown>();
  const rolled: string[] = [];
  for (const e of expandParameterKeys()) {
    const p = resolved.get(e.key);
    if (!p || !e.def.rollsWithYear) continue;
    values.set(e.key, rollValue(e.def.type, p.value, fromYear, toYear, holidays, e.key !== HOLIDAYS_KEY));
    rolled.push(e.key);
  }
  return { values, rolled };
}

export async function getParameters(year: number, executor: DbOrTx = db): Promise<TaxParametersDTO> {
  let resolveFrom = year;
  let fallbackYear: number | null = null;
  const hasRows = await yearHasRows(executor, year);
  if (!hasRows) {
    fallbackYear = await latestYearBefore(executor, year);
    if (fallbackYear !== null) resolveFrom = fallbackYear;
  }
  const isFallback = fallbackYear !== null;
  const resolved = (isFallback || hasRows)
    ? await resolveYear(executor, resolveFrom)
    : new Map<string, ResolvedValue>();

  // R3-04: fallback dates are rolled to the requested year (due dates, return due date,
  // farmer dates, holidays); amounts and rates are served as they are (provisional).
  const rolled = isFallback && fallbackYear !== null ? rollYearDates(resolved, fallbackYear, year).values : new Map<string, unknown>();
  const parameters: TaxParameterRowDTO[] = [];
  const missing: string[] = [];
  const expanded = expandParameterKeys();
  for (const e of expanded) {
    const r = resolved.get(e.key);
    if (!r) { missing.push(e.key); continue; }
    const row: TaxParameterRowDTO = {
      key: e.key, label: e.def.label, group: e.def.group, type: e.def.type, unit: e.def.unit,
      value: rolled.has(e.key) ? rolled.get(e.key) : r.value,
      status: isFallback ? 'provisional' : r.status,
      source: isFallback ? 'fallback' : r.source,
      citation: r.citation,
    };
    if (!isFallback && r.reason) row.reason = r.reason;
    if (!isFallback && r.shippedValue !== undefined) row.shippedValue = r.shippedValue;
    if (isFallback) row.fallbackYear = fallbackYear;
    parameters.push(row);
  }
  return {
    year, isFallback, fallbackYear,
    completeness: { total: expanded.length, present: parameters.length, missing },
    parameters,
  };
}

export async function getYears(): Promise<TaxParameterYearsDTO> {
  const a = await db.selectDistinct({ y: taxParameters.taxYear }).from(taxParameters);
  const b = await db.selectDistinct({ y: taxParameterOverrides.taxYear }).from(taxParameterOverrides);
  const years = [...new Set([...a.map((r) => r.y), ...b.map((r) => r.y)])].sort((x, y) => x - y);
  return { years, shippedYears: a.map((r) => r.y).sort((x, y) => x - y) };
}

async function getRow(year: number, key: string): Promise<TaxParameterRowDTO> {
  const dto = await getParameters(year);
  const row = dto.parameters.find((p) => p.key === key);
  if (!row) throw AppError.notFound('Parameter not found');
  return row;
}

export async function setOverride(
  year: number, key: string, value: unknown, reason: string, userId?: string,
): Promise<TaxParameterRowDTO> {
  const def = getParameterDef(key);
  if (!isParameterKey(key) || !def) throw AppError.badRequest(`Unknown tax parameter '${key}'`, 'TE_PARAM_INVALID');
  const err = validateParameterValue(def.def.type, value);
  if (err) throw AppError.badRequest(`Invalid value for '${key}': ${err}`, 'TE_PARAM_INVALID');
  const why = (reason ?? '').trim();
  if (why.length < MIN_REASON_LEN) throw AppError.badRequest('A reason of at least 3 characters is required', 'TE_PARAM_INVALID');

  await db.transaction(async (tx) => {
    const [prev] = await tx.select().from(taxParameterOverrides)
      .where(and(eq(taxParameterOverrides.taxYear, year), eq(taxParameterOverrides.key, key)));
    const [saved] = await tx.insert(taxParameterOverrides).values({
      taxYear: year, key, value, status: 'override', reason: why, createdBy: userId ?? null,
    }).onConflictDoUpdate({
      target: [taxParameterOverrides.taxYear, taxParameterOverrides.key],
      set: { value, status: 'override', reason: why, createdBy: userId ?? null, updatedAt: sql`now()` },
    }).returning();
    await auditLog(ZERO_TENANT, 'override', AUDIT_ENTITY, saved!.id,
      { year, key, value: prev?.value ?? null },
      { op: 'override_set', year, key, value, reason: why }, userId, tx);
  });
  return getRow(year, key);
}

export async function revertOverride(year: number, key: string, userId?: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx.delete(taxParameterOverrides)
      .where(and(eq(taxParameterOverrides.taxYear, year), eq(taxParameterOverrides.key, key)))
      .returning();
    if (!row) throw AppError.notFound('No override or provisional value for this parameter');
    await auditLog(ZERO_TENANT, 'override', AUDIT_ENTITY, row.id,
      { year, key, value: row.value },
      { op: 'override_reverted', year, key, value: null, reason: null }, userId, tx);
  });
}

function rollValue(type: string, value: unknown, fromYear: number, toYear: number, holidays: string[], business: boolean): unknown {
  const roll = (d: string): string => {
    const r = rollDateToYear(d, fromYear, toYear);
    return business ? nextBusinessDay(r, holidays) : r;
  };
  if (type === 'date' && typeof value === 'string') return roll(value);
  if (type === 'date_list' && Array.isArray(value)) return value.map((d) => roll(String(d)));
  return value;
}

export async function createYearFromPrior(year: number, userId?: string): Promise<CreateYearFromPriorResult> {
  return db.transaction(async (tx) => {
    if (await yearHasRows(tx, year)) throw AppError.conflict(`Tax year ${year} already has parameters`, 'TE_YEAR_EXISTS');
    const fromYear = await latestYearBefore(tx, year);
    if (fromYear === null) throw AppError.badRequest('No earlier tax year to copy from', 'TE_NO_PRIOR_YEAR');
    const prior = await resolveYear(tx, fromYear);
    // Holidays first: they feed the business-day landing of every other date.
    const { values: rolledValues, rolled: rolledDates } = rollYearDates(prior, fromYear, year);

    const reason = `Created from ${fromYear}; verify`;
    const values: Array<typeof taxParameterOverrides.$inferInsert> = [];
    for (const e of expandParameterKeys()) {
      const p = prior.get(e.key);
      if (!p) continue;
      const value = rolledValues.has(e.key) ? rolledValues.get(e.key) : p.value;
      values.push({
        taxYear: year, key: e.key, value, status: 'provisional', reason, createdFromYear: fromYear, createdBy: userId ?? null,
      });
    }
    if (values.length > 0) await tx.insert(taxParameterOverrides).values(values);
    await auditLog(ZERO_TENANT, 'override', AUDIT_ENTITY, null,
      { year, key: null, value: null },
      { op: 'year_created', year, key: null, value: { fromYear, created: values.length, rolledDates }, reason }, userId, tx);
    return { year, fromYear, created: values.length, rolledDates };
  });
}

export async function diffShippedVsProvisional(year: number): Promise<TaxParameterDiffRowDTO[]> {
  const ovs = await db.select().from(taxParameterOverrides)
    .where(and(eq(taxParameterOverrides.taxYear, year), eq(taxParameterOverrides.status, 'provisional')));
  if (ovs.length === 0) return [];
  const seeds = await db.select().from(taxParameters).where(eq(taxParameters.taxYear, year));
  const seedBy = new Map(seeds.map((s) => [s.key, s]));
  const order = new Map(expandParameterKeys().map((e, i) => [e.key, i]));
  const rows: Array<{ i: number; row: TaxParameterDiffRowDTO }> = [];
  for (const o of ovs) {
    const s = seedBy.get(o.key);
    const def = getParameterDef(o.key);
    if (!s || !def) continue;
    rows.push({
      i: order.get(o.key) ?? 0,
      row: {
        key: o.key, label: def.def.label,
        shippedValue: s.value, shippedStatus: s.status as ParameterStatus, shippedCitation: s.citation,
        provisionalValue: o.value,
      },
    });
  }
  return rows.sort((a, b) => a.i - b.i).map((r) => r.row);
}

export async function adoptShipped(year: number, keys: string[] | undefined, userId?: string): Promise<{ adopted: string[] }> {
  const diffable = (await diffShippedVsProvisional(year)).map((r) => r.key);
  const target = keys ? diffable.filter((k) => keys.includes(k)) : diffable;
  if (target.length === 0) return { adopted: [] };
  await db.transaction(async (tx) => {
    const removed = await tx.delete(taxParameterOverrides)
      .where(and(
        eq(taxParameterOverrides.taxYear, year),
        eq(taxParameterOverrides.status, 'provisional'),
        inArray(taxParameterOverrides.key, target),
      )).returning();
    for (const r of removed) {
      await auditLog(ZERO_TENANT, 'override', AUDIT_ENTITY, r.id,
        { year, key: r.key, value: r.value },
        { op: 'shipped_adopted', year, key: r.key, value: null, reason: null }, userId, tx);
    }
  });
  return { adopted: target };
}

interface ChangeBlob { op?: string; year?: number; key?: string | null; value?: unknown; reason?: string | null }

export async function listChanges(limit: number): Promise<TaxParameterChangeDTO[]> {
  const rows = await db.select({
    id: auditLogTable.id, at: auditLogTable.createdAt, userId: auditLogTable.userId,
    before: auditLogTable.beforeData, after: auditLogTable.afterData, email: users.email,
  }).from(auditLogTable)
    .leftJoin(users, eq(users.id, auditLogTable.userId))
    .where(and(eq(auditLogTable.tenantId, ZERO_TENANT), eq(auditLogTable.entityType, AUDIT_ENTITY)))
    .orderBy(desc(auditLogTable.id))
    .limit(limit);
  const out: TaxParameterChangeDTO[] = [];
  for (const r of rows) {
    const parse = (v: unknown): ChangeBlob => {
      if (typeof v === 'string') { try { return JSON.parse(v) as ChangeBlob; } catch { return {}; } }
      return (v ?? {}) as ChangeBlob;
    };
    const b = parse(r.before);
    const a = parse(r.after);
    const op = a.op;
    if (op !== 'override_set' && op !== 'override_reverted' && op !== 'year_created' && op !== 'shipped_adopted') continue;
    out.push({
      at: (r.at ?? new Date(0)).toISOString(),
      userId: r.userId ?? null,
      userEmail: r.email ?? null,
      action: op,
      year: a.year ?? b.year ?? 0,
      key: a.key ?? null,
      before: b.value ?? null,
      after: a.value ?? null,
      reason: a.reason ?? null,
    });
  }
  return out;
}
