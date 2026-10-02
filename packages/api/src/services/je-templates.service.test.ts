// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, companies, accounts, auditLog, jeTemplates, jeTemplateLines, tags } from '../db/schema/index.js';
import * as svc from './je-templates.service.js';

let tenantId = '';
let companyId = '';
let debitAcct = '';
let creditAcct = '';

async function cleanup() {
  if (!tenantId) return;
  await db.delete(jeTemplateLines).where(eq(jeTemplateLines.tenantId, tenantId));
  await db.delete(jeTemplates).where(eq(jeTemplates.tenantId, tenantId));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(tags).where(eq(tags.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  tenantId = '';
}

beforeEach(async () => {
  await cleanup();
  const [t] = await db.insert(tenants).values({
    name: 'JE Tpl Test',
    slug: 'je-tpl-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
  }).returning();
  tenantId = t!.id;
  const [c] = await db.insert(companies).values({ tenantId, businessName: 'JE Tpl Co' }).returning();
  companyId = c!.id;
  const [d] = await db.insert(accounts).values({ tenantId, companyId, name: 'Payroll Expense', accountType: 'expense', accountNumber: '6500' }).returning();
  debitAcct = d!.id;
  const [cr] = await db.insert(accounts).values({ tenantId, companyId, name: 'Accrued Payroll', accountType: 'liability', accountNumber: '2200' }).returning();
  creditAcct = cr!.id;
});
afterEach(cleanup);

describe('je-templates service', () => {
  it('creates, lists, and reads a template with lines', async () => {
    const tpl = await svc.createTemplate(tenantId, { name: 'Payroll accrual', memo: 'Monthly payroll accrual' }, undefined, companyId);
    expect(tpl.name).toBe('Payroll accrual');

    await svc.replaceTemplateLines(tenantId, tpl.id, [
      { label: 'Gross wages', accountId: debitAcct, normalSide: 'debit', sortOrder: 0, isRequired: true, isActive: true },
      { label: 'Accrued payroll', accountId: creditAcct, normalSide: 'credit', sortOrder: 1, isRequired: true, isActive: true },
    ]);

    const full = await svc.getTemplate(tenantId, tpl.id);
    expect(full.lines).toHaveLength(2);
    expect(full.lines[0]!.label).toBe('Gross wages');
    expect(full.lines[0]!.normalSide).toBe('debit');
    expect(full.lines[0]!.isRequired).toBe(true);

    const list = await svc.listTemplates(tenantId);
    expect(list.map((l) => l.id)).toContain(tpl.id);
  });

  it('replaceTemplateLines updates by id, inserts new, deletes removed', async () => {
    const tpl = await svc.createTemplate(tenantId, { name: 'T' }, undefined, companyId);
    const v1 = await svc.replaceTemplateLines(tenantId, tpl.id, [
      { label: 'A', accountId: debitAcct, normalSide: 'debit', sortOrder: 0, isRequired: false, isActive: true },
      { label: 'B', accountId: creditAcct, normalSide: 'credit', sortOrder: 1, isRequired: false, isActive: true },
    ]);
    const keepId = v1.lines[0]!.id;

    const v2 = await svc.replaceTemplateLines(tenantId, tpl.id, [
      { id: keepId, label: 'A renamed', accountId: debitAcct, normalSide: 'debit', sortOrder: 0, isRequired: true, isActive: true },
      { label: 'C new', accountId: creditAcct, normalSide: 'credit', sortOrder: 1, isRequired: false, isActive: true },
    ]);
    expect(v2.lines).toHaveLength(2);
    expect(v2.lines.find((l) => l.id === keepId)?.label).toBe('A renamed');
    expect(v2.lines.some((l) => l.label === 'B')).toBe(false);
    expect(v2.lines.some((l) => l.label === 'C new')).toBe(true);
  });

  it('soft-deletes: template leaves the list but survives in the table', async () => {
    const tpl = await svc.createTemplate(tenantId, { name: 'Gone' }, undefined, companyId);
    await svc.deleteTemplate(tenantId, tpl.id);
    const list = await svc.listTemplates(tenantId);
    expect(list.map((l) => l.id)).not.toContain(tpl.id);
    const raw = await db.query.jeTemplates.findFirst({ where: eq(jeTemplates.id, tpl.id) });
    expect(raw?.isActive).toBe(false);
  });

  it('stores a default tag and per-line tags; rejects a foreign tenant\'s tag', async () => {
    const [tag] = await db.insert(tags).values({ tenantId, name: 'Store 1' }).returning();
    const tpl = await svc.createTemplate(tenantId, { name: 'Tagged', defaultTagId: tag!.id }, undefined, companyId);
    expect(tpl.defaultTagId).toBe(tag!.id);

    const v = await svc.replaceTemplateLines(tenantId, tpl.id, [
      { label: 'A', accountId: debitAcct, tagId: tag!.id, normalSide: 'debit', sortOrder: 0, isRequired: false, isActive: true },
      { label: 'B', accountId: creditAcct, normalSide: 'credit', sortOrder: 1, isRequired: false, isActive: true },
    ]);
    expect(v.lines.find((l) => l.label === 'A')?.tagId).toBe(tag!.id);
    expect(v.lines.find((l) => l.label === 'B')?.tagId).toBeNull();

    const cleared = await svc.updateTemplate(tenantId, tpl.id, { defaultTagId: null });
    expect(cleared.defaultTagId).toBeNull();

    const [other] = await db.insert(tenants).values({
      name: 'Other', slug: 'other-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    }).returning();
    try {
      const [foreignTag] = await db.insert(tags).values({ tenantId: other!.id, name: 'Theirs' }).returning();
      await expect(svc.updateTemplate(tenantId, tpl.id, { defaultTagId: foreignTag!.id })).rejects.toThrow('do not belong');
      await expect(svc.replaceTemplateLines(tenantId, tpl.id, [
        { label: 'X', accountId: debitAcct, tagId: foreignTag!.id, normalSide: 'debit', sortOrder: 0, isRequired: false, isActive: true },
      ])).rejects.toThrow('do not belong');
    } finally {
      await db.delete(tags).where(eq(tags.tenantId, other!.id));
      await db.delete(tenants).where(eq(tenants.id, other!.id));
    }
  });

  it('renames and duplicates a template with its active lines', async () => {
    const tpl = await svc.createTemplate(tenantId, { name: 'Orig', memo: 'M' }, undefined, companyId);
    await svc.replaceTemplateLines(tenantId, tpl.id, [
      { label: 'A', accountId: debitAcct, normalSide: 'debit', sortOrder: 0, isRequired: true, isActive: true },
      { label: 'B', accountId: creditAcct, normalSide: 'credit', sortOrder: 1, isRequired: false, isActive: true },
    ]);
    const renamed = await svc.updateTemplate(tenantId, tpl.id, { name: 'Renamed' });
    expect(renamed.name).toBe('Renamed');

    const copy = await svc.duplicateTemplate(tenantId, tpl.id, {});
    expect(copy.id).not.toBe(tpl.id);
    expect(copy.name).toBe('Renamed (copy)');
    expect(copy.memo).toBe('M');
    expect(copy.lines.map((l) => l.label)).toEqual(['A', 'B']);
    expect(copy.lines[0]!.isRequired).toBe(true);

    const named = await svc.duplicateTemplate(tenantId, tpl.id, { name: 'Second' });
    expect(named.name).toBe('Second');
    // The original is untouched.
    expect((await svc.getTemplate(tenantId, tpl.id)).lines).toHaveLength(2);
  });

  it('is tenant-scoped: a foreign tenant cannot read or edit', async () => {
    const tpl = await svc.createTemplate(tenantId, { name: 'Mine' }, undefined, companyId);
    const [other] = await db.insert(tenants).values({
      name: 'Other', slug: 'other-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    }).returning();
    try {
      await expect(svc.getTemplate(other!.id, tpl.id)).rejects.toThrow('not found');
      await expect(svc.replaceTemplateLines(other!.id, tpl.id, [])).rejects.toThrow('not found');
    } finally {
      await db.delete(tenants).where(eq(tenants.id, other!.id));
    }
  });
});
