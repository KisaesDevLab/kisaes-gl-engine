// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// State estimate-rule store (Tax Estimator Phase 2, features/tax-estimator/MODULE.md
// "State rule keys"). Mirrors tax-parameters.service.ts:
//
//   state_estimate_rules          shipped seed rows, re-synced from code at startup
//   state_estimate_rule_overrides super-admin overrides + provisional rows created
//                                 by "create year from prior"
// Effective value per (state, key): override > provisional > shipped seed. A state
// with no rows for a year falls back to its latest earlier year (dates derived for
// the requested year, every row provisional) — in the admin summary AND in the
// estimate, which both go through getStateRules + jurisdictionFromStateRules (the
// one resolver, R6-03). A state with no usable rule set in any year is computed
// with the federal pattern and a "verify" badge. A state served through the
// fallback cannot be edited or signed until the year is created (R6-02).
//
// Audit: global data, so changes are written to audit_log under the all-zero
// tenant id with entity type 'tax_state_rule' (operation in after_data.op).

import { and, desc, eq, inArray, isNull, lt, ne, sql } from 'drizzle-orm';
import {
  STATE_CODES, STATE_NAMES, STATE_RULE_REGISTRY, getStateRuleDef, validateStateRuleValue,
  requiredStateRuleKeys, isIncomeTaxState, rollStateRuleDates, stateRuleRef, jurisdictionFromStateRules,
  type StateCode, type StateRuleSeedRow, type ParameterStatus,
  type StateRulesDTO, type StateRuleRowDTO, type StateRuleSummaryDTO,
  type CreateStateYearFromPriorResult, type StateRuleDiffRowDTO, type StateRuleChangeDTO,
  type VerifyStateRulesResult,
  STATE_INSTALLMENT_PAIRS, installmentPairOf, installmentPartnerKey, installmentPairError,
} from '@kis-books/shared';
import { db, type DbOrTx } from '../../db/index.js';
import { stateEstimateRules, stateEstimateRuleOverrides } from '../../db/schema/tax-estimator-state-rules.js';
import { auditLog as auditLogTable } from '../../db/schema/audit-log.js';
import { users } from '../../db/schema/auth.js';
import { auditLog } from '../../middleware/audit.js';
import { AppError } from '../../utils/errors.js';
import { STATE_RULE_SEEDS } from '../../db/seeds/tax-estimator/state-rules/index.js';
import { verifierEmails } from './tax-parameters.service.js';

const ZERO_TENANT = '00000000-0000-0000-0000-000000000000';
const AUDIT_ENTITY = 'tax_state_rule';
const MIN_REASON_LEN = 3;
const STATUSES: readonly string[] = ['verified', 'unverified', 'provisional'];

interface ResolvedValue {
  value: unknown;
  status: ParameterStatus;
  source: StateRuleRowDTO['source'];
  citation: string;
  reason: string | null;
  shippedValue?: unknown;
  hasShipped: boolean;
  verifiedAt: Date | null;
  verifiedBy: string | null;
  verificationNote: string | null;
}

type SeedRow = typeof stateEstimateRules.$inferSelect;
type OverrideRow = typeof stateEstimateRuleOverrides.$inferSelect;

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

/** JSON null is a legitimate rule value; a bare JS null would become SQL NULL, so always send explicit JSON. */
const jsonb = (v: unknown) => sql`${JSON.stringify(v)}::jsonb`;

const isStateCode = (s: string): s is StateCode => (STATE_CODES as readonly string[]).includes(s);

function assertState(state: string): StateCode {
  const up = state.trim().toUpperCase();
  if (!isStateCode(up)) throw AppError.badRequest(`Unknown state '${state}'`, 'TE_STATE_INVALID');
  return up;
}

function validateSeedRow(row: StateRuleSeedRow): void {
  const where = `state rule seed ${row.state} ${row.year} '${row.key}'`;
  if (!isStateCode(row.state)) throw new Error(`${where}: unknown state`);
  if (!Number.isInteger(row.year)) throw new Error(`${where}: invalid year`);
  const def = getStateRuleDef(row.key);
  if (!def) throw new Error(`${where}: unknown rule key`);
  const err = validateStateRuleValue(def, row.value);
  if (err) throw new Error(`${where}: ${err}`);
  if (!row.citation || !row.citation.trim()) throw new Error(`${where}: citation is required`);
  if (!STATUSES.includes(row.status)) throw new Error(`${where}: invalid status '${row.status}'`);
}

/**
 * Idempotently upsert the shipped state-rule seeds. Never touches the overrides
 * table. For each (state, year) that has seed rows, rows whose key is no longer in
 * the seed are removed (the code is the source of truth). `seeds` is injectable so
 * tests can sync a fixture. Everything is validated before anything is written.
 */
