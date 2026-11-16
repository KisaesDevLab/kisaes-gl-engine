// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// Sensitive accounts (U-33) canary sweep. Walks every GET route of the REAL
// app (app._router.stack) as a bookkeeper without the sensitive_accounts
// right, after the owner marked "Canary Wages" (and so its sub-account) and
// one "Canary …" account of every other account type a report or a builder
// source reads (seedCanaries). Every response must either be 403
// SENSITIVE_HIDDEN on a route not in CONVERTED, or contain no canary: a
// hidden account's name or id, a hidden line's own amount, or an owner-only
// sum. Converted routes never answer SENSITIVE_HIDDEN. The owner run proves
// the seed is live.
//
// POST read routes (PR 2): every POST route under the refuse prefixes is
// either converted, and then has live bodies in POST_CASES (the owner gets
// 200 and, for account-reading bodies, sees a canary; the bookkeeper gets an
// answer with no canary), or not converted, and then the bookkeeper's call is
// 403 SENSITIVE_HIDDEN (refused in authenticate, before any write). Report
// Builder drills are taken from the owner's runs (every drill path, hidden
// accounts' included), so a drill keyed on a hidden account is exercised.
// AI routes (draft, Ask) run with a stubbed provider: the prompt the model
// would see is checked, not only the response.
//
// Path parameters are filled in turn with a visible bank account id, a
// hidden account id, transactions with hidden lines and a saved report that
// names a hidden account. The bank side of a paycheck (amount and payee) and
// document totals on control accounts are accepted leaks (§3), so those
// amounts are not canaries. Saved report definitions keep the ids they name
// (the desktop shows "Hidden account" for an id with no name), so on the
// definition routes a hidden id is allowed; names and amounts are not.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// The sweep sends well over the 300/min global budget; throttling is not what it tests.
vi.mock('express-rate-limit', async (orig) => {
  const real = await orig<typeof import('express-rate-limit')>();
  const pass = () => (_req: unknown, _res: unknown, next: () => void) => next();
  return { ...real, default: pass, rateLimit: pass };
});
const m = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('../services/ai-providers/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/ai-providers/index.js')>()),
  executeWithFallback: (...a: unknown[]) => m.execute(...a),
}));
import type { Express } from 'express';
import { eq } from 'drizzle-orm';
import { BUILDER_STARTERS } from '@kis-books/shared';
import { db } from '../db/index.js';
import { aiConfig, companies } from '../db/schema/index.js';
import * as aiConfigService from '../services/ai-config.service.js';
import * as aiConsent from '../services/ai-consent.service.js';
import * as ledger from '../services/ledger.service.js';
import { isConvertedRoute, underRefusePrefix } from '../services/visibility.js';
import { startSensitiveHarness, seedCanaries, type SensitiveHarness, type CanarySeed, type Who, type CallResult } from './sensitive.test-fixtures.js';

let h: SensitiveHarness;
let seed: CanarySeed;
let hiddenTxn = '';
let mixedTxn = '';
let savedDefId = '';
let savedDefVersion = 1;

interface Route { method: string; path: string }

