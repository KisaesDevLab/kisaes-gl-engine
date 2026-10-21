// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Phase 12 acceptance (PHASES.md): a snapshot stays unchanged after ANY later input or
// parameter change; the assumptions block is complete for the Rivera fixture; snapshot
// reads are firm-isolated (D1). Plus D9: the snapshot payload and the Redis-cached
// estimate are ciphertext at rest; the DB trigger enforces TE_SNAPSHOT_IMMUTABLE; the
// Phase 12 audit hooks fire (auditLog with the executor) and never carry prior-year
// figures; firm disclaimer / safe-harbor default / portal_shows flow into the estimate
// and the snapshot.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, pool } from '../../db/index.js';
import { auditLog, taxEstFirmSettings, taxEstSnapshots, taxEstTaxpayers } from '../../db/schema/index.js';
import { closeTbRedis, tbCacheGet } from '../tb/tb-redis.js';
import { encrypt, decrypt } from '../../utils/encryption.js';
import { ASSUMPTION_SECTION_IDS, NONRESIDENT_FLAT_RATE_LABEL } from '@kis-books/shared';
import type { FirmScope } from './firm-scope.service.js';
import { purgeTenants } from './entities.test-fixtures.js';
import { seedRivera, riveraExpected, type RiveraFixture } from './rivera.test-fixtures.js';
import { computeEstimate, estimateCacheKey } from './estimate.service.js';
import { createSnapshot, getSnapshot, listSnapshots, compareSnapshot } from './estimate-snapshots.service.js';
import { upsertFirmSettings } from './firm-settings.service.js';
import { upsertYear } from './years.service.js';
import { createPayment } from './payments.service.js';
import { createAdjustment } from './adjustments.service.js';
import { listAdjustmentTypes } from './adjustment-types.service.js';
import { replaceStateRows } from './state-rows.service.js';
import { updateTaxpayer } from './taxpayers.service.js';
import { setOverride as setParamOverride, revertOverride as revertParamOverride } from './tax-parameters.service.js';
import { setOverride as setRuleOverride, revertOverride as revertRuleOverride } from './tax-state-rules.service.js';

const FIRM_A = '00000000-0000-0000-0000-00000000a12c';
const FIRM_B = '00000000-0000-0000-0000-00000000b12c';
const USER = '00000000-0000-0000-0000-0000000012a1';
const TODAY = new Date('2026-10-12T12:00:00Z');
const OPTS = { today: TODAY, skipProviderCache: true };
const PARAM_KEY = 'penalty.underpayment_rate';
const FIRM_DISCLAIMER = 'Rivera CPA LLC: projection only, from the books and the listed assumptions. Not a tax return.';

let fx: RiveraFixture;
let adminA: FirmScope;
let snapId = '';
let frozen: Awaited<ReturnType<typeof getSnapshot>>;
let paramOverridden = false;
let ruleOverridden = false;
let overriddenRate: unknown = null;

/** Drizzle wraps the PostgreSQL error; the trigger's message is on the cause. */
async function pgError(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    const err = e as Error & { cause?: Error };
    return `${err.message} ${err.cause?.message ?? ''}`;
  }
  return 'no error';
}

beforeAll(async () => {
  fx = await seedRivera(FIRM_A, FIRM_B, USER);
  adminA = { ...fx.scopeA, firmRole: 'firm_admin' };
  // Firm settings flow (D4/D10): disclaimer, portal default; safe-harbor default stays lesser_of.
  await upsertFirmSettings(adminA, fx.actor, { disclaimerText: FIRM_DISCLAIMER, portalShows: 'snapshot', safeHarborDefault: 'lesser_of' });
}, 240_000);

