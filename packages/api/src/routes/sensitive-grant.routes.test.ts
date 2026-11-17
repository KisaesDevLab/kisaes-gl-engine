// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// Grantable sensitive accounts (U-33, sensitive-accounts-grant-v1; ClientLedger
// P29 owner decision 2026-11-17): a bookkeeper whose template (or override)
// lists `sensitive_accounts: view` sees marked accounts, as does a bookkeeper
// with no permission row; a template without the key (A/P-style, the harness's
// "everything but sensitive") still hides them; marking stays owner only.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { permissionTemplates, userPermissions } from '../db/schema/index.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';
import { startSensitiveHarness, type SensitiveHarness } from './sensitive.test-fixtures.js';

let h: SensitiveHarness;
beforeEach(async () => { h = await startSensitiveHarness('sens-grant'); await h.markWages(); });
afterEach(async () => { await h.close(); });

async function bkSees(): Promise<{ list: boolean; byId: number; level: unknown; hiddenNotice: unknown }> {
  const list = await h.call('bk', 'GET', '/api/v1/accounts?limit=500');
  expect(list.status).toBe(200);
  const byId = (await h.call('bk', 'GET', `/api/v1/accounts/${h.acct.wagesSub}`)).status;
  const me = await h.call('bk', 'GET', '/api/v1/auth/me');
  const pl = await h.call('bk', 'GET', '/api/v1/reports/profit-loss?start_date=2026-01-01&end_date=2026-12-31');
  expect(pl.status, pl.text).toBe(200);
  return {
    list: list.json.data.some((a: { id: string }) => a.id === h.acct.wages),
    byId,
    level: me.json.permissions?.sensitive_accounts ?? me.json.user?.permissions?.sensitive_accounts,
    hiddenNotice: pl.json.hiddenNotice,
  };
}

async function setTemplate(map: Record<string, string>) {
  await db.update(permissionTemplates).set({ permissions: map as never }).where(eq(permissionTemplates.id, h.bkTemplateId));
}

describe('sensitive-accounts-grant-v1', () => {
  it('is declared', () => {
    expect(DESKTOP_CAPABILITIES).toContain('sensitive-accounts-grant-v1');
  });

  it('a template without the key hides them; listing sensitive_accounts: view in it shows them', async () => {
    expect(await bkSees()).toMatchObject({ list: false, byId: 404, level: 'none', hiddenNotice: true });
    const [tpl] = await db.select().from(permissionTemplates).where(eq(permissionTemplates.id, h.bkTemplateId));
    await setTemplate({ ...(tpl!.permissions as Record<string, string>), sensitive_accounts: 'view' });
    const seen = await bkSees();
    expect(seen).toMatchObject({ list: true, byId: 200, level: 'view' });
    expect(seen.hiddenNotice).toBeUndefined();
    // full is capped to view and still grants.
    await setTemplate({ ...(tpl!.permissions as Record<string, string>), sensitive_accounts: 'full' });
    expect(await bkSees()).toMatchObject({ list: true, byId: 200, level: 'view' });
  });

  it('an override grants it on a template without it, and an override of none takes it away', async () => {
    await db.update(userPermissions).set({ overrides: { sensitive_accounts: 'view' } as never }).where(eq(userPermissions.userId, h.bookkeeperId));
    expect(await bkSees()).toMatchObject({ list: true, byId: 200, level: 'view' });
    const [tpl] = await db.select().from(permissionTemplates).where(eq(permissionTemplates.id, h.bkTemplateId));
    await setTemplate({ ...(tpl!.permissions as Record<string, string>), sensitive_accounts: 'view' });
    await db.update(userPermissions).set({ overrides: { sensitive_accounts: 'none' } as never }).where(eq(userPermissions.userId, h.bookkeeperId));
    expect(await bkSees()).toMatchObject({ list: false, byId: 404, level: 'none' });
  });

  it('an A/P-style template (no sensitive_accounts) hides them', async () => {
    await setTemplate({ bills: 'full', pay_bills: 'full', vendor_credits: 'full', accounts: 'view', reports: 'view', financial_reports: 'view', contacts: 'full' });
    expect(await bkSees()).toMatchObject({ list: false, byId: 404, level: 'none', hiddenNotice: true });
  });

  it('a bookkeeper with no permission row (legacy full access) sees them', async () => {
    await db.delete(userPermissions).where(eq(userPermissions.userId, h.bookkeeperId));
    const seen = await bkSees();
    expect(seen).toMatchObject({ list: true, byId: 200, level: 'view' });
    expect(seen.hiddenNotice).toBeUndefined();
  });

  it('marking an account stays owner only, even for a bookkeeper who sees them', async () => {
    await db.delete(userPermissions).where(eq(userPermissions.userId, h.bookkeeperId));
    const r = await h.call('bk', 'PUT', `/api/v1/accounts/${h.acct.supplies}/sensitive`, { isSensitive: true });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe('OWNER_REQUIRED');
    const un = await h.call('bk', 'PUT', `/api/v1/accounts/${h.acct.wages}/sensitive`, { isSensitive: false });
    expect(un.status).toBe(403);
    expect(un.json.error.code).toBe('OWNER_REQUIRED');
  });
});
