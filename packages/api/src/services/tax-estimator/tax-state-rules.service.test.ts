// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { and, eq, gte } from 'drizzle-orm';
import { STATE_CODES, nextBusinessDay, rollDateToYear, statePenaltyRateOn, type StateRuleSeedRow, type StateCode } from '@kis-books/shared';
import { db } from '../../db/index.js';
import { stateEstimateRules, stateEstimateRuleOverrides } from '../../db/schema/tax-estimator-state-rules.js';
import { auditLog as auditLogTable } from '../../db/schema/audit-log.js';
import * as svc from './tax-state-rules.service.js';

// Fixture years are far in the future so they never collide with shipped seeds.
const Y1 = 2080;
const Y2 = 2081;
const Y_FALLBACK = 2085;
const Y_NONE = 2084;
const ZERO = '00000000-0000-0000-0000-000000000000';

const BASE: Record<string, unknown> = {
  has_income_tax: true,
  estimates_required: true,
  required_threshold: 1000,
  threshold_comparison: null,
  'safe_harbor.current_pct': 0.9,
  'safe_harbor.prior_pct': 1,
  'safe_harbor.high_agi_rule': null,
  'installments.due_dates': ['2080-04-15', '2080-06-15', '2080-09-15', '2081-01-15'],
  'installments.pcts': [0.25, 0.25, 0.25, 0.25],
  'installments.q4_file_and_pay_date': '2081-01-31',
  return_due_date: '2081-04-15',
  'farmer.rule': null,
  'penalty.rate_source': 'federal',
  'penalty.rate': null,
  'penalty.rate_schedule': null,
  'penalty.method': null,
  'penalty.min_balance_due': null,
  credit_for_other_state: true,
  nonresident_method: 'ratio',
  holidays: [],
};

/** Every registry key is in BASE (20 keys since the R5 review). */
const NKEYS = 20;

const full = (state: StateCode, year: number, over: Record<string, unknown> = {}, status: StateRuleSeedRow['status'] = 'verified'): StateRuleSeedRow[] =>
  Object.entries({ ...BASE, ...over }).map(([key, value]) => ({ state, year, key, value, status, citation: `Fixture ${state} ${key}` }));

// Weekday landing date in the rolled year, so the per-state holiday test is calendar-proof.
const weekday = nextBusinessDay('2081-05-04', []);
const priorOf = (d: string) => rollDateToYear(d, Y2, Y1);

const FIXTURE: StateRuleSeedRow[] = [
  ...full('AR', Y1, { holidays: [priorOf(weekday)], 'installments.due_dates': [priorOf(weekday)], 'farmer.rule': { ratio: 0.667, current_pct: 0.666, due_date: priorOf(weekday), file_by: '2081-03-01' } }),
  ...full('MO', Y1, { 'installments.due_dates': [priorOf(weekday)], holidays: [] }, 'unverified'),
  { state: 'TX', year: Y1, key: 'has_income_tax', value: false, status: 'verified', citation: 'Fixture TX' },
  { state: 'KS', year: Y1, key: 'has_income_tax', value: true, status: 'verified', citation: 'Fixture KS' },
  { state: 'KS', year: Y1, key: 'required_threshold', value: 500, status: 'verified', citation: 'Fixture KS' },
];

async function clean() {
  await db.delete(stateEstimateRules).where(gte(stateEstimateRules.taxYear, Y1));
  await db.delete(stateEstimateRuleOverrides).where(gte(stateEstimateRuleOverrides.taxYear, Y1));
  await db.delete(auditLogTable).where(and(eq(auditLogTable.tenantId, ZERO), eq(auditLogTable.entityType, 'tax_state_rule')));
}

beforeEach(async () => { await clean(); await svc.syncShippedStateRules(FIXTURE); });
afterAll(async () => { await clean(); });

const rule = (dto: Awaited<ReturnType<typeof svc.getStateRules>>, key: string) => dto.rules.find((r) => r.key === key);

