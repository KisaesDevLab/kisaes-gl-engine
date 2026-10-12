// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { and, eq, gte } from 'drizzle-orm';
import { expandParameterKeys, deriveFederalDates, legalHolidaysForTaxYear, type ParameterSeedRow } from '@kis-books/shared';
import { db } from '../../db/index.js';
import { taxParameters, taxParameterOverrides } from '../../db/schema/tax-estimator.js';
import { auditLog as auditLogTable } from '../../db/schema/audit-log.js';
import * as svc from './tax-parameters.service.js';

// Fixture years are far in the future so they never collide with shipped seeds.
const Y1 = 2090;
const Y2 = 2091;
const Y_EMPTY = 2095;
const ZERO = '00000000-0000-0000-0000-000000000000';

const seed = (key: string, value: unknown, status: ParameterSeedRow['status'] = 'verified'): ParameterSeedRow =>
  ({ key, value, status, citation: `Fixture ${key}` });

const FIXTURE: Record<number, ParameterSeedRow[]> = {
  [Y1]: [
    seed('se.nese_factor', 0.9235),
    seed('se.ss_wage_base', 176100, 'unverified'),
    seed('installments.due_dates', ['2090-06-16']),
    seed('return_due_date', '2090-06-14'),
    seed('holidays', ['2090-06-18']),
  ],
};

async function clean() {
  await db.delete(taxParameters).where(gte(taxParameters.taxYear, Y1));
  await db.delete(taxParameterOverrides).where(gte(taxParameterOverrides.taxYear, Y1));
  await db.delete(auditLogTable).where(and(eq(auditLogTable.tenantId, ZERO), eq(auditLogTable.entityType, 'tax_parameter')));
}

beforeEach(async () => { await clean(); await svc.syncShippedSeeds(FIXTURE); });
afterAll(async () => { await clean(); });

const pick = (dto: Awaited<ReturnType<typeof svc.getParameters>>, key: string) => dto.parameters.find((p) => p.key === key);

describe('syncShippedSeeds', () => {
  it('is idempotent and updates changed rows', async () => {
    await svc.syncShippedSeeds(FIXTURE);
    const rows = await db.select().from(taxParameters).where(eq(taxParameters.taxYear, Y1));
    expect(rows).toHaveLength(5);
    await svc.syncShippedSeeds({ [Y1]: [...FIXTURE[Y1]!.slice(1), seed('se.nese_factor', 0.5, 'provisional')] });
    const after = await svc.getParameters(Y1);
    expect(pick(after, 'se.nese_factor')?.value).toBe(0.5);
    expect(pick(after, 'se.nese_factor')?.status).toBe('provisional');
  });

  it('removes keys dropped from the seed and never touches overrides', async () => {
    await svc.setOverride(Y1, 'se.ss_rate', 0.124, 'Fixture override');
    await svc.syncShippedSeeds({ [Y1]: [seed('se.nese_factor', 0.9235)] });
    const rows = await db.select().from(taxParameters).where(eq(taxParameters.taxYear, Y1));
    expect(rows.map((r) => r.key)).toEqual(['se.nese_factor']);
    expect(await db.select().from(taxParameterOverrides).where(eq(taxParameterOverrides.taxYear, Y1))).toHaveLength(1);
  });

  it('names the bad key and writes nothing', async () => {
    await expect(svc.syncShippedSeeds({ [Y2]: [seed('se.nese_factor', 'x')] })).rejects.toThrow(/2091 'se.nese_factor'/);
    await expect(svc.syncShippedSeeds({ [Y2]: [seed('not.a.key', 1)] })).rejects.toThrow(/'not.a.key'.*unknown/);
    await expect(svc.syncShippedSeeds({ [Y2]: [{ ...seed('se.ss_rate', 0.1), citation: ' ' }] })).rejects.toThrow(/citation/);
    expect(await db.select().from(taxParameters).where(eq(taxParameters.taxYear, Y2))).toHaveLength(0);
  });
});

