// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { db } from '../db/index.js';
import {
  tenants, users, sessions, accounts, companies, contacts,
  bankConnections, bankFeedItems, aiConfig, aiJobs, aiUsageLog,
} from '../db/schema/index.js';
import * as authService from './auth.service.js';
import * as accountsService from './accounts.service.js';
import * as aiConfigService from './ai-config.service.js';
import * as aiConsent from './ai-consent.service.js';
import * as aiCategorization from './ai-categorization.service.js';

// `categorize()` throws structured AppError on AI failure (it only
// returns null for "no description"). `batchCategorize()` returns
// per-item results instead of aborting on the first failure.

let tenantId: string;
let userId: string;
let companyId: string;
let cashAccountId: string;
let connectionId: string;

async function cleanDb() {
  await db.delete(aiUsageLog);
  await db.delete(aiJobs);
  await db.delete(bankFeedItems);
  await db.delete(bankConnections);
  await db.delete(contacts);
  await db.delete(accounts);
  await db.delete(companies);
  await db.delete(sessions);
  // ai_config references users.id via admin_disclosure_accepted_by, so
  // we must drop the config before deleting users.
  await db.delete(aiConfig);
  await db.delete(users);
  await db.delete(tenants);
}

async function makeFeedItem(description: string): Promise<string> {
  const [item] = await db.insert(bankFeedItems).values({
    tenantId,
    bankConnectionId: connectionId,
    companyId,
    providerTransactionId: `ext-${Date.now()}-${Math.random()}`,
    feedDate: '2026-05-01',
    amount: '50.00',
    description,
    status: 'pending',
  }).returning();
  return item!.id;
}

describe('ai-categorization.service', () => {
  beforeEach(async () => {
    await cleanDb();
    const reg = await authService.register({
      email: 'cat-test@example.com',
      password: 'password123',
      displayName: 'Cat Test',
      companyName: 'Cat Co',
    });
    userId = reg.user.id;
    tenantId = reg.user.tenantId;
    const company = await db.query.companies.findFirst({
      where: (c, { eq }) => eq(c.tenantId, tenantId),
    });
    companyId = company!.id;
    const cash = await accountsService.create(tenantId, { name: 'Cash', accountType: 'asset', accountNumber: '1000' });
    cashAccountId = cash.id;
    const [conn] = await db.insert(bankConnections).values({
      tenantId, companyId, accountId: cashAccountId, institutionName: 'Test Bank',
    }).returning();
    connectionId = conn!.id;
  });

  afterEach(async () => {
    await cleanDb();
    vi.restoreAllMocks();
  });

  it('throws ai_disabled_globally when AI is not enabled', async () => {
    const id = await makeFeedItem('STARBUCKS');
    await expect(aiCategorization.categorize(tenantId, id)).rejects.toMatchObject({
      statusCode: 400,
      code: 'ai_disabled_globally',
    });
  });

  it('throws ai_no_provider_configured when AI is on but no provider picked', async () => {
    await aiConsent.acceptSystemDisclosure(userId);
    await aiConfigService.updateConfig({
      isEnabled: true,
      // categorizationProvider intentionally unset
    });
    const id = await makeFeedItem('STARBUCKS');
    await expect(aiCategorization.categorize(tenantId, id)).rejects.toMatchObject({
      statusCode: 400,
      code: 'ai_no_provider_configured',
    });
  });

  it('returns null for a feed item with no description (no work to do)', async () => {
    const [item] = await db.insert(bankFeedItems).values({
      tenantId,
      bankConnectionId: connectionId,
      companyId,
      providerTransactionId: `ext-blank-${Date.now()}`,
      feedDate: '2026-05-01',
      amount: '50.00',
      description: '',
      status: 'pending',
    }).returning();
    const result = await aiCategorization.categorize(tenantId, item!.id);
    expect(result).toBeNull();
  });

  describe('batchCategorize resilience', () => {
    it('returns per-item rows when AI is disabled — no abort on first failure', async () => {
      // AI is off → every item will throw ai_disabled_globally. Without
      // Without per-item resilience the first throw would propagate
      // and we'd lose visibility into the rest.
      const ids = await Promise.all(
        Array.from({ length: 5 }, (_, i) => makeFeedItem(`merchant-${i}`)),
      );
      const results = await aiCategorization.batchCategorize(tenantId, ids);
      // The threshold is 3 consecutive same-code failures → at most
      // 3 items processed before abort; remaining are 'skipped'.
      expect(results).toHaveLength(5);
      const errored = results.filter((r) => r.error);
      const skipped = results.filter((r) => r.skipped);
      expect(errored.length).toBeGreaterThanOrEqual(3);
      expect(errored[0]!.error!.code).toBe('ai_disabled_globally');
      // Once the consecutive-fail threshold trips, the rest get the
      // 'skipped' tag so the UI can render them distinctly.
      expect(skipped.length + errored.length).toBe(5);
    });
  });
});