afterAll(async () => {
  if (paramOverridden) await revertParamOverride(2026, PARAM_KEY, USER).catch(() => undefined);
  if (ruleOverridden) await revertRuleOverride(2026, 'MO', 'penalty.rate', USER).catch(() => undefined);
  await db.delete(taxEstFirmSettings).where(inArray(taxEstFirmSettings.firmId, [FIRM_A, FIRM_B]));
  await db.delete(taxEstTaxpayers).where(inArray(taxEstTaxpayers.firmId, [FIRM_A, FIRM_B])); // cascades snapshots
  await db.delete(auditLog).where(and(eq(auditLog.tenantId, '00000000-0000-0000-0000-000000000000'), eq(auditLog.userId, USER)));
  await purgeTenants([fx.T.schc, fx.T.scorp, fx.T.lp, fx.T.other]);
  await closeTbRedis();
  await pool.end();
});

const req = () => ({ taxpayerId: fx.taxpayerId, taxYear: 2026, scenarioId: fx.baseScenarioId, throughMonth: '2026-12' });
const section = (a: { sections: Array<{ id: string; items: Array<{ label: string; detail: string; badge?: string | null; code?: string | null }> }> }, id: string) =>
  a.sections.find((s) => s.id === id)!;
const sectionText = (a: Parameters<typeof section>[0], id: string) => section(a, id).items.map((i) => `${i.label}: ${i.detail}`).join('\n');

describe('estimate carries the firm settings and the assumptions block', () => {
  it('disclaimer, portal default and safe-harbor default flow into the live estimate; the Redis copy is ciphertext (D9)', async () => {
    const r = await computeEstimate(fx.scopeA, { ...req(), refresh: true }, OPTS);
    expect(r.summary.federalTotal).toBe('35829');
    expect(r.disclaimerText).toBe(FIRM_DISCLAIMER);
    expect(r.portalShows).toBe('snapshot');
    expect(r.firmSafeHarborDefault).toBe('lesser_of');
    expect(r.safeHarborRuleSource).toBe('firm_default');
    expect(r.assumptions!.disclaimerText).toBe(FIRM_DISCLAIMER);

    const raw = await tbCacheGet<Record<string, unknown>>(estimateCacheKey(fx.scopeA, req(), r.inputsHash));
    expect(raw).not.toBeNull();
    expect(Object.keys(raw!)).toEqual(['enc']);
    const rawText = JSON.stringify(raw);
    for (const secret of ['31500', '182000', '34650', 'Rivera Plumbing', 'requiredAnnualPayment']) expect(rawText).not.toContain(secret);
    expect(JSON.parse(decrypt(raw!['enc'] as string)).summary.federalTotal).toBe('35829');
    const again = await computeEstimate(fx.scopeA, req(), OPTS);
    expect(again.cached).toBe(true);
    expect(again.assumptions).toEqual(r.assumptions);
  }, 180_000);

  it('a taxpayer portal_shows override wins over the firm default; changing the disclaimer misses the cache', async () => {
    await updateTaxpayer(fx.scopeA, fx.actor, fx.taxpayerId, { portalShows: 'live' });
    const r = await computeEstimate(fx.scopeA, req(), OPTS);
    expect(r.cached).toBe(false);
    expect(r.portalShows).toBe('live');
    await updateTaxpayer(fx.scopeA, fx.actor, fx.taxpayerId, { portalShows: null });
  }, 180_000);

  it('the assumptions block is complete for Rivera (every section, real content)', async () => {
    const r = await computeEstimate(fx.scopeA, req(), OPTS);
    const a = r.assumptions!;
    expect(a.sections.map((s) => s.id)).toEqual([...ASSUMPTION_SECTION_IDS]);
    expect(sectionText(a, 'rate_mode')).toMatch(/2026 brackets for MFJ/);
    expect(sectionText(a, 'rate_mode')).toContain('MO (resident): Effective-rate override: 4% on base federal AGI'); // Q53: the Rivera rows are pinned to the override
    const proj = sectionText(a, 'projection');
    for (const c of ['Rivera Plumbing LLC', 'Maria Designs Inc', 'Oak Street Rentals LP']) expect(proj).toContain(`${c}: books through 2026-12`);
    expect(proj).toContain('12 months actual (year closed; no projection)');
    expect(proj).toContain('cash basis');
    expect(section(a, 'non_recurring').items[0]!.label).toBe('None');
    const reclass = sectionText(a, 'reclass');
    expect(reclass).toContain('Rivera Plumbing LLC — Owner health insurance moved to the owner (SEHI): $10,800 year to date');
    expect(reclass).toContain('Rivera Plumbing LLC — Nondeductible portion added back: $1,800');
    expect(reclass).toContain('Rivera Plumbing LLC — Estimated tax payments removed from expenses');
    const adj = sectionText(a, 'adjustments');
    expect(adj).toContain('Interest income: income $2,400 for the year');
    expect(adj).toContain('SEP contribution: deduction $15,000 for the year');
    const sh = sectionText(a, 'safe_harbor');
    expect(sh).toContain('lesser of current-year and prior-year rule (the firm default)');
    expect(sh).toContain(`Required annual payment $${Number(riveraExpected['safe_harbor']!['required_lesser_of']).toLocaleString('en-US')}`);
    expect(sh).toContain('Annualized income (Schedule AI)');
    expect(sh).toMatch(/AR estimates: Not required/);
    const st = sectionText(a, 'state_methods');
    expect(st).toContain(NONRESIDENT_FLAT_RATE_LABEL);
    expect(st).toContain('MO resident');
    expect(section(a, 'parameters').items.some((i) => i.code === PARAM_KEY && i.badge === 'unverified')).toBe(true);
    expect(section(a, 'readiness').items.some((i) => i.code === 'TE_PARAM_UNVERIFIED')).toBe(true);
    expect(section(a, 'engine_notes').items.map((i) => i.code)).toEqual(expect.arrayContaining(['Q29', 'Q30', 'Q33', 'Q34']));
    expect(sectionText(a, 'disclaimer')).toContain(FIRM_DISCLAIMER);
  }, 180_000);
});

