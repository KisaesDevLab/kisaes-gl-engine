// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.
//
// AI draft of a Report Builder definition (U-120, report-builder-ai-v1;
// ClientLedger A10, ADD-03 Q-315), with a stubbed model:
//   - a good reply becomes a definition that passes the shared save check
//     (and saves through POST /definitions), with engine-made node ids, ids
//     the engine looked up, and no digit outside DRAFT_STRUCTURAL_DIGITS;
//   - the prompt holds names, never a balance, an amount, a memo, a contact
//     the description does not name, or a phone number;
//   - an amount filter, a JSON number, a digit in kept text, an id or an
//     id-like key from the model is 422 DRAFT_UNMAPPED, never echoed;
//   - unresolved and ambiguous names leave "$ref:N" (a save refuses it) and
//     an entry in unresolved; replacing the tokens makes it savable;
//   - consent off is 403 with no provider call and no ai_jobs row; a
//     provider error or none is 503; Ollama answers as self_hosted.

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
import {
  accounts, aiConfig, aiJobs, aiUsageLog, auditLog, companies, contacts, items, journalLines, reportDefinitions, tagGroups, transactions,
} from '../db/schema/index.js';
import { reportBuilderRouter } from './report-builder.routes.js';
import { errorHandler } from '../middleware/error-handler.js';
import * as aiConfigService from '../services/ai-config.service.js';
import * as aiConsent from '../services/ai-consent.service.js';
import {
  DRAFT_STRUCTURAL_DIGITS, NUMBER_WORDS, REPORT_DRAFT_SYSTEM_PROMPT, draftNotes, hasNumberWord, maskNumbers, nodeIdFor, prescreen, resolveNames,
} from '../services/report-builder/draft.js';
import { OfflineUnavailableError } from '../utils/offline.js';
import { makeCompany, cleanTenant, type Co } from '../services/templates/templates.test-helpers.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';
import { parseBuilderDefinition } from '@kis-books/shared';

let server: Server | null = null;
let port = 0;
const tenantIds: string[] = [];
let c: Co;
let rentId = '';
let itemId = '';
let crewsId = '';

interface Res { status: number; json: ReturnType<typeof JSON.parse> }

