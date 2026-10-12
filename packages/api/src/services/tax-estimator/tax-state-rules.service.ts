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
// with no rows for a year falls back (display only) to its latest earlier year,
// flagged provisional. The estimator itself uses resolveStateRulesForEngine():
// a state with no usable rule set is computed with the federal pattern and a
// "verify" badge.
//
// Audit: global data, so changes are written to audit_log under the all-zero
// tenant id with entity type 'tax_state_rule' (operation in after_data.op).

import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm';
import {
  STATE_CODES, STATE_NAMES, STATE_RULE_REGISTRY, getStateRuleDef, validateStateRuleValue,
  requiredStateRuleKeys, isIncomeTaxState, rollStateRuleDates, stateRuleRef,
  type StateCode, type StateRuleSeedRow, type ParameterStatus,
  type StateRulesDTO, type StateRuleRowDTO, type StateRuleSummaryDTO,
  type CreateStateYearFromPriorResult, type StateRulesEngineView, type StateRuleDiffRowDTO, type StateRuleChangeDTO,
  type VerifyStateRulesResult,
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
const ESTIMATES_REQUIRED_KEY = 'estimates_required';
/** Voucher-schedule keys withheld from the engine when a state has no estimate regime. */
const VOUCHER_KEYS: readonly string[] = ['installments.due_dates', 'installments.pcts', 'installments.q4_file_and_pay_date'];
const STATUSES: readonly string[] = ['verified', 'unverified', 'provisional'];

interface ResolvedValue {
  value: unknown;
  status: ParameterStatus;
  source: StateRuleRowDTO['source'];
  citation: string;
  reason: string | null;
  shippedValue?: unknown;
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
          // R7 Verify: an in-app verification survives the re-sync only while the shipped value is unchanged.
          set: {
            value: jsonb(row.value), citation: row.citation, updatedAt: sql`now()`,
            status: sql`CASE WHEN "state_estimate_rules"."verified_at" IS NOT NULL AND "state_estimate_rules"."value" = excluded."value" THEN 'verified' ELSE excluded."status" END`,
            verifiedAt: sql`CASE WHEN "state_estimate_rules"."value" = excluded."value" THEN "state_estimate_rules"."verified_at" ELSE NULL END`,
            verifiedBy: sql`CASE WHEN "state_estimate_rules"."value" = excluded."value" THEN "state_estimate_rules"."verified_by" ELSE NULL END`,
            verificationNote: sql`CASE WHEN "state_estimate_rules"."value" = excluded."value" THEN "state_estimate_rules"."verification_note" ELSE NULL END`,
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

async function anyRowsInYear(exec: DbOrTx, year: number): Promise<boolean> {
  const [a] = await exec.select({ n: sql<number>`count(*)::int` }).from(stateEstimateRules).where(eq(stateEstimateRules.taxYear, year));
  if ((a?.n ?? 0) > 0) return true;
  const [b] = await exec.select({ n: sql<number>`count(*)::int` }).from(stateEstimateRuleOverrides).where(eq(stateEstimateRuleOverrides.taxYear, year));
  return (b?.n ?? 0) > 0;
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
        citation: ov.citation || seed?.citation || '',
        reason: ov.reason,
        shippedValue: seed && !deepEqual(seed.value, ov.value) ? seed.value : undefined,
        verifiedAt: ov.verifiedAt, verifiedBy: ov.verifiedBy, verificationNote: ov.verificationNote,
      });
    } else if (seed) {
      out.set(def.key, {
        value: seed.value, status: seed.status as ParameterStatus, source: 'seed', citation: seed.citation, reason: null,
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

export async function getStateRules(year: number, stateIn: string, executor: DbOrTx = db): Promise<StateRulesDTO> {
  const state = assertState(stateIn);
  let loaded = await loadYear(executor, year, state);
  let resolved = resolveRows(loaded.seeds.get(state) ?? [], loaded.overrides.get(state) ?? []);
  let fallbackYear: number | null = null;
  if (resolved.size === 0) {
    fallbackYear = await latestYearBefore(executor, year, state);
    if (fallbackYear !== null) {
      loaded = await loadYear(executor, fallbackYear, state);
      resolved = resolveRows(loaded.seeds.get(state) ?? [], loaded.overrides.get(state) ?? []);
    }
  }
  const isFallback = fallbackYear !== null && resolved.size > 0;
  const missing = missingKeys(state, resolved);
  // R3-04: a fallback year's date rules are rolled to the requested year.
  const rolled = isFallback ? rollStateDates(resolved, fallbackYear!, year) : new Map<string, unknown>();
  const rules: StateRuleRowDTO[] = [];
  const emails = isFallback ? new Map<string, string>() : await verifierEmails(executor, [...resolved.values()].map((r) => r.verifiedBy));
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
    isFallback, fallbackYear: isFallback ? fallbackYear : null,
    complete: missing.length === 0, missing, rules,
  };
}

function countsOf(resolved: Map<string, ResolvedValue>): StateRuleSummaryDTO['counts'] {
  const counts = { verified: 0, unverified: 0, provisional: 0, override: 0 };
  for (const r of resolved.values()) {
    if (r.source === 'override') counts.override++;
    else counts[r.status]++;
  }
  return counts;
}

type EngineView = StateRulesEngineView;

/** The shared decision behind summaries and the engine resolver (no earlier-year fallback). */
function engineView(state: StateCode, resolved: Map<string, ResolvedValue>): EngineView {
  if (resolved.size === 0) {
    if (!isIncomeTaxState(state)) return { rules: { has_income_tax: false }, usesFederalFallback: false, verifyBadge: true, estimatesRequired: false };
    return { rules: {}, usesFederalFallback: true, verifyBadge: true, estimatesRequired: true };
  }
  const allVerified = [...resolved.values()].every((r) => r.status === 'verified');
  if (!incomeTaxOf(state, resolved)) {
    const flag = resolved.get('has_income_tax');
    return { rules: { has_income_tax: false }, usesFederalFallback: false, verifyBadge: !flag || flag.status !== 'verified', estimatesRequired: false };
  }
  const rules: Record<string, unknown> = {};
  for (const [k, r] of resolved) rules[k] = r.value;
  if (missingKeys(state, resolved).length > 0) return { rules, usesFederalFallback: true, verifyBadge: true, estimatesRequired: true };
  const estimatesRequired = rules[ESTIMATES_REQUIRED_KEY] !== false;
  if (!estimatesRequired) for (const k of VOUCHER_KEYS) delete rules[k];
  return { rules, usesFederalFallback: false, verifyBadge: !allVerified, estimatesRequired };
}

export async function listSummaries(year: number, executor: DbOrTx = db): Promise<StateRuleSummaryDTO[]> {
  const loaded = await loadYear(executor, year);
  return STATE_CODES.map((state) => {
    const resolved = resolveRows(loaded.seeds.get(state) ?? [], loaded.overrides.get(state) ?? []);
    const missing = missingKeys(state, resolved);
    const status: StateRuleSummaryDTO['status'] = resolved.size === 0 ? 'missing' : missing.length === 0 ? 'complete' : 'partial';
    return {
      state, name: STATE_NAMES[state], hasIncomeTax: incomeTaxOf(state, resolved), status,
      counts: countsOf(resolved),
      usesFederalFallback: engineView(state, resolved).usesFederalFallback,
    };
  });
}

/**
 * Engine entry point. `usesFederalFallback` means the caller must apply the federal
 * pattern for this state and show a "verify" badge. States without an income tax
 * return only { has_income_tax: false }.
 */
export async function resolveStateRulesForEngine(stateIn: string, year: number, executor: DbOrTx = db): Promise<EngineView> {
  const state = assertState(stateIn);
  const loaded = await loadYear(executor, year, state);
  return engineView(state, resolveRows(loaded.seeds.get(state) ?? [], loaded.overrides.get(state) ?? []));
}

// ── writes ──────────────────────────────────────────────────────────────

async function getRow(year: number, state: StateCode, key: string): Promise<StateRuleRowDTO> {
  const dto = await getStateRules(year, state);
  const row = dto.rules.find((p) => p.key === key);
  if (!row) throw AppError.notFound('State rule not found');
  return row;
}

export async function setOverride(
  year: number, stateIn: string, key: string, value: unknown, reason: string, userId?: string,
): Promise<StateRuleRowDTO> {
  const state = assertState(stateIn);
  const def = getStateRuleDef(key);
  if (!def) throw AppError.badRequest(`Unknown state rule '${key}'`, 'TE_STATE_RULE_INVALID');
  const err = validateStateRuleValue(def, value);
  if (err) throw AppError.badRequest(`Invalid value for '${key}': ${err}`, 'TE_STATE_RULE_INVALID');
  const why = (reason ?? '').trim();
  if (why.length < MIN_REASON_LEN) throw AppError.badRequest('A reason of at least 3 characters is required', 'TE_STATE_RULE_INVALID');

  await db.transaction(async (tx) => {
    const [prev] = await tx.select().from(stateEstimateRuleOverrides).where(and(
      eq(stateEstimateRuleOverrides.state, state), eq(stateEstimateRuleOverrides.taxYear, year), eq(stateEstimateRuleOverrides.key, key)));
    const [saved] = await tx.insert(stateEstimateRuleOverrides).values({
      state, taxYear: year, key, value: jsonb(value), status: 'override', reason: why, createdBy: userId ?? null,
    }).onConflictDoUpdate({
      target: [stateEstimateRuleOverrides.state, stateEstimateRuleOverrides.taxYear, stateEstimateRuleOverrides.key],
      // A new override value is a new decision: any earlier verification is cleared (R7 Verify).
      set: { value: jsonb(value), status: 'override', reason: why, createdBy: userId ?? null, updatedAt: sql`now()`, verifiedAt: null, verifiedBy: null, verificationNote: null },
    }).returning();
    await auditLog(ZERO_TENANT, 'override', AUDIT_ENTITY, saved!.id,
      { year, state, key, value: prev?.value ?? null },
      { op: 'override_set', year, state, key, value, reason: why }, userId, tx);
  });
  return getRow(year, state, key);
}

export async function revertOverride(year: number, stateIn: string, key: string, userId?: string): Promise<void> {
  const state = assertState(stateIn);
  await db.transaction(async (tx) => {
    const [row] = await tx.delete(stateEstimateRuleOverrides).where(and(
      eq(stateEstimateRuleOverrides.state, state), eq(stateEstimateRuleOverrides.taxYear, year), eq(stateEstimateRuleOverrides.key, key),
    )).returning();
    if (!row) throw AppError.notFound('No override or provisional value for this state rule');
    await auditLog(ZERO_TENANT, 'override', AUDIT_ENTITY, row.id,
      { year, state, key, value: row.value },
      { op: 'override_reverted', year, state, key, value: null, reason: null }, userId, tx);
  });
}

// ── in-app Verify (R7; super admin only — enforced by the admin router) ────

const cleanNote = (note: string | undefined): string | null => {
  const t = (note ?? '').trim();
  return t === '' ? null : t;
};

/** Mark one (state, key) verified for its current value; the override/provisional row wins over the seed. Already verified = no-op. */
async function verifyOne(tx: DbOrTx, year: number, state: StateCode, key: string, note: string | null, userId: string | undefined): Promise<boolean> {
  const now = new Date();
  const [ov] = await tx.select().from(stateEstimateRuleOverrides).where(and(
    eq(stateEstimateRuleOverrides.state, state), eq(stateEstimateRuleOverrides.taxYear, year), eq(stateEstimateRuleOverrides.key, key)));
  if (ov) {
    if (ov.verifiedAt) return false;
    await tx.update(stateEstimateRuleOverrides).set({ verifiedAt: now, verifiedBy: userId ?? null, verificationNote: note }).where(eq(stateEstimateRuleOverrides.id, ov.id));
    await auditLog(ZERO_TENANT, 'signoff', AUDIT_ENTITY, ov.id,
      { year, state, key, value: ov.value, status: ov.status },
      { op: 'verified', year, state, key, value: ov.value, source: ov.status, reason: note }, userId, tx);
    return true;
  }
  const [seed] = await tx.select().from(stateEstimateRules).where(and(
    eq(stateEstimateRules.state, state), eq(stateEstimateRules.taxYear, year), eq(stateEstimateRules.key, key)));
  if (!seed) throw AppError.notFound('State rule not found');
  if (seed.status === 'verified') return false;
  await tx.update(stateEstimateRules).set({ status: 'verified', verifiedAt: now, verifiedBy: userId ?? null, verificationNote: note }).where(eq(stateEstimateRules.id, seed.id));
  await auditLog(ZERO_TENANT, 'signoff', AUDIT_ENTITY, seed.id,
    { year, state, key, value: seed.value, status: seed.status },
    { op: 'verified', year, state, key, value: seed.value, source: 'seed', reason: note }, userId, tx);
  return true;
}

export async function verifyStateRule(year: number, stateIn: string, key: string, note: string | undefined, userId?: string): Promise<StateRuleRowDTO> {
  const state = assertState(stateIn);
  if (!getStateRuleDef(key)) throw AppError.badRequest(`Unknown state rule '${key}'`, 'TE_STATE_RULE_INVALID');
  await db.transaction(async (tx) => { await verifyOne(tx, year, state, key, cleanNote(note), userId); });
  return getRow(year, state, key);
}

/** Bulk Verify for ONE jurisdiction's year: every rule whose effective status is not verified. Returns `ST:key` refs. */
export async function verifyAllStateRules(year: number, stateIn: string, note: string | undefined, userId?: string): Promise<VerifyStateRulesResult> {
  const state = assertState(stateIn);
  const why = cleanNote(note);
  return db.transaction(async (tx) => {
    const loaded = await loadYear(tx, year, state);
    const resolved = resolveRows(loaded.seeds.get(state) ?? [], loaded.overrides.get(state) ?? []);
    const verified: string[] = [];
    for (const [key, r] of resolved) {
      if (r.status === 'verified') continue;
      if (await verifyOne(tx, year, state, key, why, userId)) verified.push(stateRuleRef(state, key));
    }
    return { verified };
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

export async function createYearFromPrior(year: number, userId?: string): Promise<CreateStateYearFromPriorResult> {
  return db.transaction(async (tx) => {
    if (await anyRowsInYear(tx, year)) throw AppError.conflict(`State rules for ${year} already exist`, 'TE_YEAR_EXISTS');
    const fromYear = await latestYearBefore(tx, year);
    if (fromYear === null) throw AppError.badRequest('No earlier tax year to copy from', 'TE_NO_PRIOR_YEAR');
    const prior = await loadYear(tx, fromYear);

    const reason = `Created from ${fromYear}; verify`;
    const rolledDates: string[] = [];
    const values: Array<typeof stateEstimateRuleOverrides.$inferInsert> = [];
    let states = 0;
    for (const state of STATE_CODES) {
      const resolved = resolveRows(prior.seeds.get(state) ?? [], prior.overrides.get(state) ?? []);
      if (resolved.size === 0) continue;
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
    if (values.length > 0) await tx.insert(stateEstimateRuleOverrides).values(values);
    await auditLog(ZERO_TENANT, 'override', AUDIT_ENTITY, null,
      { year, state: null, key: null, value: null },
      { op: 'year_created', year, state: null, key: null, value: { fromYear, created: values.length, states, rolledDates }, reason }, userId, tx);
    return { year, fromYear, created: values.length, states, rolledDates };
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

export async function listChanges(limit: number): Promise<StateRuleChangeDTO[]> {
  const rows = await db.select({
    id: auditLogTable.id, at: auditLogTable.createdAt, userId: auditLogTable.userId,
    before: auditLogTable.beforeData, after: auditLogTable.afterData, email: users.email,
  }).from(auditLogTable)
    .leftJoin(users, eq(users.id, auditLogTable.userId))
    .where(and(eq(auditLogTable.tenantId, ZERO_TENANT), eq(auditLogTable.entityType, AUDIT_ENTITY)))
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