describe('getParameters', () => {
  it('reports partial completeness and resolves seed rows', async () => {
    const dto = await svc.getParameters(Y1);
    const total = expandParameterKeys().length;
    expect(dto.isFallback).toBe(false);
    expect(dto.completeness.total).toBe(total);
    expect(dto.completeness.present).toBe(5);
    expect(dto.completeness.missing).toHaveLength(total - 5);
    expect(dto.completeness.missing).not.toContain('se.nese_factor');
    const row = pick(dto, 'se.ss_wage_base');
    expect(row).toMatchObject({ value: 176100, status: 'unverified', source: 'seed', citation: 'Fixture se.ss_wage_base' });
    expect(row?.label).toBeTruthy();
    expect(row?.group).toBe('Self-employment');
  });

  it('override beats seed and exposes shippedValue and reason', async () => {
    await svc.setOverride(Y1, 'se.ss_wage_base', 180000, 'Corrected per notice');
    const row = pick(await svc.getParameters(Y1), 'se.ss_wage_base');
    expect(row).toMatchObject({ value: 180000, source: 'override', reason: 'Corrected per notice', shippedValue: 176100 });
  });

  it('an override equal to the seed carries no shippedValue', async () => {
    await svc.setOverride(Y1, 'se.ss_wage_base', 176100, 'Same value');
    expect(pick(await svc.getParameters(Y1), 'se.ss_wage_base')?.shippedValue).toBeUndefined();
  });

  it('override-only keys appear and provisional rows win over the seed', async () => {
    await db.insert(taxParameterOverrides).values({
      taxYear: Y1, key: 'se.nese_factor', value: 0.9, status: 'provisional', reason: 'Created from 2089; verify', createdFromYear: 2089,
    });
    await svc.setOverride(Y1, 'se.ss_rate', 0.124, 'Only override');
    const dto = await svc.getParameters(Y1);
    expect(pick(dto, 'se.nese_factor')).toMatchObject({ value: 0.9, source: 'provisional', status: 'provisional', shippedValue: 0.9235 });
    expect(pick(dto, 'se.ss_rate')).toMatchObject({ value: 0.124, source: 'override' });
    expect(dto.completeness.present).toBe(6);
  });

  it('falls back to the latest earlier year, all rows provisional', async () => {
    await svc.syncShippedSeeds({ ...FIXTURE, [Y2]: [seed('se.nese_factor', 0.7)] });
    const dto = await svc.getParameters(Y_EMPTY);
    expect(dto).toMatchObject({ isFallback: true, fallbackYear: Y2 });
    expect(dto.parameters).toHaveLength(1);
    expect(dto.parameters[0]).toMatchObject({ key: 'se.nese_factor', value: 0.7, source: 'fallback', status: 'provisional', fallbackYear: Y2 });
    expect(dto.completeness.present).toBe(1);
  });

  it('ignores DB keys that are not in the registry', async () => {
    await db.insert(taxParameters).values({ taxYear: Y1, key: 'bogus.key', value: 1, status: 'verified', citation: 'x' });
    const dto = await svc.getParameters(Y1);
    expect(dto.parameters.some((p) => p.key === 'bogus.key')).toBe(false);
    expect(dto.completeness.present).toBe(5);
  });

  it('getYears lists years and shipped years', async () => {
    await svc.setOverride(Y_EMPTY, 'se.ss_rate', 0.124, 'Override only year');
    const y = await svc.getYears();
    expect(y.years).toContain(Y1);
    expect(y.years).toContain(Y_EMPTY);
    expect(y.shippedYears).toContain(Y1);
    expect(y.shippedYears).not.toContain(Y_EMPTY);
  });
});