describe('finalize → immutable snapshot', () => {
  it('stores inputs, results, engine version, federal parameters and state rules with statuses, readiness, assumptions, disclaimer, user and time', async () => {
    const s = await createSnapshot(fx.scopeA, fx.actor, { ...req(), reason: 'finalize', note: 'Q3 vouchers' }, OPTS);
    snapId = s.id;
    const p = s.payload;
    expect(s).toMatchObject({ taxpayerId: fx.taxpayerId, taxYear: 2026, scenarioId: fx.baseScenarioId, scenarioName: 'Base', reason: 'finalize', note: 'Q3 vouchers', createdBy: USER, accessible: true });
    expect(s.summary!.total).toBe(String(riveraExpected['base']!['total']));
    expect(p.result.engineVersion).toBe(s.engineVersion);
    expect(p.result.summary.federalTotal).toBe('35829');
    expect(p.federalParameters.parameters.length).toBeGreaterThan(100);
    expect(p.federalParameters.parameters.every((x) => ['verified', 'unverified', 'provisional'].includes(x.status))).toBe(true);
    expect(p.stateRules.map((x) => x.state).sort()).toEqual(['AR', 'MO']);
    expect(p.stateRules.every((x) => x.rules.every((rr) => !!rr.status))).toBe(true);
    expect(p.readiness!.entities).toHaveLength(3);
    expect(p.readinessWarnings).toEqual(p.result.warnings);
    expect(p.assumptions.sections.map((x) => x.id)).toEqual([...ASSUMPTION_SECTION_IDS]);
    expect(p.disclaimerText).toBe(FIRM_DISCLAIMER);
    expect(p.firmSettings).toMatchObject({ safeHarborDefault: 'lesser_of', portalShows: 'snapshot' });
    expect(p.inputs.taxpayer.displayName).toBe('Carlos & Maria Rivera');
    expect(p.inputs.companies).toHaveLength(3);
    expect(p.inputs.safeHarbor).toEqual({ rule: 'lesser_of', ruleSource: 'firm_default' });
    // D9: the read-only view withholds the raw prior-year inputs (present flags stay).
    expect(p.inputs.year['priorYearTax']).toBeNull();
    expect(p.inputs.year['priorYearTaxPresent']).toBe(true);
    expect(JSON.stringify(p.inputs)).not.toContain('31500');
    expect(JSON.stringify(p.inputs.stateRows)).not.toContain('7050');
    frozen = await getSnapshot(fx.scopeA, snapId);
    expect(frozen.payload).toEqual(s.payload);
  }, 240_000);

  it('the payload is ciphertext at rest; the audit row is metadata only', async () => {
    const [row] = await db.select().from(taxEstSnapshots).where(eq(taxEstSnapshots.id, snapId));
    for (const col of [row!.payloadEncrypted, row!.summaryEncrypted]) {
      expect(col.split(':')).toHaveLength(3);
      for (const secret of ['31500', '182000', '35829', 'Rivera', 'federalTotal']) expect(col).not.toContain(secret);
    }
    expect(row!.tenantIds.sort()).toEqual([fx.T.schc, fx.T.scorp, fx.T.lp].sort());
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.entityType, 'tax_est_snapshot'), eq(auditLog.entityId, snapId)));
    expect(audits.map((x) => x.action)).toEqual(['create']);
    expect(audits[0]!.tenantId).toBe(fx.actor.tenantId);
    for (const secret of ['31500', '182000', '35829', '34650']) expect(JSON.stringify(audits[0]!.afterData)).not.toContain(secret);
  });

  it('stays byte-identical after later input, payment, adjustment, state-row, firm-setting and parameter / state-rule changes', async () => {
    const types = await listAdjustmentTypes(fx.scopeA);
    await upsertYear(fx.scopeA, fx.actor, fx.taxpayerId, 2026, { priorYearTax: '45000', creditsNonrefundable: '0' });
    await createPayment(fx.scopeA, fx.actor, fx.taxpayerId, 2026, { jurisdiction: 'federal', date: '2026-10-01', amount: '5000', source: 'manual', memo: 'after finalize' });
    await createAdjustment(fx.scopeA, fx.actor, fx.baseScenarioId, { adjustmentTypeId: types.find((t) => t.code === 'interest_income')!.id, label: 'Late interest', amount: '9000', cadence: 'annual', startMonth: 1, endMonth: 12, glLinked: false, nonRecurring: true });
    await replaceStateRows(fx.scopeA, fx.actor, fx.baseScenarioId, { rows: [{ residency: 'resident', state: 'MO', effectiveRate: 0.05, base: 'federal_agi', sourcedManual: false }] });
    await upsertFirmSettings(adminA, fx.actor, { disclaimerText: 'Changed text.' });
    const periods = frozen.payload.result.parametersUsed.find((u) => u.key === PARAM_KEY)!.value as Array<{ rate: number }>;
    overriddenRate = periods.map((x) => ({ ...x, rate: x.rate + 0.02 }));
    await setParamOverride(2026, PARAM_KEY, overriddenRate, 'Phase 12 immutability test', USER);
    paramOverridden = true;
    await setRuleOverride(2026, 'MO', 'penalty.rate', 0.11, 'Phase 12 immutability test', USER);
    ruleOverridden = true;

    const after = await getSnapshot(fx.scopeA, snapId);
    expect(after.payload).toEqual(frozen.payload);
    expect(after.payloadSha256).toBe(frozen.payloadSha256);
    expect(after.summary).toEqual(frozen.summary);
    expect(after.payload.disclaimerText).toBe(FIRM_DISCLAIMER);

    // …while the live estimate moved.
    const live = await computeEstimate(fx.scopeA, req(), OPTS);
    expect(live.summary.federalTotal).not.toBe(frozen.payload.result.summary.federalTotal);
    expect(live.disclaimerText).toBe('Changed text.');
    expect(live.parametersUsed.find((u) => u.key === PARAM_KEY)!.value).toEqual(overriddenRate);
  }, 240_000);

  it('compare: the frozen result vs live lists the money lines, parameter and rule changes', async () => {
    const c = await compareSnapshot(fx.scopeA, snapId, OPTS);
    expect(c.summary.snapshot).toEqual(frozen.payload.result.summary);
    expect(c.engineVersionChanged).toBe(false);
    expect(c.inputsHashChanged).toBe(true);
    const paths = c.differences.map((d) => d.path);
    // QA D24: each line once (the federal required annual payment is only the summary line).
    expect(new Set(c.differences.map((d) => d.label)).size).toBe(c.differences.length);
    expect(paths).not.toContain('estimates.federal.requiredAnnualPayment');
    expect(paths).toEqual(expect.arrayContaining(['summary.federalTotal', 'federal.agi', 'state.MO.netTax']));
    expect(c.differences.find((d) => d.path === 'state.AR.netTax')).toMatchObject({ live: null, delta: null }); // AR row removed after finalize
    const agi = c.differences.find((d) => d.path === 'federal.agi')!;
    expect(Number(agi.delta)).toBe(Number(agi.live) - Number(agi.snapshot));
    expect(c.parameterChanges.find((x) => x.scope === 'federal' && x.key === PARAM_KEY)).toMatchObject({ live: { value: overriddenRate } });
    expect(c.parameterChanges.some((x) => x.scope === 'AR')).toBe(true); // AR left the scenario: its rules are only in the snapshot
  }, 240_000);

  it('the database refuses UPDATE of any column but the ciphertext (TE_SNAPSHOT_IMMUTABLE); a re-encrypted payload still verifies, a swapped one does not', async () => {
    expect(await pgError(db.update(taxEstSnapshots).set({ note: 'edited' }).where(eq(taxEstSnapshots.id, snapId)))).toMatch(/TE_SNAPSHOT_IMMUTABLE/);
    expect(await pgError(db.update(taxEstSnapshots).set({ payloadSha256: 'f'.repeat(64) }).where(eq(taxEstSnapshots.id, snapId)))).toMatch(/TE_SNAPSHOT_IMMUTABLE/);
    expect(await pgError(db.execute(sql`UPDATE tax_est_snapshots SET scenario_id = gen_random_uuid() WHERE id = ${snapId}`))).toMatch(/TE_SNAPSHOT_IMMUTABLE/);
    const [row] = await db.select().from(taxEstSnapshots).where(eq(taxEstSnapshots.id, snapId));
    // Key rotation path: same plaintext, new ciphertext → allowed and still verifies.
    await db.update(taxEstSnapshots).set({ payloadEncrypted: encrypt(decrypt(row!.payloadEncrypted)) }).where(eq(taxEstSnapshots.id, snapId));
    expect((await getSnapshot(fx.scopeA, snapId)).payload).toEqual(frozen.payload);
    // Tampering through the allowed column is detected by the plaintext hash.
    await db.update(taxEstSnapshots).set({ payloadEncrypted: encrypt('{"version":1}') }).where(eq(taxEstSnapshots.id, snapId));
    await expect(getSnapshot(fx.scopeA, snapId)).rejects.toMatchObject({ code: 'TE_SNAPSHOT_INTEGRITY' });
    await db.update(taxEstSnapshots).set({ payloadEncrypted: row!.payloadEncrypted }).where(eq(taxEstSnapshots.id, snapId));
    expect((await getSnapshot(fx.scopeA, snapId)).payloadSha256).toBe(frozen.payloadSha256);
  }, 60_000);

  it('history lists newest first with a total and the decrypted summary', async () => {
    await createSnapshot(fx.scopeA, fx.actor, { ...req(), reason: 'pdf' }, OPTS);
    const h = await listSnapshots(fx.scopeA, fx.taxpayerId, 2026, { limit: 1, offset: 0 });
    expect(h.total).toBe(2);
    expect(h.data).toHaveLength(1);
    expect(h.data[0]!.reason).toBe('pdf');
    const all = await listSnapshots(fx.scopeA, fx.taxpayerId, 2026, { limit: 50, offset: 0, scenarioId: fx.baseScenarioId });
    expect(all.data.map((x) => x.id)).toContain(snapId);
    expect(all.data.find((x) => x.id === snapId)!.summary).toEqual(frozen.summary);
  }, 240_000);
});