export async function syncShippedStateRules(
  seeds: readonly StateRuleSeedRow[] = STATE_RULE_SEEDS,
): Promise<{ groups: number; rows: number }> {
  const groups = new Map<string, StateRuleSeedRow[]>();
  const seen = new Set<string>();
  for (const row of seeds) {
    validateSeedRow(row);
    const id = `${row.state}|${row.year}|${row.key}`;
    if (seen.has(id)) throw new Error(`state rule seed ${row.state} ${row.year} '${row.key}': duplicate key`);
    seen.add(id);
    const g = `${row.state}|${row.year}`;
    (groups.get(g) ?? groups.set(g, []).get(g)!).push(row);
  }
  let total = 0;
  await db.transaction(async (tx) => {
    for (const rows of groups.values()) {
      const { state, year } = rows[0]!;
      for (const row of rows) {
        await tx.insert(stateEstimateRules).values({
          state, taxYear: year, key: row.key, value: jsonb(row.value), status: row.status, citation: row.citation,
        }).onConflictDoUpdate({
          target: [stateEstimateRules.state, stateEstimateRules.taxYear, stateEstimateRules.key],
          // R7 Verify: an in-app verification survives the re-sync only while the shipped value AND its
          // citation are unchanged (R6-10: "verified" means checked against the cited source).
          set: {
            value: jsonb(row.value), citation: row.citation, updatedAt: sql`now()`,
            status: sql`CASE WHEN "state_estimate_rules"."verified_at" IS NOT NULL AND "state_estimate_rules"."value" = excluded."value" AND "state_estimate_rules"."citation" = excluded."citation" THEN 'verified' ELSE excluded."status" END`,
            verifiedAt: sql`CASE WHEN "state_estimate_rules"."value" = excluded."value" AND "state_estimate_rules"."citation" = excluded."citation" THEN "state_estimate_rules"."verified_at" ELSE NULL END`,
            verifiedBy: sql`CASE WHEN "state_estimate_rules"."value" = excluded."value" AND "state_estimate_rules"."citation" = excluded."citation" THEN "state_estimate_rules"."verified_by" ELSE NULL END`,
            verificationNote: sql`CASE WHEN "state_estimate_rules"."value" = excluded."value" AND "state_estimate_rules"."citation" = excluded."citation" THEN "state_estimate_rules"."verification_note" ELSE NULL END`,
          },
        });
        total++;
      }
      const keep = rows.map((r) => r.key);
      const existing = await tx.select({ key: stateEstimateRules.key }).from(stateEstimateRules)
        .where(and(eq(stateEstimateRules.state, state), eq(stateEstimateRules.taxYear, year)));
      const stale = existing.map((e) => e.key).filter((k) => !keep.includes(k));
      if (stale.length > 0) {
        await tx.delete(stateEstimateRules).where(and(
          eq(stateEstimateRules.state, state), eq(stateEstimateRules.taxYear, year), inArray(stateEstimateRules.key, stale),
        ));
      }
    }
  });
  return { groups: groups.size, rows: total };
}

// ── loading + resolution ────────────────────────────────────────────────

interface Loaded { seeds: Map<string, SeedRow[]>; overrides: Map<string, OverrideRow[]> }

function group<T extends { state: string }>(rows: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) (m.get(r.state) ?? m.set(r.state, []).get(r.state)!).push(r);
  return m;
}

async function loadYear(exec: DbOrTx, year: number, state?: string): Promise<Loaded> {
  const sCond = state ? and(eq(stateEstimateRules.taxYear, year), eq(stateEstimateRules.state, state)) : eq(stateEstimateRules.taxYear, year);
  const oCond = state ? and(eq(stateEstimateRuleOverrides.taxYear, year), eq(stateEstimateRuleOverrides.state, state)) : eq(stateEstimateRuleOverrides.taxYear, year);
  const seeds = await exec.select().from(stateEstimateRules).where(sCond);
  const overrides = await exec.select().from(stateEstimateRuleOverrides).where(oCond);
  return { seeds: group(seeds), overrides: group(overrides) };
}

async function latestYearBefore(exec: DbOrTx, year: number, state?: string): Promise<number | null> {
  const sCond = state ? and(lt(stateEstimateRules.taxYear, year), eq(stateEstimateRules.state, state)) : lt(stateEstimateRules.taxYear, year);
  const oCond = state ? and(lt(stateEstimateRuleOverrides.taxYear, year), eq(stateEstimateRuleOverrides.state, state)) : lt(stateEstimateRuleOverrides.taxYear, year);
  const [a] = await exec.select({ y: sql<number | null>`max(${stateEstimateRules.taxYear})` }).from(stateEstimateRules).where(sCond);
  const [b] = await exec.select({ y: sql<number | null>`max(${stateEstimateRuleOverrides.taxYear})` }).from(stateEstimateRuleOverrides).where(oCond);
  const ys = [a?.y, b?.y].filter((y): y is number => typeof y === 'number');
  return ys.length > 0 ? Math.max(...ys) : null;
}

/** Latest earlier year per state (both tables), for the states that need a fallback. */
async function latestYearsBefore(exec: DbOrTx, year: number): Promise<Map<string, number>> {
  const a = await exec.select({ state: stateEstimateRules.state, y: sql<number>`max(${stateEstimateRules.taxYear})::int` })
    .from(stateEstimateRules).where(lt(stateEstimateRules.taxYear, year)).groupBy(stateEstimateRules.state);
  const b = await exec.select({ state: stateEstimateRuleOverrides.state, y: sql<number>`max(${stateEstimateRuleOverrides.taxYear})::int` })
    .from(stateEstimateRuleOverrides).where(lt(stateEstimateRuleOverrides.taxYear, year)).groupBy(stateEstimateRuleOverrides.state);
  const out = new Map<string, number>();
  for (const r of [...a, ...b]) out.set(r.state, Math.max(out.get(r.state) ?? 0, r.y));
  return out;
}

