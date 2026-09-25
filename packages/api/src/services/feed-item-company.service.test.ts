// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// New bank-feed items get a company: the connection's, else the tenant's
// only company. Before this, every feed item had company_id NULL and every
// company-scoped Close Review view came back empty.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, companies, accounts, bankConnections, bankFeedItems, transactionClassificationState } from '../db/schema/index.js';

vi.mock('./ai-categorization.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./ai-categorization.service.js')>();
  return {
    ...actual,
    resolvePreAiLayers: vi.fn().mockResolvedValue(null),
    categorizeFeedItemsBatch: vi.fn().mockResolvedValue(new Map()),
  };
});

import { resolveCompanyForConnection } from './feed-item-company.service.js';
import * as bankFeedService from './bank-feed.service.js';

let tenantId = '';
let accountId = '';

async function clean() {
  if (!tenantId) return;
  await db.delete(transactionClassificationState).where(eq(transactionClassificationState.tenantId, tenantId));
  await db.delete(bankFeedItems).where(eq(bankFeedItems.tenantId, tenantId));
  await db.delete(bankConnections).where(eq(bankConnections.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  tenantId = '';
}

beforeEach(async () => {
  const [t] = await db.insert(tenants).values({ name: 'FIC', slug: `fic-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` }).returning();
  tenantId = t!.id;
  const [a] = await db.insert(accounts).values({ tenantId, name: 'Checking', accountType: 'asset', detailType: 'bank' }).returning();
  accountId = a!.id;
});
afterEach(clean);

async function conn(companyId: string | null = null) {
  const [c] = await db.insert(bankConnections).values({ tenantId, accountId, provider: 'manual', companyId }).returning();
  return c!.id;
}

describe('resolveCompanyForConnection', () => {
  it("falls back to the tenant's only company", async () => {
    const [co] = await db.insert(companies).values({ tenantId, businessName: 'Only Co' }).returning();
    expect(await resolveCompanyForConnection(tenantId, await conn())).toBe(co!.id);
  });

  it("prefers the connection's own company", async () => {
    await db.insert(companies).values({ tenantId, businessName: 'A' });
    const [b] = await db.insert(companies).values({ tenantId, businessName: 'B' }).returning();
    expect(await resolveCompanyForConnection(tenantId, await conn(b!.id))).toBe(b!.id);
  });

  it('stays null when a multi-company tenant has an unscoped connection', async () => {
    await db.insert(companies).values([{ tenantId, businessName: 'A' }, { tenantId, businessName: 'B' }]);
    expect(await resolveCompanyForConnection(tenantId, await conn())).toBeNull();
  });
});

describe('CSV import stamps the company on new feed items', () => {
  it('sets company_id on every inserted row', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const [co] = await db.insert(companies).values({ tenantId, businessName: 'Only Co' }).returning();
    const connectionId = await conn();
    const csv = ['Date,Description,Amount', '2026-06-01,FIC VENDOR ONE,12.34', '2026-06-02,FIC VENDOR TWO,-5.00'].join('\n');
    await bankFeedService.importFromCsv(tenantId, connectionId, csv, { date: 0, description: 1, amount: 2 });
    const rows = await db.query.bankFeedItems.findMany({ where: eq(bankFeedItems.tenantId, tenantId) });
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(r.companyId).toBe(co!.id);
  });
});
