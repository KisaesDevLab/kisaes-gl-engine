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

import { and, desc, eq, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import {
  expandParameterKeys, getParameterDef, isParameterKey, validateParameterValue, deriveFederalDates,
  type ParameterSeedRow, type ParameterStatus,
  type TaxParametersDTO, type TaxParameterRowDTO, type TaxParameterYearsDTO,
  type CreateYearFromPriorResult, type TaxParameterDiffRowDTO, type TaxParameterChangeDTO, type VerifyTaxParametersResult,
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

type SeedMap = Readonly<Record<number, readonly ParameterSeedRow[]>>;

interface ResolvedValue {
  value: unknown;
  status: ParameterStatus;
  source: TaxParameterRowDTO['source'];
  citation: string;
  reason: string | null;
  shippedValue?: unknown;
  hasShipped: boolean;
  verifiedAt: Date | null;
  verifiedBy: string | null;
  verificationNote: string | null;
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
          // R7 Verify: an in-app verification survives the re-sync only while the shipped value is unchanged.
          set: {
            value: row.value, citation: row.citation, updatedAt: sql`now()`,
            status: sql`CASE WHEN "tax_parameters"."verified_at" IS NOT NULL AND "tax_parameters"."value" = excluded."value" THEN 'verified' ELSE excluded."status" END`,
            verifiedAt: sql`CASE WHEN "tax_parameters"."value" = excluded."value" THEN "tax_parameters"."verified_at" ELSE NULL END`,
            verifiedBy: sql`CASE WHEN "tax_parameters"."value" = excluded."value" THEN "tax_parameters"."verified_by" ELSE NULL END`,
            verificationNote: sql`CASE WHEN "tax_parameters"."value" = excluded."value" THEN "tax_parameters"."verification_note" ELSE NULL END`,
          },
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
        status: ov.verifiedAt ? 'verified' : isOverride ? 'unverified' : 'provisional',
        source: isOverride ? 'override' : 'provisional',
        citation: seed?.citation ?? '',
        reason: ov.reason,
        shippedValue: seed && !deepEqual(seed.value, ov.value) ? seed.value : undefined,
        hasShipped: !!seed,
        verifiedAt: ov.verifiedAt, verifiedBy: ov.verifiedBy, verificationNote: ov.verificationNote,
      });
    } else if (seed) {
      out.set(key, {
        value: seed.value, status: seed.status as ParameterStatus, source: 'seed',
        citation: seed.citation, reason: null, hasShipped: true,
        verifiedAt: seed.verifiedAt, verifiedBy: seed.verifiedBy, verificationNote: seed.verificationNote,
      });
    }
  }
  return out;
}

/**
 * Every `rollsWithYear` date key of `toYear` that the source year carries, DERIVED from the
 * registry's statutory rule and the computed legal-holiday calendar (shared deriveFederalDates;
 * R6-01). The prior year's stored dates are never rolled: they are observed dates (June 16,
 * 2025 for a Sunday June 15) and floating holidays, so a month/day shift lands on wrong days.
 * Shared by "create year from prior" and the missing-year fallback (R3-04), so a fallback
 * year's calendar is THAT year's calendar.
 */
function rollYearDates(resolved: Map<string, ResolvedValue>, toYear: number): { values: Map<string, unknown>; rolled: string[] } {
  const derived = deriveFederalDates(toYear);
  const values = new Map<string, unknown>();
  const rolled: string[] = [];
  for (const e of expandParameterKeys()) {
    if (!resolved.has(e.key) || !derived.has(e.key)) continue;
    values.set(e.key, derived.get(e.key));
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
  const rolled = isFallback ? rollYearDates(resolved, year).values : new Map<string, unknown>();
  const parameters: TaxParameterRowDTO[] = [];
  const missing: string[] = [];
  const expanded = expandParameterKeys();
  const emails = isFallback ? new Map<string, string>() : await verifierEmails(executor, [...resolved.values()].map((r) => r.verifiedBy));
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
    if (!isFallback && r.verifiedAt) {
      row.verifiedAt = r.verifiedAt.toISOString();
      row.verifiedBy = r.verifiedBy;
      row.verifiedByEmail = r.verifiedBy ? emails.get(r.verifiedBy) ?? null : null;
      row.verificationNote = r.verificationNote;
    }
    parameters.push(row);
  }
  return {
    year, isFallback, fallbackYear,
    completeness: { total: expanded.length, present: parameters.length, missing },
    parameters,
  };
}