const stateHasRows = (loaded: Loaded, state: string): boolean =>
  (loaded.seeds.get(state)?.length ?? 0) + (loaded.overrides.get(state)?.length ?? 0) > 0;

/**
 * R6-02: a state served through the fallback has nothing of its own to edit or sign; one stray
 * row would end its fallback (a 1/20 "partial" set) and, before R6-02, block create-from-prior
 * for all 51 jurisdictions. A state with no rows in any year may still be built by hand.
 */
async function assertStateEditable(exec: DbOrTx, year: number, state: StateCode): Promise<void> {
  if (stateHasRows(await loadYear(exec, year, state), state)) return;
  if ((await latestYearBefore(exec, year, state)) === null) return;
  throw AppError.conflict(`${state} has no ${year} rules of its own (it is served from an earlier year); create the ${year} state rules from the prior year first`, 'TE_YEAR_NOT_CREATED', { year, state });
}

/** Resolve registry keys for one state's rows. Unknown DB keys are ignored. */
function resolveRows(seedRows: SeedRow[], ovRows: OverrideRow[]): Map<string, ResolvedValue> {
  const seedBy = new Map(seedRows.map((r) => [r.key, r]));
  const ovBy = new Map(ovRows.map((r) => [r.key, r]));
  const out = new Map<string, ResolvedValue>();
  for (const def of STATE_RULE_REGISTRY) {
    const seed = seedBy.get(def.key);
    const ov = ovBy.get(def.key);
    if (ov) {
      const isOverride = ov.status === 'override';
      out.set(def.key, {
        value: ov.value,
        status: ov.verifiedAt ? 'verified' : isOverride ? 'unverified' : 'provisional',
        source: isOverride ? 'override' : 'provisional',
        citation: seed ? seed.citation : ov.citation,
        reason: ov.reason,
        shippedValue: seed && !deepEqual(seed.value, ov.value) ? seed.value : undefined,
        hasShipped: !!seed,
        verifiedAt: ov.verifiedAt, verifiedBy: ov.verifiedBy, verificationNote: ov.verificationNote,
      });
    } else if (seed) {
      out.set(def.key, {
        value: seed.value, status: seed.status as ParameterStatus, source: 'seed', citation: seed.citation, reason: null, hasShipped: true,
        verifiedAt: seed.verifiedAt, verifiedBy: seed.verifiedBy, verificationNote: seed.verificationNote,
      });
    }
  }
  return out;
}

function incomeTaxOf(state: StateCode, resolved: Map<string, ResolvedValue>): boolean {
  const v = resolved.get('has_income_tax')?.value;
  return typeof v === 'boolean' ? v : isIncomeTaxState(state);
}

function missingKeys(state: StateCode, resolved: Map<string, ResolvedValue>): string[] {
  return requiredStateRuleKeys(incomeTaxOf(state, resolved)).filter((k) => !resolved.has(k));
}

// ── reads ───────────────────────────────────────────────────────────────

