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
  tenants, users, sessions, companies, accounts, auditLog, aiConfig,
  bankConnections, bankFeedItems, transactionClassificationState,
} from '../db/schema/index.js';
import * as authService from './auth.service.js';
import * as aiConfigService from './ai-config.service.js';
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
  await db.delete(aiConfig);
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

  it('FIX 3: short-circuits ONLY on a genuine provider outage, after 5 consecutive outages', async () => {
    // ai_all_providers_failed = every provider in the chain is down. That's an
    // infrastructure outage, so it accumulates toward the run-abandon.
    catMock.categorize.mockRejectedValue(
      AppError.badRequest('Every provider failed', 'ai_all_providers_failed'),
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const items = await insertItems(7);

    const agg = await bankFeedService.runCleansingPipeline(tenantId, items);

    // First 5 hit the LLM (threshold), the remaining 2 skip.
    expect(catMock.categorize).toHaveBeenCalledTimes(5);
    expect(agg.aiFailed).toBe(7);
  });

  it('FIX 3: a per-row parse failure NEVER trips the outage short-circuit (every row still tried)', async () => {
    // ai_parse_failed = a reachable model returned a bad-shape reply. It's
    // item-specific, so it must not abandon the rest of the run — even for
    // many consecutive rows.
    catMock.categorize.mockRejectedValue(
      AppError.badRequest('AI returned non-JSON (ollama / m). bad', 'ai_parse_failed'),
    );
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const items = await insertItems(7);

    const agg = await bankFeedService.runCleansingPipeline(tenantId, items);

    // All 7 attempted despite 7 consecutive parse failures — no short-circuit.
    expect(catMock.categorize).toHaveBeenCalledTimes(7);
    expect(agg.aiFailed).toBe(7);
  });

  it('FIX 3: an outage streak below the threshold, broken by a success, resets the counter', async () => {
    let call = 0;
    catMock.categorize.mockImplementation(() => {
      call++;
      // outage, outage, succeed, outage, outage → never 5 consecutive.
      if (call === 3) return Promise.resolve({ contactName: 'Vendor', contactId: '11111111-1111-1111-1111-111111111111' });
      return Promise.reject(AppError.badRequest('down', 'ai_all_providers_failed'));
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const items = await insertItems(5);

    const agg = await bankFeedService.runCleansingPipeline(tenantId, items);

    expect(catMock.categorize).toHaveBeenCalledTimes(5);
    expect(agg.aiFailed).toBe(4);
    expect(agg.aiCleansed).toBe(1);
  });

  it('FIX 3: consent-off (ai_consent_blocked) is a CLEAN full-run skip (disabled), not a failure', async () => {
    catMock.categorize.mockRejectedValue(
      AppError.badRequest('This company has not opted in to AI processing.', 'ai_consent_blocked'),
    );
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const items = await insertItems(4);

    const agg = await bankFeedService.runCleansingPipeline(tenantId, items);

    expect(agg).toMatchObject({ processed: 4, disabled: 4, aiFailed: 0, aiCleansed: 0 });
    expect(agg.firstError).toBeUndefined();
    // Only the first item probes; the deliberate consent state persists.
    expect(catMock.categorize).toHaveBeenCalledTimes(1);
    // Not an outage — no warning noise.
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('[cleanse]'))).toBe(false);
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

  it('M1: skips the per-row LLM step entirely when autoCategorizeOnImport is off, but still cleans deterministically', async () => {
    // Turn off the master "Auto-categorize on import" switch.
    await aiConfigService.updateConfig({ autoCategorizeOnImport: false });
    // If the gate leaks, this would resolve and be counted as aiCleansed.
    catMock.categorize.mockResolvedValue({ contactName: 'Should Not Be Used', contactId: null });
    const items = await insertItems(3);

    const agg = await bankFeedService.runCleansingPipeline(tenantId, items);

    // LLM never invoked; every row bucketed as `disabled` (deliberate off state).
    expect(catMock.categorize).not.toHaveBeenCalled();
    expect(agg).toMatchObject({ processed: 3, disabled: 3, aiCleansed: 0, aiFailed: 0 });
    // Deterministic (regex) cleaning still ran → each row keeps a description.
    const stored = await db.query.bankFeedItems.findFirst({ where: eq(bankFeedItems.id, items[0]!.id) });
    expect(stored!.description).toBeTruthy();
  });

  it('M1: still runs the LLM step when autoCategorizeOnImport is on (default)', async () => {
    await aiConfigService.updateConfig({ autoCategorizeOnImport: true });
    catMock.categorize.mockResolvedValue({ contactName: 'Clean Vendor', contactId: '11111111-1111-1111-1111-111111111111' });
    const items = await insertItems(2);

    const agg = await bankFeedService.runCleansingPipeline(tenantId, items);

    expect(catMock.categorize).toHaveBeenCalledTimes(2);
    expect(agg.aiCleansed).toBe(2);
    expect(agg.disabled).toBe(0);
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
