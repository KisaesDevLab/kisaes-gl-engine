// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// The assignable-code surface (ADR-TB-02) is scoped by activity: the
// profile's entity activity + 'common' + live activity-unit types.
// Without the filter every code shows once per seed activity type.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, pool } from '../../db/index.js';
import { activityUnits, companies, companyTaxProfiles, tenants } from '../../db/schema/index.js';
import { importSeed } from './tax-code-seed.service.js';
import { listAvailableCodes } from './assignments.service.js';

const SEED_FILE_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'db', 'seeds', 'tax-codes', '2025', 'tax-codes.xlsx');

let tenantId: string;
let companyId: string;

beforeAll(async () => {
  await importSeed({ taxYear: 2025, buffer: readFileSync(SEED_FILE_PATH), dryRun: false });
  const [t] = await db.insert(tenants).values({ name: 'tb-avail-test', slug: `tb-avail-${Date.now()}` }).returning();
  tenantId = t!.id;
  const [c] = await db.insert(companies).values({ tenantId, businessName: 'Avail Co', fiscalYearStartMonth: 1 }).returning();
  companyId = c!.id;
  await db.insert(companyTaxProfiles).values({ tenantId, companyId, returnForm: '1120S', defaultActivityType: 'business' });
});

afterAll(async () => {
  await db.delete(activityUnits).where(eq(activityUnits.tenantId, tenantId));
  await db.delete(companyTaxProfiles).where(eq(companyTaxProfiles.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  await pool.end();
});

describe('listAvailableCodes activity scoping', () => {
  it('returns only common + the profile activity, with no duplicate (activity, code) pairs', async () => {
    const result = await listAvailableCodes(tenantId, companyId);
    expect(result.activityType).toBe('business');
    const activities = new Set(result.seedCodes.map((c) => c.activityType));
    expect([...activities].sort()).toEqual(['business', 'common']);
    // No code repeated across the surviving activity types beyond its
    // legitimate per-activity rows.
    const keys = result.seedCodes.map((c) => `${c.activityType}|${c.code}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('widens to live activity-unit types', async () => {
    await db.insert(activityUnits).values({
      tenantId, companyId, activityType: 'rental', instanceNumber: 1, displayName: 'Rental 1',
    });
    const result = await listAvailableCodes(tenantId, companyId);
    const activities = new Set(result.seedCodes.map((c) => c.activityType));
    expect(activities.has('rental')).toBe(true);
    expect(activities.has('farm')).toBe(false);
  });
});