/** One state-year DTO from its resolved rows (`fallbackYear` set = served through the fallback: dates derived for `year`, everything provisional). */
function buildStateRulesDto(year: number, state: StateCode, resolved: Map<string, ResolvedValue>, fallbackYear: number | null, emails: Map<string, string>): StateRulesDTO {
  const isFallback = fallbackYear !== null;
  const missing = missingKeys(state, resolved);
  // R3-04 / R6-01: a fallback year's date rules are derived for the requested year.
  const rolled = isFallback ? rollStateDates(resolved, fallbackYear, year) : new Map<string, unknown>();
  const rules: StateRuleRowDTO[] = [];
  for (const def of STATE_RULE_REGISTRY) {
    const r = resolved.get(def.key);
    if (!r) continue;
    const row: StateRuleRowDTO = {
      state, key: def.key, label: def.label, type: def.type, value: rolled.has(def.key) ? rolled.get(def.key) : r.value,
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
    rules.push(row);
  }
  return {
    year, state, hasIncomeTax: incomeTaxOf(state, resolved),
    isFallback, fallbackYear,
    complete: missing.length === 0, missing, rules,
  };
}

/**
 * THE state-year read (R6-03): the estimate (gather → jurisdictionFromStateRules), the admin
 * detail screen and the summaries all resolve through it, so they cannot disagree about a
 * state with no rows for the year (served from its latest earlier year, flagged).
 */
export async function getStateRules(year: number, stateIn: string, executor: DbOrTx = db): Promise<StateRulesDTO> {
  const state = assertState(stateIn);
  let loaded = await loadYear(executor, year, state);
  let resolved = resolveRows(loaded.seeds.get(state) ?? [], loaded.overrides.get(state) ?? []);
  let fallbackYear: number | null = null;
  if (resolved.size === 0) {
    const fy = await latestYearBefore(executor, year, state);
    if (fy !== null) {
      loaded = await loadYear(executor, fy, state);
      resolved = resolveRows(loaded.seeds.get(state) ?? [], loaded.overrides.get(state) ?? []);
      if (resolved.size > 0) fallbackYear = fy;
    }
  }
  const emails = fallbackYear !== null ? new Map<string, string>() : await verifierEmails(executor, [...resolved.values()].map((r) => r.verifiedBy));
  return buildStateRulesDto(year, state, resolved, fallbackYear, emails);
}

function countsOf(resolved: Map<string, ResolvedValue>): StateRuleSummaryDTO['counts'] {
  const counts = { verified: 0, unverified: 0, provisional: 0, override: 0 };
  for (const r of resolved.values()) {
    if (r.source === 'override') counts.override++;
    else counts[r.status]++;
  }
  return counts;
}

/**
 * One summary per jurisdiction, with the SAME resolution the estimate uses (R6-03): a state with
 * no rows for `year` reports status `fallback` + `fallbackYear` (its rules are served, all
 * provisional), `missing` only when it has no rows in any year; `usesFederalFallback` is
 * jurisdictionFromStateRules' decision on that same DTO.
 */
export async function listSummaries(year: number, executor: DbOrTx = db): Promise<StateRuleSummaryDTO[]> {
  const loaded = await loadYear(executor, year);
  const fallbackYears = await latestYearsBefore(executor, year);
  const fallbackLoaded = new Map<number, Loaded>();
  for (const state of STATE_CODES) {
    const fy = fallbackYears.get(state);
    if (fy !== undefined && !stateHasRows(loaded, state) && !fallbackLoaded.has(fy)) fallbackLoaded.set(fy, await loadYear(executor, fy));
  }
  return STATE_CODES.map((state) => {
    let resolved = resolveRows(loaded.seeds.get(state) ?? [], loaded.overrides.get(state) ?? []);
    let fallbackYear: number | null = null;
    const fy = fallbackYears.get(state);
    if (resolved.size === 0 && fy !== undefined) {
      const fl = fallbackLoaded.get(fy)!;
      resolved = resolveRows(fl.seeds.get(state) ?? [], fl.overrides.get(state) ?? []);
      if (resolved.size > 0) fallbackYear = fy;
    }
    const dto = buildStateRulesDto(year, state, resolved, fallbackYear, new Map());
    const status: StateRuleSummaryDTO['status'] = resolved.size === 0 ? 'missing' : fallbackYear !== null ? 'fallback' : dto.complete ? 'complete' : 'partial';
    return {
      state, name: STATE_NAMES[state], hasIncomeTax: dto.hasIncomeTax, status,
      counts: fallbackYear !== null ? { verified: 0, unverified: 0, provisional: resolved.size, override: 0 } : countsOf(resolved),
      usesFederalFallback: jurisdictionFromStateRules(dto).usesFederalFallback,
      fallbackYear,
    };
  });
}

// ── writes ──────────────────────────────────────────────────────────────

async function getRow(year: number, state: StateCode, key: string): Promise<StateRuleRowDTO> {
  const dto = await getStateRules(year, state);
  const row = dto.rules.find((p) => p.key === key);
  if (!row) throw AppError.notFound('State rule not found');
  return row;
}

/** A second key saved in the same request (QA D6: the other half of an installment pair). */
export interface StateRuleCompanion { key: string; value: unknown }

/** Effective value of `key` for the state-year (override, else shipped); undefined when the rule has no row. */
async function effectiveValue(exec: DbOrTx, year: number, state: StateCode, key: string): Promise<unknown> {
  const loaded = await loadYear(exec, year, state);
  return resolveRows(loaded.seeds.get(state) ?? [], loaded.overrides.get(state) ?? []).get(key)?.value;
}

/** QA D6: the installment percentages must match the due dates and add up to 100% after the edit. */
async function assertInstallmentShape(exec: DbOrTx, year: number, state: StateCode, edits: Map<string, unknown>): Promise<void> {
  for (const key of edits.keys()) {
    const pair = installmentPairOf(STATE_INSTALLMENT_PAIRS, key);
    if (!pair) continue;
    const pick = async (k: string) => (edits.has(k) ? edits.get(k) : (await effectiveValue(exec, year, state, k)) ?? null);
    const err = installmentPairError(pair, await pick(pair.pcts), await pick(pair.schedule));
    if (err) throw new AppError(400, `${state}: ${err}`, 'TE_STATE_RULE_INVALID', { year, state, key });
  }
}

export async function setOverride(
  year: number, stateIn: string, key: string, value: unknown, reason: string, userId?: string, companion?: StateRuleCompanion,
): Promise<StateRuleRowDTO> {
  const state = assertState(stateIn);
  const edits = new Map<string, unknown>([[key, value]]);
  if (companion) {
    if (installmentPartnerKey(STATE_INSTALLMENT_PAIRS, key) !== companion.key) {
      throw AppError.badRequest(`'${companion.key}' cannot be saved together with '${key}'`, 'TE_STATE_RULE_INVALID');
    }
    edits.set(companion.key, companion.value);
  }
  for (const [k, v] of edits) {
    const def = getStateRuleDef(k);
    if (!def) throw AppError.badRequest(`Unknown state rule '${k}'`, 'TE_STATE_RULE_INVALID');
    const err = validateStateRuleValue(def, v);
    if (err) throw AppError.badRequest(`Invalid value for '${k}': ${err}`, 'TE_STATE_RULE_INVALID');
  }
  const why = (reason ?? '').trim();
  if (why.length < MIN_REASON_LEN) throw AppError.badRequest('A reason of at least 3 characters is required', 'TE_STATE_RULE_INVALID');

  await db.transaction(async (tx) => {
    await assertStateEditable(tx, year, state);
    await assertInstallmentShape(tx, year, state, edits);
    for (const [k, v] of edits) await upsertOverride(tx, year, state, k, v, why, userId);
  });
  return getRow(year, state, key);
}

async function upsertOverride(tx: DbOrTx, year: number, state: StateCode, key: string, value: unknown, why: string, userId?: string): Promise<void> {
  const [prev] = await tx.select().from(stateEstimateRuleOverrides).where(and(
    eq(stateEstimateRuleOverrides.state, state), eq(stateEstimateRuleOverrides.taxYear, year), eq(stateEstimateRuleOverrides.key, key)));
  const [seed] = await tx.select().from(stateEstimateRules).where(and(
    eq(stateEstimateRules.state, state), eq(stateEstimateRules.taxYear, year), eq(stateEstimateRules.key, key)));
  // R6-08: the same value again keeps the sign-off; a provisional copy with no shipped row stays provisional.
  const sameValue = !!prev && deepEqual(prev.value, value);
  const status = prev?.status === 'provisional' && !seed ? 'provisional' : 'override';
  const [saved] = await tx.insert(stateEstimateRuleOverrides).values({
    state, taxYear: year, key, value: jsonb(value), status, reason: why, createdBy: userId ?? null,
  }).onConflictDoUpdate({
    target: [stateEstimateRuleOverrides.state, stateEstimateRuleOverrides.taxYear, stateEstimateRuleOverrides.key],
    // A new override value is a new decision: any earlier verification is cleared (R7 Verify).
    set: {
      value: jsonb(value), status, reason: why, createdBy: userId ?? null, updatedAt: sql`now()`,
      ...(sameValue ? {} : { verifiedAt: null, verifiedBy: null, verificationNote: null }),
    },
  }).returning();
  // R6-09: `before` is the value the engine was reading (override, else the shipped seed).
  await auditLog(ZERO_TENANT, 'override', AUDIT_ENTITY, saved!.id,
    { year, state, key, value: prev?.value ?? seed?.value ?? null },
    { op: 'override_set', year, state, key, value, reason: why }, userId, tx);
}

export async function revertOverride(year: number, stateIn: string, key: string, userId?: string): Promise<void> {
  const state = assertState(stateIn);
  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(stateEstimateRuleOverrides).where(and(
      eq(stateEstimateRuleOverrides.state, state), eq(stateEstimateRuleOverrides.taxYear, year), eq(stateEstimateRuleOverrides.key, key)));
    if (!row) throw AppError.notFound('No override or provisional value for this state rule');
    const [seed] = await tx.select({ id: stateEstimateRules.id }).from(stateEstimateRules).where(and(
      eq(stateEstimateRules.state, state), eq(stateEstimateRules.taxYear, year), eq(stateEstimateRules.key, key)));
    if (!seed) {
      // R6-07: no shipped row underneath — deleting leaves the rule missing (an incomplete set, federal pattern)
      // unless this is the state-year's only row, in which case removing it restores the fallback.
      const [n] = await tx.select({ n: sql<number>`count(*)::int` }).from(stateEstimateRuleOverrides).where(and(
        eq(stateEstimateRuleOverrides.state, state), eq(stateEstimateRuleOverrides.taxYear, year)));
      const [m] = await tx.select({ n: sql<number>`count(*)::int` }).from(stateEstimateRules).where(and(
        eq(stateEstimateRules.state, state), eq(stateEstimateRules.taxYear, year)));
      if ((n?.n ?? 0) + (m?.n ?? 0) > 1) {
        throw AppError.conflict(`${state} ${key} has no shipped value for ${year}; removing it would leave the rule missing. Edit the value instead.`, 'TE_NO_SHIPPED_VALUE', { year, state, key });
      }
    }
    await tx.delete(stateEstimateRuleOverrides).where(eq(stateEstimateRuleOverrides.id, row.id));
    await auditLog(ZERO_TENANT, 'override', AUDIT_ENTITY, row.id,
      { year, state, key, value: row.value },
      { op: 'override_reverted', year, state, key, value: null, reason: null }, userId, tx);
    // QA D6: back on the shipped value, the installment pair must still line up; when it no
    // longer does, the partner's override goes back to shipped too (in the same transaction).
    const pair = installmentPairOf(STATE_INSTALLMENT_PAIRS, key);
    if (pair) {
      const partner = pair.pcts === key ? pair.schedule : pair.pcts;
      const pcts = (await effectiveValue(tx, year, state, pair.pcts)) ?? null;
      const sched = (await effectiveValue(tx, year, state, pair.schedule)) ?? null;
      if (installmentPairError(pair, pcts, sched)) {
        const [p] = await tx.select().from(stateEstimateRuleOverrides).where(and(
          eq(stateEstimateRuleOverrides.state, state), eq(stateEstimateRuleOverrides.taxYear, year), eq(stateEstimateRuleOverrides.key, partner)));
        const [pSeed] = await tx.select({ id: stateEstimateRules.id }).from(stateEstimateRules).where(and(
          eq(stateEstimateRules.state, state), eq(stateEstimateRules.taxYear, year), eq(stateEstimateRules.key, partner)));
        if (p && !pSeed) {
          throw new AppError(400, `Reverting ${key} would leave it out of line with ${partner}; override both together instead`, 'TE_STATE_RULE_INVALID', { year, state, key });
        }
        if (p) {
          await tx.delete(stateEstimateRuleOverrides).where(eq(stateEstimateRuleOverrides.id, p.id));
          await auditLog(ZERO_TENANT, 'override', AUDIT_ENTITY, p.id,
            { year, state, key: partner, value: p.value },
            { op: 'override_reverted', year, state, key: partner, value: null, reason: `reverted with ${key}` }, userId, tx);
        }
      }
    }
  });
}

