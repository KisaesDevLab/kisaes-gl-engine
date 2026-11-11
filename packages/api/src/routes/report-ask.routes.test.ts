// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.
//
// Ask a question (U-206, reports-ask-v1; ClientLedger P28 PR-G), with a
// stubbed model:
//   - the mapping holds only sent tokens, ISO dates and engine-resolved ids:
//     no number the engine did not produce, no model free text;
//   - an unknown or invented report key, preset, column, extra or name, an
//     option the report does not take, an amount filter, a JSON number or an
//     id from the model is 422 ASK_UNMAPPED;
//   - consent off (AI off, no opt-in, report_summary off) is 403
//     AI_CONSENT_REQUIRED with no provider call and no ai_jobs row;
//   - a provider error or offline is 503 AI_UNAVAILABLE;
//   - the prompt carries names, never a balance, an amount or a memo; the
//     question and names stay out of ai_jobs and the console;
//   - names resolve in the request's company only.

import 'express-async-errors';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';

const m = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('../services/ai-providers/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/ai-providers/index.js')>()),
  executeWithFallback: (...a: unknown[]) => m.execute(...a),
}));

import { db } from '../db/index.js';
import { accounts, aiConfig, aiJobs, aiUsageLog, companies, contacts, journalLines, tags, transactions } from '../db/schema/index.js';
import { reportAskRouter } from './report-ask.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import * as aiConfigService from '../services/ai-config.service.js';
import * as aiConsent from '../services/ai-consent.service.js';
import { validateMapping, questionWords, isIsoDate, type AskRequest, type NameResolver } from '../services/report-ask.service.js';
import { OfflineUnavailableError } from '../utils/offline.js';
import { makeCompany, cleanTenant, type Co } from '../services/templates/templates.test-helpers.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';

let server: Server | null = null;
let port = 0;
const tenantIds: string[] = [];
let c: Co;
let rentId = '';
let otherCoContact = '';
let txnId = '';

interface Res { status: number; json: ReturnType<typeof JSON.parse> }

