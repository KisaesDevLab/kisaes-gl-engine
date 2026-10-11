// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { db } from '../../db/index.js';
import { tenants, companies, companyTaxProfiles, auditLog, taxEstTaxpayers } from '../../db/schema/index.js';
import * as svc from './taxpayers.service.js';
import type { FirmScope } from './firm-scope.service.js';

// Service-level contract tests: the scope object is the only authority.
const firmA = randomUUID();
const firmB = randomUUID();
let t1 = ''; let t2 = ''; let c1 = ''; let c2 = '';
const actor = () => ({ tenantId: t1, userId: randomUUID() });
const scope = (firmId: string, allowed: string[]): FirmScope => ({ firmId, firmRole: 'firm_staff', allowedTenantIds: allowed });

async function mk(name: string) {
  const [t] = await db.insert(tenants).values({ name, slug: `${name}-${Math.random().toString(36).slice(2, 8)}` }).returning();
  const [c] = await db.insert(companies).values({ tenantId: t!.id, businessName: `${name} Co`, entityType: 'single_member_llc' }).returning();
  return { t: t!.id, c: c!.id };
}

beforeEach(async () => {
  ({ t: t1, c: c1 } = await mk('svc-a'));
  ({ t: t2, c: c2 } = await mk('svc-b'));
});
afterEach(async () => {
  await db.delete(taxEstTaxpayers).where(inArray(taxEstTaxpayers.firmId, [firmA, firmB]));
  await db.delete(auditLog).where(inArray(auditLog.tenantId, [t1, t2]));
  await db.delete(companyTaxProfiles).where(inArray(companyTaxProfiles.tenantId, [t1, t2]));
  await db.delete(companies).where(inArray(companies.tenantId, [t1, t2]));
  await db.delete(tenants).where(inArray(tenants.id, [t1, t2]));
});

describe('taxpayers.service', () => {
  it('every taxpayer access is firm-checked', async () => {
    const tp = await svc.createTaxpayer(scope(firmA, [t1]), actor(), { displayName: 'A', filingStatus: 'single' });
    await expect(svc.getTaxpayer(scope(firmB, [t1]), tp.id)).rejects.toMatchObject({ statusCode: 404, code: 'TE_TAXPAYER_NOT_FOUND' });
    await expect(svc.updateTaxpayer(scope(firmB, [t1]), actor(), tp.id, { displayName: 'x' })).rejects.toMatchObject({ statusCode: 404 });
    await expect(svc.archiveTaxpayer(scope(firmB, [t1]), actor(), tp.id)).rejects.toMatchObject({ statusCode: 404 });
    expect((await svc.listTaxpayers(scope(firmB, [t1]), { status: 'all', sortBy: 'displayName', sortDir: 'asc', limit: 50, offset: 0 })).total).toBe(0);
  });

  it('an empty allowed set blocks every link write and yields no company options', async () => {
    const s = scope(firmA, []);
    const tp = await svc.createTaxpayer(s, actor(), { displayName: 'A', filingStatus: 'single' });
    await svc.upsertPerson(s, actor(), tp.id, 'primary', { firstName: 'a', lastName: 'b', isBlind: false });
    await expect(svc.upsertLink(s, actor(), tp.id, {
      personRole: 'primary', taxYear: 2026, tenantId: t1, companyId: c1, isOfficer: false, activityType: 'active', activeParticipation: false,
    })).rejects.toMatchObject({ statusCode: 404, code: 'TE_TENANT_NOT_MANAGED' });
    expect((await svc.listCompanyOptions(s, { limit: 50, offset: 0 })).total).toBe(0);
  });

  it('entity kind: TB return form wins, entity_type is the fallback', async () => {
    expect((await svc.resolveEntityKind(t1, c1)).kind).toBe('sole');
    await db.insert(companyTaxProfiles).values({ tenantId: t1, companyId: c1, returnForm: '1065' });
    expect(await svc.resolveEntityKind(t1, c1)).toMatchObject({ kind: 'partnership', returnForm: '1065', exists: true });
    expect((await svc.resolveEntityKind(t2, c1)).exists).toBe(false); // company id under the wrong tenant
    await db.update(companies).set({ entityType: 'c_corp' }).where(eq(companies.id, c2));
    expect((await svc.resolveEntityKind(t2, c2)).kind).toBe('c_corp');
  });

  it('percent totals use exact 4-decimal arithmetic', async () => {
    const s = scope(firmA, [t1]);
    const tp = await svc.createTaxpayer(s, actor(), { displayName: 'A', filingStatus: 'mfj' });
    await svc.upsertPerson(s, actor(), tp.id, 'primary', { firstName: 'a', lastName: 'b', isBlind: false });
    await svc.upsertPerson(s, actor(), tp.id, 'spouse', { firstName: 'c', lastName: 'd', isBlind: false });
    const base = { taxYear: 2026, tenantId: t1, companyId: c1, isOfficer: false, activityType: 'active' as const, activeParticipation: false };
    await svc.upsertLink(s, actor(), tp.id, { ...base, personRole: 'primary', profitPct: 33.3333 });
    await svc.upsertLink(s, actor(), tp.id, { ...base, personRole: 'spouse', profitPct: 66.6667 }); // exactly 100.0000
    await expect(svc.upsertLink(s, actor(), tp.id, { ...base, personRole: 'spouse', profitPct: 66.6668 }))
      .rejects.toMatchObject({ code: 'TE_LINK_PCT_OVER_100' });
  });
});