// ── in-app Verify (R7; super admin only — enforced by the admin router) ────

const cleanNote = (note: string | undefined): string | null => {
  const t = (note ?? '').trim();
  return t === '' ? null : t;
};

const changedError = (year: number, state: StateCode, key: string, currentValue: unknown) => AppError.conflict(
  `The value of ${state} ${key} for ${year} changed since you read it; review the current value and verify again`,
  'TE_PARAM_CHANGED', { year, state, key, currentValue },
);

interface VerifyOpts {
  /** The value the caller saw (R6-04). undefined = sign whatever the row carries now. */
  expectedValue?: { value: unknown };
  /** Bulk verify: a row whose value changed under us is skipped, not thrown. */
  onChanged: 'throw' | 'skip';
}

type VerifyOutcome = 'verified' | 'already' | 'changed';

function changed(year: number, state: StateCode, key: string, currentValue: unknown, opts: VerifyOpts): VerifyOutcome {
  if (opts.onChanged === 'throw') throw changedError(year, state, key, currentValue);
  return 'changed';
}

/**
 * Mark one (state, key) verified for the value the caller saw; the override/provisional row wins
 * over the seed. Already verified = no-op. Conditional UPDATE … WHERE not yet verified AND value =
 * expected RETURNING (R6-04): one sign-off and one audit row per race, and a value changed after
 * it was read is never signed (409 TE_PARAM_CHANGED, or `changed` under bulk).
 */