describe('syncShippedStateRules', () => {
  it('is idempotent, updates changed rows and removes dropped keys', async () => {
    await svc.syncShippedStateRules(FIXTURE);
    expect(await db.select().from(stateEstimateRules).where(eq(stateEstimateRules.taxYear, Y1))).toHaveLength(NKEYS + NKEYS + 1 + 2);
    await svc.syncShippedStateRules([
      ...full('KS', Y1, {}, 'provisional').slice(0, 1),
    ]);
    const ks = await svc.getStateRules(Y1, 'KS');
    expect(ks.rules.map((r) => r.key)).toEqual(['has_income_tax']);
    expect(ks.rules[0]!.status).toBe('provisional');
    // other states' rows are untouched
    expect((await svc.getStateRules(Y1, 'AR')).complete).toBe(true);
  });

  it('rejects unknown keys/states/bad values and writes nothing', async () => {
    const row = (over: Partial<StateRuleSeedRow>): StateRuleSeedRow =>
      ({ state: 'AR', year: Y2, key: 'required_threshold', value: 1, status: 'verified', citation: 'x', ...over });
    await expect(svc.syncShippedStateRules([row({ key: 'nope.key' })])).rejects.toThrow(/AR 2081 'nope.key'.*unknown/);
    await expect(svc.syncShippedStateRules([row({ state: 'ZZ' as StateCode })])).rejects.toThrow(/unknown state/);
    await expect(svc.syncShippedStateRules([row({ value: 'abc' })])).rejects.toThrow(/non-negative number/);
    await expect(svc.syncShippedStateRules([row({ citation: '  ' })])).rejects.toThrow(/citation/);
    await expect(svc.syncShippedStateRules([row({}), row({})])).rejects.toThrow(/duplicate/);
    expect(await db.select().from(stateEstimateRules).where(eq(stateEstimateRules.taxYear, Y2))).toHaveLength(0);
  });
});

