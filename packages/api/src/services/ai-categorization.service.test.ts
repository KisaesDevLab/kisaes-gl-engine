// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
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

// ── Mocked Ollama provider for the parse-path suite ────────────────
// The class runs the REAL extractJsonForResult over whatever raw text the
// test enqueues, so these tests exercise the genuine provider-parse →
// executeJsonWithRetry → categorize() mapping end-to-end (fences, <think>
// blocks, prose, truncation) with only the network call faked.
const parseMocks = vi.hoisted(() => ({
  // Returns the raw "model output" for each successive completion call.
  reply: vi.fn<(params: { userPrompt: string }) => { text: string; truncated?: boolean }>(),
}));

vi.mock('./ai-providers/ollama.provider.js', async () => {
  const { extractJsonForResult } = await import('./ai-providers/json-utils.js');
  return {
    OllamaProvider: class {
      name = 'ollama';
      supportsVision = true;
      private model: string;
      constructor(_baseUrl?: string, model: string = 'llama-default') { this.model = model; }
      async complete(params: { userPrompt: string; responseFormat?: 'json' | 'text' }) {
        const { text, truncated = false } = parseMocks.reply(params);
        const { parsed, parseError } = extractJsonForResult(text, params.responseFormat, { truncated });
        return {
          text, parsed, parseError, truncated,
          inputTokens: 1, outputTokens: 1, model: this.model, provider: 'ollama', durationMs: 1,
        };
      }
      async completeWithImage(): Promise<never> { throw new Error('not used in this suite'); }
      async testConnection() { return { success: true }; }
      estimateCost() { return 0; }
    },
  };
});

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

  describe('AI parse path (mocked ollama provider, real JSON extraction)', () => {
    let officeSuppliesId: string;

    // Distinctive name — register() seeds a default COA, so a common name
    // like "Office Supplies" would collide with a seeded row and the
    // name-match would resolve to that one instead.
    const GOOD_JSON =
      '{"account_name":"ZZ Parse Test Expense","vendor_name":"Staples","memo":"Office supplies","tag_name":null,"confidence":0.9}';

    beforeEach(async () => {
      parseMocks.reply.mockReset();
      // AI on, ollama-only chain (so a live cloud provider can never be
      // reached), disclosure accepted, company consent for categorization.
      await db.insert(aiConfig).values({
        isEnabled: true,
        categorizationProvider: 'ollama',
        fallbackChain: ['ollama'],
        adminDisclosureAcceptedAt: new Date(),
        adminDisclosureAcceptedBy: userId,
        taskOptions: { categorization: { fallbackChain: ['ollama'] } },
      });
      await db.update(companies).set({
        aiEnabled: true,
        aiDisclosureVersion: 1,
        aiEnabledTasks: { categorization: true },
      }).where(eq(companies.id, companyId));
      const office = await accountsService.create(tenantId, {
        name: 'ZZ Parse Test Expense', accountType: 'expense', accountNumber: '6990',
      });
      officeSuppliesId = office.id;
    });

    it('maps clean JSON to a suggestion', async () => {
      parseMocks.reply.mockReturnValue({ text: GOOD_JSON });
      const id = await makeFeedItem('STAPLES 00123');

      const result = await aiCategorization.categorize(tenantId, id);

      expect(result).toMatchObject({ accountId: officeSuppliesId, matchType: 'ai', confidence: 0.9 });
      expect(parseMocks.reply).toHaveBeenCalledTimes(1);
    });

    it('parses a ```json-fenced reply', async () => {
      parseMocks.reply.mockReturnValue({ text: '```json\n' + GOOD_JSON + '\n```' });
      const id = await makeFeedItem('STAPLES 00123');

      const result = await aiCategorization.categorize(tenantId, id);

      expect(result?.accountId).toBe(officeSuppliesId);
      expect(parseMocks.reply).toHaveBeenCalledTimes(1);
    });

    it('parses a <think>-prefixed reply from a thinking model', async () => {
      parseMocks.reply.mockReturnValue({
        text: `<think>Staples sells {office: stuff}, so Office Supplies.</think>\n${GOOD_JSON}`,
      });
      const id = await makeFeedItem('STAPLES 00123');

      const result = await aiCategorization.categorize(tenantId, id);

      expect(result?.accountId).toBe(officeSuppliesId);
    });

    it('retries once with a corrective instruction and recovers', async () => {
      parseMocks.reply
        .mockReturnValueOnce({ text: 'Sure! I would categorize this as Office Supplies.' })
        .mockReturnValueOnce({ text: GOOD_JSON });
      const id = await makeFeedItem('STAPLES 00123');

      const result = await aiCategorization.categorize(tenantId, id);

      expect(result?.accountId).toBe(officeSuppliesId);
      expect(parseMocks.reply).toHaveBeenCalledTimes(2);
      // The retry carried the corrective follow-up.
      expect(parseMocks.reply.mock.calls[1]![0].userPrompt).toContain('was not valid JSON');
      expect(parseMocks.reply.mock.calls[0]![0].userPrompt).not.toContain('was not valid JSON');
    });

    it('throws ai_parse_failed naming provider + model when both attempts are prose', async () => {
      parseMocks.reply.mockReturnValue({ text: 'I am unable to produce JSON, sorry.' });
      const id = await makeFeedItem('STAPLES 00123');

      await expect(aiCategorization.categorize(tenantId, id)).rejects.toMatchObject({
        statusCode: 400,
        code: 'ai_parse_failed',
      });
      expect(parseMocks.reply).toHaveBeenCalledTimes(2);

      // Message carries who failed + what it said (for the toast detail).
      parseMocks.reply.mockClear();
      parseMocks.reply.mockReturnValue({ text: 'still prose' });
      const id2 = await makeFeedItem('STAPLES 00456');
      const err = await aiCategorization.categorize(tenantId, id2).catch((e: Error) => e);
      expect((err as Error).message).toContain('ollama / llama-default');
      expect((err as Error).message).toContain('still prose');
    });

    it('reports truncation as "raise max tokens" and does NOT burn a retry', async () => {
      parseMocks.reply.mockReturnValue({ text: '{"account_name":"Office Sup', truncated: true });
      const id = await makeFeedItem('STAPLES 00123');

      const err = await aiCategorization.categorize(tenantId, id).catch((e: Error) => e);

      expect((err as Error & { code?: string }).code).toBe('ai_parse_failed');
      expect((err as Error).message).toMatch(/truncated at the max-token limit/);
      expect(parseMocks.reply).toHaveBeenCalledTimes(1);
    });
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