async function verifyOne(tx: DbOrTx, year: number, state: StateCode, key: string, note: string | null, userId: string | undefined, opts: VerifyOpts): Promise<VerifyOutcome> {
  const now = new Date();
  const [ov] = await tx.select().from(stateEstimateRuleOverrides).where(and(
    eq(stateEstimateRuleOverrides.state, state), eq(stateEstimateRuleOverrides.taxYear, year), eq(stateEstimateRuleOverrides.key, key)));
  if (ov) {
    if (ov.verifiedAt) return 'already';
    const expected = opts.expectedValue ? opts.expectedValue.value : ov.value;
    if (!deepEqual(expected, ov.value)) return changed(year, state, key, ov.value, opts);
    const updated = await tx.update(stateEstimateRuleOverrides).set({ verifiedAt: now, verifiedBy: userId ?? null, verificationNote: note })
      .where(and(eq(stateEstimateRuleOverrides.id, ov.id), isNull(stateEstimateRuleOverrides.verifiedAt), sql`${stateEstimateRuleOverrides.value} = ${jsonb(expected)}`))
      .returning({ id: stateEstimateRuleOverrides.id });
    if (updated.length === 0) {
      const [now2] = await tx.select().from(stateEstimateRuleOverrides).where(eq(stateEstimateRuleOverrides.id, ov.id));
      if (!now2) throw AppError.notFound('State rule not found');
      if (now2.verifiedAt) return 'already';
      return changed(year, state, key, now2.value, opts);
    }
    await auditLog(ZERO_TENANT, 'signoff', AUDIT_ENTITY, ov.id,
      { year, state, key, value: ov.value, status: ov.status },
      { op: 'verified', year, state, key, value: ov.value, source: ov.status, reason: note }, userId, tx);
    return 'verified';
  }
  const [seed] = await tx.select().from(stateEstimateRules).where(and(
    eq(stateEstimateRules.state, state), eq(stateEstimateRules.taxYear, year), eq(stateEstimateRules.key, key)));
  if (!seed) throw AppError.notFound('State rule not found');
  if (seed.status === 'verified') return 'already';
  const expected = opts.expectedValue ? opts.expectedValue.value : seed.value;
  if (!deepEqual(expected, seed.value)) return changed(year, state, key, seed.value, opts);
  const updated = await tx.update(stateEstimateRules).set({ status: 'verified', verifiedAt: now, verifiedBy: userId ?? null, verificationNote: note })
    .where(and(eq(stateEstimateRules.id, seed.id), ne(stateEstimateRules.status, 'verified'), sql`${stateEstimateRules.value} = ${jsonb(expected)}`))
    .returning({ id: stateEstimateRules.id });
  if (updated.length === 0) {
    const [now2] = await tx.select().from(stateEstimateRules).where(eq(stateEstimateRules.id, seed.id));
    if (!now2) throw AppError.notFound('State rule not found');
    if (now2.status === 'verified') return 'already';
    return changed(year, state, key, now2.value, opts);
  }
  await auditLog(ZERO_TENANT, 'signoff', AUDIT_ENTITY, seed.id,
    { year, state, key, value: seed.value, status: seed.status },
    { op: 'verified', year, state, key, value: seed.value, source: 'seed', reason: note }, userId, tx);
  return 'verified';
}