describe('D1 isolation on snapshots', () => {
  it('another firm gets 404 on view, compare, history and finalize', async () => {
    await expect(getSnapshot(fx.scopeB, snapId)).rejects.toMatchObject({ code: 'TE_SNAPSHOT_NOT_FOUND' });
    await expect(compareSnapshot(fx.scopeB, snapId, OPTS)).rejects.toMatchObject({ code: 'TE_SNAPSHOT_NOT_FOUND' });
    await expect(listSnapshots(fx.scopeB, fx.taxpayerId, 2026, { limit: 50, offset: 0 })).rejects.toMatchObject({ code: 'TE_TAXPAYER_NOT_FOUND' });
    await expect(createSnapshot(fx.scopeB, fx.actor, req(), OPTS)).rejects.toMatchObject({ code: 'TE_TAXPAYER_NOT_FOUND' });
  });

  it('a firm member who can no longer reach one of the snapshot\'s tenants sees the row without figures and gets 404 on view', async () => {
    const narrowed: FirmScope = { ...fx.scopeA, allowedTenantIds: [fx.T.schc, fx.T.scorp] };
    const h = await listSnapshots(narrowed, fx.taxpayerId, 2026, { limit: 50, offset: 0 });
    const row = h.data.find((x) => x.id === snapId)!;
    expect(row.accessible).toBe(false);
    expect(row.summary).toBeNull();
    await expect(getSnapshot(narrowed, snapId)).rejects.toMatchObject({ code: 'TE_TENANT_NOT_MANAGED' });
    await expect(compareSnapshot(narrowed, snapId, OPTS)).rejects.toMatchObject({ code: 'TE_TENANT_NOT_MANAGED' });
  });
});