function call(method: string, path: string, body: unknown, opts: { co?: string } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = http.request({
      hostname: '127.0.0.1', port, path: `/api/v1/report-builder${path}`, method,
      headers: {
        'Content-Type': 'application/json', 'Content-Length': String(data.length),
        Authorization: `Bearer ${c.token}`, 'X-Company-Id': opts.co ?? c.companyId,
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

const post = (body: unknown, opts: { co?: string } = {}) => call('POST', '/draft', body, opts);

const DESCRIPTION = 'Monthly report of income, rent from Kumquat Hall by crew, and job sales of Granite Install for Rivera Remodel, only bills over $500. Call me at 555-123-4567.';
const request = (over: Record<string, unknown> = {}) => ({ description: DESCRIPTION, datePresets: ['this_month', 'this_year', 'last_12_months'], ...over });
const UUID_G = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

const reply = (parsed: unknown, extra: Record<string, unknown> = {}) => ({
  text: JSON.stringify(parsed), parsed, inputTokens: 900, outputTokens: 300, model: 'claude-test', provider: 'anthropic', durationMs: 5, ...extra,
});

const GOOD = {
  title: 'Jobs and rent by crew',
  dates: 'range', datePreset: 'this_year', basis: 'accrual', periods: 'month', agingBuckets: false, compare: [],
  percentOf: 'income', detailFields: ['date', 'txn_type', 'contact', 'memo'],
  rows: [
    { type: 'section', label: 'income', caption: 'Income', source: 'gl', measure: 'amount',
      filters: [{ field: 'account_type', op: 'in', values: ['revenue'] }], groupBy: [{ key: 'account' }], totalCaption: 'Total Income' },
    { type: 'section', label: 'rent', caption: 'Rent', source: 'gl', measure: 'amount', display: 'expandable',
      filters: [{ field: 'account', op: 'in', names: ['Rent Kumquat Hall'] }], groupBy: [{ key: 'tag', tagGroup: 'crews' }] },
    { type: 'section', label: 'jobs', caption: 'Job sales', source: 'item_sales', measure: 'amount',
      filters: [{ field: 'contact', op: 'in', names: ['rivera remodel'] }, { field: 'item', op: 'in', names: ['Granite Install'] }],
      groupBy: [{ key: 'item' }] },
    { type: 'formula', label: 'net', caption: 'Income less rent', terms: [{ row: 'income', op: 'add' }, { row: 'rent', op: 'subtract' }] },
    { type: 'blank' },
    { type: 'text', text: 'Drafted for review' },
  ],
  // Free text: dropped unread.
  explanation: 'Rent was about $1,234.56 last quarter.',
};

/** GOOD with one change at a path. */
function good(edit: (g: Record<string, any>) => void): Record<string, unknown> {
  const g = clone(GOOD) as Record<string, any>;
  edit(g);
  return g;
}

async function enableAi(tasks: Record<string, boolean> = { report_summary: true }) {
  await aiConsent.acceptSystemDisclosure(c.userId);
  await aiConfigService.updateConfig({ isEnabled: true, chatProvider: 'anthropic', chatModel: 'claude-test', anthropicApiKey: 'sk-test-fake-key' });
  const cfg = await aiConfigService.getRawConfig();
  await db.update(companies).set({
    aiEnabled: true, aiDisclosureAcceptedAt: new Date(), aiDisclosureAcceptedBy: c.userId,
    aiDisclosureVersion: cfg.disclosureVersion ?? 1, aiEnabledTasks: tasks,
  }).where(eq(companies.id, c.companyId));
}

const jobs = () => db.select().from(aiJobs).where(eq(aiJobs.tenantId, c.tenantId));

/** This tenant's report_builder_draft audit rows, `after` parsed, drafted before refused. */
async function draftAudits() {
  const rows = (await db.select().from(auditLog).where(eq(auditLog.tenantId, c.tenantId))).filter((a) => a.entityType === 'report_builder_draft');
  return rows
    .map((a) => ({ ...a, after: (typeof a.afterData === 'string' ? JSON.parse(a.afterData) : a.afterData) as Record<string, unknown> }))
    .sort((x, y) => String(x.after['outcome']).localeCompare(String(y.after['outcome'])));
}

/** Everything sent to the provider in call i: the system prompt and the user prompt. */
function sent(i = 0): string {
  const p = m.execute.mock.calls[i]![0] as { systemPrompt: string; userPrompt: string };
  return `${p.systemPrompt}\n${p.userPrompt}`;
}
/** The description as the model saw it. */
function sentDescription(i = 0): string {
  const u = (m.execute.mock.calls[i]![0] as { userPrompt: string }).userPrompt;
  return u.slice(u.indexOf('DESCRIPTION'), u.indexOf('CATALOGUE'));
}
/** Digits in a prompt outside the structural tokens the engine must send: the catalogue's aging bucket keys and the sent presets. */
const SENT_PRESETS = ['this_month', 'this_year', 'last_12_months'];
function promptDigits(text: string): string[] {
  let t = text;
  for (const k of [...DRAFT_STRUCTURAL_DIGITS.enumKeys, ...SENT_PRESETS]) t = t.split(k).join('');
  return t.match(/\p{Nd}/gu) ?? [];
}
const OPEN_INVOICES = { dates: 'range', rows: [
  { type: 'section', caption: 'Open invoices', source: 'ar_open', measure: 'open_balance', groupBy: [{ key: 'contact' }] },
] };

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/v1/report-builder', reportBuilderRouter);
  app.use(errorHandler);
  await new Promise<void>((resolve) => { server = app.listen(0, () => { port = (server!.address() as AddressInfo).port; resolve(); }); });
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
});

beforeEach(async () => {
  await db.delete(aiConfig);
  c = await makeCompany('draft', tenantIds);
  // A distinctive balance, amount and memo: none may reach the model.
  const [rent] = await db.insert(accounts).values({
    tenantId: c.tenantId, companyId: c.companyId, name: 'Rent Kumquat Hall', accountNumber: '6100', accountType: 'expense', balance: '98765.4321',
  }).returning();
  rentId = rent!.id;
  const [item] = await db.insert(items).values({ tenantId: c.tenantId, companyId: c.companyId, name: 'Granite Install', unitPrice: '24680.1357', incomeAccountId: c.income }).returning();
  itemId = item!.id;
  const [tg] = await db.insert(tagGroups).values({ tenantId: c.tenantId, name: 'Crews' }).returning();
  crewsId = tg!.id;
  await db.insert(contacts).values({ tenantId: c.tenantId, companyId: c.companyId, contactType: 'vendor', displayName: 'Zephyr Holdings' });
  await db.insert(contacts).values({ tenantId: c.tenantId, companyId: c.companyB, contactType: 'customer', displayName: 'Bravo Only Co' });
  const [t] = await db.insert(transactions).values({
    tenantId: c.tenantId, companyId: c.companyId, txnType: 'expense', txnDate: '2026-09-15', total: '13579.2468', memo: 'quince memo secret', status: 'posted',
  }).returning();
  await db.insert(journalLines).values([
    { tenantId: c.tenantId, companyId: c.companyId, transactionId: t!.id, accountId: rentId, debit: '13579.2468', credit: '0', description: 'quince line secret' },
    { tenantId: c.tenantId, companyId: c.companyId, transactionId: t!.id, accountId: c.bank, debit: '0', credit: '13579.2468' },
  ] as never);
  m.execute.mockReset().mockResolvedValue(reply(GOOD));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await db.delete(aiConfig);
  for (const tid of tenantIds.splice(0)) {
    await db.delete(aiJobs).where(eq(aiJobs.tenantId, tid));
    await db.delete(aiUsageLog).where(eq(aiUsageLog.tenantId, tid));
    await db.delete(reportDefinitions).where(eq(reportDefinitions.tenantId, tid));
    await db.delete(tagGroups).where(eq(tagGroups.tenantId, tid));
    await db.delete(items).where(eq(items.tenantId, tid));
    await cleanTenant(tid);
  }
  await db.delete(aiConfig);
});

describe('POST /report-builder/draft (U-120)', () => {
  it('is advertised as report-builder-ai-v1', () => {
    expect(DESKTOP_CAPABILITIES).toContain('report-builder-ai-v1');
  });

  it('drafts a savable definition with looked-up ids and no digit outside the structural allowlist', async () => {
    await enableAi();
    const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((k) => vi.spyOn(console, k));
    const res = await post(request());
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const { definition, unresolved, notes, savable, reader, provider, model } = res.json;
    expect(savable).toBe(true);
    expect(unresolved).toEqual([]);
    expect({ reader, provider, model }).toEqual({ reader: 'cloud', provider: 'anthropic', model: 'claude-test' });
    // The same shared validator as a save.
    const parsed = parseBuilderDefinition(definition);
    expect(parsed.ok).toBe(true);
    expect(definition).toMatchObject({
      schemaVersion: 1, kind: 'builder', title: 'Jobs and rent by crew', dates: { mode: 'range', preset: 'this_year' }, basis: 'accrual',
      columns: { detailFields: ['date', 'txn_type', 'contact', 'memo'], periods: 'month', compare: [], percentOf: 'row_a', headers: {} },
    });
    const nodes = definition.nodes;
    expect(nodes.map((n: { id: string }) => n.id)).toEqual(['row_a', 'row_b', 'row_c', 'row_d', 'row_e', 'row_f']);
    expect(nodes[1].filters).toEqual([{ field: 'account', op: 'in', ids: [rentId] }]);
    expect(nodes[1].groupBy).toEqual([{ key: 'tag', tagGroupId: crewsId }]);
    expect(nodes[2].filters).toEqual([{ field: 'contact', op: 'in', ids: [c.customer] }, { field: 'item', op: 'in', ids: [itemId] }]);
    expect(nodes[3].terms).toEqual([{ nodeId: 'row_a', sign: 1 }, { nodeId: 'row_b', sign: -1 }]);
    // Digits: only looked-up ids, schemaVersion 1 and term signs.
    const text = JSON.stringify(res.json);
    expect(text).not.toContain('explanation');
    expect(text).not.toContain('label');
    const rest = JSON.stringify(definition).replace(UUID_G, '').replace(/"schemaVersion":1/, '').replace(/"sign":-?1/g, '');
    expect(rest).not.toMatch(/\d/);
    expect(JSON.stringify(notes)).not.toMatch(/\d/);
    // The owner's amount ("over $500") is drafted without a filter and noted; it is nowhere in the response.
    expect(notes).toEqual([{ code: 'amount_filter_left_out', message: expect.any(String) }]);
    expect(text.replace(UUID_G, '')).not.toContain('500');

    // The prompt: names and the catalogue; never a balance, an amount, a memo, an unnamed contact or a phone.
    expect(m.execute).toHaveBeenCalledTimes(1);
    const params = m.execute.mock.calls[0]![0] as { userPrompt: string; systemPrompt: string; responseFormat: string; maxTokens: number };
    expect(params.responseFormat).toBe('json');
    for (const name of ['Rent Kumquat Hall', 'Granite Install', 'Crews', 'Rivera Remodel', 'item_sales', 'aging_bucket', 'this_year']) {
      expect(params.userPrompt).toContain(name);
    }
    for (const secret of ['98765', '13579', '24680', 'quince', 'Zephyr Holdings', 'Bravo Only Co', '555-123-4567']) {
      expect(params.userPrompt).not.toContain(secret);
      expect(params.systemPrompt).not.toContain(secret);
    }
    expect(params.userPrompt).toContain('[PHONE_REDACTED]');
    // The owner's amount is masked before the prompt (Q-315).
    expect(params.userPrompt).toContain('over [AMOUNT]');
    expect(params.userPrompt).not.toContain('500');
    expect(params.systemPrompt).toMatch(/no amount filter/i);

    // ai_jobs: counts only; the console: nothing of the description.
    const rows = await jobs();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.jobType).toBe('report_draft');
    expect(rows[0]!.status).toBe('complete');
    const stored = JSON.stringify([rows[0]!.inputData, rows[0]!.outputData, rows[0]!.errorMessage]);
    for (const s of ['Rent', 'Rivera', 'Kumquat', 'Granite', 'Crews', '500']) expect(stored).not.toContain(s);
    const logged = JSON.stringify(consoleSpies.flatMap((s) => s.mock.calls));
    for (const s of ['Rivera', 'Kumquat', 'Granite', DESCRIPTION]) expect(logged).not.toContain(s);

    // Audit trail: one row, who and which provider; never the description, prompt or definition.
    const audits = await db.select().from(auditLog).where(eq(auditLog.tenantId, c.tenantId));
    const draftRows = audits.filter((a) => a.entityType === 'report_builder_draft');
    expect(draftRows).toHaveLength(1);
    expect(draftRows[0]!).toMatchObject({ action: 'create', userId: c.userId, entityId: rows[0]!.id, beforeData: null });
    const raw = draftRows[0]!.afterData;
    const after = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Record<string, unknown>;
    expect(after).toEqual({ companyId: c.companyId, provider: 'anthropic', model: 'claude-test', reader: 'cloud', outcome: 'drafted', nodes: 6, unresolved: 0 });
    for (const s of ['Rent', 'Rivera', 'Kumquat', 'Granite', 'Crews', '500', 'row_a', 'section', 'onthly']) expect(JSON.stringify(raw).replace(UUID_G, '')).not.toContain(s);

    // Savable as is: the real save route takes it, and nothing was saved before.
    expect(await db.select().from(reportDefinitions).where(eq(reportDefinitions.tenantId, c.tenantId))).toHaveLength(0);
    const saved = await call('POST', '/definitions', { name: 'Drafted', definition });
    expect(saved.status, JSON.stringify(saved.json)).toBe(201);
  });

  it('aging bucket keys are the one place a model digit is kept', async () => {
    await enableAi();
    m.execute.mockResolvedValueOnce(reply({
      dates: 'asOf', datePreset: 'last_12_months', agingBuckets: true, rows: [
        { type: 'section', caption: 'Late invoices', source: 'ar_open', measure: 'open_balance',
          filters: [{ field: 'aging_bucket', op: 'in', values: ['d31_60', 'over_90'] }], groupBy: [{ key: 'contact' }] },
      ],
    }));
    const res = await post(request({ description: 'Late customer invoices' }));
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.definition.nodes[0].filters).toEqual([{ field: 'aging_bucket', op: 'in', values: ['d31_60', 'over_90'] }]);
    // A sent preset with digits is kept (client vocabulary).
    expect(res.json.definition.dates).toEqual({ mode: 'asOf', preset: 'last_12_months' });
    expect(parseBuilderDefinition(res.json.definition).ok).toBe(true);
    expect(res.json.notes).toEqual([]);
  });

  it('a preset the client did not send is left out with a note', async () => {
    await enableAi();
    m.execute.mockResolvedValueOnce(reply(good((g) => { g['datePreset'] = 'this_week'; })));
    const res = await post(request({ description: 'Income and rent' }));
    expect(res.status).toBe(200);
    expect(res.json.definition.dates).toEqual({ mode: 'range' });
    expect(res.json.notes.map((n: { code: string }) => n.code)).toEqual(['preset_left_out']);
  });

  it('unresolved and ambiguous names leave "$ref:N", which a save refuses until replaced', async () => {
    await enableAi();
    const [d1] = await db.insert(contacts).values({ tenantId: c.tenantId, companyId: c.companyId, contactType: 'customer', displayName: 'Delta Supply' }).returning();
    const [d2] = await db.insert(contacts).values({ tenantId: c.tenantId, companyId: c.companyId, contactType: 'vendor', displayName: 'Delta Supply' }).returning();
    m.execute.mockResolvedValueOnce(reply({
      dates: 'range', rows: [
        { type: 'section', caption: 'Purchases', source: 'purchases', measure: 'amount', groupBy: [{ key: 'contact' }],
          filters: [
            { field: 'contact', op: 'in', names: ['Delta Supply'] },
            { field: 'account', op: 'in', names: ['Petty Cash Jar'] },
            { field: 'item', op: 'not_in', names: ['Moonrock Polish'] },
          ] },
        { type: 'section', caption: 'Rent', source: 'gl', measure: 'amount', filters: [{ field: 'account', op: 'in', names: ['petty cash jar'] }] },
      ],
    }));
    const res = await post(request({ description: 'Purchases from Delta Supply and Petty Cash Jar spending' }));
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.savable).toBe(false);
    const { definition, unresolved } = res.json;
    expect(unresolved).toHaveLength(3);
    expect(unresolved[0]).toMatchObject({ ref: '$ref:0', kind: 'contact', name: 'Delta Supply', reason: 'ambiguous',
      sites: [{ nodeId: 'row_a', path: 'definition.nodes.0.filters.0.ids.0' }] });
    expect(unresolved[0].candidates.map((x: { id: string }) => x.id).sort()).toEqual([d1!.id, d2!.id].sort());
    expect(unresolved[0].candidates.map((x: { label: string }) => x.label).sort()).toEqual(['Delta Supply (customer)', 'Delta Supply (vendor)']);
    // Typed by the owner: shown; one token for both sections.
    expect(unresolved[1]).toEqual({ ref: '$ref:1', kind: 'account', name: 'Petty Cash Jar', reason: 'not_found', candidates: [],
      sites: [{ nodeId: 'row_a', path: 'definition.nodes.0.filters.1.ids.0' }, { nodeId: 'row_b', path: 'definition.nodes.1.filters.0.ids.0' }] });
    // Named by the model only: never shown.
    expect(unresolved[2]).toEqual({ ref: '$ref:2', kind: 'item', name: null, reason: 'not_found', candidates: [],
      sites: [{ nodeId: 'row_a', path: 'definition.nodes.0.filters.2.ids.0' }] });
    expect(JSON.stringify(res.json)).not.toContain('Moonrock');
    expect(definition.nodes[0].filters.map((f: { ids: string[] }) => f.ids)).toEqual([['$ref:0'], ['$ref:1'], ['$ref:2']]);
    expect(res.json.notes.map((n: { code: string }) => n.code)).toEqual(['pick_unresolved']);

    // The placeholder can't be saved as a real reference.
    const refused = await call('POST', '/definitions', { name: 'Draft with tokens', definition });
    expect(refused.status).toBe(400);
    expect(refused.json.error.code).toBe('DEFINITION_INVALID');

    // Picking the candidate and leaving the others out makes it savable.
    const fixed = clone(definition);
    fixed.nodes[0].filters = [{ field: 'contact', op: 'in', ids: [d2!.id] }];
    fixed.nodes[1].filters = [{ field: 'account', op: 'in', ids: [rentId] }];
    const saved = await call('POST', '/definitions', { name: 'Draft picked', definition: fixed });
    expect(saved.status, JSON.stringify(saved.json)).toBe(201);
  });

  it('a name of another company stays unresolved, never its id', async () => {
    await enableAi();
    m.execute.mockResolvedValueOnce(reply({ dates: 'range', rows: [
      { type: 'section', caption: 'Sales', source: 'sales', measure: 'amount', filters: [{ field: 'contact', op: 'in', names: ['Bravo Only Co'] }] },
    ] }));
    const res = await post(request({ description: 'Sales to Bravo Only Co' }));
    expect(res.status).toBe(200);
    expect(res.json.unresolved).toEqual([expect.objectContaining({ kind: 'contact', name: 'Bravo Only Co', reason: 'not_found', candidates: [] })]);
    expect(JSON.stringify(res.json).match(UUID_G)).toBeNull();
  });

  // Owner Q&A 2026-11-15: an amount condition is left out and noted, never refused when that is clean.
  it.each([
    ['an amount filter by field', good((g) => { g['rows'][1].filters.push({ field: 'amount', op: 'gte', value: '500.00' }); }), 'row_b'],
    ['an amount filter with a JSON number', good((g) => { g['rows'][1].filters.push({ field: 'amount', op: 'gte', value: 500 }); }), 'row_b'],
    ['an amount comparison on another field', good((g) => { g['rows'][2].filters.push({ field: 'contact', op: 'lte', names: ['500'] }); }), 'row_c'],
    ['a value on a list filter (key removed, filter kept)', good((g) => { g['rows'][1].filters[0].value = '500'; }), 'row_b'],
    ['an amount-like key in a list filter (key removed, filter kept)', good((g) => { g['rows'][1].filters[0].minAmount = 500; }), 'row_b'],
    ['a gt comparison', good((g) => { g['rows'][1].filters.push({ field: 'account', op: 'gt', names: ['500'] }); }), 'row_b'],
    ['a between comparison', good((g) => { g['rows'][1].filters.push({ field: 'amount', op: 'between', values: ['100', '500'] }); }), 'row_b'],
    ['a >= comparison', good((g) => { g['rows'][1].filters.push({ field: 'contact', op: '>=', value: 500 }); }), 'row_b'],
    ['a total field', good((g) => { g['rows'][1].filters.push({ field: 'total', op: 'in', values: ['500'] }); }), 'row_b'],
    ['an amount key in a row', good((g) => { g['rows'][0].minTotal = '500'; }), 'row_a'],
    ['an amount key in a grouped row', good((g) => { g['rows'] = [{ type: 'group', caption: 'Costs', children: [{ ...g['rows'][1], amountOver: 500 }] }]; g['percentOf'] = null; }), 'row_b'],
    ['a section marked amountCondition', good((g) => { g['rows'][2].amountCondition = true; }), 'row_c'],
    ['an amount key at the top', good((g) => { g['amountMin'] = 500; }), null],
  ])('leaves out %s: 200, the note, no amount in the definition or response', async (_name, parsed, nodeId) => {
    await enableAi();
    m.execute.mockResolvedValueOnce(reply(parsed));
    // The description holds no amount: the note comes from the model's condition.
    const res = await post(request({ description: 'Income, rent by crew and job sales for Rivera Remodel' }));
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.notes).toEqual([{ code: 'amount_filter_left_out', message: expect.any(String), ...(nodeId ? { nodeId } : {}) }]);
    const def = res.json.definition;
    expect(JSON.stringify(def)).not.toMatch(/"amount","op"|"value"|"op":"(gte|lte)"|minAmount|minTotal|amountOver|amountMin|amountCondition/);
    expect(JSON.stringify(res.json).replace(UUID_G, '')).not.toContain('500');
    expect(parseBuilderDefinition(def).ok).toBe(true);
    expect(res.json.savable).toBe(true);
    // The section keeps its own (non-amount) filter: never broadened.
    if (nodeId === 'row_b' && def.nodes[1]) expect(def.nodes[1].filters).toEqual([{ field: 'account', op: 'in', ids: [rentId] }]);
  });

  it('an amount in the description is drafted without a filter, noted, and never echoed', async () => {
    await enableAi();
    m.execute.mockResolvedValueOnce(reply({ dates: 'range', rows: [
      { type: 'section', caption: 'Open invoices', source: 'ar_open', measure: 'open_balance', groupBy: [{ key: 'contact' }] },
    ] }));
    const res = await post(request({ description: 'Invoices over $1,250 that are still open' }));
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.notes.map((n: { code: string }) => n.code)).toEqual(['amount_filter_left_out']);
    expect(res.json.definition.nodes[0].filters).toEqual([]);
    expect(JSON.stringify(res.json).replace(UUID_G, '')).not.toMatch(/1,?250/);
  });

  // Q-A10l (review B1): every number in the description, in any format, is masked before the prompt and noted.
  it.each([
    ['Bills over £500', 'amount'],
    ['Invoices of 500', 'amount'],
    ['Bills totalling 1,250.75', 'amount'],
    ['Bills 500€ and up', 'amount'],
    ['Bills over USD 500', 'amount'],
    ['Amount = 500', 'amount'],
    ['Bills between 100 and 500', 'amount'],
    ['Bills 100-500', 'number'],
    ['Bills of 5e3', 'amount'],
    ['Bills over 1.5k', 'amount'],
    ['Margin under 20%', 'amount'],
    ['Sales that grew 20 percent', 'number'],
    ['Bills over ５００ (fullwidth)', 'amount'],
    ['Bills over ٥٠٠ (Arabic-Indic)', 'amount'],
    ['Bills over १२३ (Devanagari)', 'amount'],
    ['Bills over 5\u200B00 (a zero-width space)', 'amount'],
    ['Bills > five hundred dollars', 'amount'],
    ['Bills over five hundred dollars', 'amount'],
    ['Bills over a thousand', 'amount'],
    ['Bills over a grand', 'amount'],
    ['Vendors paid fifty bucks or more', 'amount'],
    ['Projects over half a million', 'amount'],
    ['Our two dozen top customers', 'number'],
    ['Income for 2026', 'number'],
    ['Sales in the last twelve months', 'number'],
  ])('masks "%s" before the prompt and notes it (%s)', async (description, kind) => {
    await enableAi();
    m.execute.mockResolvedValueOnce(reply(OPEN_INVOICES));
    const res = await post(request({ description }));
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    // The prompt: no digit outside the structural tokens; no number word in the description the model saw.
    expect(promptDigits(sent())).toEqual([]);
    const seen = sentDescription();
    expect(seen).toMatch(/\[(AMOUNT|NUMBER)\]/);
    expect(hasNumberWord(seen), seen).toBe(false);
    expect(seen).not.toMatch(/\p{N}/u);
    // The response: the note, and the number in no form.
    expect(res.json.notes.map((n: { code: string }) => n.code)).toEqual([kind === 'amount' ? 'amount_filter_left_out' : 'numbers_not_used']);
    const text = JSON.stringify(res.json).replace(UUID_G, '').replace(/"schemaVersion":1/, '');
    expect(text).not.toMatch(/\p{N}/u);
    expect(hasNumberWord(text)).toBe(false);
  });

  it('"Bills over five hundred dollars": masked and noted; a caption that repeats it is refused; both calls audited (B1, Q-A10k)', async () => {
    await enableAi();
    const description = 'Bills over five hundred dollars';
    const bills = (caption: string) => reply({ dates: 'range', rows: [
      { type: 'section', caption, source: 'ar_open', measure: 'open_balance', groupBy: [{ key: 'contact' }], amountCondition: true },
    ] });
    m.execute.mockResolvedValueOnce(bills('Bills over five hundred dollars'));
    const r1 = await post(request({ description }));
    expect(r1.status).toBe(422);
    expect(r1.json.error.details).toEqual({ field: 'rows.0.caption', reason: 'number' });
    expect(JSON.stringify(r1.json)).not.toMatch(/five|hundred/i);
    expect(sentDescription()).toContain('Bills over [AMOUNT]');
    expect(sentDescription()).not.toMatch(/five|hundred|dollars/i);

    m.execute.mockResolvedValueOnce(bills('Unpaid bills'));
    const r2 = await post(request({ description }));
    expect(r2.status, JSON.stringify(r2.json)).toBe(200);
    expect(r2.json.notes).toEqual([{ code: 'amount_filter_left_out', message: expect.any(String), nodeId: 'row_a' }]);
    expect(JSON.stringify(r2.json)).not.toMatch(/five|hundred|500/i);

    // One audit row per answered call, the refused one too; never the description, the reply or the definition.
    const audits = await draftAudits();
    const base = { companyId: c.companyId, provider: 'anthropic', model: 'claude-test', reader: 'cloud' };
    expect(audits.map((a) => a.after)).toEqual([
      { ...base, outcome: 'drafted', nodes: 1, unresolved: 0 },
      { ...base, outcome: 'refused', reason: 'number' },
    ]);
    expect(audits.map((a) => [a.action, a.userId, a.beforeData])).toEqual([['create', c.userId, null], ['create', c.userId, null]]);
    expect(JSON.stringify(audits.map((a) => a.afterData))).not.toMatch(/five|hundred|bills|caption|rows|AMOUNT/i);
  });

  it('the prompt holds no digit and no amount of its own (S4): only the structural tokens it must send', async () => {
    expect(REPORT_DRAFT_SYSTEM_PROMPT).not.toMatch(/\p{N}/u);
    expect(REPORT_DRAFT_SYSTEM_PROMPT).not.toMatch(/\p{Sc}/u);
    await enableAi();
    const res = await post(request({ description: 'Monthly income and rent by crew for Rivera Remodel' }));
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(promptDigits(sent())).toEqual([]);
    expect(res.json.notes).toEqual([]);
    // The allowlist hides something real: the structural tokens are sent.
    for (const k of ['d1_30', 'over_90', 'last_12_months']) expect(sent()).toContain(k);
  });

  it('a caption that is exactly a name in the books may hold number words; anything more is refused (Q-A10l)', async () => {
    await enableAi();
    await db.insert(contacts).values({ tenantId: c.tenantId, companyId: c.companyId, contactType: 'vendor', displayName: 'Five Star Supply' });
    const purchases = (caption: string) => reply({ dates: 'range', rows: [
      { type: 'section', caption, source: 'purchases', measure: 'amount', filters: [{ field: 'contact', op: 'in', names: ['Five Star Supply'] }] },
    ] });
    m.execute.mockResolvedValueOnce(purchases('five star supply'));
    const ok = await post(request({ description: 'Purchases from Five Star Supply' }));
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json.definition.nodes[0].caption).toBe('five star supply');
    expect(ok.json.unresolved).toEqual([]);
    m.execute.mockResolvedValueOnce(purchases('Five Star Supply over five hundred'));
    const bad = await post(request({ description: 'Purchases from Five Star Supply' }));
    expect(bad.status).toBe(422);
    expect(bad.json.error.details).toEqual({ field: 'rows.0.caption', reason: 'number' });
  });

  it('a name not found is shown back only when it is a whole word or phrase of the description', async () => {
    await enableAi();
    m.execute.mockResolvedValueOnce(reply({ dates: 'range', rows: [
      { type: 'section', caption: 'Spending', source: 'gl', measure: 'amount', filters: [{ field: 'account', op: 'in', names: ['Cash J', 'Petty Cash Jar', 'P'] }] },
    ] }));
    const res = await post(request({ description: 'Spending from Petty Cash Jar' }));
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.unresolved.map((u: { name: string | null }) => u.name)).toEqual([null, 'Petty Cash Jar', null]);
  });

  const UUID = '00000000-0000-4000-8000-000000000000';
  it.each([
    ['an amount-like key in a group-by', good((g) => { g['rows'][1].groupBy = [{ key: 'account', minAmount: 'x' }]; }), 'rows.1.groupBy.0', 'amount_filter'],
    ['digits in a caption', good((g) => { g['rows'][1].caption = 'Rent over 500'; }), 'rows.1.caption', 'number'],
    ['digits in a total caption', good((g) => { g['rows'][0].totalCaption = 'Total 2026'; }), 'rows.0.totalCaption', 'number'],
    ['fullwidth digits in a text row', good((g) => { g['rows'][5].text = 'Budget ５００'; }), 'rows.5.text', 'number'],
    ['Arabic-Indic digits in a caption', good((g) => { g['rows'][1].caption = 'Rent ٥٠٠'; }), 'rows.1.caption', 'number'],
    ['number words in a caption', good((g) => { g['rows'][1].caption = 'Rent over five hundred'; }), 'rows.1.caption', 'number'],
    ['a hyphenated number word in the title', good((g) => { g['title'] = 'Top twenty-five customers'; }), 'title', 'number'],
    ['a number word split by a zero-width space', good((g) => { g['rows'][5].text = 'Fi\u200Bfty'; }), 'rows.5.text', 'number'],
    ['"one" in a total caption', good((g) => { g['rows'][0].totalCaption = 'One-time income'; }), 'rows.0.totalCaption', 'number'],
    ['a mask marker in a caption', good((g) => { g['rows'][1].caption = 'Rent over [AMOUNT]'; }), 'rows.1.caption', 'number'],
    ['an unresolved name with number words', good((g) => { g['rows'][2].filters[0].names = ['Five Hundred Club']; }), 'definition.nodes.2.filters.0.ids.0', 'number'],
    ['digits in the title', good((g) => { g['title'] = 'Top 10 customers'; }), 'title', 'number'],
    ['a JSON number in a row', good((g) => { g['rows'][0].hideZero = 0; }), 'rows.0.hideZero', 'number'],
    ['a JSON number in free text at the top', good((g) => { g['confidence'] = 0.9; }), 'reply', 'number'],
    ['ids from the model', good((g) => { g['rows'][1].filters = [{ field: 'account', op: 'in', ids: [UUID] }]; }), 'rows.1.filters.0', 'id'],
    ['an id-like key in a row', good((g) => { g['rows'][1].accountId = 'x'; }), 'rows.1', 'id'],
    ['an id key at the top', good((g) => { g['reportId'] = 'x'; }), 'reply', 'id'],
    ['a uuid as a name', good((g) => { g['rows'][1].filters[0].names = [UUID]; }), 'rows.1.filters.0.names', 'id'],
    ['a uuid in a caption', good((g) => { g['rows'][1].caption = `Rent ${UUID}`; }), 'rows.1.caption', 'id'],
    ['a uuid as a label', good((g) => { g['rows'][1].label = UUID; }), 'rows.1.label', 'shape'],
    ['an unresolved name with digits', good((g) => { g['rows'][2].filters[0].names = ['Over 500 Club']; }), 'definition.nodes.2.filters.0.ids.0', 'number'],
    ['a preset with digits not sent', good((g) => { g['datePreset'] = 'last_24_months'; }), 'datePreset', 'number'],
    ['a value not in the catalogue', good((g) => { g['rows'][0].filters[0].values = ['d1_45']; }), 'rows.0.filters.0.values', 'number'],
    ['a formula on an unknown row', good((g) => { g['rows'][3].terms[1].row = 'payroll'; }), 'rows.3.terms.1.row', 'unknown'],
    ['a duplicate label', good((g) => { g['rows'][2].label = 'rent'; }), 'rows.2.label', 'duplicate'],
    ['an unknown key in a row', good((g) => { g['rows'][0].colour = 'blue'; }), 'rows.0', 'unknown'],
    ['a natural gl section over both sides', good((g) => { g['rows'][0].filters = []; }), 'definition.nodes.0.polarity', 'MIXED_POLARITY'],
    ['a group key the source lacks', good((g) => { g['rows'][2].groupBy = [{ key: 'cleared' }]; }), 'definition.nodes.2.groupBy.0.key', 'NOT_IN_SOURCE'],
    ['an unknown source', good((g) => { g['rows'][2].source = 'payroll'; }), 'rows.2.source', 'shape'],
    ['no rows', { dates: 'range', rows: [] }, 'rows', 'no_report'],
    ['a reply that is not an object', ['income'], 'reply', 'not_json'],
  ])('refuses %s with 422 DRAFT_UNMAPPED', async (_name, parsed, field, reason) => {
    await enableAi();
    m.execute.mockResolvedValueOnce(reply(parsed));
    const res = await post(request());
    expect(res.status, JSON.stringify(res.json)).toBe(422);
    expect(res.json.error.code).toBe('DRAFT_UNMAPPED');
    expect(res.json.error.details).toEqual({ field, reason });
    // The refusal echoes no model text.
    expect(JSON.stringify(res.json)).not.toMatch(/500|1234|0\.9|00000000|payroll|blue|colour|minTotal|accountId|reportId|Club/);
    expect(JSON.stringify(res.json)).not.toMatch(/five|hundred|twenty|fifty|one-time|\[AMOUNT\]|٥/i);
    const rows = await jobs();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('failed');
    // Q-A10k: names were sent, so the refusal is audited: its code only.
    expect((await draftAudits()).map((a) => a.after)).toEqual([{
      companyId: c.companyId, provider: 'anthropic', model: 'claude-test', reader: 'cloud', outcome: 'refused', reason,
    }]);
  });

  it('a reply that did not parse as JSON is 422 not_json', async () => {
    await enableAi();
    m.execute.mockResolvedValueOnce(reply(undefined, { text: 'Your rent was $900.', parseError: 'no JSON' }));
    const res = await post(request());
    expect(res.status).toBe(422);
    expect(res.json.error.details).toEqual({ field: 'reply', reason: 'not_json' });
    expect(JSON.stringify(res.json)).not.toContain('900');
    expect((await draftAudits()).map((a) => [a.after['outcome'], a.after['reason']])).toEqual([['refused', 'not_json']]);
  });

  // ── Consent and availability ─────────────────────────────────────

  it('AI off: 403 AI_CONSENT_REQUIRED, no provider call, no ai_jobs row', async () => {
    const res = await post(request());
    expect(res.status).toBe(403);
    expect(res.json.error).toMatchObject({ code: 'AI_CONSENT_REQUIRED', details: { reason: 'system_disabled', task: 'report_summary' } });
    expect(m.execute).not.toHaveBeenCalled();
    expect(await jobs()).toHaveLength(0);
    expect(await draftAudits()).toEqual([]);
  });

  it('consent off with an Ollama provider: 403, no call (the local model is gated too)', async () => {
    await enableAi({ categorization: true });
    await db.update(aiConfig).set({ chatProvider: 'ollama', chatModel: 'llama3' });
    const res = await post(request());
    expect(res.status).toBe(403);
    expect(res.json.error).toMatchObject({ code: 'AI_CONSENT_REQUIRED', details: { reason: 'task_disabled', task: 'report_summary' } });
    expect(m.execute).not.toHaveBeenCalled();
    expect(await jobs()).toHaveLength(0);
    expect(await draftAudits()).toEqual([]);
  });

  it('the report_summary task off, the company not opted in, or another company: 403, no call', async () => {
    await enableAi({ categorization: true });
    const r1 = await post(request());
    expect(r1.status).toBe(403);
    expect(r1.json.error.details).toMatchObject({ reason: 'task_disabled', task: 'report_summary' });
    await db.update(companies).set({ aiEnabled: false }).where(eq(companies.id, c.companyId));
    const r2 = await post(request());
    expect(r2.status).toBe(403);
    expect(r2.json.error.details.reason).toBe('company_not_opted_in');
    await enableAi();
    const r3 = await post(request(), { co: c.companyB });
    expect(r3.status).toBe(403);
    expect(m.execute).not.toHaveBeenCalled();
    expect(await jobs()).toHaveLength(0);
    expect(await draftAudits()).toEqual([]);
  });

  it('a provider error or offline is 503 AI_UNAVAILABLE', async () => {
    await enableAi();
    m.execute.mockRejectedValueOnce(new Error('upstream said: rent from Kumquat Hall'));
    const r1 = await post(request());
    expect(r1.status).toBe(503);
    expect(r1.json.error).toMatchObject({ code: 'AI_UNAVAILABLE', details: { provider: 'anthropic', reason: 'provider_error' } });
    expect(JSON.stringify(r1.json)).not.toContain('Kumquat');
    m.execute.mockRejectedValueOnce(new OfflineUnavailableError('ai'));
    const r2 = await post(request());
    expect(r2.status).toBe(503);
    expect(r2.json.error.details.reason).toBe('offline');
    expect((await jobs()).map((r) => r.status)).toEqual(['failed', 'failed']);
    // The provider was not reached: no audit row (Q-A10k).
    expect(await draftAudits()).toEqual([]);
  });

  it('no provider, or the chat function off, is 503 without a call or a job', async () => {
    await enableAi();
    await db.update(aiConfig).set({ chatProvider: null, categorizationProvider: null });
    const r1 = await post(request());
    expect(r1.status).toBe(503);
    expect(r1.json.error).toMatchObject({ code: 'AI_UNAVAILABLE', details: { provider: null, reason: 'no_provider' } });
    await db.update(aiConfig).set({ chatProvider: 'anthropic', taskOptions: { chat: { enabled: false } } });
    const r2 = await post(request());
    expect(r2.status).toBe(503);
    expect(r2.json.error.details.reason).toBe('function_disabled');
    expect(m.execute).not.toHaveBeenCalled();
    expect(await jobs()).toHaveLength(0);
    expect(await draftAudits()).toEqual([]);
  });

  it('a self-hosted provider (Ollama) answers as self_hosted', async () => {
    await enableAi();
    await db.update(aiConfig).set({ chatProvider: 'ollama', chatModel: 'llama3' });
    m.execute.mockResolvedValueOnce(reply(GOOD, { provider: 'ollama', model: 'llama3' }));
    const res = await post(request());
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json).toMatchObject({ reader: 'self_hosted', provider: 'ollama', savable: true });
    // executeWithFallback(params, rawConfig, fallbackChain, provider, model, opts): the local provider was asked.
    expect(m.execute.mock.calls[0]![3]).toBe('ollama');
  });

  it('validates the request: a description of 1 to 1,000 characters, no extra keys', async () => {
    await enableAi();
    expect((await post(request({ description: '   ' }))).status).toBe(400);
    expect((await post(request({ description: 'x'.repeat(1001) }))).status).toBe(400);
    expect((await post({ ...request(), amountMin: '500' })).status).toBe(400);
    expect((await post(request({ datePresets: ['This Year'] }))).status).toBe(400);
    // One-shot (owner 2026-11-15): no existing definition to redraft.
    const redraft = await post(request({ definition: { schemaVersion: 1, kind: 'builder' } }));
    expect(redraft.status).toBe(400);
    expect(redraft.json.error.code).toBe('VALIDATION_ERROR');
    expect(m.execute).not.toHaveBeenCalled();
    expect(await draftAudits()).toEqual([]);
  });
});