export async function verifyStateRule(year: number, stateIn: string, key: string, note: string | undefined, userId?: string, expectedValue?: unknown): Promise<StateRuleRowDTO> {
  const state = assertState(stateIn);
  if (!getStateRuleDef(key)) throw AppError.badRequest(`Unknown state rule '${key}'`, 'TE_STATE_RULE_INVALID');
  await db.transaction(async (tx) => {
    await assertStateEditable(tx, year, state);
    await verifyOne(tx, year, state, key, cleanNote(note), userId, { expectedValue: expectedValue === undefined ? undefined : { value: expectedValue }, onChanged: 'throw' });
  });
  return getRow(year, state, key);
}

/**
 * Bulk Verify for ONE jurisdiction's year: every rule whose effective status is not verified, each
 * signed for the value read in this transaction; a rule overridden under us is listed in `changed`.
 * Returns `ST:key` refs.
 */
export async function verifyAllStateRules(year: number, stateIn: string, note: string | undefined, userId?: string): Promise<VerifyStateRulesResult> {
  const state = assertState(stateIn);
  const why = cleanNote(note);
  return db.transaction(async (tx) => {
    const loaded = await loadYear(tx, year, state);
    const resolved = resolveRows(loaded.seeds.get(state) ?? [], loaded.overrides.get(state) ?? []);
    const verified: string[] = [];
    const changedKeys: string[] = [];
    for (const [key, r] of resolved) {
      if (r.status === 'verified') continue;
      const outcome = await verifyOne(tx, year, state, key, why, userId, { expectedValue: { value: r.value }, onChanged: 'skip' });
      if (outcome === 'verified') verified.push(stateRuleRef(state, key));
      else if (outcome === 'changed') changedKeys.push(stateRuleRef(state, key));
    }
    return changedKeys.length > 0 ? { verified, changed: changedKeys } : { verified };
  });
}

/**
 * One state's date-valued rules rolled from `fromYear` to `year` (key → rolled value, in
 * registry order) through the shared rollStateRuleDates (R6-01): the state's holiday list is
 * regenerated from the rules it evidently follows, each observed date is un-bumped to its
 * statutory day and landed on the next business day under the new list; penalty rate legs
 * keep their rates. Shared by "create year from prior" and the missing-year fallback of
 * getStateRules (R3-04). Every result is provisional and flagged "verify".
 */
function rollStateDates(resolved: Map<string, ResolvedValue>, fromYear: number, year: number): Map<string, unknown> {
  const values = new Map<string, unknown>();
  for (const def of STATE_RULE_REGISTRY) {
    const r = resolved.get(def.key);
    if (r) values.set(def.key, r.value);
  }
  return rollStateRuleDates(values, fromYear, year);
}

/**
 * Create `year` for every jurisdiction that has rows in the latest earlier year and none for
 * `year` yet (R6-02: per state — a jurisdiction that already has rows is skipped and reported,
 * never a reason to refuse the other fifty). 409 TE_YEAR_EXISTS only when nothing is left to create.
 */
export async function createYearFromPrior(year: number, userId?: string): Promise<CreateStateYearFromPriorResult> {
  return db.transaction(async (tx) => {
    const fromYear = await latestYearBefore(tx, year);
    if (fromYear === null) throw AppError.badRequest('No earlier tax year to copy from', 'TE_NO_PRIOR_YEAR');
    const existing = await loadYear(tx, year);
    const prior = await loadYear(tx, fromYear);

    const reason = `Created from ${fromYear}; verify`;
    const rolledDates: string[] = [];
    const skipped: StateCode[] = [];
    const values: Array<typeof stateEstimateRuleOverrides.$inferInsert> = [];
    let states = 0;
    for (const state of STATE_CODES) {
      const resolved = resolveRows(prior.seeds.get(state) ?? [], prior.overrides.get(state) ?? []);
      if (resolved.size === 0) continue;
      if (stateHasRows(existing, state)) { skipped.push(state); continue; }
      states++;
      const rolled = rollStateDates(resolved, fromYear, year);
      for (const k of rolled.keys()) rolledDates.push(`${state}:${k}`);
      for (const def of STATE_RULE_REGISTRY) {
        const p = resolved.get(def.key);
        if (!p) continue;
        const value = rolled.has(def.key) ? rolled.get(def.key) : p.value;
        values.push({
          state, taxYear: year, key: def.key, value: jsonb(value), status: 'provisional', citation: p.citation,
          reason, createdFromYear: fromYear, createdBy: userId ?? null,
        });
      }
    }
    if (values.length === 0) throw AppError.conflict(`State rules for ${year} already exist for every jurisdiction that has ${fromYear} rules`, 'TE_YEAR_EXISTS', { skipped });
    await tx.insert(stateEstimateRuleOverrides).values(values);
    await auditLog(ZERO_TENANT, 'override', AUDIT_ENTITY, null,
      { year, state: null, key: null, value: null },
      { op: 'year_created', year, state: null, key: null, value: { fromYear, created: values.length, states, skipped, rolledDates }, reason }, userId, tx);
    return { year, fromYear, created: values.length, states, skipped, rolledDates };
  });
}

