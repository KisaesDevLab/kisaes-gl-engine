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

    it('FIX 5: a clean, confident COA match returns status "suggested"', async () => {
      parseMocks.reply.mockReturnValue({ text: GOOD_JSON });
      const id = await makeFeedItem('STAPLES 00123');

      const result = await aiCategorization.categorize(tenantId, id);

      expect(result).toMatchObject({ status: 'suggested', accountId: officeSuppliesId });
    });

    it('FIX 5: no COA match returns status "no_confident_match" (200, not an error) and persists nothing', async () => {
      // A valid-JSON reply whose account_name matches NO account in the COA →
      // an honest "reviewed, nothing confident", not a broken button.
      parseMocks.reply.mockReturnValue({
        text: '{"account_name":"Zznonexistent Ledger Account","vendor_name":"X","memo":"m","tag_name":null,"confidence":0.95}',
      });
      const id = await makeFeedItem('MYSTERY MERCHANT 001');

      const result = await aiCategorization.categorize(tenantId, id);

      expect(result).toMatchObject({ status: 'no_confident_match', accountId: null });
      const stored = await db.query.bankFeedItems.findFirst({ where: eq(bankFeedItems.id, id) });
      expect(stored!.suggestedAccountId).toBeNull();
    });
  });

  describe('FIX 4 — enumeratePendingWithoutSuggestion', () => {
    it('returns every pending-without-suggestion id, excluding suggested and non-pending rows', async () => {
      const a = await makeFeedItem('A vendor');
      const b = await makeFeedItem('B vendor');
      // Pending but already has a suggestion → excluded.
      const withSug = await makeFeedItem('C vendor');
      await db.update(bankFeedItems).set({ suggestedAccountId: cashAccountId }).where(eq(bankFeedItems.id, withSug));
      // Not pending → excluded.
      const done = await makeFeedItem('D vendor');
      await db.update(bankFeedItems).set({ status: 'categorized' }).where(eq(bankFeedItems.id, done));

      const ids = await aiCategorization.enumeratePendingWithoutSuggestion(tenantId);
      expect([...ids].sort()).toEqual([a, b].sort());
    });

    it('scopes to a bank connection when one is given', async () => {
      const a = await makeFeedItem('A vendor');
      const [conn2] = await db.insert(bankConnections).values({
        tenantId, companyId, accountId: cashAccountId, institutionName: 'Bank 2',
      }).returning();
      const [other] = await db.insert(bankFeedItems).values({
        tenantId, bankConnectionId: conn2!.id, companyId,
        providerTransactionId: `ext-other-${Date.now()}`,
        feedDate: '2026-05-01', amount: '9.00', description: 'other', status: 'pending',
      }).returning();

      const ids = await aiCategorization.enumeratePendingWithoutSuggestion(tenantId, connectionId);
      expect(ids).toContain(a);
      expect(ids).not.toContain(other!.id);
    });
  });

  describe('batchCategorize resilience', () => {
    it('returns per-item rows when AI is globally disabled — no throw, every item errored', async () => {
      // AI is off → the batch governance gate fails once and stamps every item
      // with ai_disabled_globally (a deliberate off-state, not an outage).
      const ids = await Promise.all(
        Array.from({ length: 5 }, (_, i) => makeFeedItem(`merchant-${i}`)),
      );
      const results = await aiCategorization.batchCategorize(tenantId, ids);
      expect(results).toHaveLength(5);
      const errored = results.filter((r) => r.error);
      expect(errored).toHaveLength(5);
      expect(errored.every((r) => r.error!.code === 'ai_disabled_globally')).toBe(true);
    });
  });

  // ── Batched LLM categorization (N transactions per API call) ────────
  describe('batched categorization (categorizeFeedItemsBatch)', () => {
    let officeSuppliesId: string;

    const arrayEntry = (index: number, account = 'ZZ Parse Test Expense', vendor = 'Staples', confidence = 0.9) =>
      `{"index":${index},"account_name":"${account}","vendor_name":"${vendor}","memo":"m","tag_name":null,"confidence":${confidence}}`;

    async function enableAiWithBatchSize(batchSize: number) {
      await db.insert(aiConfig).values({
        isEnabled: true,
        categorizationProvider: 'ollama',
        fallbackChain: ['ollama'],
        adminDisclosureAcceptedAt: new Date(),
        adminDisclosureAcceptedBy: userId,
        taskOptions: { categorization: { fallbackChain: ['ollama'], batchSize } },
      });
      await db.update(companies).set({
        aiEnabled: true, aiDisclosureVersion: 1, aiEnabledTasks: { categorization: true },
      }).where(eq(companies.id, companyId));
      const office = await accountsService.create(tenantId, {
        name: 'ZZ Parse Test Expense', accountType: 'expense', accountNumber: '6990',
      });
      officeSuppliesId = office.id;
    }

    beforeEach(() => {
      parseMocks.reply.mockReset();
    });

    it('sends N=3 transactions in ONE provider call and maps every result by index', async () => {
      await enableAiWithBatchSize(15);
      parseMocks.reply.mockReturnValue({
        text: `[${arrayEntry(0)},${arrayEntry(1)},${arrayEntry(2)}]`,
      });
      const ids = await Promise.all([
        makeFeedItem('STAPLES 001'), makeFeedItem('STAPLES 002'), makeFeedItem('STAPLES 003'),
      ]);

      const results = await aiCategorization.categorizeFeedItemsBatch(tenantId, ids);

      // ONE provider call for the whole batch (the headline assertion).
      expect(parseMocks.reply).toHaveBeenCalledTimes(1);
      // ONE ai_usage_log row for the batch call.
      const usage = await db.select().from(aiUsageLog);
      expect(usage).toHaveLength(1);
      // All three mapped + persisted to the same COA account.
      for (const id of ids) {
        expect(results.get(id)?.outcome?.accountId).toBe(officeSuppliesId);
        const stored = await db.query.bankFeedItems.findFirst({ where: eq(bankFeedItems.id, id) });
        expect(stored!.suggestedAccountId).toBe(officeSuppliesId);
      }
    });

    it('does not persist a hallucinated account name (name validation still applies)', async () => {
      await enableAiWithBatchSize(15);
      parseMocks.reply.mockReturnValue({
        // index 0 real account, index 1 hallucinated (no COA match).
        text: `[${arrayEntry(0)},{"index":1,"account_name":"Zznonexistent Ledger","vendor_name":"X","memo":"m","tag_name":null,"confidence":0.99}]`,
      });
      const [good, bad] = await Promise.all([makeFeedItem('STAPLES 001'), makeFeedItem('MYSTERY 002')]);

      const results = await aiCategorization.categorizeFeedItemsBatch(tenantId, [good!, bad!]);

      expect(results.get(good!)?.outcome?.accountId).toBe(officeSuppliesId);
      expect(results.get(bad!)?.outcome?.status).toBe('no_confident_match');
      expect(results.get(bad!)?.outcome?.accountId).toBeNull();
      const storedBad = await db.query.bankFeedItems.findFirst({ where: eq(bankFeedItems.id, bad!) });
      expect(storedBad!.suggestedAccountId).toBeNull();
    });

    it('a short array applies the entries it has, leaves missing indexes pending + counted, and later batches still run', async () => {
      // batchSize 2 → two batches over three items. First batch returns only
      // index 0 (index 1 dropped); second batch is valid.
      await enableAiWithBatchSize(2);
      parseMocks.reply
        .mockReturnValueOnce({ text: `[${arrayEntry(0)}]` })       // batch 1: index 1 missing
        .mockReturnValueOnce({ text: `[${arrayEntry(0)}]` });      // batch 2 (single item at its index 0)
      const ids = await Promise.all([
        makeFeedItem('STAPLES 001'), makeFeedItem('STAPLES 002'), makeFeedItem('STAPLES 003'),
      ]);

      const results = await aiCategorization.categorizeFeedItemsBatch(tenantId, ids);

      // Two provider calls (one per batch) — the second batch was NOT abandoned.
      expect(parseMocks.reply).toHaveBeenCalledTimes(2);
      // Batch 1 index 0 applied; index 1 left pending + counted as a per-index miss.
      expect(results.get(ids[0]!)?.outcome?.accountId).toBe(officeSuppliesId);
      expect(results.get(ids[1]!)?.error?.code).toBe('ai_no_result_for_index');
      const storedMissing = await db.query.bankFeedItems.findFirst({ where: eq(bankFeedItems.id, ids[1]!) });
      expect(storedMissing!.suggestedAccountId).toBeNull();
      // Batch 2 (third item) still ran and mapped.
      expect(results.get(ids[2]!)?.outcome?.accountId).toBe(officeSuppliesId);
    });

    it('a whole-batch parse failure leaves items pending but does not abandon the next batch', async () => {
      await enableAiWithBatchSize(2);
      parseMocks.reply
        .mockReturnValueOnce({ text: 'I could not produce JSON, sorry.' }) // batch 1: unparseable (twice via retry)
        .mockReturnValueOnce({ text: 'still prose' })
        .mockReturnValueOnce({ text: `[${arrayEntry(0)}]` });               // batch 2: valid
      const ids = await Promise.all([
        makeFeedItem('STAPLES 001'), makeFeedItem('STAPLES 002'), makeFeedItem('STAPLES 003'),
      ]);

      const results = await aiCategorization.categorizeFeedItemsBatch(tenantId, ids);

      expect(results.get(ids[0]!)?.error?.code).toBe('ai_parse_failed');
      expect(results.get(ids[1]!)?.error?.code).toBe('ai_parse_failed');
      // Next batch still processed.
      expect(results.get(ids[2]!)?.outcome?.accountId).toBe(officeSuppliesId);
    });

    it('batchSize=1 falls back to the single-transaction path (one call per item)', async () => {
      await enableAiWithBatchSize(1);
      parseMocks.reply.mockReturnValue({ text: arrayEntry(0).replace('"index":0,', '') });
      const ids = await Promise.all([makeFeedItem('STAPLES 001'), makeFeedItem('STAPLES 002')]);

      const results = await aiCategorization.categorizeFeedItemsBatch(tenantId, ids);

      // One provider call PER item (the single path), not one for the pair.
      expect(parseMocks.reply).toHaveBeenCalledTimes(2);
      expect(results.get(ids[0]!)?.outcome?.accountId).toBe(officeSuppliesId);
      expect(results.get(ids[1]!)?.outcome?.accountId).toBe(officeSuppliesId);
    });

    it('abandons the run after consecutive OUTAGE batches (short-circuit at batch granularity)', async () => {
      // batchSize 2 over 12 same-company items → 6 batches. Every provider
      // call throws (infra outage → ai_all_providers_failed). After 5
      // consecutive outage batches the 6th is skipped, not attempted.
      await enableAiWithBatchSize(2);
      parseMocks.reply.mockImplementation(() => { throw new Error('connection refused'); });
      const ids: string[] = [];
      for (let i = 0; i < 12; i++) ids.push(await makeFeedItem(`OUTAGE ${i}`));

      const results = await aiCategorization.categorizeFeedItemsBatch(tenantId, ids);

      const outaged = ids.filter((id) => results.get(id)?.error?.outage);
      const skipped = ids.filter((id) => results.get(id)?.skipped);
      expect(outaged).toHaveLength(10); // 5 batches × 2 items attempted
      expect(skipped).toHaveLength(2);  // 6th batch abandoned
    });

    it('chunks by company: an un-consented company is blocked while the consented one succeeds', async () => {
      await enableAiWithBatchSize(15);
      // Second company WITHOUT AI opt-in → its batch fails company-scoped consent.
      const [company2] = await db.insert(companies).values({
        tenantId, businessName: 'No-Consent Co',
      }).returning();
      const [conn2] = await db.insert(bankConnections).values({
        tenantId, companyId: company2!.id, accountId: cashAccountId, institutionName: 'Bank 2',
      }).returning();
      const makeItemFor = async (companyIdArg: string, connId: string, desc: string) => {
        const [item] = await db.insert(bankFeedItems).values({
          tenantId, bankConnectionId: connId, companyId: companyIdArg,
          providerTransactionId: `ext-${Date.now()}-${Math.random()}`,
          feedDate: '2026-05-01', amount: '50.00', description: desc, status: 'pending',
        }).returning();
        return item!.id;
      };
      const c1Item = await makeItemFor(companyId, connectionId, 'STAPLES C1');
      const c2Item = await makeItemFor(company2!.id, conn2!.id, 'STAPLES C2');
      parseMocks.reply.mockReturnValue({ text: `[${arrayEntry(0)}]` });

      const results = await aiCategorization.categorizeFeedItemsBatch(tenantId, [c1Item, c2Item]);

      // Only the consented company's batch reached the provider.
      expect(parseMocks.reply).toHaveBeenCalledTimes(1);
      expect(results.get(c1Item)?.outcome?.accountId).toBe(officeSuppliesId);
      expect(results.get(c2Item)?.error?.code).toBe('ai_consent_blocked');
    });
  });
});
