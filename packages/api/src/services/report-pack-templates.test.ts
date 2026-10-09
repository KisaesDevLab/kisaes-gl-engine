// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, companies, reportPacks, reportPackItems, reportPackTemplates } from '../db/schema/index.js';
import { createPack, getPack } from './report-pack.service.js';
import { saveAsTemplate, listTemplates, applyTemplate, deleteTemplate, updateTemplate } from './report-pack-templates.service.js';

const uid = '00000000-0000-4000-8000-0000000000aa';
const tag = '11111111-1111-4111-8111-111111111111';
const acct = '22222222-2222-4222-8222-222222222222';
let tenantA = ''; let companyA = '';
let tenantB = ''; let companyB = '';
const templateIds: string[] = [];

beforeAll(async () => {
  const stamp = Date.now();
  const [a] = await db.insert(tenants).values({ name: 'Firm Tenant', slug: `tpl-a-${stamp}` }).returning();
  const [b] = await db.insert(tenants).values({ name: 'Client Tenant', slug: `tpl-b-${stamp}` }).returning();
  tenantA = a!.id; tenantB = b!.id;
  const [ca] = await db.insert(companies).values({ tenantId: tenantA, businessName: 'A Co' }).returning();
  const [cb] = await db.insert(companies).values({ tenantId: tenantB, businessName: 'B Co' }).returning();
  companyA = ca!.id; companyB = cb!.id;
});

afterAll(async () => {
  if (templateIds.length) await db.delete(reportPackTemplates).where(inArray(reportPackTemplates.id, templateIds));
  for (const t of [tenantA, tenantB]) {
    const packs = await db.select({ id: reportPacks.id }).from(reportPacks).where(eq(reportPacks.tenantId, t));
    if (packs.length) await db.delete(reportPackItems).where(inArray(reportPackItems.packId, packs.map((p) => p.id)));
    await db.delete(reportPacks).where(eq(reportPacks.tenantId, t));
    await db.execute((await import('drizzle-orm')).sql`DELETE FROM audit_log WHERE tenant_id = ${t}`);
    await db.delete(companies).where(eq(companies.tenantId, t));
    await db.delete(tenants).where(eq(tenants.id, t));
  }
});

describe('report pack templates', () => {
  it('saves a pack as a template without client-specific filters and applies it to another client', async () => {
    const pack = await createPack(tenantA, companyA, uid, {
      name: 'Month End Close',
      periodPreset: 'last-month',
      defaultBasis: 'cash',
      defaultTagId: tag,
      coverPage: false,
      filenameTemplate: '{tenant}-{range}',
      items: [
        { reportId: 'profit-loss', options: { basis: 'cash', tagId: tag, showPct: true } },
        { reportId: 'bank-reconciliations', options: { omitStatements: true } },
        { reportId: 'transaction-report', options: { accountId: acct, txnType: 'expense' } },
      ],
    });

    const tpl = await saveAsTemplate(tenantA, pack.id, uid, { name: 'Standard Close' });
    templateIds.push(tpl.id);
    expect(tpl.reportIds).toEqual(['profit-loss', 'bank-reconciliations', 'transaction-report']);
    expect((await listTemplates()).some((t) => t.id === tpl.id)).toBe(true);

    const applied = await applyTemplate(tenantB, companyB, uid, tpl.id);
    const full = await getPack(tenantB, applied.id);
    expect(full.companyId).toBe(companyB);
    expect(full.name).toBe('Standard Close');
    expect(full.periodPreset).toBe('last-month');
    expect(full.defaultBasis).toBe('cash');
    expect(full.coverPage).toBe(false);
    expect(full.filenameTemplate).toBe('{tenant}-{range}');
    expect(full.defaultTagId).toBeNull();
    expect(full.items.map((i) => i.reportId)).toEqual(['profit-loss', 'bank-reconciliations', 'transaction-report']);
    expect(full.items[0]!.optionsJson).toEqual({ basis: 'cash', showPct: true });
    expect(full.items[2]!.optionsJson).toEqual({ txnType: 'expense' });
  });

  it('renames and deletes; a deleted template can no longer be applied', async () => {
    const pack = await createPack(tenantA, companyA, uid, { name: 'Tmp', items: [{ reportId: 'profit-loss', options: {} }] });
    const tpl = await saveAsTemplate(tenantA, pack.id, uid, {});
    templateIds.push(tpl.id);
    expect((await updateTemplate(tenantA, tpl.id, uid, { name: 'Renamed' })).name).toBe('Renamed');
    await deleteTemplate(tenantA, tpl.id, uid);
    expect((await listTemplates()).some((t) => t.id === tpl.id)).toBe(false);
    await expect(applyTemplate(tenantB, companyB, uid, tpl.id)).rejects.toThrow(/not found/i);
  });
});