describe('report draft helpers (no database)', () => {
  it('node ids are engine-made letters', () => {
    expect([0, 1, 25, 26, 27, 199].map(nodeIdFor)).toEqual(['row_a', 'row_b', 'row_z', 'row_aa', 'row_ab', 'row_gr']);
    for (let i = 0; i < 200; i++) expect(nodeIdFor(i)).toMatch(/^row_[a-z]+$/);
  });

  it('the structural digits are explicit: aging bucket keys are the only digit-bearing enum keys', () => {
    expect(DRAFT_STRUCTURAL_DIGITS.enumKeys).toEqual(['d1_30', 'd31_60', 'd61_90', 'over_90']);
    expect(DRAFT_STRUCTURAL_DIGITS.schemaVersion).toEqual([1]);
    expect(DRAFT_STRUCTURAL_DIGITS.termSign).toEqual([1, -1]);
  });

  it('prescreen drops free text at the top level and does not mistake ordinary words for ids', () => {
    expect(prescreen({ dates: 'range', rows: [], summary: 'Rent is high', paid: 'yes', valid: 'ok' }))
      .toEqual({ kept: { dates: 'range', rows: [] }, amountRows: new Set(), amountTop: false });
    expect(() => prescreen({ dates: 'range', rows: [], tag_ids: 'x' })).toThrow();
  });

  it('maskNumbers: amounts become [AMOUNT], other numbers [NUMBER], and nothing numeric survives', () => {
    expect(maskNumbers('Bills between 100 and 500 in 2026, or over $1,250.75').text).toBe('Bills between [AMOUNT] and [AMOUNT] in [NUMBER], or over [AMOUNT]');
    expect(maskNumbers('Bills over five hundred dollars')).toEqual({ text: 'Bills over [AMOUNT]', masked: true, amountLike: true });
    expect(maskNumbers('Bills 500€ and up').text).toBe('Bills [AMOUNT] and up');
    expect(maskNumbers('Bills 100-500').text).toBe('Bills [NUMBER]-[NUMBER]');
    expect(maskNumbers('one hundred and fifty, a thousand, half a million, two dozen').text).toBe('[NUMBER], [NUMBER], [NUMBER], [NUMBER]');
    expect(maskNumbers('the last 12 months')).toEqual({ text: 'the last [NUMBER] months', masked: true, amountLike: false });
    expect(maskNumbers('Grand total, second quarter, someone often')).toEqual({ text: 'Grand total, second quarter, someone often', masked: false, amountLike: false });
    // Roman numerals are letters and stay (Ⅻ folds to XII under NFKC).
    expect(maskNumbers('Phase Ⅻ and phase IV')).toEqual({ text: 'Phase XII and phase IV', masked: false, amountLike: false });
    for (const s of ['٥٠٠', '５００', '१२३', '½', '²', '①', '𝟓', '5\u200B00', '1 000 000', "1'000", '.5', '0x1F']) {
      expect(maskNumbers(s).text, s).not.toMatch(/\p{N}/u);
      expect(maskNumbers(s).masked, s).toBe(true);
    }
  });

  it('notes follow the description: an amount or limit in any form, else numbers_not_used', () => {
    const codes = (d: string) => draftNotes(d, false, [], [], false).map((n) => n.code);
    expect(codes('income for 2026')).toEqual(['numbers_not_used']);
    expect(codes('Two dozen vendors')).toEqual(['numbers_not_used']);
    expect(codes('Bills over five hundred dollars')).toEqual(['amount_filter_left_out']);
    expect(codes('Bills of 5e3')).toEqual(['amount_filter_left_out']);
    expect(codes('Bills by vendor')).toEqual([]);
    // The engine's own note texts hold no number either.
    const all = [...draftNotes('sales over $500', true, ['preset_left_out'], ['row_b'], false), ...draftNotes('in 2026', false, [], [], false)];
    expect(all.map((n) => n.code).sort()).toEqual(['amount_filter_left_out', 'numbers_not_used', 'pick_unresolved', 'preset_left_out']);
    for (const n of all) {
      expect(n.message).not.toMatch(/\p{N}/u);
      expect(hasNumberWord(n.message), n.message).toBe(false);
    }
    expect(draftNotes('sales over $500 in 2026', true, ['preset_left_out'], ['row_b'], false).map((n) => [n.code, n.nodeId]))
      .toEqual([['pick_unresolved', undefined], ['amount_filter_left_out', 'row_b'], ['preset_left_out', undefined]]);
  });

  it('the number word list is explicit; period words, "grand" and Roman numerals are not on it', () => {
    expect(NUMBER_WORDS).toEqual(expect.arrayContaining(['zero', 'one', 'five', 'twelve', 'fifty', 'ninety', 'hundred', 'thousand', 'million', 'dozen']));
    for (const w of ['quarter', 'second', 'first', 'half', 'grand', 'gross', 'score', 'xii']) expect(NUMBER_WORDS).not.toContain(w);
    for (const s of ['Five hundred', 'Twenty-five vendors', 'One-time customers', 'Fi\u200Bve', 'THOUSANDS', 'Over a grand']) expect(hasNumberWord(s), s).toBe(true);
    for (const s of ['Grand total', 'A grand total', 'Second quarter', 'Someone often', 'Phase XII', 'Gross profit', 'Tenant fees']) expect(hasNumberWord(s), s).toBe(false);
  });

  it('ambiguous names are labelled with one lookup per kind', async () => {
    const calls: Array<[string, string[]]> = [];
    const resolver = { resolve: async (_k: string, texts: string[]) => new Map(texts.map((t) => [t.toLowerCase(), [`${t}-x`, `${t}-y`]])) };
    const labeler = { labels: async (kind: string, ids: string[]) => { calls.push([kind, ids]); return new Map(ids.map((id) => [id, id.toUpperCase()])); } };
    const site = (kind: 'contact' | 'item', name: string) => ({ kind, name, nodeId: 'row_a', path: `p.${name}`, set: () => {} });
    const out = await resolveNames([site('contact', 'Alpha'), site('contact', 'Beta'), site('item', 'Gamma'), site('contact', 'Alpha')], '', resolver as never, labeler as never);
    expect(calls.map(([k, ids]) => [k, ids.length])).toEqual([['contact', 4], ['item', 2]]);
    expect(out.map((u) => [u.name, u.candidates.length, u.sites.length])).toEqual([['Alpha', 2, 2], ['Beta', 2, 1], ['Gamma', 2, 1]]);
  });
});
