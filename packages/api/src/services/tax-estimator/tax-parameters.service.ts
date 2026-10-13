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
// no rows at all falls back to the latest earlier year, flagged provisional (dates
// derived for the requested year, R6-01); such a year cannot be edited or signed
// until it is created from the prior year (R6-02), so one stray row never ends the
// fallback.
//
// Audit: parameters have no tenant, so (like the tax-code seed admin) every
// change is written to audit_log under the all-zero tenant id with entity
// type 'tax_parameter'. The DTO-level operation lives in after_data.op.

import { SHIPPED_ADJUSTMENT_TYPES_SQL } from '../../db/seeds/tax-estimator/adjustment-types.js';
import { and, desc, eq, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import {
  expandParameterKeys, getParameterDef, isParameterKey, validateParameterValue, deriveFederalDates,
  type ParameterSeedRow, type ParameterStatus,
  type TaxParametersDTO, type TaxParameterRowDTO, type TaxParameterYearsDTO,
  type CreateYearFromPriorResult, type TaxParameterDiffRowDTO, type TaxParameterChangeDTO, type VerifyTaxParametersResult,
  isAiCitation, type OverrideWriteOptions,
  FEDERAL_INSTALLMENT_PAIRS, installmentPairOf, installmentPartnerKey, installmentPairError,
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
const CARRIED_PREFIX = 'Carried from';

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

/** Re-insert the shipped adjustment-type catalog if its rows are missing (idempotent). */
export async function ensureShippedAdjustmentTypes(): Promise<void> {
  await db.execute(sql.raw(SHIPPED_ADJUSTMENT_TYPES_SQL));
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
    await tx.execute(sql.raw(SHIPPED_ADJUSTMENT_TYPES_SQL));
    for (const [year, rows] of plan) {
      for (const row of rows) {
        await tx.insert(taxParameters).values({
          taxYear: year, key: row.key, value: row.value, status: row.status, citation: row.citation,
        }).onConflictDoUpdate({
          target: [taxParameters.taxYear, taxParameters.key],
          // R7 Verify: an in-app verification survives the re-sync only while the shipped value AND its
          // citation are unchanged (R6-10: "verified" means checked against the cited source).
          set: {
            value: row.value, citation: row.citation, updatedAt: sql`now()`,
            status: sql`CASE WHEN "tax_parameters"."verified_at" IS NOT NULL AND "tax_parameters"."value" = excluded."value" AND "tax_parameters"."citation" = excluded."citation" THEN 'verified' ELSE excluded."status" END`,
            verifiedAt: sql`CASE WHEN "tax_parameters"."value" = excluded."value" AND "tax_parameters"."citation" = excluded."citation" THEN "tax_parameters"."verified_at" ELSE NULL END`,
            verifiedBy: sql`CASE WHEN "tax_parameters"."value" = excluded."value" AND "tax_parameters"."citation" = excluded."citation" THEN "tax_parameters"."verified_by" ELSE NULL END`,
            verificationNote: sql`CASE WHEN "tax_parameters"."value" = excluded."value" AND "tax_parameters"."citation" = excluded."citation" THEN "tax_parameters"."verification_note" ELSE NULL END`,
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

/**
 * R6-02: a year served through the missing-year fallback has nothing of its own to edit or sign.
 * One stray override would end the fallback (the year becomes 1/161 complete, every estimate
 * fails TE_PARAM_MISSING) and block create-from-prior with TE_YEAR_EXISTS. A year with nothing
 * to fall back to (no earlier year at all) may still be built by hand.
 */
async function assertYearEditable(exec: DbOrTx, year: number): Promise<void> {
  if (await yearHasRows(exec, year)) return;
  if ((await latestYearBefore(exec, year)) === null) return;
  throw AppError.conflict(`Tax year ${year} has no parameters of its own (it is served from an earlier year); create ${year} from the prior year first`, 'TE_YEAR_NOT_CREATED', { year });
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
        // R6-06: a created year has no seed yet; its rows carry the prior year's citation.
        // Q48: an "Apply AI value" citation on the override row replaces the seed's (it describes the applied value).
        citation: isAiCitation(ov.citation) ? ov.citation : seed ? seed.citation : ov.citation,
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
    if (!isFallback && r.source !== 'seed') row.hasShipped = r.hasShipped;
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

/** QA D6: the other half of an installment pair, saved in the same request. */
export interface ParameterCompanion { key: string; value: unknown }

/** Stored value of `key` for `year` (override, else shipped seed); null when neither exists. */
async function storedValue(exec: DbOrTx, year: number, key: string): Promise<unknown> {
  const [ov] = await exec.select({ value: taxParameterOverrides.value }).from(taxParameterOverrides)
    .where(and(eq(taxParameterOverrides.taxYear, year), eq(taxParameterOverrides.key, key)));
  if (ov) return ov.value;
  const [seed] = await exec.select({ value: taxParameters.value }).from(taxParameters)
    .where(and(eq(taxParameters.taxYear, year), eq(taxParameters.key, key)));
  return seed ? seed.value : null;
}

async function assertInstallmentShape(exec: DbOrTx, year: number, edits: Map<string, unknown>): Promise<void> {
  for (const key of edits.keys()) {
    const pair = installmentPairOf(FEDERAL_INSTALLMENT_PAIRS, key);
    if (!pair) continue;
    const pick = async (k: string) => (edits.has(k) ? edits.get(k) : await storedValue(exec, year, k));
    const err = installmentPairError(pair, await pick(pair.pcts), await pick(pair.schedule));
    if (err) throw new AppError(400, err, 'TE_PARAM_INVALID', { year, key });
  }
}

export async function setOverride(
  year: number, key: string, value: unknown, reason: string, userId?: string, companion?: ParameterCompanion,
  opts?: OverrideWriteOptions,
): Promise<TaxParameterRowDTO> {
  const edits = new Map<string, unknown>([[key, value]]);
  if (companion) {
    if (installmentPartnerKey(FEDERAL_INSTALLMENT_PAIRS, key) !== companion.key) {
      throw AppError.badRequest(`'${companion.key}' cannot be saved together with '${key}'`, 'TE_PARAM_INVALID');
    }
    edits.set(companion.key, companion.value);
  }
  for (const [k, v] of edits) {
    const def = getParameterDef(k);
    if (!isParameterKey(k) || !def) throw AppError.badRequest(`Unknown tax parameter '${k}'`, 'TE_PARAM_INVALID');
    const err = validateParameterValue(def.def.type, v);
    if (err) throw AppError.badRequest(`Invalid value for '${k}': ${err}`, 'TE_PARAM_INVALID');
  }
  const why = (reason ?? '').trim();
  if (why.length < MIN_REASON_LEN) throw AppError.badRequest('A reason of at least 3 characters is required', 'TE_PARAM_INVALID');

  await db.transaction(async (tx) => {
    await assertYearEditable(tx, year);
    await assertInstallmentShape(tx, year, edits);
    for (const [k, v] of edits) await upsertOverride(tx, year, k, v, why, userId, k === key ? opts : undefined);
  });
  return getRow(year, key);
}

async function upsertOverride(
  tx: DbOrTx, year: number, key: string, value: unknown, why: string, userId?: string, opts?: OverrideWriteOptions,
): Promise<void> {
  const [prev] = await tx.select().from(taxParameterOverrides)
    .where(and(eq(taxParameterOverrides.taxYear, year), eq(taxParameterOverrides.key, key)));
  const [seed] = await tx.select().from(taxParameters).where(and(eq(taxParameters.taxYear, year), eq(taxParameters.key, key)));
  // R6-08: the same value again (a reason edit) is not a new decision — the sign-off stays; and a
  // provisional copy that still has no shipped row stays provisional so it remains in the diff / adopt flow.
  const sameValue = !!prev && deepEqual(prev.value, value);
  const status = prev?.status === 'provisional' && !seed ? 'provisional' : 'override';
  // Q48: Apply AI value may set the citation; a later manual value change drops an AI citation.
  const citation = opts?.citation !== undefined ? opts.citation : (!sameValue && isAiCitation(prev?.citation) ? '' : undefined);
  const [saved] = await tx.insert(taxParameterOverrides).values({
    taxYear: year, key, value, status, reason: why, createdBy: userId ?? null,
    ...(citation !== undefined ? { citation } : {}),
  }).onConflictDoUpdate({
    target: [taxParameterOverrides.taxYear, taxParameterOverrides.key],
    // A new override value is a new decision: any earlier verification is cleared (R7 Verify).
    set: {
      value, status, reason: why, createdBy: userId ?? null, updatedAt: sql`now()`,
      ...(citation !== undefined ? { citation } : {}),
      ...(sameValue ? {} : { verifiedAt: null, verifiedBy: null, verificationNote: null }),
    },
  }).returning();
  // R6-09: `before` is the value the engine was reading (override, else the shipped seed).
  await auditLog(ZERO_TENANT, 'override', AUDIT_ENTITY, saved!.id,
    { year, key, value: prev?.value ?? seed?.value ?? null },
    { op: 'override_set', year, key, value, reason: why, ...(opts?.citation !== undefined ? { citation: opts.citation } : {}), ...(opts?.audit ?? {}) }, userId, tx);
}

export async function revertOverride(year: number, key: string, userId?: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(taxParameterOverrides)
      .where(and(eq(taxParameterOverrides.taxYear, year), eq(taxParameterOverrides.key, key)));
    if (!row) throw AppError.notFound('No override or provisional value for this parameter');
    const [seed] = await tx.select({ id: taxParameters.id }).from(taxParameters).where(and(eq(taxParameters.taxYear, year), eq(taxParameters.key, key)));
    if (!seed) {
      // R6-07: with no shipped row underneath, deleting leaves the key missing for the year (the year still has
      // rows, so no fallback; the next estimate throws TE_PARAM_MISSING). Edit the value instead. The one
      // exception: this is the year's only row, and removing it restores the fallback.
      const [ovs] = await tx.select({ n: sql<number>`count(*)::int` }).from(taxParameterOverrides).where(eq(taxParameterOverrides.taxYear, year));
      const [seeds] = await tx.select({ n: sql<number>`count(*)::int` }).from(taxParameters).where(eq(taxParameters.taxYear, year));
      if ((ovs?.n ?? 0) + (seeds?.n ?? 0) > 1) {
        throw AppError.conflict(`${key} has no shipped value for ${year}; removing it would leave the key missing for the year. Edit the value instead.`, 'TE_NO_SHIPPED_VALUE', { year, key });
      }
    }
    await tx.delete(taxParameterOverrides).where(eq(taxParameterOverrides.id, row.id));
    await auditLog(ZERO_TENANT, 'override', AUDIT_ENTITY, row.id,
      { year, key, value: row.value },
      { op: 'override_reverted', year, key, value: null, reason: null }, userId, tx);
    // QA D6: an installment pair that no longer lines up on the shipped value takes its partner back too.
    const pair = installmentPairOf(FEDERAL_INSTALLMENT_PAIRS, key);
    if (pair && installmentPairError(pair, await storedValue(tx, year, pair.pcts), await storedValue(tx, year, pair.schedule))) {
      const partner = pair.pcts === key ? pair.schedule : pair.pcts;
      const [p] = await tx.select().from(taxParameterOverrides)
        .where(and(eq(taxParameterOverrides.taxYear, year), eq(taxParameterOverrides.key, partner)));
      const [pSeed] = await tx.select({ id: taxParameters.id }).from(taxParameters)
        .where(and(eq(taxParameters.taxYear, year), eq(taxParameters.key, partner)));
      if (p && !pSeed) {
        throw new AppError(400, `Reverting ${key} would leave it out of line with ${partner}; override both together instead`, 'TE_PARAM_INVALID', { year, key });
      }
      if (p) {
        await tx.delete(taxParameterOverrides).where(eq(taxParameterOverrides.id, p.id));
        await auditLog(ZERO_TENANT, 'override', AUDIT_ENTITY, p.id,
          { year, key: partner, value: p.value },
          { op: 'override_reverted', year, key: partner, value: null, reason: `reverted with ${key}` }, userId, tx);
      }
    }
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
    await assertYearEditable(tx, year);
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
      // R6-06: carry the source the admin will check the value against (the seed for `year` does not exist yet).
      const citation = p.citation === '' || p.citation.startsWith(CARRIED_PREFIX) ? p.citation : `${CARRIED_PREFIX} ${fromYear}: ${p.citation}`;
      values.push({
        taxYear: year, key: e.key, value, status: 'provisional', reason, citation, createdFromYear: fromYear, createdBy: userId ?? null,
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
        same: deepEqual(s.value, o.value),
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

/** Recent parameter changes, newest first; `year` (R6-09) limits the feed to one tax year. */
export async function listChanges(limit: number, year?: number): Promise<TaxParameterChangeDTO[]> {
  const rows = await db.select({
    id: auditLogTable.id, at: auditLogTable.createdAt, userId: auditLogTable.userId,
    before: auditLogTable.beforeData, after: auditLogTable.afterData, email: users.email,
  }).from(auditLogTable)
    .leftJoin(users, eq(users.id, auditLogTable.userId))
    .where(and(
      eq(auditLogTable.tenantId, ZERO_TENANT), eq(auditLogTable.entityType, AUDIT_ENTITY),
      // The audit writer stores JSON.stringify(after) in the jsonb column, so the blob is a jsonb STRING scalar; unwrap it first.
      year === undefined ? undefined : sql`((CASE WHEN jsonb_typeof(${auditLogTable.afterData}) = 'string' THEN (${auditLogTable.afterData} #>> '{}')::jsonb ELSE ${auditLogTable.afterData} END)->>'year')::int = ${year}`,
    ))
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