describe('getStateRules resolution', () => {
  it('returns shipped rows with statuses and completeness', async () => {
    const ar = await svc.getStateRules(Y1, 'AR');
    expect(ar).toMatchObject({ year: Y1, state: 'AR', hasIncomeTax: true, isFallback: false, complete: true, missing: [] });
    expect(rule(ar, 'required_threshold')).toMatchObject({ value: 1000, status: 'verified', source: 'seed', citation: 'Fixture AR required_threshold' });
    const ks = await svc.getStateRules(Y1, 'KS');
    expect(ks.complete).toBe(false);
    expect(ks.missing).toContain('holidays');
  });

  it('override beats seed and revert restores it', async () => {
    const row = await svc.setOverride(Y1, 'AR', 'required_threshold', 2000, 'Rule changed');
    expect(row).toMatchObject({ value: 2000, source: 'override', status: 'unverified', shippedValue: 1000, reason: 'Rule changed' });
    await svc.revertOverride(Y1, 'AR', 'required_threshold');
    expect(rule(await svc.getStateRules(Y1, 'AR'), 'required_threshold')).toMatchObject({ value: 1000, source: 'seed' });
    await expect(svc.revertOverride(Y1, 'AR', 'required_threshold')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('can override into a state that has no seed rows', async () => {
    const row = await svc.setOverride(Y1, 'ID', 'has_income_tax', true, 'Seed missing');
    expect(row.source).toBe('override');
    expect((await svc.getStateRules(Y1, 'ID')).complete).toBe(false);
  });

  it('a state with no rows falls back to its latest earlier year as provisional', async () => {
    const fb = await svc.getStateRules(Y_FALLBACK, 'AR');
    expect(fb).toMatchObject({ isFallback: true, fallbackYear: Y1, complete: true });
    expect(fb.rules.every((r) => r.status === 'provisional' && r.source === 'fallback' && r.fallbackYear === Y1)).toBe(true);
  });

  it('rejects an unknown state', async () => {
    await expect(svc.getStateRules(Y1, 'ZZ')).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('setOverride validation', () => {
  it('validates by key and requires a reason', async () => {
    await expect(svc.setOverride(Y1, 'AR', 'nope', 1, 'abc')).rejects.toMatchObject({ code: 'TE_STATE_RULE_INVALID' });
    await expect(svc.setOverride(Y1, 'AR', 'required_threshold', -1, 'abc')).rejects.toMatchObject({ code: 'TE_STATE_RULE_INVALID' });
    await expect(svc.setOverride(Y1, 'AR', 'required_threshold', 5, 'ab')).rejects.toMatchObject({ code: 'TE_STATE_RULE_INVALID' });
    await expect(svc.setOverride(Y1, 'AR', 'penalty.rate_source', 'bogus', 'abc')).rejects.toMatchObject({ code: 'TE_STATE_RULE_INVALID' });
    await expect(svc.setOverride(Y1, 'AR', 'safe_harbor.high_agi_rule', { threshold: 1 }, 'abc')).rejects.toMatchObject({ code: 'TE_STATE_RULE_INVALID' });
    await expect(svc.setOverride(Y1, 'AR', 'installments.due_dates', ['04/15/2080'], 'abc')).rejects.toMatchObject({ code: 'TE_STATE_RULE_INVALID' });
    await expect(svc.setOverride(Y1, 'AR', 'required_threshold', null, 'abc')).rejects.toMatchObject({ code: 'TE_STATE_RULE_INVALID' });
    expect(await db.select().from(stateEstimateRuleOverrides).where(eq(stateEstimateRuleOverrides.taxYear, Y1))).toHaveLength(0);
  });

  it('accepts the JSON object rule types and null for nullable keys', async () => {
    const hi = await svc.setOverride(Y1, 'AR', 'safe_harbor.high_agi_rule', { threshold: 150000, pct: 1.1 }, 'Added rule');
    expect(hi.value).toEqual({ threshold: 150000, pct: 1.1 });
    const nul = await svc.setOverride(Y1, 'AR', 'farmer.rule', null, 'Not applicable');
    expect(nul.value).toBeNull();
  });
});

describe('R5 key validation', () => {
  const bad = (key: string, value: unknown) => expect(svc.setOverride(Y1, 'AR', key, value, 'abc')).rejects.toMatchObject({ code: 'TE_STATE_RULE_INVALID' });

  it('rejects malformed values for the new keys', async () => {
    await bad('estimates_required', 'no');
    await bad('estimates_required', null);
    await bad('penalty.min_balance_due', -500);
    await bad('threshold_comparison', 'greater');
    await bad('penalty.method', 'weekly');
    await bad('return_due_date', '2081-02-30');
    await bad('installments.q4_file_and_pay_date', ['2081-01-31']);
    await bad('penalty.rate_schedule', []);
    await bad('penalty.rate_schedule', [{ from: '2080-01-01', to: '2080-12-31' }]);
    await bad('penalty.rate_schedule', [{ from: '2080-12-31', to: '2080-01-01', rate: 0.08 }]);
    await bad('penalty.rate_schedule', [{ from: '2080-01-01', to: '2080-12-31', rate: 0.08 }, { from: '2080-06-01', to: '2081-12-31', rate: 0.07 }]);
    await bad('penalty.rate_schedule', [{ from: '2080-01-01', to: '2080-12-31', rate: -0.01 }]);
    await bad('farmer.rule', { ratio: 0.667, current_pct: 0, due_date: '2081-04-15', file_by: '2081-04-15', treatment: 'sometimes' });
    await bad('safe_harbor.high_agi_rule', { threshold: 150000, pct: 1.1, no_prior_year_agi: 'big' });
    expect(await db.select().from(stateEstimateRuleOverrides).where(eq(stateEstimateRuleOverrides.taxYear, Y1))).toHaveLength(0);
  });

  it('accepts well-formed values and explicit nulls for the new keys', async () => {
    const sched = [{ from: '2080-01-01', to: '2080-12-31', rate: 0.08 }, { from: '2081-01-01', to: '2081-12-31', rate: 0.07 }];
    expect((await svc.setOverride(Y1, 'AR', 'penalty.rate_schedule', sched, 'Two legs')).value).toEqual(sched);
    expect((await svc.setOverride(Y1, 'AR', 'penalty.min_balance_due', 500, 'Floor')).value).toBe(500);
    expect((await svc.setOverride(Y1, 'AR', 'penalty.min_balance_due', null, 'No floor')).value).toBeNull();
    expect((await svc.setOverride(Y1, 'AR', 'threshold_comparison', 'more_than', 'Boundary')).value).toBe('more_than');
    expect((await svc.setOverride(Y1, 'AR', 'penalty.method', 'monthly_or_fraction', 'HI style')).value).toBe('monthly_or_fraction');
    expect((await svc.setOverride(Y1, 'AR', 'return_due_date', '2081-05-01', 'VA style')).value).toBe('2081-05-01');
    expect((await svc.setOverride(Y1, 'AR', 'installments.q4_file_and_pay_date', null, 'No relief')).value).toBeNull();
    const exempt = { ratio: 0.667, current_pct: 0, due_date: '2081-04-15', file_by: '2081-04-15', treatment: 'exempt' };
    expect((await svc.setOverride(Y1, 'AR', 'farmer.rule', exempt, 'Exempt')).value).toEqual(exempt);
    const ca = { threshold: 150000, pct: 1.1, threshold_mfs: 75000, no_prior_year_agi: 1000000, no_prior_year_agi_mfs: 500000 };
    expect((await svc.setOverride(Y1, 'AR', 'safe_harbor.high_agi_rule', ca, 'CA style')).value).toEqual(ca);
  });
});

describe('summaries and engine resolution', () => {
  it('lists 51 jurisdictions with status, counts and fallback flags', async () => {
    const list = await svc.listSummaries(Y1);
    expect(list).toHaveLength(51);
    expect(list.map((s) => s.state)).toEqual([...STATE_CODES]);
    const by = Object.fromEntries(list.map((s) => [s.state, s]));
    expect(by['AR']).toMatchObject({ name: 'Arkansas', status: 'complete', hasIncomeTax: true, usesFederalFallback: false, counts: { verified: NKEYS, unverified: 0, provisional: 0, override: 0 } });
    expect(by['MO']!.counts.unverified).toBe(NKEYS);
    expect(by['TX']).toMatchObject({ status: 'complete', hasIncomeTax: false, usesFederalFallback: false });
    expect(by['KS']).toMatchObject({ status: 'partial', usesFederalFallback: true });
    expect(by['CA']).toMatchObject({ status: 'missing', usesFederalFallback: true });
    await svc.setOverride(Y1, 'AR', 'required_threshold', 5, 'abc');
    expect((await svc.listSummaries(Y1)).find((s) => s.state === 'AR')!.counts).toMatchObject({ verified: NKEYS - 1, override: 1 });
  });

  it('complete states resolve for the engine, with a badge unless fully verified', async () => {
    const ar = await svc.resolveStateRulesForEngine('AR', Y1);
    expect(ar).toMatchObject({ usesFederalFallback: false, verifyBadge: false });
    expect(ar.rules['required_threshold']).toBe(1000);
    const mo = await svc.resolveStateRulesForEngine('MO', Y1);
    expect(mo).toMatchObject({ usesFederalFallback: false, verifyBadge: true });
    await svc.setOverride(Y1, 'AR', 'required_threshold', 5, 'abc');
    const edited = await svc.resolveStateRulesForEngine('AR', Y1);
    expect(edited.rules['required_threshold']).toBe(5);
    expect(edited.verifyBadge).toBe(true);
  });

  it('estimates_required=false yields a readable flag and never a voucher schedule', async () => {
    const ar = await svc.resolveStateRulesForEngine('AR', Y1);
    expect(ar.estimatesRequired).toBe(true);
    expect(ar.rules['installments.due_dates']).toEqual([priorOf(weekday)]);
    await svc.setOverride(Y1, 'AR', 'estimates_required', false, 'No estimate regime (ID/UT pattern)');
    const off = await svc.resolveStateRulesForEngine('AR', Y1);
    expect(off).toMatchObject({ estimatesRequired: false, usesFederalFallback: false });
    expect(off.rules['estimates_required']).toBe(false);
    for (const k of ['installments.due_dates', 'installments.pcts', 'installments.q4_file_and_pay_date']) expect(off.rules).not.toHaveProperty(k);
    // the admin view still shows the stored (placeholder) rows
    expect(rule(await svc.getStateRules(Y1, 'AR'), 'installments.due_dates')).toBeDefined();
  });

  it('penalty.rate_schedule takes precedence over penalty.rate on covered days', async () => {
    await svc.setOverride(Y1, 'AR', 'penalty.rate', 0.08, 'Single rate');
    expect(statePenaltyRateOn((await svc.resolveStateRulesForEngine('AR', Y1)).rules, '2081-02-01')).toEqual({ rate: 0.08, fromSchedule: false, covered: true });
    await svc.setOverride(Y1, 'AR', 'penalty.rate_schedule', [
      { from: '2080-01-01', to: '2080-12-31', rate: 0.08 }, { from: '2081-01-01', to: '2081-12-31', rate: 0.07 },
    ], 'Calendar-year legs');
    const rules = (await svc.resolveStateRulesForEngine('AR', Y1)).rules;
    expect(statePenaltyRateOn(rules, '2080-12-31')).toEqual({ rate: 0.08, fromSchedule: true, covered: true });
    expect(statePenaltyRateOn(rules, '2081-02-01')).toEqual({ rate: 0.07, fromSchedule: true, covered: true });
    // a day outside every leg (next year's rate unpublished) falls back to the single rate, flagged uncovered
    expect(statePenaltyRateOn(rules, '2082-02-01')).toEqual({ rate: 0.08, fromSchedule: false, covered: false });
  });

  it('no-income-tax states return only has_income_tax:false', async () => {
    expect(await svc.resolveStateRulesForEngine('TX', Y1)).toEqual({ rules: { has_income_tax: false }, usesFederalFallback: false, verifyBadge: false, estimatesRequired: false });
    // and with no rows at all for a state that statutorily has no income tax
    expect(await svc.resolveStateRulesForEngine('WA', Y_NONE)).toEqual({ rules: { has_income_tax: false }, usesFederalFallback: false, verifyBadge: true, estimatesRequired: false });
  });

  it('incomplete or absent income-tax states use the federal fallback with a verify badge', async () => {
    expect(await svc.resolveStateRulesForEngine('KS', Y1)).toMatchObject({ usesFederalFallback: true, verifyBadge: true });
    expect(await svc.resolveStateRulesForEngine('CA', Y1)).toEqual({ rules: {}, usesFederalFallback: true, verifyBadge: true, estimatesRequired: true });
    expect(await svc.resolveStateRulesForEngine('AR', Y_NONE)).toMatchObject({ usesFederalFallback: true });
  });
});

describe('createYearFromPrior', () => {
  it('copies per state as provisional and rolls dates with that state\'s own holidays', async () => {
    const r = await svc.createYearFromPrior(Y2);
    expect(r).toMatchObject({ year: Y2, fromYear: Y1, states: 4 });
    expect(r.created).toBe(NKEYS + NKEYS + 1 + 2);
    expect(r.rolledDates).toEqual(expect.arrayContaining(['AR:installments.due_dates', 'AR:holidays', 'AR:farmer.rule', 'MO:installments.due_dates']));

    const ar = await svc.getStateRules(Y2, 'AR');
    const mo = await svc.getStateRules(Y2, 'MO');
    expect(ar.rules.every((x) => x.source === 'provisional' && x.status === 'provisional')).toBe(true);
    // AR lists the rolled date as a holiday, so its installment moves; MO's does not.
    expect(rule(ar, 'holidays')!.value).toEqual([weekday]);
    expect(rule(ar, 'installments.due_dates')!.value).toEqual([nextBusinessDay(weekday, [weekday])]);
    expect(rule(mo, 'installments.due_dates')!.value).toEqual([weekday]);
    expect(rule(ar, 'installments.due_dates')!.value).not.toEqual(rule(mo, 'installments.due_dates')!.value);
    const farmer = rule(ar, 'farmer.rule')!.value as { due_date: string; file_by: string };
    expect(farmer.due_date).toBe(nextBusinessDay(weekday, [weekday]));
    expect(farmer.file_by).toBe(nextBusinessDay('2082-03-01', [weekday]));
    expect(rule(ar, 'required_threshold')).toMatchObject({ value: 1000, citation: 'Fixture AR required_threshold', reason: `Created from ${Y1}; verify` });
    // pure copy keys are unchanged
    expect(rule(ar, 'safe_harbor.prior_pct')!.value).toBe(1);
  });

  it('rolls the R5 single-date keys to business days and shifts rate-schedule legs a year', async () => {
    await svc.setOverride(Y1, 'MO', 'penalty.rate_schedule', [{ from: '2080-01-01', to: '2080-12-31', rate: 0.08 }], 'Leg');
    const r = await svc.createYearFromPrior(Y2);
    expect(r.rolledDates).toEqual(expect.arrayContaining(['AR:return_due_date', 'AR:installments.q4_file_and_pay_date', 'MO:penalty.rate_schedule']));
    const ar = await svc.getStateRules(Y2, 'AR');
    expect(rule(ar, 'return_due_date')!.value).toBe(nextBusinessDay('2082-04-15', [weekday]));
    expect(rule(ar, 'installments.q4_file_and_pay_date')!.value).toBe(nextBusinessDay('2082-01-31', [weekday]));
    expect(rule(await svc.getStateRules(Y2, 'MO'), 'penalty.rate_schedule')!.value).toEqual([{ from: '2081-01-01', to: '2081-12-31', rate: 0.08 }]);
  });

  it('refuses an existing year and a missing prior year', async () => {
    await svc.createYearFromPrior(Y2);
    await expect(svc.createYearFromPrior(Y2)).rejects.toMatchObject({ statusCode: 409 });
    await expect(svc.createYearFromPrior(1950)).rejects.toMatchObject({ code: 'TE_NO_PRIOR_YEAR' });
  });

  it('complete provisional sets are usable by the engine with a verify badge', async () => {
    await svc.createYearFromPrior(Y2);
    expect(await svc.resolveStateRulesForEngine('AR', Y2)).toMatchObject({ usesFederalFallback: false, verifyBadge: true });
    expect(await svc.resolveStateRulesForEngine('TX', Y2)).toMatchObject({ rules: { has_income_tax: false }, usesFederalFallback: false });
  });
});

describe('diff and adopt', () => {
  it('diffs provisional against later-shipped rows and adopts selectively', async () => {
    await svc.createYearFromPrior(Y2);
    await svc.syncShippedStateRules([
      ...full('AR', Y2, { required_threshold: 1500 }),
    ]);
    const diff = await svc.diffShippedVsProvisional(Y2);
    expect(diff.map((d) => `${d.state}:${d.key}`)).toContain('AR:required_threshold');
    const thr = diff.find((d) => d.key === 'required_threshold')!;
    expect(thr).toMatchObject({ state: 'AR', shippedValue: 1500, provisionalValue: 1000, shippedStatus: 'verified' });
    const adopted = await svc.adoptShipped(Y2, ['AR:required_threshold']);
    expect(adopted.adopted).toEqual(['AR:required_threshold']);
    expect(rule(await svc.getStateRules(Y2, 'AR'), 'required_threshold')).toMatchObject({ value: 1500, source: 'seed' });
    const rest = await svc.adoptShipped(Y2, undefined);
    expect(rest.adopted.length).toBeGreaterThan(0);
    expect(await svc.diffShippedVsProvisional(Y2)).toEqual([]);
    expect((await svc.adoptShipped(Y2, undefined)).adopted).toEqual([]);
  });
});

describe('audit', () => {
  it('writes audit_log rows under the global tenant and lists them as changes', async () => {
    await svc.setOverride(Y1, 'AR', 'required_threshold', 2000, 'Edit one');
    await svc.revertOverride(Y1, 'AR', 'required_threshold');
    await svc.createYearFromPrior(Y2);
    await svc.syncShippedStateRules(full('AR', Y2, { required_threshold: 1500 }));
    await svc.adoptShipped(Y2, ['AR:required_threshold']);

    const raw = await db.select().from(auditLogTable).where(and(eq(auditLogTable.tenantId, ZERO), eq(auditLogTable.entityType, 'tax_state_rule')));
    expect(raw).toHaveLength(4);
    expect(new Set(raw.map((r) => r.action))).toEqual(new Set(['override']));

    const changes = await svc.listChanges(10);
    expect(changes.map((c) => c.action)).toEqual(['shipped_adopted', 'year_created', 'override_reverted', 'override_set']);
    expect(changes[3]).toMatchObject({ year: Y1, state: 'AR', key: 'required_threshold', after: 2000, reason: 'Edit one' });
    expect(changes[2]).toMatchObject({ before: 2000, after: null, state: 'AR' });
    expect(changes[1]).toMatchObject({ year: Y2, state: null, key: null });
    expect(changes[0]).toMatchObject({ state: 'AR', key: 'required_threshold' });
  });
});