/** Email of each verifier (display only). Exported for the state-rule store. */
export async function verifierEmails(exec: DbOrTx, ids: Array<string | null>): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (unique.length === 0) return new Map();
  const rows = await exec.select({ id: users.id, email: users.email }).from(users).where(inArray(users.id, unique));
  return new Map(rows.map((r) => [r.id, r.email]));
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
      // A new override value is a new decision: any earlier verification is cleared (R7 Verify).
      set: { value, status: 'override', reason: why, createdBy: userId ?? null, updatedAt: sql`now()`, verifiedAt: null, verifiedBy: null, verificationNote: null },
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

// ── in-app Verify (R7; super admin only — enforced by the admin router) ────

const cleanNote = (note: string | undefined): string | null => {
  const t = (note ?? '').trim();
  return t === '' ? null : t;
};

/** jsonb equality (semantic: 1.0 = 1, key order ignored, array order significant) against a JS value. */
const jsonbEquals = (column: Parameters<typeof eq>[0], value: unknown) => sql`${column} = ${JSON.stringify(value)}::jsonb`;

const changedError = (year: number, key: string, currentValue: unknown) => AppError.conflict(
  `The value of ${key} for ${year} changed since you read it; review the current value and verify again`,
  'TE_PARAM_CHANGED', { year, key, currentValue },
);

interface VerifyOpts {
  /** The value the caller saw (R6-04). undefined = sign whatever the row carries now (scripts, bulk reads it itself). */
  expectedValue?: { value: unknown };
  /** Bulk verify: a row whose value changed under us is skipped, not thrown. */
  onChanged: 'throw' | 'skip';
}

type VerifyOutcome = 'verified' | 'already' | 'changed';

/**
 * Mark ONE row verified for the value the caller saw: the override / provisional row when one
 * exists (it is what the engine reads), else the shipped seed row. Already verified = no-op (no
 * audit). The write is a conditional UPDATE … WHERE verified_at IS NULL AND value = <expected>
 * RETURNING (R6-04): two admins racing on one row produce exactly one sign-off and one audit row,
 * and a row whose value was overridden after the admin read it is never signed (409
 * TE_PARAM_CHANGED, or `changed` under bulk). Only status + verified_* change — value, citation
 * and every other row are untouched.
 */