describe('audit hooks (auditLog with the executor)', () => {
  it('settings, links, persons, adjustments, treatments, state rows, payments, firm settings / disclaimer and parameter / state-rule overrides are audited', async () => {
    const tenantRows = await db.select({ entityType: auditLog.entityType, action: auditLog.action, afterData: auditLog.afterData, beforeData: auditLog.beforeData })
      .from(auditLog).where(inArray(auditLog.tenantId, [fx.T.schc, fx.T.scorp, fx.T.lp]));
    const types = new Set(tenantRows.map((r) => r.entityType));
    for (const t of ['tax_est_taxpayer', 'tax_est_person', 'tax_est_link', 'tax_est_treatment', 'tax_est_year', 'tax_est_adjustment', 'tax_est_state_rows',
      'tax_est_payment', 'tax_est_firm_settings', 'tax_est_snapshot']) {
      expect(types, t).toContain(t);
    }
    const firm = tenantRows.filter((r) => r.entityType === 'tax_est_firm_settings');
    expect(firm.some((r) => JSON.stringify(r.afterData ?? '').includes('Changed text.') && JSON.stringify(r.beforeData ?? '').includes(FIRM_DISCLAIMER))).toBe(true);
    // D9: no prior-year federal / state figure is ever written to the audit trail.
    // Checked on the audit VALUES only: ids and timestamps are left out, a
    // UUID's hex digits or a time can contain "7050" by chance.
    const values: string[] = [];
    const walk = (v: unknown): void => {
      if (v === null || v === undefined) return;
      if (typeof v === 'object') { for (const x of Object.values(v as Record<string, unknown>)) walk(x); return; }
      const str = String(v);
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str) || /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:?\d{2})?$/.test(str)) return;
      values.push(str);
    };
    for (const r of tenantRows) { walk(r.afterData); walk(r.beforeData); }
    expect(values.length).toBeGreaterThan(0);
    for (const secret of ['31500', '182000', '45000', '7050']) {
      expect(values.filter((v) => v.includes(secret)), secret).toEqual([]);
    }
    const overrides = await db.select({ entityType: auditLog.entityType }).from(auditLog)
      .where(and(eq(auditLog.tenantId, '00000000-0000-0000-0000-000000000000'), eq(auditLog.userId, USER), eq(auditLog.action, 'override')));
    expect(new Set(overrides.map((o) => o.entityType))).toEqual(new Set(['tax_parameter', 'tax_state_rule']));
  });
});