// Express 4 mount regexp -> literal path ('' for '/'), or null for a mount
// we can't reproduce (parameterized or regexp mounts).
function mountPath(layer: { regexp: RegExp & { fast_slash?: boolean }; keys?: unknown[] }): string | null {
  if (layer.regexp.fast_slash) return '';
  if (layer.keys && layer.keys.length > 0) return null;
  const mm = /^\^(.*)\\\/\?\(\?=\\\/\|\$\)$/.exec(layer.regexp.source);
  if (!mm) return null;
  const p = mm[1]!.replace(/\\\//g, '/').replace(/\\\./g, '.').replace(/\\-/g, '-');
  return /[\\()[\]*+?^$]/.test(p) ? null : p;
}

function collect(stack: any[], prefix: string, out: Route[]): void {
  for (const layer of stack) {
    if (layer.route) {
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      for (const p of paths) {
        if (typeof p !== 'string') continue;
        for (const mth of Object.keys(layer.route.methods)) out.push({ method: mth.toUpperCase(), path: prefix + p });
      }
    } else if (layer.handle?.stack && Array.isArray(layer.handle.stack)) {
      const mp = mountPath(layer);
      if (mp !== null) collect(layer.handle.stack, prefix + mp, out);
    }
  }
}

async function routesOf(): Promise<Route[]> {
  const { app } = await import('../app.js');
  const routes: Route[] = [];
  collect(((app as Express & { _router: { stack: any[] } })._router).stack, '', routes);
  return routes;
}

// Families with nothing to sweep here: sign-in, platform admin, the
// desktop supervisor channel, OAuth and third-party connectors.
const SKIP = ['/api/v1/auth', '/api/v1/admin', '/api/v1/desktop', '/api/v1/plaid', '/oauth', '/api/v1/bank-connect', '/api/v1/portal', '/api/portal'];
const RANGE = 'start_date=2026-01-01&end_date=2026-12-31&startDate=2026-01-01&endDate=2026-12-31&from=2026-01-01&to=2026-12-31&as_of_date=2026-12-31&limit=500';
const FY = ['2025-01-01', '2026-01-01'];

const reply = (parsed: unknown) => ({
  text: JSON.stringify(parsed), parsed, inputTokens: 100, outputTokens: 40, model: 'claude-test', provider: 'anthropic', durationMs: 5,
});

async function enableAi(): Promise<void> {
  await aiConsent.acceptSystemDisclosure(h.ownerId);
  await aiConfigService.updateConfig({ isEnabled: true, chatProvider: 'anthropic', chatModel: 'claude-test', anthropicApiKey: 'sk-test-fake-key' });
  const cfg = await aiConfigService.getRawConfig();
  await db.update(companies).set({
    aiEnabled: true, aiDisclosureAcceptedAt: new Date(), aiDisclosureAcceptedBy: h.ownerId,
    aiDisclosureVersion: cfg.disclosureVersion ?? 1, aiEnabledTasks: { report_summary: true },
  }).where(eq(companies.id, h.companyId));
}

beforeAll(async () => {
  h = await startSensitiveHarness('sens-sweep');
  const post = (memo: string, txnType: string, lines: Array<{ accountId: string; debit: string; credit: string }>) =>
    ledger.postTransaction(h.tenantId, { txnType: txnType as never, txnDate: '2026-03-01', memo, lines }, h.ownerId, h.companyId);
  await post('sale', 'deposit', [{ accountId: h.acct.bank, debit: '1000.00', credit: '0' }, { accountId: h.acct.sales, debit: '0', credit: '1000.00' }]);
  await post('paper', 'expense', [{ accountId: h.acct.supplies, debit: '10.00', credit: '0' }, { accountId: h.acct.bank, debit: '0', credit: '10.00' }]);
  hiddenTxn = (await post('payroll', 'check', [{ accountId: h.acct.wagesSub, debit: '4321.09', credit: '0' }, { accountId: h.acct.bank, debit: '0', credit: '4321.09' }])).id;
  mixedTxn = (await post('mixed', 'journal_entry', [
    { accountId: h.acct.wages, debit: '1234.57', credit: '0' },
    { accountId: h.acct.supplies, debit: '5.00', credit: '0' },
    { accountId: h.acct.bank, debit: '0', credit: '1239.57' },
  ])).id;
  seed = await seedCanaries(h);
  await h.markWages();
  // A saved report the owner made that names a hidden account (and a visible one).
  const def = await h.call('owner', 'POST', '/api/v1/report-builder/definitions', {
    name: 'Owner wages report', definition: {
      schemaVersion: 1, kind: 'builder', title: 'Wages and supplies', dates: { mode: 'range' }, basis: 'accrual',
      columns: { detailFields: ['date', 'account', 'amount'], compare: [], headers: {} },
      nodes: [{
        type: 'section', id: 'w', caption: 'Wages', source: 'gl', measure: 'amount', polarity: 'debit',
        filters: [{ field: 'account', op: 'in', ids: [h.acct.wages, h.acct.supplies] }], groupBy: [{ key: 'account' }],
        display: 'detail', defaultExpanded: true, showTotal: true, hideZero: false,
      }],
    },
  });
  if (def.status !== 201) throw new Error(`saved definition: ${def.status} ${def.text}`);
  savedDefId = def.json.id;
  savedDefVersion = def.json.version;
  await db.delete(aiConfig);
  await enableAi();
}, 180_000);

afterAll(async () => {
  await db.delete(aiConfig);
  await h.close();
});

function canariesIn(text: string, opts: { idsAllowed?: boolean } = {}): string[] {
  const c = ['Canary', ...(opts.idsAllowed ? [] : seed.hiddenIds), ...seed.amounts];
  return c.filter((x) => text.includes(x));
}

/**
 * Converted POST routes that write and read no amounts; report-builder.sensitive.routes.test.ts covers them (a
 * hidden id in a saved definition is NOT_IN_COMPANY; groups name no account).
 */
const WRITES_TESTED_ELSEWHERE = ['/api/v1/report-builder/definitions', '/api/v1/report-builder/definition-groups'];

/**
 * Accepted gaps (Q-P29a, §3): a total over every visible line of a mixed entry is minus its hidden line. Removed from
 * the text before the scan, in that signed form only, so the hidden line itself (a debit of 1234.57) is still a leak.
 */
const ACCEPTED_GAPS: Array<{ path: string; text: string }> = [
  // The Journal's totals: the mixed entry's visible lines (5.00 debit, 1239.57 credit) total -1234.57.
  { path: '/api/v1/reports/journal-entry-report', text: '-1234.57' },
];
const withoutGaps = (path: string, text: string) =>
  ACCEPTED_GAPS.filter((g) => g.path === path).reduce((t, g) => t.split(g.text).join(''), text);

/** Definition routes return the ids a saved report names (allowed); names and amounts never. */
const idsAllowedOn = (path: string) => /^\/api\/v1\/report-builder\/definitions(\/[0-9a-f-]{36})?$/i.test(path.split('?')[0]!);

describe('sensitive accounts canary sweep', () => {
  it('no GET route leaks a hidden account to the bookkeeper', async () => {
    const routes = await routesOf();
    const gets = routes.filter((r) => r.method === 'GET' && r.path.startsWith('/api/') && !SKIP.some((s) => r.path.startsWith(s)));
    expect(gets.length).toBeGreaterThan(200);

    const fills = [h.acct.bank, h.acct.wages, seed.hidden.revenue, hiddenTxn, mixedTxn, seed.invoiceId, seed.allHiddenTxn, savedDefId];
    const leaks: string[] = [];
    let refused = 0;
    let checked = 0;
    const seen = new Set<string>();
    for (const r of gets) {
      const variants = r.path.includes(':') ? fills.map((id) => r.path.replace(/:[A-Za-z_]+(\([^)]*\))?\??/g, id)) : [r.path];
      // A converted route is also read in its exact and CSV forms (other routers serve them on the same path).
      const forms = (p: string) => (isConvertedRoute('GET', p) ? ['', '&exact=1', '&format=csv'] : ['']);
      for (const path of variants.flatMap((p) => forms(p).map((f) => `${p}\u0000${f}`))) {
        if (seen.has(path)) continue;
        seen.add(path);
        const [p0, form] = path.split('\u0000') as [string, string];
        const res = await Promise.race([
          h.call('bk', 'GET', `${p0}?${RANGE}${form}`),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 20_000)),
        ]);
        if (res === null) continue; // a stream or long poll; nothing returned
        checked++;
        const label = `${p0}${form ? ` [${form.slice(1)}]` : ''}`;
        if (res.status === 429) { leaks.push(`${label}: 429 (rate limited, not checked)`); continue; }
        const converted = isConvertedRoute('GET', p0);
        if (res.status === 403 && res.json?.error?.code === 'SENSITIVE_HIDDEN') {
          refused++;
          if (converted) leaks.push(`${label}: converted route refused`);
          continue;
        }
        const found = canariesIn(withoutGaps(p0, res.text), { idsAllowed: idsAllowedOn(p0) });
        if (found.length > 0) leaks.push(`${label} (${res.status}): ${found.join(', ')}`);
      }
    }
    // eslint-disable-next-line no-console
    if (leaks.length > 0) console.log(`sweep leaks:\n${leaks.join('\n')}`);
    expect(refused).toBeGreaterThan(10);
    expect(checked).toBeGreaterThan(200);
    expect(leaks).toEqual([]);
  }, 1_200_000);

  it('no POST read route leaks a hidden account to the bookkeeper', async () => {
    const leaks: string[] = [];
    const swept = new Set<string>();
    const R = { from: '2026-01-01', to: '2026-12-31' };

    /** One POST read: the owner must answer 200 (and show a canary when `live`); the bookkeeper must not leak. */
    const check = async (label: string, path: string, body: unknown, o: { live?: boolean; prompt?: boolean; okStatus?: number[]; scan?: (json: any) => unknown } = {}) => {
      const key = path.split('?')[0]!;
      swept.add(`POST ${key}`);
      const converted = isConvertedRoute('POST', key);
      const ownerCalls = m.execute.mock.calls.length;
      const own = await h.call('owner', 'POST', path, body);
      if (own.status !== 200) { leaks.push(`${label}: owner ${own.status} ${own.text.slice(0, 200)} (seed not live)`); return null; }
      const ownPrompt = o.prompt ? JSON.stringify(m.execute.mock.calls.slice(ownerCalls)) : '';
      if (o.live && canariesIn(own.text + ownPrompt).length === 0) leaks.push(`${label}: owner sees no canary (seed not live)`);
      const before = m.execute.mock.calls.length;
      const bk = await h.call('bk', 'POST', path, body);
      if (bk.status === 403 && bk.json?.error?.code === 'SENSITIVE_HIDDEN') {
        if (converted) leaks.push(`${label}: converted route refused`);
        return { own, bk };
      }
      if (!converted) leaks.push(`${label}: unconverted route answered ${bk.status}, not SENSITIVE_HIDDEN`);
      if (bk.status !== 200 && !(o.okStatus ?? []).includes(bk.status)) leaks.push(`${label}: bookkeeper ${bk.status} ${bk.text.slice(0, 200)}`);
      const sent = o.prompt ? JSON.stringify(m.execute.mock.calls.slice(before)) : '';
      const text = o.scan && bk.json ? JSON.stringify(o.scan(bk.json)) : bk.text;
      const found = canariesIn(text + sent, { idsAllowed: idsAllowedOn(key) });
      if (found.length > 0) leaks.push(`${label} (${bk.status}): ${found.join(', ')}`);
      return { own, bk };
    };

    // Report Builder runs: every starter, a section per line source in detail, Trial Balance tag mode, a saved report,
    // preview and export purposes. Then every drill path of the owner's runs, as each viewer.
    const runs: Array<{ label: string; body: Record<string, unknown>; live: boolean }> = [];
    for (const st of BUILDER_STARTERS) {
      const def = st.definition as { dates: { mode: string } };
      runs.push({
        label: `run starter ${st.key}`, live: ['profit_loss', 'balance_sheet', 'trial_balance', 'transaction_detail_by_account', 'expenses_by_category', 'revenue_by_category'].includes(st.key),
        body: { definition: st.definition, dates: def.dates.mode === 'range' ? R : { asOf: '2026-12-31' }, fiscalYearStarts: FY, expandAll: true },
      });
    }
    const section = (id: string, source: string, measure: string, extra: Record<string, unknown> = {}) => ({
      type: 'section', id, caption: id, source, measure, filters: [], groupBy: [{ key: 'account' }],
      display: 'detail', defaultExpanded: true, showTotal: true, hideZero: false, ...extra,
    });
    const allSources = {
      schemaVersion: 1, kind: 'builder', title: 'All sources', dates: { mode: 'range' },
      columns: { detailFields: ['date', 'account', 'item', 'description', 'amount'], compare: [], headers: {} },
      nodes: [
        section('gl_debit', 'gl', 'amount', { polarity: 'debit' }), section('gl_cnt', 'gl', 'count'),
        section('gl_dr', 'gl', 'debit'), section('gl_cr', 'gl', 'credit'),
        section('sales', 'sales', 'amount'), section('item_sales', 'item_sales', 'amount', { groupBy: [{ key: 'item' }] }),
        section('purchases', 'purchases', 'amount'), section('item_purchases', 'item_purchases', 'amount', { groupBy: [{ key: 'item' }, { key: 'account' }] }),
        section('by_type', 'gl', 'amount', { polarity: 'debit', groupBy: [{ key: 'account_type' }] }),
        { type: 'formula', id: 'f', caption: 'Sales less purchases', terms: [{ nodeId: 'sales', sign: 1 }, { nodeId: 'purchases', sign: -1 }] },
      ],
    };
    runs.push({ label: 'run all sources', live: true, body: { definition: allSources, dates: R, fiscalYearStarts: FY, expandAll: true } });
    runs.push({ label: 'run all sources cash', live: true, body: { definition: allSources, dates: R, fiscalYearStarts: FY, expandAll: true, basis: 'cash' } });
    runs.push({ label: 'run all sources preview', live: true, body: { definition: allSources, dates: R, fiscalYearStarts: FY, expandAll: true, purpose: 'preview' } });
    runs.push({ label: 'run all sources export', live: true, body: { definition: allSources, dates: R, fiscalYearStarts: FY, expandAll: true, purpose: 'export' } });
    const balances = (detailFields: string[], compare: unknown[]) => ({
      schemaVersion: 1, kind: 'builder', title: 'Balances', dates: { mode: 'range' },
      columns: { detailFields, compare, headers: {}, percentOf: 'section' },
      nodes: [
        section('bal', 'gl', 'balance', { filters: [{ field: 'account_type', op: 'in', values: ['asset', 'liability', 'equity'] }], polarity: 'debit', earnings: 'balance_sheet' }),
        section('flow', 'gl', 'amount', { filters: [{ field: 'account_type', op: 'in', values: ['expense', 'cogs', 'other_expense'] }] }),
      ],
    });
    runs.push({ label: 'run balances, periods, compare', live: true, body: {
      definition: balances(['date', 'account', 'amount'], [{ base: 'prior_year', amount: true, dollarChange: true, percentChange: true }]),
      dates: R, fiscalYearStarts: FY, expandAll: true, periodRanges: [{ from: '2026-01-01', to: '2026-06-30' }, { from: '2026-07-01', to: '2026-12-31' }],
    } });
    runs.push({ label: 'run balances, running balance', live: true, body: {
      definition: balances(['date', 'account', 'amount', 'running_balance'], []), dates: { from: '2026-04-02', to: '2026-12-31' }, fiscalYearStarts: FY, expandAll: true,
    } });
    const tbTag = {
      schemaVersion: 1, kind: 'builder', title: 'Tagged TB', dates: { mode: 'asOf' },
      columns: { detailFields: [], compare: [], headers: {} },
      nodes: [section('tb', 'gl', 'tb_net', { filters: [{ field: 'tag', op: 'in', ids: [seed.tagId] }], earnings: 'trial_balance', display: 'summary' })],
    };
    // Its hidden figure is the prior years' earnings only (asserted exactly in report-builder.sensitive.routes.test.ts).
    runs.push({ label: 'run TB tag mode', live: false, body: { definition: tbTag, dates: { asOf: '2026-12-31' }, fiscalYearStarts: FY, expandAll: true } });
    runs.push({ label: 'run TB tag mode cash', live: false, body: { definition: tbTag, dates: { asOf: '2026-12-31' }, fiscalYearStarts: FY, expandAll: true, basis: 'cash' } });
    runs.push({ label: 'run saved report', live: true, body: { definitionId: savedDefId, version: savedDefVersion, dates: R, fiscalYearStarts: FY, expandAll: true } });

    for (const run of runs) {
      const res = await check(run.label, '/api/v1/report-builder/run', run.body, { live: run.live });
      if (!res) continue;
      // Every drill of the owner's run (hidden accounts' paths included), as each viewer.
      const drills = (res.own.json.rows as Array<{ drill?: { type: string; nodeId: string; path: string[] } | null }>)
        .map((r) => r.drill).filter((d): d is { type: string; nodeId: string; path: string[] } => !!d && d.type === 'detail');
      const { open: _o, collapsed: _c, expandAll: _e, purpose: _p, ...ref } = run.body as Record<string, unknown>;
      for (const d of drills.slice(0, 40)) {
        await check(`${run.label} drill ${d.path.join('/')}`, '/api/v1/report-builder/run/detail',
          { ...ref, nodeId: d.nodeId, path: d.path, fingerprint: res.own.json.fingerprint, stamp: res.own.json.stamp },
          { okStatus: [404] });
      }
    }

    // Report files: export of the saved report naming a hidden account; import preview of a file naming one.
    await check('export saved report', '/api/v1/report-builder/definitions/export', { ids: [savedDefId] }, { live: true });
    const file = {
      reports: [{
        name: 'Imported wages', kind: 'builder', groupName: null,
        definition: {
          schemaVersion: 1, kind: 'builder', title: 'Imported', dates: { mode: 'range' },
          columns: { detailFields: [], compare: [], headers: {} },
          nodes: [section('w', 'gl', 'amount', { polarity: 'debit', filters: [{ field: 'account', op: 'in', ids: ['$ref:0', '$ref:1'] }] })],
        },
        references: [
          { kind: 'account', name: 'Canary Wages', number: '6999', accountType: 'expense' },
          { kind: 'account', name: 'Supplies', number: '6000', accountType: 'expense' },
        ],
      }],
    };
    // The preview echoes the file's own references (the caller sent them); everything else must hold no canary.
    const prev = await check('import preview', '/api/v1/report-builder/definitions/import/preview', file, {
      live: false,
      scan: (j: { reports: Array<Record<string, any>> }) => j.reports.map((r) => ({ ...r, unresolved: r['unresolved'].map((u: Record<string, unknown>) => ({ ...u, reference: null })) })),
    });
    if (prev && prev.bk.status === 200) {
      const own = prev.own.json.reports[0];
      if (!JSON.stringify(own.definition).includes(h.acct.wages)) leaks.push('import preview: owner did not resolve Canary Wages (seed not live)');
    }

    // AI: the draft and Ask, with a model reply naming a hidden account. The prompt is checked too.
    m.execute.mockReset().mockResolvedValue(reply({
      title: 'Wages', dates: 'range', datePreset: null, basis: 'accrual', periods: null, agingBuckets: false, compare: [], percentOf: null,
      detailFields: ['date', 'account'], rows: [{ type: 'section', label: 'w', caption: 'Wages', source: 'gl', measure: 'amount', polarity: 'debit',
        filters: [{ field: 'account', op: 'in', names: ['Canary Wages', 'Supplies'] }], groupBy: [{ key: 'account' }] }],
    }));
    await check('AI draft', '/api/v1/report-builder/draft', { description: 'Wages and supplies by account', datePresets: [] }, { live: true, prompt: true, okStatus: [422] });
    m.execute.mockReset().mockResolvedValue(reply({
      reportKey: 'profit_and_loss', datePreset: null, from: '2026-01-01', to: '2026-12-31', asOf: null, basis: null, columns: null, extras: [],
      filters: { accountNames: ['Canary Wages'], contactNames: [], tagNames: [] },
    }));
    await check('Ask', '/api/v1/reports/ask', {
      question: 'What did we spend on wages this year?', datePresets: [],
      reports: [{ key: 'profit_and_loss', title: 'Profit and Loss', params: ['range', 'accounts'] }],
    }, { live: true, prompt: true, okStatus: [422] });

    // The ledger reports' converted POST forms.
    for (const p of ['/api/v1/reports/general-ledger?exact=1', '/api/v1/reports/transaction-list?exact=1']) {
      await check(`POST ${p}`, p, { start_date: '2026-01-01', end_date: '2026-12-31', account_ids: [...seed.hiddenIds, h.acct.supplies] }, { live: true });
    }

    // Every POST route under the refuse prefixes: converted ones were swept above with live bodies; any other refuses
    // the bookkeeper in authenticate (before it reads the body or writes anything).
    const posts = (await routesOf()).filter((r) => r.method === 'POST' && underRefusePrefix(r.path.toLowerCase()));
    expect(posts.length).toBeGreaterThan(20);
    for (const r of posts) {
      const path = r.path.replace(/:[A-Za-z_]+(\([^)]*\))?\??/g, savedDefId);
      if (isConvertedRoute('POST', path.toLowerCase())) {
        if (WRITES_TESTED_ELSEWHERE.includes(r.path)) continue;
        if (![...swept].some((s) => s.toLowerCase() === `post ${path.toLowerCase()}`)) leaks.push(`POST ${r.path}: converted but no live body in the sweep`);
        continue;
      }
      if (swept.has(`POST ${path}`)) continue;
      const bk: CallResult = await h.call('bk' as Who, 'POST', path, {});
      if (!(bk.status === 403 && bk.json?.error?.code === 'SENSITIVE_HIDDEN') && ![401, 404].includes(bk.status)) {
        leaks.push(`POST ${r.path}: unconverted route answered ${bk.status} ${bk.text.slice(0, 120)}`);
      }
    }

    // eslint-disable-next-line no-console
    if (leaks.length > 0) console.log(`POST sweep leaks:\n${leaks.join('\n')}`);
    expect(leaks).toEqual([]);
  }, 900_000);

  it('the seed is live: the owner sees the canaries', async () => {
    const accts = await h.call('owner', 'GET', '/api/v1/accounts?limit=500');
    expect(canariesIn(accts.text)).toEqual(expect.arrayContaining(['Canary', ...seed.hiddenIds]));
    const tl = await h.call('owner', 'GET', `/api/v1/reports/transaction-list?${RANGE}`);
    for (const a of ['1234.57', '2111.13', '3222.24', '4333.35', '6555.57', '7666.68', '1777.79', '1444.45']) expect(tl.text).toContain(a);
    // The budget canary: the owner's month of expense budget holds the hidden line.
    const bp = await h.call('owner', 'GET', '/api/v1/dashboard/budget-performance');
    expect(bp.text).toContain('877.71');
  });
});
