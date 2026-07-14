// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Coverage for the bank-feed cleansing pipeline after batching:
//   - aggregate accounting (processed / aiCleansed / aiFailed / disabled)
//   - the LLM step now runs ONCE per company-chunked batch (not once per row)
//   - validated vs. unvalidated name handling is preserved
//   - disabled/consent codes bucket as `disabled` (silent), errors as
//     `aiFailed`, and the batch's own outage short-circuit surfaces as
//     `skipped` (counted as aiFailed by the pipeline).
//
// The batched engine (categorizeFeedItemsBatch) and rules/history precedence
// (resolvePreAiLayers) are mocked here so these tests exercise ONLY the
// pipeline's bucketing/apply logic; the real engine is covered in
// ai-categorization.service.test.ts.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, sessions, companies, accounts, auditLog, aiConfig,
  bankConnections, bankFeedItems, transactionClassificationState,
} from '../db/schema/index.js';
import * as authService from './auth.service.js';
import * as aiConfigService from './ai-config.service.js';

const catMock = vi.hoisted(() => ({
  resolvePreAiLayers: vi.fn(),
  categorizeFeedItemsBatch: vi.fn(),
}));

// runCleansingPipeline dynamically imports these from ai-categorization —
// vitest's module registry intercepts dynamic imports too.
vi.mock('./ai-categorization.service.js', () => ({
  resolvePreAiLayers: (...args: unknown[]) => catMock.resolvePreAiLayers(...args),
  categorizeFeedItemsBatch: (...args: unknown[]) => catMock.categorizeFeedItemsBatch(...args),
}));

import * as bankFeedService from './bank-feed.service.js';

let tenantId: string;
let connectionId: string;

// Build the per-item result Map the batched engine returns, keyed by the ids
// the pipeline passes in, using a single template result for every item.
type ItemResult = {
  outcome?: { status: string; contactName: string | null; contactId: string | null };
  error?: { code: string; message: string; outage: boolean };
  skipped?: boolean;
};
function mapResult(result: ItemResult) {
  return async (_tenantId: string, ids: string[]) => new Map(ids.map((id) => [id, result]));
}