export async function diffShippedVsProvisional(year: number): Promise<StateRuleDiffRowDTO[]> {
  const ovs = await db.select().from(stateEstimateRuleOverrides)
    .where(and(eq(stateEstimateRuleOverrides.taxYear, year), eq(stateEstimateRuleOverrides.status, 'provisional')));
  if (ovs.length === 0) return [];
  const seeds = await db.select().from(stateEstimateRules).where(eq(stateEstimateRules.taxYear, year));
  const seedBy = new Map(seeds.map((s) => [`${s.state}|${s.key}`, s]));
  const keyOrder = new Map(STATE_RULE_REGISTRY.map((d, i) => [d.key, i]));
  const stateOrder = new Map(STATE_CODES.map((c, i) => [c as string, i]));
  const rows: Array<{ s: number; k: number; row: StateRuleDiffRowDTO }> = [];
  for (const o of ovs) {
    const s = seedBy.get(`${o.state}|${o.key}`);
    const def = getStateRuleDef(o.key);
    if (!s || !def || !isStateCode(o.state)) continue;
    rows.push({
      s: stateOrder.get(o.state) ?? 0, k: keyOrder.get(o.key) ?? 0,
      row: {
        state: o.state, key: o.key, label: def.label,
        shippedValue: s.value, shippedStatus: s.status as ParameterStatus, shippedCitation: s.citation,
        provisionalValue: o.value,
        same: deepEqual(s.value, o.value),
      },
    });
  }
  return rows.sort((a, b) => a.s - b.s || a.k - b.k).map((r) => r.row);
}

/** `keys` are `ST:key` references (see stateRuleRef); omit to adopt every differing row. */
export async function adoptShipped(year: number, keys: string[] | undefined, userId?: string): Promise<{ adopted: string[] }> {
  const diffable = await diffShippedVsProvisional(year);
  const target = keys ? diffable.filter((r) => keys.includes(stateRuleRef(r.state, r.key))) : diffable;
  if (target.length === 0) return { adopted: [] };
  await db.transaction(async (tx) => {
    for (const t of target) {
      const removed = await tx.delete(stateEstimateRuleOverrides).where(and(
        eq(stateEstimateRuleOverrides.taxYear, year), eq(stateEstimateRuleOverrides.status, 'provisional'),
        eq(stateEstimateRuleOverrides.state, t.state), eq(stateEstimateRuleOverrides.key, t.key),
      )).returning();
      for (const r of removed) {
        await auditLog(ZERO_TENANT, 'override', AUDIT_ENTITY, r.id,
          { year, state: t.state, key: r.key, value: r.value },
          { op: 'shipped_adopted', year, state: t.state, key: r.key, value: null, reason: null }, userId, tx);
      }
    }
  });
  return { adopted: target.map((t) => stateRuleRef(t.state, t.key)) };
}

interface ChangeBlob { op?: string; year?: number; state?: string | null; key?: string | null; value?: unknown; reason?: string | null }

/** Recent state-rule changes, newest first; `year` (R6-09) limits the feed to one tax year. */
export async function listChanges(limit: number, year?: number): Promise<StateRuleChangeDTO[]> {
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
  const parse = (v: unknown): ChangeBlob => {
    if (typeof v === 'string') { try { return JSON.parse(v) as ChangeBlob; } catch { return {}; } }
    return (v ?? {}) as ChangeBlob;
  };
  const out: StateRuleChangeDTO[] = [];
  for (const r of rows) {
    const b = parse(r.before);
    const a = parse(r.after);
    const op = a.op;
    if (op !== 'override_set' && op !== 'override_reverted' && op !== 'year_created' && op !== 'shipped_adopted' && op !== 'verified') continue;
    const st = a.state ?? b.state ?? null;
    out.push({
      at: (r.at ?? new Date(0)).toISOString(),
      userId: r.userId ?? null,
      userEmail: r.email ?? null,
      action: op,
      year: a.year ?? b.year ?? 0,
      state: st && isStateCode(st) ? st : null,
      key: a.key ?? null,
      before: b.value ?? null,
      after: a.value ?? null,
      reason: a.reason ?? null,
    });
  }
  return out;
}
