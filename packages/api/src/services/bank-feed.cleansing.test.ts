// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// First-ever coverage for the bank-feed cleansing pipeline:
//   - aggregate accounting (processed / aiCleansed / aiFailed / disabled)
//   - the 3-consecutive-failures short-circuit (mirrors
//     CONSECUTIVE_FAIL_THRESHOLD in ai-categorization.service.ts)
//   - disabled-function codes skip silently as `disabled`, not `aiFailed`
//   - an AI outage no longer disappears into a bare catch — items still
//     import with deterministic (regex) cleaning and the aggregate says so.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, sessions, companies, accounts, auditLog,
  bankConnections, bankFeedItems, transactionClassificationState,
} from '../db/schema/index.js';
import * as authService from './auth.service.js';
import { AppError } from '../utils/errors.js';

const catMock = vi.hoisted(() => ({ categorize: vi.fn() }));

// runCleansingPipeline dynamically imports categorize() for its AI step —
// vitest's module registry intercepts dynamic imports too.
vi.mock('./ai-categorization.service.js', () => ({
  categorize: (...args: unknown[]) => catMock.categorize(...args),
}));

import * as bankFeedService from './bank-feed.service.js';

let tenantId: string;
let connectionId: string;

async function cleanDb() {
  await db.delete(transactionClassificationState);
  await db.delete(bankFeedItems);
  await db.delete(bankConnections);
  await db.delete(auditLog);
  await db.delete(accounts);
  await db.delete(companies);
  await db.delete(sessions);
  await db.delete(users);
  await db.delete(tenants);
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

describe('runCleansingPipeline — aggregate accounting', () => {
  beforeEach(async () => {
    await cleanDb();
    catMock.categorize.mockReset();
    await setup();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanDb();
  });

  it('counts AI-cleansed items and rewrites their description (validated contact → verbatim)', async () => {
    // H3 VALIDATED path: categorize() resolved the name to a real tenant
    // contact (contactId present), so its display name is trusted as-is.
    catMock.categorize.mockResolvedValue({
      contactName: 'Clean Vendor Inc',
      contactId: '11111111-1111-1111-1111-111111111111',
    });
    const items = await insertItems(2);

    const agg = await bankFeedService.runCleansingPipeline(tenantId, items);

    expect(agg).toMatchObject({ processed: 2, aiCleansed: 2, aiFailed: 0, disabled: 0 });
    expect(agg.firstError).toBeUndefined();
    const stored = await db.query.bankFeedItems.findFirst({ where: eq(bankFeedItems.id, items[0]!.id) });
    expect(stored!.description).toBe('Clean Vendor Inc');
  });

  it('H3: UNVALIDATED raw model text is normalized through the regex cleaner, never written verbatim', async () => {
    // No contactId → the name is raw model output. It must be run through
    // the same deterministic cleaner as the regex fallback (which strips
    // corporate suffixes like "Inc"), never written into `description`
    // verbatim, and never junkier than the regex path.
    catMock.categorize.mockResolvedValue({ contactName: 'Clean Vendor Inc' });
    const items = await insertItems(1);

    const agg = await bankFeedService.runCleansingPipeline(tenantId, items);

    expect(agg).toMatchObject({ processed: 1, aiFailed: 0, disabled: 0 });
    const stored = await db.query.bankFeedItems.findFirst({ where: eq(bankFeedItems.id, items[0]!.id) });
    // cleanBankDescription('Clean Vendor Inc') strips the corporate suffix.
    expect(stored!.description).toBe('Clean Vendor');
    // originalDescription is never touched by cleansing.
    expect(stored!.originalDescription).toBe(items[0]!.originalDescription);
  });

  it('H3: junk raw model text (no letters) falls back to the regex-cleaned original, not the model text', async () => {
    // A garbage model "name" must not overwrite the description — the code
    // keeps the regex-cleaned original instead.
    catMock.categorize.mockResolvedValue({ contactName: '###   ' });
    const items = await insertItems(1);

    const agg = await bankFeedService.runCleansingPipeline(tenantId, items);

    expect(agg.aiFailed).toBe(0);
    const stored = await db.query.bankFeedItems.findFirst({ where: eq(bankFeedItems.id, items[0]!.id) });
    expect(stored!.description).not.toContain('#');
  });

  it('counts AI failures, captures firstError, logs a warning, and still imports with regex cleaning', async () => {
    catMock.categorize.mockRejectedValue(new Error('provider exploded'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const items = await insertItems(2);

    const agg = await bankFeedService.runCleansingPipeline(tenantId, items);

    expect(agg).toMatchObject({ processed: 2, aiFailed: 2, aiCleansed: 0, disabled: 0 });
    expect(agg.firstError).toBe('provider exploded');
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('[cleanse] AI step failed for item'))).toBe(true);
    // Deterministic cleaning still ran — the item keeps a usable description.
    const stored = await db.query.bankFeedItems.findFirst({ where: eq(bankFeedItems.id, items[0]!.id) });
    expect(stored!.description).toBeTruthy();
  });

  it('short-circuits the AI step after 3 consecutive failures (skips counted as aiFailed)', async () => {
    catMock.categorize.mockRejectedValue(new Error('dead provider'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const items = await insertItems(5);

    const agg = await bankFeedService.runCleansingPipeline(tenantId, items);

    // Only the first 3 items actually hit the LLM; the remaining 2 skip.
    expect(catMock.categorize).toHaveBeenCalledTimes(3);
    expect(agg.aiFailed).toBe(5);
  });

  it('a success resets the consecutive-failure counter', async () => {
    let call = 0;
    catMock.categorize.mockImplementation(() => {
      call++;
      // fail, fail, succeed, fail, fail → never 3 consecutive.
      if (call === 3) return Promise.resolve({ contactName: 'Vendor' });
      return Promise.reject(new Error('flaky'));
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const items = await insertItems(5);

    const agg = await bankFeedService.runCleansingPipeline(tenantId, items);

    expect(catMock.categorize).toHaveBeenCalledTimes(5);
    expect(agg.aiFailed).toBe(4);
    expect(agg.aiCleansed).toBe(1);
  });

  it('counts disabled-function skips as `disabled` (silent) and stops calling the LLM', async () => {
    catMock.categorize.mockRejectedValue(
      AppError.badRequest('This AI function is disabled in Admin → AI', 'ai_function_disabled'),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const items = await insertItems(4);

    const agg = await bankFeedService.runCleansingPipeline(tenantId, items);

    expect(agg).toMatchObject({ processed: 4, disabled: 4, aiFailed: 0, aiCleansed: 0 });
    expect(agg.firstError).toBeUndefined();
    // Only the first item probes; the deliberate-disabled state persists.
    expect(catMock.categorize).toHaveBeenCalledTimes(1);
    // Disabled is an admin state, not an outage — no warning noise.
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('[cleanse]'))).toBe(false);
  });

  it('treats ai_disabled_globally / ai_no_provider_configured the same way (non-AI installs stay quiet)', async () => {
    catMock.categorize.mockRejectedValue(
      AppError.badRequest('AI processing is not enabled.', 'ai_disabled_globally'),
    );
    const items = await insertItems(3);

    const agg = await bankFeedService.runCleansingPipeline(tenantId, items);

    expect(agg.disabled).toBe(3);
    expect(agg.aiFailed).toBe(0);
  });
});

describe('importFromCsv — cleansing failures no longer break or silently degrade the import', () => {
  beforeEach(async () => {
    await cleanDb();
    catMock.categorize.mockReset();
    await setup();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanDb();
  });

  it('imports every row with regex cleaning and reports the aggregate when the LLM throws', async () => {
    catMock.categorize.mockRejectedValue(new Error('LLM unreachable'));
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
    // Rows really landed, pending, with a description.
    const stored = await db.query.bankFeedItems.findMany({ where: eq(bankFeedItems.tenantId, tenantId) });
    expect(stored).toHaveLength(2);
    for (const row of stored) {
      expect(row.status).toBe('pending');
      expect(row.description).toBeTruthy();
    }
  });
});