// Tenant-SCOPED cleanup — unscoped deletes nuke concurrently-running
// suites' data and die on their FKs. Only ever touch our own tenant.
async function cleanDb() {
  // global table — no tenant column; suites share it by design (and the
  // M1 tests here rely on it being reset between tests).
  await db.delete(aiConfig);
  if (!tenantId) return;
  await db.delete(transactionClassificationState).where(eq(transactionClassificationState.tenantId, tenantId));
  await db.delete(bankFeedItems).where(eq(bankFeedItems.tenantId, tenantId));
  await db.delete(bankConnections).where(eq(bankConnections.tenantId, tenantId));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  // sessions has no tenant_id — scope through this tenant's users.
  await db.delete(sessions).where(
    inArray(sessions.userId, db.select({ id: users.id }).from(users).where(eq(users.tenantId, tenantId))),
  );
  await db.delete(users).where(eq(users.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  tenantId = '';
}

async function setup() {
  const { user } = await authService.register({
    email: `cleanse-${Date.now()}@example.com`,
    password: 'password123',
    displayName: 'Cleanse Test User',
    companyName: 'Cleanse Test Co',
  });
  tenantId = user.tenantId;
  const bankAccount = await db.query.accounts.findFirst({
    where: eq(accounts.tenantId, tenantId),
  });
  const [conn] = await db.insert(bankConnections).values({
    tenantId,
    accountId: bankAccount!.id,
    provider: 'manual',
    institutionName: 'Test Bank',
  }).returning();
  connectionId = conn!.id;
}

async function insertItems(count: number): Promise<Array<typeof bankFeedItems.$inferSelect>> {
  const rows: Array<typeof bankFeedItems.$inferInsert> = [];
  for (let i = 0; i < count; i++) {
    rows.push({
      tenantId,
      bankConnectionId: connectionId,
      feedDate: '2026-06-01',
      // Deliberately nonsense so no tenant/global bank rule can claim the
      // clean name before the AI step (the behavior under test).
      description: `ZZQX RAW FEED 00${i} XKCD VENDOR ${i}`,
      originalDescription: `ZZQX RAW FEED 00${i} XKCD VENDOR ${i}`,
      amount: '10.0000',
      status: 'pending',
    });
  }
  return db.insert(bankFeedItems).values(rows).returning();
}

describe('runCleansingPipeline — aggregate accounting (batched)', () => {
  beforeEach(async () => {
    await cleanDb();
    catMock.resolvePreAiLayers.mockReset().mockResolvedValue(null); // no rule/history hit
    catMock.categorizeFeedItemsBatch.mockReset();
    await setup();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanDb();
  });

  it('runs the LLM step ONCE per batch (not once per row) and passes every candidate id', async () => {
    catMock.categorizeFeedItemsBatch.mockImplementation(
      mapResult({ outcome: { status: 'suggested', contactName: 'Clean Vendor Inc', contactId: '11111111-1111-1111-1111-111111111111' } }),
    );
    const items = await insertItems(6);

    await bankFeedService.runCleansingPipeline(tenantId, items);

    // The whole batch is ONE call to the engine, regardless of row count.
    expect(catMock.categorizeFeedItemsBatch).toHaveBeenCalledTimes(1);
    const passedIds = catMock.categorizeFeedItemsBatch.mock.calls[0]![1] as string[];
    expect([...passedIds].sort()).toEqual(items.map((i) => i.id).sort());
  });

  it('counts AI-cleansed items and rewrites their description (validated contact → verbatim)', async () => {
    catMock.categorizeFeedItemsBatch.mockImplementation(
      mapResult({ outcome: { status: 'suggested', contactName: 'Clean Vendor Inc', contactId: '11111111-1111-1111-1111-111111111111' } }),
    );
    const items = await insertItems(2);

    const agg = await bankFeedService.runCleansingPipeline(tenantId, items);

    expect(agg).toMatchObject({ processed: 2, aiCleansed: 2, aiFailed: 0, disabled: 0 });
    expect(agg.firstError).toBeUndefined();
    const stored = await db.query.bankFeedItems.findFirst({ where: eq(bankFeedItems.id, items[0]!.id) });
    expect(stored!.description).toBe('Clean Vendor Inc');
  });

  it('UNVALIDATED raw model text is normalized through the regex cleaner, never written verbatim', async () => {
    catMock.categorizeFeedItemsBatch.mockImplementation(
      mapResult({ outcome: { status: 'suggested', contactName: 'Clean Vendor Inc', contactId: null } }),
    );
    const items = await insertItems(1);

    const agg = await bankFeedService.runCleansingPipeline(tenantId, items);

    expect(agg).toMatchObject({ processed: 1, aiFailed: 0, disabled: 0 });
    const stored = await db.query.bankFeedItems.findFirst({ where: eq(bankFeedItems.id, items[0]!.id) });
    // cleanBankDescription('Clean Vendor Inc') strips the corporate suffix.
    expect(stored!.description).toBe('Clean Vendor');
    expect(stored!.originalDescription).toBe(items[0]!.originalDescription);
  });

  it('junk raw model text (no letters) falls back to the regex-cleaned original', async () => {
    catMock.categorizeFeedItemsBatch.mockImplementation(
      mapResult({ outcome: { status: 'suggested', contactName: '###   ', contactId: null } }),
    );
    const items = await insertItems(1);

    const agg = await bankFeedService.runCleansingPipeline(tenantId, items);

    expect(agg.aiFailed).toBe(0);
    const stored = await db.query.bankFeedItems.findFirst({ where: eq(bankFeedItems.id, items[0]!.id) });
    expect(stored!.description).not.toContain('#');
  });

  it('counts AI failures, captures firstError, logs a warning, and still imports with regex cleaning', async () => {
    catMock.categorizeFeedItemsBatch.mockImplementation(
      mapResult({ error: { code: 'ai_provider_failed', message: 'provider exploded', outage: true } }),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const items = await insertItems(2);

    const agg = await bankFeedService.runCleansingPipeline(tenantId, items);

    expect(agg).toMatchObject({ processed: 2, aiFailed: 2, aiCleansed: 0, disabled: 0 });
    expect(agg.firstError).toBe('provider exploded');
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('[cleanse] AI step failed for item'))).toBe(true);
    const stored = await db.query.bankFeedItems.findFirst({ where: eq(bankFeedItems.id, items[0]!.id) });
    expect(stored!.description).toBeTruthy();
  });

  it('a per-item parse failure counts as aiFailed (item-specific, not disabled)', async () => {
    catMock.categorizeFeedItemsBatch.mockImplementation(
      mapResult({ error: { code: 'ai_parse_failed', message: 'AI returned non-JSON', outage: false } }),
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const items = await insertItems(3);

    const agg = await bankFeedService.runCleansingPipeline(tenantId, items);

    expect(agg).toMatchObject({ processed: 3, aiFailed: 3, disabled: 0 });
  });

  it('items the batch abandoned via its outage short-circuit (skipped) count as aiFailed', async () => {
    catMock.categorizeFeedItemsBatch.mockImplementation(mapResult({ skipped: true }));
    const items = await insertItems(3);

    const agg = await bankFeedService.runCleansingPipeline(tenantId, items);

    expect(agg).toMatchObject({ processed: 3, aiFailed: 3, aiCleansed: 0, disabled: 0 });
  });

  it('consent-off (ai_consent_blocked) is a CLEAN skip (disabled), not a failure', async () => {
    catMock.categorizeFeedItemsBatch.mockImplementation(
      mapResult({ error: { code: 'ai_consent_blocked', message: 'This company has not opted in.', outage: false } }),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const items = await insertItems(4);

    const agg = await bankFeedService.runCleansingPipeline(tenantId, items);

    expect(agg).toMatchObject({ processed: 4, disabled: 4, aiFailed: 0, aiCleansed: 0 });
    expect(agg.firstError).toBeUndefined();
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('[cleanse]'))).toBe(false);
  });

  it('function-disabled and globally-disabled codes bucket as `disabled` (silent)', async () => {
    for (const code of ['ai_function_disabled', 'ai_disabled_globally', 'ai_no_provider_configured']) {
      catMock.categorizeFeedItemsBatch.mockImplementation(
        mapResult({ error: { code, message: code, outage: false } }),
      );
      const items = await insertItems(3);
      const agg = await bankFeedService.runCleansingPipeline(tenantId, items);
      expect(agg.disabled).toBe(3);
      expect(agg.aiFailed).toBe(0);
      await db.delete(bankFeedItems).where(eq(bankFeedItems.tenantId, tenantId));
    }
  });

  it('M1: skips the LLM step entirely when autoCategorizeOnImport is off, but still cleans deterministically', async () => {
    await aiConfigService.updateConfig({ autoCategorizeOnImport: false });
    const items = await insertItems(3);

    const agg = await bankFeedService.runCleansingPipeline(tenantId, items);

    // The batched engine is never invoked; every row is bucketed as `disabled`.
    expect(catMock.categorizeFeedItemsBatch).not.toHaveBeenCalled();
    expect(agg).toMatchObject({ processed: 3, disabled: 3, aiCleansed: 0, aiFailed: 0 });
    const stored = await db.query.bankFeedItems.findFirst({ where: eq(bankFeedItems.id, items[0]!.id) });
    expect(stored!.description).toBeTruthy();
  });

  it('M1: still runs the LLM step when autoCategorizeOnImport is on (default)', async () => {
    await aiConfigService.updateConfig({ autoCategorizeOnImport: true });
    catMock.categorizeFeedItemsBatch.mockImplementation(
      mapResult({ outcome: { status: 'suggested', contactName: 'Clean Vendor', contactId: '11111111-1111-1111-1111-111111111111' } }),
    );
    const items = await insertItems(2);

    const agg = await bankFeedService.runCleansingPipeline(tenantId, items);

    expect(catMock.categorizeFeedItemsBatch).toHaveBeenCalledTimes(1);
    expect(agg.aiCleansed).toBe(2);
    expect(agg.disabled).toBe(0);
  });

  it('honors a rules/history hit (resolvePreAiLayers) and never sends those rows to the LLM', async () => {
    // resolvePreAiLayers resolves a validated contact for every item → no
    // item becomes an LLM candidate, so the batched engine is not called.
    catMock.resolvePreAiLayers.mockResolvedValue({
      status: 'suggested', accountId: 'acct', contactId: '11111111-1111-1111-1111-111111111111',
      contactName: 'History Vendor', confidence: 0.95, matchType: 'history',
    });
    const items = await insertItems(2);

    const agg = await bankFeedService.runCleansingPipeline(tenantId, items);

    expect(catMock.categorizeFeedItemsBatch).not.toHaveBeenCalled();
    expect(agg.aiCleansed).toBe(2);
    const stored = await db.query.bankFeedItems.findFirst({ where: eq(bankFeedItems.id, items[0]!.id) });
    expect(stored!.description).toBe('History Vendor');
  });
});

describe('importFromCsv — cleansing failures no longer break or silently degrade the import', () => {
  beforeEach(async () => {
    await cleanDb();
    catMock.resolvePreAiLayers.mockReset().mockResolvedValue(null);
    catMock.categorizeFeedItemsBatch.mockReset();
    await setup();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanDb();
  });

  it('imports every row with regex cleaning and reports the aggregate when the LLM fails', async () => {
    catMock.categorizeFeedItemsBatch.mockImplementation(
      mapResult({ error: { code: 'ai_provider_failed', message: 'LLM unreachable', outage: true } }),
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const csv = [
      'Date,Description,Amount',
      '2026-06-01,ZZQX CSV ROW 001 XKCD VENDOR A,12.34',
      '2026-06-02,ZZQX CSV ROW 002 XKCD VENDOR B,-56.78',
    ].join('\n');

    const result = await bankFeedService.importFromCsv(
      tenantId, connectionId, csv, { date: 0, description: 1, amount: 2 },
    );

    expect(result.items).toHaveLength(2);
    expect(result.cleansing.processed).toBe(2);
    expect(result.cleansing.aiFailed).toBe(2);
    expect(result.cleansing.firstError).toBe('LLM unreachable');
    const stored = await db.query.bankFeedItems.findMany({ where: eq(bankFeedItems.tenantId, tenantId) });
    expect(stored).toHaveLength(2);
    for (const row of stored) {
      expect(row.status).toBe('pending');
      expect(row.description).toBeTruthy();
    }
  });
});