function post(body: unknown, opts: { co?: string; token?: string } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({
      hostname: '127.0.0.1', port, path: '/api/v1/reports/ask', method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'Content-Length': String(data.length),
        Authorization: `Bearer ${opts.token ?? c.token}`, 'X-Company-Id': opts.co ?? c.companyId,
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (x) => chunks.push(x));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: res.statusCode ?? 0, json: raw ? JSON.parse(raw) : null }); } catch { resolve({ status: res.statusCode ?? 0, json: raw }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

const CATALOG: AskRequest['reports'] = [
  { key: 'profit_and_loss', title: 'Profit and Loss', description: 'Income and expenses for a period',
    params: ['range', 'basis', 'accounts', 'contacts', 'tags'], columns: ['total', 'month', 'by_contact'], extras: ['pct_of_income', 'ytd'] },
  { key: 'balance_sheet', title: 'Balance Sheet', params: ['as_of', 'basis'], columns: ['total'], extras: [] },
  { key: 'ar_aging_summary', title: 'A/R Aging Summary', params: ['as_of', 'contacts'] },
  { key: 'last_12_months_sales', title: 'Sales, last 12 months', params: [] },
];
const PRESETS = ['this_month', 'last_quarter', 'this_year', 'last_12_months'];
const QUESTION = 'What did we spend on rent for Rivera Remodel last quarter, cash basis, only bills over $500? Call me at 555-123-4567.';
const request = (over: Partial<AskRequest> = {}): AskRequest => ({ question: QUESTION, reports: CATALOG, datePresets: PRESETS, today: '2026-11-10', ...over });

const reply = (parsed: unknown, extra: Record<string, unknown> = {}) => ({
  text: JSON.stringify(parsed), parsed, inputTokens: 300, outputTokens: 40, model: 'claude-test', provider: 'anthropic', durationMs: 5, ...extra,
});

const GOOD = {
  reportKey: 'profit_and_loss', datePreset: 'last_quarter', from: null, to: null, asOf: null, basis: 'cash', columns: 'month',
  extras: ['pct_of_income'], filters: { accountNames: ['Rent Kumquat Hall'], contactNames: ['rivera remodel'], tagNames: [] },
  // Free text: dropped unread.
  explanation: 'Rent was about $1,234.56 last quarter.',
};

async function enableAi(tasks: Record<string, boolean> = { report_summary: true }) {
  await aiConsent.acceptSystemDisclosure(c.userId);
  await aiConfigService.updateConfig({ isEnabled: true, chatProvider: 'anthropic', chatModel: 'claude-test', anthropicApiKey: 'sk-test-fake-key' });
  const cfg = await aiConfigService.getRawConfig();
  await db.update(companies).set({
    aiEnabled: true, aiDisclosureAcceptedAt: new Date(), aiDisclosureAcceptedBy: c.userId,
    aiDisclosureVersion: cfg.disclosureVersion ?? 1, aiEnabledTasks: tasks,
  }).where(eq(companies.id, c.companyId));
}

async function jobs() {
  return db.select().from(aiJobs).where(eq(aiJobs.tenantId, c.tenantId));
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/reports', reportAskRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); }); });
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
});

beforeEach(async () => {
  await db.delete(aiConfig);
  c = await makeCompany('ask', tenantIds);
  // A distinctive balance, amount and memo: none may reach the model.
  const [rent] = await db.insert(accounts).values({
    tenantId: c.tenantId, companyId: c.companyId, name: 'Rent Kumquat Hall', accountNumber: '6100', accountType: 'expense', balance: '98765.4321',
  }).returning();
  rentId = rent!.id;
  await db.insert(contacts).values({ tenantId: c.tenantId, companyId: c.companyId, contactType: 'vendor', displayName: 'Zephyr Holdings' });
  // Shares letters, not a word, with the question ("rent"): never sent.
  await db.insert(contacts).values({ tenantId: c.tenantId, companyId: c.companyId, contactType: 'vendor', displayName: 'Trent Parent Bros' });
  const [bravo] = await db.insert(contacts).values({ tenantId: c.tenantId, companyId: c.companyB, contactType: 'customer', displayName: 'Bravo Only Co' }).returning();
  otherCoContact = bravo!.id;
  const [t] = await db.insert(transactions).values({
    tenantId: c.tenantId, companyId: c.companyId, txnType: 'expense', txnDate: '2026-09-15', total: '13579.2468', memo: 'quince memo secret', status: 'posted',
  }).returning();
  txnId = t!.id;
  await db.insert(journalLines).values([
    { tenantId: c.tenantId, companyId: c.companyId, transactionId: txnId, accountId: rentId, debit: '13579.2468', credit: '0', description: 'quince line secret' },
    { tenantId: c.tenantId, companyId: c.companyId, transactionId: txnId, accountId: c.bank, debit: '0', credit: '13579.2468' },
  ] as never);
  m.execute.mockReset().mockResolvedValue(reply(GOOD));
});

afterEach(async () => {
  vi.restoreAllMocks();
  // ai_config references the user who accepted the disclosure.
  await db.delete(aiConfig);
  for (const tid of tenantIds.splice(0)) {
    await db.delete(aiJobs).where(eq(aiJobs.tenantId, tid));
    await db.delete(aiUsageLog).where(eq(aiUsageLog.tenantId, tid));
    await cleanTenant(tid);
  }
  await db.delete(aiConfig);
});

// ── The mapping ────────────────────────────────────────────────────

describe('POST /reports/ask', () => {
  it('is advertised as reports-ask-v1', () => {
    expect(DESKTOP_CAPABILITIES).toContain('reports-ask-v1');
  });

  it('maps a question to a sent report with resolved ids, and no number the engine did not produce', async () => {
    await enableAi();
    const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((k) => vi.spyOn(console, k));
    const res = await post(request());
    expect(res.status).toBe(200);
    const [rivera] = await db.select().from(contacts).where(eq(contacts.id, c.customer));
    expect(rivera!.displayName).toBe('Rivera Remodel');
    expect(res.json).toEqual({
      reportKey: 'profit_and_loss', dates: { preset: 'last_quarter' }, basis: 'cash', columns: 'month', extras: ['pct_of_income'],
      filters: { accountIds: [rentId], contactIds: [c.customer], tagIds: [] }, unresolved: [],
      reader: 'cloud', provider: 'anthropic', model: 'claude-test',
    });
    // Every digit in the response is in an id the engine resolved: no
    // amount, no model text ("$1,234.56" was dropped).
    const text = JSON.stringify(res.json);
    expect(text).not.toContain('explanation');
    expect(text.replace(new RegExp(`${rentId}|${c.customer}`, 'g'), '')).not.toMatch(/\d/);

    // The prompt: names and the catalog; never a balance, an amount or a memo.
    expect(m.execute).toHaveBeenCalledTimes(1);
    const params = m.execute.mock.calls[0]![0] as { userPrompt: string; systemPrompt: string; responseFormat: string };
    expect(params.responseFormat).toBe('json');
    expect(params.userPrompt).toContain('Rent Kumquat Hall');
    expect(params.userPrompt).toContain('Rivera Remodel');
    expect(params.userPrompt).toContain('profit_and_loss');
    expect(params.userPrompt).toContain('last_quarter');
    expect(params.userPrompt).toContain('Today is 2026-11-10');
    for (const secret of ['98765', '13579', 'quince', 'Zephyr Holdings', 'Trent Parent Bros', 'Bravo Only Co', '555-123-4567']) {
      expect(params.userPrompt).not.toContain(secret);
      expect(params.systemPrompt).not.toContain(secret);
    }
    expect(params.userPrompt).toContain('[PHONE_REDACTED]');
    expect(params.systemPrompt).toMatch(/no amount filter/i);

    // ai_jobs: counts and the report key only; the console: nothing of the question.
    const rows = await jobs();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.jobType).toBe('report_ask');
    expect(rows[0]!.status).toBe('complete');
    const stored = JSON.stringify([rows[0]!.inputData, rows[0]!.outputData, rows[0]!.errorMessage]);
    for (const s of ['rent', 'Rent', 'Rivera', '500', 'Kumquat', 'quarter']) expect(stored).not.toContain(s);
    const logged = JSON.stringify(consoleSpies.flatMap((s) => s.mock.calls));
    for (const s of ['Rivera', 'Kumquat', 'rent', QUESTION]) expect(logged).not.toContain(s);
    const usage = await db.select().from(aiUsageLog).where(eq(aiUsageLog.tenantId, c.tenantId));
    expect(usage.map((u) => u.jobType)).toEqual(['report_ask']);
  });

  it('takes explicit dates and an as-of date, and "number name" for an account', async () => {
    await enableAi();
    m.execute.mockResolvedValueOnce(reply({ reportKey: 'profit_and_loss', from: '2026-01-01', to: '2026-03-31', filters: { accountNames: ['6100 Rent Kumquat Hall'] } }));
    const r1 = await post(request());
    expect(r1.status).toBe(200);
    expect(r1.json.dates).toEqual({ from: '2026-01-01', to: '2026-03-31' });
    expect(r1.json.filters.accountIds).toEqual([rentId]);
    expect(r1.json.basis).toBeNull();
    expect(r1.json.columns).toBeNull();
    m.execute.mockResolvedValueOnce(reply({ reportKey: 'balance_sheet', asOf: '2026-06-30', basis: 'accrual' }));
    const r2 = await post(request({ question: 'balance sheet at the end of June' }));
    expect(r2.status).toBe(200);
    expect(r2.json.dates).toEqual({ asOf: '2026-06-30' });
  });

  it('a name typed in the question but not in this company comes back unresolved, never as an id', async () => {
    await enableAi();
    m.execute.mockResolvedValueOnce(reply({ reportKey: 'ar_aging_summary', filters: { contactNames: ['Bravo Only Co'] } }));
    const res = await post(request({ question: 'What does Bravo Only Co owe us?' }));
    expect(res.status).toBe(200);
    expect(res.json.filters.contactIds).toEqual([]);
    expect(JSON.stringify(res.json)).not.toContain(otherCoContact);
    expect(res.json.unresolved).toEqual([{ kind: 'contact', text: 'Bravo Only Co' }]);
    // The other company's contact was never in the prompt's names either.
    const contactsLine = (m.execute.mock.calls[0]![0] as { userPrompt: string }).userPrompt.split('\n').find((l) => l.startsWith('Contacts:'));
    expect(contactsLine).toBe('Contacts: (none)');
  });

  it.each([
    ['an unknown report key', { reportKey: 'cash_flow_forecast' }, 'reportKey', 'unknown'],
    ['no report', { reportKey: null }, 'reportKey', 'no_report'],
    ['an amount filter', { ...GOOD, amountMin: '500.00' }, 'reply', 'amount_filter'],
    ['a digit-bearing amount key (never echoed)', { ...GOOD, min_500: true }, 'reply', 'amount_filter'],
    ['an amount filter inside filters', { ...GOOD, filters: { amountMax: '500' } }, 'filters', 'amount_filter'],
    ['ids from the model', { ...GOOD, filters: { accountIds: ['00000000-0000-4000-8000-000000000000'] } }, 'filters', 'unknown'],
    ['a uuid as a name', { ...GOOD, filters: { accountNames: ['00000000-0000-4000-8000-000000000000'] } }, 'filters.accountNames', 'id'],
    ['a JSON number', { ...GOOD, columns: 500 }, 'columns', 'number'],
    ['a number in a name', { ...GOOD, filters: { contactNames: ['Over 500 dollars'] } }, 'filters.contactNames', 'number'],
    ['an invented name', { ...GOOD, filters: { contactNames: ['Acme Industries'] } }, 'filters.contactNames', 'invented_name'],
    ['a preset not sent', { ...GOOD, datePreset: 'last_week' }, 'datePreset', 'unknown'],
    ['a column not offered', { ...GOOD, columns: 'by_tag' }, 'columns', 'unknown'],
    ['an extra not offered', { ...GOOD, extras: ['prior_year'] }, 'extras', 'unknown'],
    ['a bad date', { reportKey: 'profit_and_loss', from: '2026-02-30', to: '2026-03-31' }, 'from', 'not_a_date'],
    ['a range backwards', { reportKey: 'profit_and_loss', from: '2026-03-31', to: '2026-01-01' }, 'to', 'before_from'],
    ['two date forms', { ...GOOD, from: '2026-01-01', to: '2026-03-31' }, 'dates', 'more_than_one'],
    ['a range on an as-of report', { reportKey: 'balance_sheet', from: '2026-01-01', to: '2026-03-31' }, 'from', 'not_taken'],
    ['basis on a report without it', { reportKey: 'ar_aging_summary', basis: 'cash' }, 'basis', 'not_taken'],
    ['a filter the report does not take', { reportKey: 'balance_sheet', filters: { accountNames: ['Rent Kumquat Hall'] } }, 'filters.accountNames', 'not_taken'],
    ['a free-text key holding a number', { ...GOOD, note: 1234.56 }, 'reply', 'number'],
    ['a reply that is not an object', ['profit_and_loss'], 'reply', 'not_json'],
  ])('refuses %s with 422 ASK_UNMAPPED', async (_name, parsed, field, reason) => {
    await enableAi();
    m.execute.mockResolvedValueOnce(reply(parsed));
    const res = await post(request());
    expect(res.status).toBe(422);
    expect(res.json.error.code).toBe('ASK_UNMAPPED');
    expect(res.json.error.details).toEqual({ field, reason });
    // The refusal names no model text.
    expect(JSON.stringify(res.json)).not.toMatch(/500|Acme|cash_flow_forecast|1234/);
    const rows = await jobs();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('failed');
    // Tokens spent on a refused reply still count.
    const usage = await db.select().from(aiUsageLog).where(eq(aiUsageLog.tenantId, c.tenantId));
    expect(usage[0]!.inputTokens).toBe(300);
  });

  it('a reply that did not parse as JSON is 422', async () => {
    await enableAi();
    m.execute.mockResolvedValueOnce(reply(undefined, { text: 'Sure! Your rent was $900.', parseError: 'no JSON' }));
    const res = await post(request());
    expect(res.status).toBe(422);
    expect(res.json.error.details).toEqual({ field: 'reply', reason: 'not_json' });
    expect(JSON.stringify(res.json)).not.toContain('900');
  });

  // ── Consent and availability ─────────────────────────────────────

  it('AI off: 403 AI_CONSENT_REQUIRED, no provider call, no ai_jobs row', async () => {
    const res = await post(request());
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe('AI_CONSENT_REQUIRED');
    expect(res.json.error.details.reason).toBe('system_disabled');
    expect(m.execute).not.toHaveBeenCalled();
    expect(await jobs()).toHaveLength(0);
  });

  it('the report_summary task off, or the company not opted in: 403, no call', async () => {
    await enableAi({ categorization: true });
    const r1 = await post(request());
    expect(r1.status).toBe(403);
    expect(r1.json.error).toMatchObject({ code: 'AI_CONSENT_REQUIRED', details: { reason: 'task_disabled', task: 'report_summary' } });
    await db.update(companies).set({ aiEnabled: false }).where(eq(companies.id, c.companyId));
    const r2 = await post(request());
    expect(r2.status).toBe(403);
    expect(r2.json.error.details.reason).toBe('company_not_opted_in');
    // Another company's opt-in does not cover this one.
    await enableAi();
    const r3 = await post(request(), { co: c.companyB });
    expect(r3.status).toBe(403);
    expect(m.execute).not.toHaveBeenCalled();
    expect(await jobs()).toHaveLength(0);
  });

  it('a provider error is 503 AI_UNAVAILABLE; offline says reports still work', async () => {
    await enableAi();
    m.execute.mockRejectedValueOnce(new Error('upstream said: What did we spend on rent'));
    const r1 = await post(request());
    expect(r1.status).toBe(503);
    expect(r1.json.error).toMatchObject({ code: 'AI_UNAVAILABLE', details: { provider: 'anthropic', reason: 'provider_error' } });
    expect(JSON.stringify(r1.json)).not.toContain('rent');
    m.execute.mockRejectedValueOnce(new OfflineUnavailableError('ai'));
    const r2 = await post(request());
    expect(r2.status).toBe(503);
    expect(r2.json.error.details.reason).toBe('offline');
    expect(r2.json.error.message).toMatch(/Couldn't reach anthropic; reports still work/);
    const rows = await jobs();
    expect(rows.map((r) => r.status)).toEqual(['failed', 'failed']);
    expect(rows.map((r) => r.errorMessage).join(' ')).not.toContain('rent');
  });

  it('no provider, or the chat function off, is 503 AI_UNAVAILABLE without a call or a job', async () => {
    await enableAi();
    // Straight to the row, so the disclosure version does not move.
    await db.update(aiConfig).set({ chatProvider: null, categorizationProvider: null });
    const r1 = await post(request());
    expect(r1.status).toBe(503);
    expect(r1.json.error).toMatchObject({ code: 'AI_UNAVAILABLE', details: { provider: null, reason: 'no_provider' } });
    await db.update(aiConfig).set({ chatProvider: 'anthropic', taskOptions: { chat: { enabled: false } } });
    const r2 = await post(request());
    expect(r2.status).toBe(503);
    expect(r2.json.error).toMatchObject({ code: 'AI_UNAVAILABLE', details: { provider: 'anthropic', reason: 'function_disabled' } });
    expect(m.execute).not.toHaveBeenCalled();
    expect(await jobs()).toHaveLength(0);
  });
  it('a self-hosted provider (Ollama) answers as self_hosted', async () => {
    await enableAi();
    m.execute.mockResolvedValueOnce(reply(GOOD, { provider: 'ollama', model: 'llama' }));
    const res = await post(request());
    expect(res.status).toBe(200);
    expect(res.json.reader).toBe('self_hosted');
  });

  it('validates the request: no extra keys, sent tokens only', async () => {
    await enableAi();
    const r1 = await post({ ...request(), amountMin: '500' });
    expect(r1.status).toBe(400);
    const r2 = await post(request({ reports: [{ key: 'Profit & Loss', title: 'x', params: [] }] }));
    expect(r2.status).toBe(400);
    const r3 = await post(request({ question: '' }));
    expect(r3.status).toBe(400);
    expect(m.execute).not.toHaveBeenCalled();
  });
});

// ── Pure helpers ───────────────────────────────────────────────────

describe('report ask validation (no database)', () => {
  const none: NameResolver = { resolve: async () => new Map() };

  it('isIsoDate checks the calendar', () => {
    expect(isIsoDate('2028-02-29')).toBe(true);
    expect(isIsoDate('2026-02-29')).toBe(false);
    expect(isIsoDate('2026-13-01')).toBe(false);
    expect(isIsoDate('20260101')).toBe(false);
    expect(isIsoDate(20260101)).toBe(false);
  });

  it('question words skip short words, stop words and numbers', () => {
    expect(questionWords('What did Rivera Remodel pay in 2026 over $500?')).toEqual(['rivera', 'remodel', 'pay', 'over']);
  });

  it('a sent token that contains digits is fine; an unsent one is a number', async () => {
    const ok = await validateMapping({ reportKey: 'last_12_months_sales' }, request(), none);
    expect(ok.reportKey).toBe('last_12_months_sales');
    await expect(validateMapping({ reportKey: 'sales_last_24_months' }, request(), none))
      .rejects.toMatchObject({ code: 'ASK_UNMAPPED', details: { field: 'reportKey', reason: 'number' } });
  });

  it('free-text keys are dropped unread; amount-like keys are refused', async () => {
    const r = await validateMapping({ reportKey: 'profit_and_loss', summary: 'Rent is high', comment: 'ok' }, request(), none);
    expect(Object.keys(r).sort()).toEqual(['basis', 'columns', 'dates', 'extras', 'filters', 'reportKey', 'unresolved']);
    for (const key of ['min_total', 'maxAmount', 'over', 'balanceAbove', 'amount_gte']) {
      await expect(validateMapping({ reportKey: 'profit_and_loss', [key]: '1' }, request(), none))
        .rejects.toMatchObject({ details: { field: 'reply', reason: 'amount_filter' } });
    }
  });

  it('fullwidth digits count as digits: such a name is refused, never echoed', async () => {
    await expect(validateMapping({ reportKey: 'profit_and_loss', filters: { contactNames: ['５００'] } }, request({ question: 'sales over ５００' }), none))
      .rejects.toMatchObject({ details: { field: 'filters.contactNames', reason: 'number' } });
  });

  it('a preset on a report that takes no dates is refused', async () => {
    await expect(validateMapping({ reportKey: 'last_12_months_sales', datePreset: 'this_year' }, request(), none))
      .rejects.toMatchObject({ details: { field: 'datePreset', reason: 'not_taken' } });
  });

  it('empty values are absent, and duplicate names and extras collapse', async () => {
    const r = await validateMapping({
      reportKey: 'profit_and_loss', datePreset: '', basis: null, columns: '  ', extras: ['ytd', 'ytd'],
      filters: { contactNames: ['Rivera Remodel', 'RIVERA REMODEL'] },
    }, request(), none);
    expect(r).toMatchObject({ dates: null, basis: null, columns: null, extras: ['ytd'] });
    expect(r.unresolved).toEqual([{ kind: 'contact', text: 'Rivera Remodel' }]);
  });
});