async function verifyOne(tx: DbOrTx, year: number, key: string, note: string | null, userId: string | undefined, opts: VerifyOpts): Promise<VerifyOutcome> {
  const now = new Date();
  const [ov] = await tx.select().from(taxParameterOverrides).where(and(eq(taxParameterOverrides.taxYear, year), eq(taxParameterOverrides.key, key)));
  if (ov) {
    if (ov.verifiedAt) return 'already';
    const expected = opts.expectedValue ? opts.expectedValue.value : ov.value;
    if (!deepEqual(expected, ov.value)) return changed(year, key, ov.value, opts);
    const updated = await tx.update(taxParameterOverrides).set({ verifiedAt: now, verifiedBy: userId ?? null, verificationNote: note })
      .where(and(eq(taxParameterOverrides.id, ov.id), isNull(taxParameterOverrides.verifiedAt), jsonbEquals(taxParameterOverrides.value, expected)))
      .returning({ id: taxParameterOverrides.id });
    if (updated.length === 0) {
      const [now2] = await tx.select().from(taxParameterOverrides).where(eq(taxParameterOverrides.id, ov.id));
      if (!now2) throw AppError.notFound('Parameter not found');
      if (now2.verifiedAt) return 'already';
      return changed(year, key, now2.value, opts);
    }
    await auditLog(ZERO_TENANT, 'signoff', AUDIT_ENTITY, ov.id,
      { year, key, value: ov.value, status: ov.status },
      { op: 'verified', year, key, value: ov.value, source: ov.status, reason: note }, userId, tx);
    return 'verified';
  }
  const [seed] = await tx.select().from(taxParameters).where(and(eq(taxParameters.taxYear, year), eq(taxParameters.key, key)));
  if (!seed) throw AppError.notFound('Parameter not found');
  if (seed.status === 'verified') return 'already';
  const expected = opts.expectedValue ? opts.expectedValue.value : seed.value;
  if (!deepEqual(expected, seed.value)) return changed(year, key, seed.value, opts);
  const updated = await tx.update(taxParameters).set({ status: 'verified', verifiedAt: now, verifiedBy: userId ?? null, verificationNote: note })
    .where(and(eq(taxParameters.id, seed.id), ne(taxParameters.status, 'verified'), jsonbEquals(taxParameters.value, expected)))
    .returning({ id: taxParameters.id });
  if (updated.length === 0) {
    const [now2] = await tx.select().from(taxParameters).where(eq(taxParameters.id, seed.id));
    if (!now2) throw AppError.notFound('Parameter not found');
    if (now2.status === 'verified') return 'already';
    return changed(year, key, now2.value, opts);
  }
  await auditLog(ZERO_TENANT, 'signoff', AUDIT_ENTITY, seed.id,
    { year, key, value: seed.value, status: seed.status },
    { op: 'verified', year, key, value: seed.value, source: 'seed', reason: note }, userId, tx);
  return 'verified';
}

function changed(year: number, key: string, currentValue: unknown, opts: VerifyOpts): VerifyOutcome {
  if (opts.onChanged === 'throw') throw changedError(year, key, currentValue);
  return 'changed';
}

export async function verifyParameter(year: number, key: string, note: string | undefined, userId?: string, expectedValue?: unknown): Promise<TaxParameterRowDTO> {
  if (!isParameterKey(key) || !getParameterDef(key)) throw AppError.badRequest(`Unknown tax parameter '${key}'`, 'TE_PARAM_INVALID');
  await db.transaction(async (tx) => {
    await verifyOne(tx, year, key, cleanNote(note), userId, { expectedValue: expectedValue === undefined ? undefined : { value: expectedValue }, onChanged: 'throw' });
  });
  return getRow(year, key);
}

/**
 * Bulk Verify: every row of `year` whose effective status is not verified, each signed for the
 * value read in this transaction; a row overridden under us is listed in `changed`, not signed.
 * A fallback year has no rows → nothing.
 */
export async function verifyAllParameters(year: number, note: string | undefined, userId?: string): Promise<VerifyTaxParametersResult> {
  const why = cleanNote(note);
  return db.transaction(async (tx) => {
    const resolved = await resolveYear(tx, year);
    const verified: string[] = [];
    const changedKeys: string[] = [];
    for (const [key, r] of resolved) {
      if (r.status === 'verified') continue;
      const outcome = await verifyOne(tx, year, key, why, userId, { expectedValue: { value: r.value }, onChanged: 'skip' });
      if (outcome === 'verified') verified.push(key);
      else if (outcome === 'changed') changedKeys.push(key);
    }
    return changedKeys.length > 0 ? { verified, changed: changedKeys } : { verified };
  });
}

export async function createYearFromPrior(year: number, userId?: string): Promise<CreateYearFromPriorResult> {
  return db.transaction(async (tx) => {
    if (await yearHasRows(tx, year)) throw AppError.conflict(`Tax year ${year} already has parameters`, 'TE_YEAR_EXISTS');
    const fromYear = await latestYearBefore(tx, year);
    if (fromYear === null) throw AppError.badRequest('No earlier tax year to copy from', 'TE_NO_PRIOR_YEAR');
    const prior = await resolveYear(tx, fromYear);
    // Dates come from the statute + the computed holiday calendar for `year`, not from the prior rows.
    const { values: rolledValues, rolled: rolledDates } = rollYearDates(prior, year);

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
    if (op !== 'override_set' && op !== 'override_reverted' && op !== 'year_created' && op !== 'shipped_adopted' && op !== 'verified') continue;
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