describe('setOverride / revertOverride', () => {
  it('rejects unknown keys, bad values and short reasons with TE_PARAM_INVALID', async () => {
    await expect(svc.setOverride(Y1, 'nope', 1, 'because')).rejects.toMatchObject({ statusCode: 400, code: 'TE_PARAM_INVALID' });
    await expect(svc.setOverride(Y1, 'se.ss_rate', 'abc', 'because')).rejects.toMatchObject({ statusCode: 400, code: 'TE_PARAM_INVALID' });
    await expect(svc.setOverride(Y1, 'se.ss_rate', 0.1, 'ab')).rejects.toMatchObject({ statusCode: 400, code: 'TE_PARAM_INVALID' });
    expect(await db.select().from(taxParameterOverrides).where(eq(taxParameterOverrides.taxYear, Y1))).toHaveLength(0);
  });

  it('upserts on repeat and reverts, 404 when nothing to revert', async () => {
    await svc.setOverride(Y1, 'se.ss_rate', 0.1, 'first');
    await svc.setOverride(Y1, 'se.ss_rate', 0.2, 'second');
    expect(await db.select().from(taxParameterOverrides).where(eq(taxParameterOverrides.taxYear, Y1))).toHaveLength(1);
    await svc.revertOverride(Y1, 'se.ss_rate');
    expect(pick(await svc.getParameters(Y1), 'se.ss_rate')).toBeUndefined();
    await expect(svc.revertOverride(Y1, 'se.ss_rate')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('reverting an override restores the shipped value', async () => {
    await svc.setOverride(Y1, 'se.ss_wage_base', 1, 'temp');
    await svc.revertOverride(Y1, 'se.ss_wage_base');
    expect(pick(await svc.getParameters(Y1), 'se.ss_wage_base')).toMatchObject({ value: 176100, source: 'seed' });
  });
});

describe('createYearFromPrior', () => {
  it('copies resolved values as provisional and derives the dates from the statute and the computed holiday calendar (R6-01)', async () => {
    await svc.setOverride(Y1, 'se.ss_wage_base', 180000, 'Admin edit'); // resolved (override) value is what is copied
    const res = await svc.createYearFromPrior(Y2);
    expect(res).toMatchObject({ year: Y2, fromYear: Y1, created: 5 });
    expect(res.rolledDates.sort()).toEqual(['holidays', 'installments.due_dates', 'return_due_date']);
    const dto = await svc.getParameters(Y2);
    expect(dto.isFallback).toBe(false);
    expect(pick(dto, 'se.ss_wage_base')).toMatchObject({ value: 180000, source: 'provisional', status: 'provisional', reason: 'Created from 2090; verify' });
    // The fixture stores an observed Saturday-ish date list and a made-up holiday; neither is rolled.
    // The new year's dates come from the registry's statutory days under the computed legal-holiday calendar.
    const derived = deriveFederalDates(Y2);
    expect(pick(dto, 'installments.due_dates')?.value).toEqual(derived.get('installments.due_dates'));
    expect((pick(dto, 'installments.due_dates')?.value as string[]).length).toBe(4);
    expect(pick(dto, 'installments.due_dates')?.value).not.toEqual(['2091-06-16']);
    expect(pick(dto, 'return_due_date')?.value).toBe(derived.get('return_due_date'));
    expect(pick(dto, 'return_due_date')?.value).toBe('2092-04-15'); // Apr 15, 2092 is a Friday
    expect(pick(dto, 'holidays')?.value).toEqual(legalHolidaysForTaxYear(Y2));
    expect(pick(dto, 'holidays')?.value).not.toContain('2091-06-18');
    const [row] = await db.select().from(taxParameterOverrides)
      .where(and(eq(taxParameterOverrides.taxYear, Y2), eq(taxParameterOverrides.key, 'se.nese_factor')));
    expect(row?.createdFromYear).toBe(Y1);
  });

  it('the missing-year fallback serves the same derived dates for the requested year (R3-04 / R6-14)', async () => {
    const dto = await svc.getParameters(Y_EMPTY);
    expect(dto).toMatchObject({ isFallback: true, fallbackYear: Y1 });
    const derived = deriveFederalDates(Y_EMPTY);
    expect(pick(dto, 'installments.due_dates')).toMatchObject({ value: derived.get('installments.due_dates'), source: 'fallback', status: 'provisional' });
    expect(pick(dto, 'return_due_date')?.value).toBe(derived.get('return_due_date'));
    expect(pick(dto, 'holidays')?.value).toEqual(legalHolidaysForTaxYear(Y_EMPTY));
    expect(pick(dto, 'se.nese_factor')?.value).toBe(0.9235); // amounts and rates are the fallback year's
  });

  it('TY2027 from the shipped 2026 seed (read through the fallback, no writes): the hand-checked 2028 dates', async () => {
    const dto = await svc.getParameters(2027);
    if (!dto.isFallback) return; // a 2027 seed has shipped: covered by the seed completeness roll test instead
    expect(dto.fallbackYear).toBe(2026);
    expect(pick(dto, 'installments.due_dates')?.value).toEqual(['2027-04-15', '2027-06-15', '2027-09-15', '2028-01-18']); // Sat Jan 15 → Mon 17 is MLK Day → Tue 18
    expect(pick(dto, 'installments.q4_file_and_pay_date')?.value).toBe('2028-01-31'); // a Monday
    expect(pick(dto, 'return_due_date')?.value).toBe('2028-04-18'); // Sat Apr 15 → Mon 17 is observed Emancipation Day → Tue 18
    expect(pick(dto, 'farmer.single_due_date')?.value).toBe('2028-01-18');
    expect(pick(dto, 'farmer.file_by_date')?.value).toBe('2028-03-01');
    expect(pick(dto, 'holidays')?.value).toEqual(expect.arrayContaining(['2027-12-31', '2028-01-17', '2028-04-17', '2028-11-10']));
  });

  it('409 TE_YEAR_EXISTS when the year already has rows', async () => {
    await expect(svc.createYearFromPrior(Y1)).rejects.toMatchObject({ statusCode: 409, code: 'TE_YEAR_EXISTS' });
    await svc.createYearFromPrior(Y2);
    await expect(svc.createYearFromPrior(Y2)).rejects.toMatchObject({ statusCode: 409, code: 'TE_YEAR_EXISTS' });
  });
});

describe('diff and adopt', () => {
  it('lists provisional rows that now have shipped counterparts and adopts them', async () => {
    await svc.createYearFromPrior(Y2);
    expect(await svc.diffShippedVsProvisional(Y2)).toEqual([]); // no shipped rows for Y2 yet
    await svc.syncShippedSeeds({ ...FIXTURE, [Y2]: [seed('se.nese_factor', 0.8), seed('se.ss_wage_base', 176100, 'verified')] });
    const diff = await svc.diffShippedVsProvisional(Y2);
    expect(diff.map((d) => d.key).sort()).toEqual(['se.nese_factor', 'se.ss_wage_base']);
    const nese = diff.find((d) => d.key === 'se.nese_factor')!;
    expect(nese).toMatchObject({ shippedValue: 0.8, provisionalValue: 0.9235, shippedStatus: 'verified', shippedCitation: 'Fixture se.nese_factor' });
    // Before adopting, the provisional copy still wins.
    expect(pick(await svc.getParameters(Y2), 'se.nese_factor')?.value).toBe(0.9235);

    const one = await svc.adoptShipped(Y2, ['se.nese_factor']);
    expect(one.adopted).toEqual(['se.nese_factor']);
    expect(pick(await svc.getParameters(Y2), 'se.nese_factor')).toMatchObject({ value: 0.8, source: 'seed' });
    expect((await svc.diffShippedVsProvisional(Y2)).map((d) => d.key)).toEqual(['se.ss_wage_base']);

    const rest = await svc.adoptShipped(Y2, undefined);
    expect(rest.adopted).toEqual(['se.ss_wage_base']);
    expect(await svc.diffShippedVsProvisional(Y2)).toEqual([]);
    // Provisional rows without a shipped counterpart are never adopted away.
    expect(pick(await svc.getParameters(Y2), 'return_due_date')?.source).toBe('provisional');
  });
});

describe('audit and change history', () => {
  it('writes global audit rows and lists them newest first', async () => {
    await svc.setOverride(Y1, 'se.ss_wage_base', 190000, 'Edit one');
    await svc.revertOverride(Y1, 'se.ss_wage_base');
    await svc.createYearFromPrior(Y2);
    await svc.syncShippedSeeds({ ...FIXTURE, [Y2]: [seed('se.nese_factor', 0.8)] });
    await svc.adoptShipped(Y2, undefined);

    const raw = await db.select().from(auditLogTable).where(and(eq(auditLogTable.tenantId, ZERO), eq(auditLogTable.entityType, 'tax_parameter')));
    expect(raw).toHaveLength(4);
    expect(new Set(raw.map((r) => r.action))).toEqual(new Set(['override']));

    const changes = await svc.listChanges(10);
    expect(changes.map((c) => c.action)).toEqual(['shipped_adopted', 'year_created', 'override_reverted', 'override_set']);
    const set = changes[3]!;
    expect(set).toMatchObject({ year: Y1, key: 'se.ss_wage_base', after: 190000, reason: 'Edit one' });
    expect(changes[2]).toMatchObject({ before: 190000, after: null });
    expect(changes[1]).toMatchObject({ year: Y2, key: null });
    expect(await svc.listChanges(2)).toHaveLength(2);
  });
});

describe('R7 in-app Verify (super-admin sign-off)', () => {
  const ADMIN = '00000000-0000-4000-8000-0000000000a7';

  it('marks a shipped unverified row verified with who / when / note, audits it, and changes nothing else', async () => {
    const before = pick(await svc.getParameters(Y1), 'se.ss_wage_base')!;
    const row = await svc.verifyParameter(Y1, 'se.ss_wage_base', 'Checked against SSA fact sheet', ADMIN);
    expect(row).toMatchObject({ value: before.value, citation: before.citation, source: 'seed', status: 'verified', verifiedBy: ADMIN, verificationNote: 'Checked against SSA fact sheet' });
    expect(row.verifiedAt).toBeTruthy();
    const others = (await svc.getParameters(Y1)).parameters.filter((p) => p.key !== 'se.ss_wage_base');
    expect(others.every((p) => p.verifiedAt == null)).toBe(true);
    const audit = await db.select().from(auditLogTable).where(and(eq(auditLogTable.tenantId, ZERO), eq(auditLogTable.entityType, 'tax_parameter')));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.action).toBe('signoff');
    expect(audit[0]!.userId).toBe(ADMIN);
    const [change] = await svc.listChanges(1);
    expect(change).toMatchObject({ action: 'verified', year: Y1, key: 'se.ss_wage_base', reason: 'Checked against SSA fact sheet' });
  });

  it('an already verified row is a no-op (no audit); an unknown key is TE_PARAM_INVALID; a key with no row is 404', async () => {
    await svc.verifyParameter(Y1, 'se.nese_factor', undefined, ADMIN);
    expect(await db.select().from(auditLogTable).where(and(eq(auditLogTable.tenantId, ZERO), eq(auditLogTable.entityType, 'tax_parameter')))).toHaveLength(0);
    await expect(svc.verifyParameter(Y1, 'not.a.key', undefined, ADMIN)).rejects.toMatchObject({ code: 'TE_PARAM_INVALID' });
    await expect(svc.verifyParameter(Y1, 'se.ss_rate', undefined, ADMIN)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('the startup re-sync keeps a verification while the shipped value is unchanged and drops it when the value changes', async () => {
    await svc.verifyParameter(Y1, 'se.ss_wage_base', 'ok', ADMIN);
    await svc.syncShippedSeeds(FIXTURE);
    expect(pick(await svc.getParameters(Y1), 'se.ss_wage_base')).toMatchObject({ status: 'verified', verifiedBy: ADMIN });
    await svc.syncShippedSeeds({ [Y1]: [...FIXTURE[Y1]!.filter((r) => r.key !== 'se.ss_wage_base'), seed('se.ss_wage_base', 180000, 'unverified')] });
    const after = pick(await svc.getParameters(Y1), 'se.ss_wage_base')!;
    expect(after).toMatchObject({ value: 180000, status: 'unverified' });
    expect(after.verifiedAt ?? null).toBeNull();
  });

  it('a verified row can still be overridden with a reason; a new override value is unverified until verified again', async () => {
    await svc.verifyParameter(Y1, 'se.ss_wage_base', 'ok', ADMIN);
    const ov = await svc.setOverride(Y1, 'se.ss_wage_base', 184500, 'Correct 2026 base', ADMIN);
    expect(ov).toMatchObject({ value: 184500, source: 'override', status: 'unverified' });
    const v = await svc.verifyParameter(Y1, 'se.ss_wage_base', 'override checked', ADMIN);
    expect(v).toMatchObject({ source: 'override', status: 'verified', verificationNote: 'override checked' });
    const again = await svc.setOverride(Y1, 'se.ss_wage_base', 184600, 'Typo fix', ADMIN);
    expect(again).toMatchObject({ status: 'unverified' });
    expect(again.verifiedAt ?? null).toBeNull();
    await svc.revertOverride(Y1, 'se.ss_wage_base', ADMIN);
    expect(pick(await svc.getParameters(Y1), 'se.ss_wage_base')).toMatchObject({ source: 'seed', status: 'verified', value: 176100 });
  });

  it('R6-04: two admins verifying the same row at once produce one sign-off, one verifier and one audit row', async () => {
    const ADMIN_B = '00000000-0000-4000-8000-0000000000b8';
    const results = await Promise.allSettled([
      svc.verifyParameter(Y1, 'se.ss_wage_base', 'admin A', ADMIN),
      svc.verifyParameter(Y1, 'se.ss_wage_base', 'admin B', ADMIN_B),
    ]);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const row = pick(await svc.getParameters(Y1), 'se.ss_wage_base')!;
    expect(row.status).toBe('verified');
    const audit = await db.select().from(auditLogTable).where(and(eq(auditLogTable.tenantId, ZERO), eq(auditLogTable.entityType, 'tax_parameter')));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.userId).toBe(row.verifiedBy);
    expect([ADMIN, ADMIN_B]).toContain(row.verifiedBy);
    expect(row.verificationNote).toBe(row.verifiedBy === ADMIN ? 'admin A' : 'admin B');
  });

  it('R6-04: a verify that names a stale expectedValue is refused with 409 TE_PARAM_CHANGED and signs nothing', async () => {
    // seed row: the dialog showed a value the seed no longer carries
    await expect(svc.verifyParameter(Y1, 'se.ss_wage_base', undefined, ADMIN, 170000)).rejects.toMatchObject({ code: 'TE_PARAM_CHANGED', details: { currentValue: 176100 } });
    await svc.setOverride(Y1, 'se.ss_wage_base', 184500, 'Correct base', ADMIN); // the admin's dialog still shows 176100
    await expect(svc.verifyParameter(Y1, 'se.ss_wage_base', 'checked', ADMIN, 176100))
      .rejects.toMatchObject({ statusCode: 409, code: 'TE_PARAM_CHANGED', details: { year: Y1, key: 'se.ss_wage_base', currentValue: 184500 } });
    const row = pick(await svc.getParameters(Y1), 'se.ss_wage_base')!;
    expect(row).toMatchObject({ value: 184500, status: 'unverified' });
    expect(row.verifiedAt ?? null).toBeNull();
    const audit = await db.select().from(auditLogTable).where(and(eq(auditLogTable.tenantId, ZERO), eq(auditLogTable.entityType, 'tax_parameter')));
    expect(audit.map((a) => a.action)).toEqual(['override']);
    // the value the admin actually sees is accepted (jsonb equality is semantic: 184500.0 = 184500)
    expect((await svc.verifyParameter(Y1, 'se.ss_wage_base', 'checked', ADMIN, 184500.0)).status).toBe('verified');
    // an already-verified row stays a no-op whatever the expectation (nothing to sign)
    expect((await svc.verifyParameter(Y1, 'se.nese_factor', undefined, ADMIN, 0.5)).status).toBe('verified');
  });

  it('verify all: every not-yet-verified row of the year (seed + provisional), nothing already verified, nothing in a fallback year', async () => {
    await svc.createYearFromPrior(Y2);
    const r = await svc.verifyAllParameters(Y2, 'Bulk after review', ADMIN);
    expect(r.verified.sort()).toEqual(FIXTURE[Y1]!.map((x) => x.key).sort());
    const dto = await svc.getParameters(Y2);
    expect(dto.parameters.every((p) => p.status === 'verified' && p.source === 'provisional')).toBe(true);
    expect((await svc.verifyAllParameters(Y2, undefined, ADMIN)).verified).toEqual([]);
    const y1 = await svc.verifyAllParameters(Y1, undefined, ADMIN);
    expect(y1.verified).toEqual(['se.ss_wage_base']);
    expect((await svc.verifyAllParameters(Y_EMPTY, undefined, ADMIN)).verified).toEqual([]);
    expect((await svc.getParameters(Y_EMPTY)).parameters.every((p) => p.status === 'provisional')).toBe(true);
  });
});
