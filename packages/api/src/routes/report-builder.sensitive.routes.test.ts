// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// Sensitive accounts (U-33 part 2) in the Report Builder, report files, the
// AI draft and Ask, over the REAL app, as a bookkeeper without the
// sensitive_accounts right (exact strings, both bases):
//   - nothing marked: the bookkeeper's run is the owner's, hiddenNotice null;
//   - runs leave hidden lines out of rows, totals, earnings and drills, and
//     tie to the standard reports for the same viewer (Q-P29a, §7);
//   - a drill keyed on a hidden account is 404; a hidden account gives no
//     MIXED_POLARITY hint;
//   - a saved report naming a hidden account: canEdit false, hiddenRefs and
//     hidden (no name); PUT and DELETE 403 SENSITIVE_DEFINITION; it still
//     runs, hidden (Q-309); a hidden id sent in a definition is answered as
//     an id not in this company;
//   - .clreport export names a hidden account {kind, missing: true}; the
//     import preview never matches, offers or accepts one;
//   - the AI draft and Ask never send, resolve or keep a hidden name.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const m = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('../services/ai-providers/index.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/ai-providers/index.js')>()),
  executeWithFallback: (...a: unknown[]) => m.execute(...a),
}));
import DecimalLib from 'decimal.js';
import { eq } from 'drizzle-orm';
import { BUILDER_STARTERS } from '@kis-books/shared';
import { db } from '../db/index.js';
import { aiConfig, companies } from '../db/schema/index.js';
import * as aiConfigService from '../services/ai-config.service.js';
import * as aiConsent from '../services/ai-consent.service.js';
import * as ledger from '../services/ledger.service.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';
import { startSensitiveHarness, seedCanaries, type SensitiveHarness, type CanarySeed, type Who } from './sensitive.test-fixtures.js';

const Decimal = DecimalLib.default || DecimalLib;
let h: SensitiveHarness;
let seed: CanarySeed;
const R = { from: '2026-01-01', to: '2026-12-31' };
const FY = ['2025-01-01', '2026-01-01'];
const RB = '/api/v1/report-builder';

const reply = (parsed: unknown) => ({
  text: JSON.stringify(parsed), parsed, inputTokens: 100, outputTokens: 40, model: 'claude-test', provider: 'anthropic', durationMs: 5,
});

const starter = (key: string) => BUILDER_STARTERS.find((s) => s.key === key)!.definition as { dates: { mode: string } };
const runBody = (definition: unknown, over: Record<string, unknown> = {}) => {
  const mode = (definition as { dates: { mode: string } }).dates.mode;
  return { definition, dates: mode === 'range' ? R : { asOf: '2026-12-31' }, fiscalYearStarts: FY, expandAll: true, ...over };
};
const run = (who: Who, body: unknown) => h.call(who, 'POST', `${RB}/run`, body);

function noCanary(text: string): void {
  expect(text).not.toContain('Canary');
  for (const id of seed.hiddenIds) expect(text).not.toContain(id);
  for (const a of seed.amounts) expect(text).not.toContain(a);
}

type Row = { kind: string; nodeId: string; caption: string; cells: Array<string | null>; path: string[]; drill?: { type: string; nodeId: string; path: string[] } | null };
const rowsOf = (res: { json: { rows: Row[] } }) => res.json.rows;
const totalCell = (rows: Row[], nodeId: string) => rows.find((r) => r.kind === 'total' && r.nodeId === nodeId)!.cells.find((c) => c !== null)!;

function section(id: string, extra: Record<string, unknown> = {}) {
  return {
    type: 'section', id, caption: id, source: 'gl', measure: 'amount', filters: [], groupBy: [{ key: 'account' }],
    display: 'detail', defaultExpanded: true, showTotal: true, hideZero: false, ...extra,
  };
}
const builder = (nodes: unknown[], over: Record<string, unknown> = {}) => ({
  schemaVersion: 1, kind: 'builder', title: 'T', dates: { mode: 'range' }, columns: { detailFields: ['date', 'account', 'amount'], compare: [], headers: {} }, nodes, ...over,
});

beforeAll(async () => {
  h = await startSensitiveHarness('sens-rb');
  const post = (memo: string, txnType: string, lines: Array<{ accountId: string; debit: string; credit: string }>) =>
    ledger.postTransaction(h.tenantId, { txnType: txnType as never, txnDate: '2026-03-01', memo, lines }, h.ownerId, h.companyId);
  await post('sale', 'deposit', [{ accountId: h.acct.bank, debit: '1000.00', credit: '0' }, { accountId: h.acct.sales, debit: '0', credit: '1000.00' }]);
  await post('paper', 'expense', [{ accountId: h.acct.supplies, debit: '10.00', credit: '0' }, { accountId: h.acct.bank, debit: '0', credit: '10.00' }]);
  await post('payroll', 'check', [{ accountId: h.acct.wagesSub, debit: '4321.09', credit: '0' }, { accountId: h.acct.bank, debit: '0', credit: '4321.09' }]);
  await post('mixed', 'journal_entry', [
    { accountId: h.acct.wages, debit: '1234.57', credit: '0' },
    { accountId: h.acct.supplies, debit: '5.00', credit: '0' },
    { accountId: h.acct.bank, debit: '0', credit: '1239.57' },
  ]);
}, 120_000);

afterAll(async () => {
  await db.delete(aiConfig);
  await h.close();
});

describe('Report Builder for a viewer without sensitive_accounts (U-33 part 2)', () => {
  it('advertises sensitive-accounts-builder-v1', () => {
    expect(DESKTOP_CAPABILITIES).toContain('sensitive-accounts-builder-v1');
  });

  it('nothing marked: the bookkeeper runs what the owner runs, hiddenNotice null', async () => {
    for (const key of ['profit_loss', 'balance_sheet', 'trial_balance']) {
      const body = runBody(starter(key));
      const bk = await run('bk', body);
      const own = await run('owner', body);
      expect(bk.status, bk.text.slice(0, 200)).toBe(200);
      expect(bk.json.meta.hiddenNotice).toBeNull();
      expect(bk.json).toEqual(own.json);
    }
  });

  it('after marking: rows, totals and earnings leave hidden accounts out and tie to the standard reports (both bases)', async () => {
    seed = await seedCanaries(h);
    await h.markWages();
    for (const basis of ['accrual', 'cash'] as const) {
      const pl = await run('bk', runBody(starter('profit_loss'), { basis }));
      expect(pl.status, pl.text.slice(0, 300)).toBe(200);
      expect(pl.json.meta.hiddenNotice).toBe(true);
      noCanary(pl.text);
      // Supplies 10 + 5 (+ 20 on the accrual bill; a bill unpaid is no cash).
      expect(new Decimal(totalCell(rowsOf(pl), 'expenses')).toFixed(2)).toBe(basis === 'accrual' ? '35.00' : '15.00');
      const net = rowsOf(pl).find((r) => r.kind === 'formula' && /net income/i.test(r.caption))!;
      const std = await h.call('bk', 'GET', `/api/v1/reports/profit-loss?start_date=2026-01-01&end_date=2026-12-31&basis=${basis}&exact=1`);
      expect(std.json.hiddenNotice).toBe(true);
      expect(new Decimal(net.cells.find((c) => c !== null)!).eq(new Decimal(std.json.netIncomeExact))).toBe(true);
      const ownPl = await run('owner', runBody(starter('profit_loss'), { basis }));
      expect(ownPl.json.meta.hiddenNotice).toBeNull();
      expect(ownPl.text).toContain('Canary Wages');

      // Balance Sheet: this year's earnings row = the bookkeeper's net income (the same rule everywhere).
      const bs = await run('bk', runBody(starter('balance_sheet'), { basis }));
      expect(bs.status).toBe(200);
      expect(bs.json.meta.hiddenNotice).toBe(true);
      noCanary(bs.text);
      const ni = rowsOf(bs).find((r) => r.kind === 'earnings' && r.path[1] === 'earnings:current')!;
      expect(new Decimal(ni.cells.find((c) => c !== null)!).eq(new Decimal(std.json.netIncomeExact))).toBe(true);

      // Trial Balance: debits - credits = the standard TB's for this viewer (the gap is the hidden net, Q-P29a).
      const tb = await run('bk', runBody(starter('trial_balance'), { basis }));
      expect(tb.status).toBe(200);
      noCanary(tb.text);
      const tot = rowsOf(tb).find((r) => r.kind === 'total')!.cells.filter((c) => c !== null) as string[];
      const stdTb = await h.call('bk', 'GET', `/api/v1/reports/trial-balance?start_date=2026-01-01&end_date=2026-12-31&basis=${basis}&exact=1`);
      expect(new Decimal(tot[0]!).minus(tot[1]!).eq(new Decimal(stdTb.json.totalDebitsExact).minus(stdTb.json.totalCreditsExact))).toBe(true);
    }
  });

  it('drills: rows sum to the row, no hidden line; a drill keyed on a hidden account is 404', async () => {
    const body = runBody(starter('profit_loss'));
    const bk = await run('bk', body);
    const own = await run('owner', body);
    const ref = { definition: body.definition, dates: body.dates, fiscalYearStarts: FY, fingerprint: bk.json.fingerprint, stamp: bk.json.stamp };
    const d = await h.call('bk', 'POST', `${RB}/run/detail`, { ...ref, nodeId: 'expenses', path: ['n:expenses'] });
    expect(d.status, d.text.slice(0, 200)).toBe(200);
    noCanary(d.text);
    expect(d.json.subtotal.find((c: string | null) => c !== null)).toBe(totalCell(rowsOf(bk), 'expenses'));
    const hiddenPath = rowsOf(own).find((r) => r.kind === 'line' && r.path[1] === `account:${h.acct.wages}`)!.path;
    const hd = await h.call('bk', 'POST', `${RB}/run/detail`, { ...ref, nodeId: hiddenPath[0]!.slice(2), path: hiddenPath });
    expect(hd.status).toBe(404);
    noCanary(hd.text);
    // The owner drills it.
    expect((await h.call('owner', 'POST', `${RB}/run/detail`, { ...ref, nodeId: hiddenPath[0]!.slice(2), path: hiddenPath })).text).toContain('1234.57');
  });

  it('Trial Balance tag mode: prior years\' earnings leave the hidden line out (both bases)', async () => {
    const def = builder([section('tb', { measure: 'tb_net', earnings: 'trial_balance', display: 'summary', filters: [{ field: 'tag', op: 'in', ids: [seed.tagId] }] })],
      { dates: { mode: 'asOf' }, columns: { detailFields: [], compare: [], headers: {} } });
    for (const basis of ['accrual', 'cash'] as const) {
      const bk = await run('bk', runBody(def, { basis }));
      expect(bk.status, bk.text.slice(0, 300)).toBe(200);
      noCanary(bk.text);
      const re = rowsOf(bk).find((r) => r.kind === 'earnings')!;
      expect(re.cells.filter((c) => c !== null)).toEqual(['11.6900']);
      const own = await run('owner', runBody(def, { basis }));
      expect(rowsOf(own).find((r) => r.kind === 'earnings')!.cells.filter((c) => c !== null)).toEqual(['3011.0000']);
    }
  });

  it('a hidden account gives no MIXED_POLARITY hint; an inline hidden id is NOT_IN_COMPANY, as an unknown id', async () => {
    const mixed = builder([section('m', { filters: [{ field: 'account', op: 'in', ids: [h.acct.wages, h.acct.sales] }] })]);
    const saved = await h.call('owner', 'POST', `${RB}/definitions`, { name: 'Mixed', definition: mixed });
    expect(saved.status).toBe(201);
    const ownRun = await run('owner', { definitionId: saved.json.id, dates: R, fiscalYearStarts: FY });
    expect(ownRun.json.error.details.code).toBe('MIXED_POLARITY');
    const bkRun = await run('bk', { definitionId: saved.json.id, dates: R, fiscalYearStarts: FY });
    expect(bkRun.status, bkRun.text.slice(0, 200)).toBe(200);
    noCanary(bkRun.text);

    const inline = await run('bk', runBody(builder([section('w', { polarity: 'debit', filters: [{ field: 'account', op: 'in', ids: [h.acct.wages] }] })])));
    const unknown = await run('bk', runBody(builder([section('w', { polarity: 'debit', filters: [{ field: 'account', op: 'in', ids: ['00000000-0000-4000-8000-000000000001'] }] })])));
    expect(inline.status).toBe(400);
    expect(inline.json.error.code).toBe('DEFINITION_INVALID');
    expect(inline.json.error.details.code).toBe('NOT_IN_COMPANY');
    // The same answer as an unknown id, but for the id itself.
    expect(JSON.stringify(inline.json).split(h.acct.wages).join('X')).toBe(JSON.stringify(unknown.json).split('00000000-0000-4000-8000-000000000001').join('X'));
    const create = await h.call('bk', 'POST', `${RB}/definitions`, { name: 'Sneaky', definition: builder([section('w', { polarity: 'debit', filters: [{ field: 'account', op: 'in', ids: [h.acct.wages] }] })]) });
    expect(create.status).toBe(400);
    expect(create.json.error.details.code).toBe('NOT_IN_COMPANY');
  });

  it('a saved report naming a hidden account: listed read-only with hiddenRefs, runs hidden, can\'t be changed (Q-309)', async () => {
    const def = builder([section('w', { polarity: 'debit', filters: [{ field: 'account', op: 'in', ids: [h.acct.wages, h.acct.supplies] }] })]);
    const saved = await h.call('owner', 'POST', `${RB}/definitions`, { name: 'Owner wages', definition: def });
    expect(saved.status).toBe(201);
    const id = saved.json.id as string;
    expect(saved.json.hiddenRefs).toBeUndefined();
    expect(saved.json.canEdit).toBe(true);

    const got = await h.call('bk', 'GET', `${RB}/definitions/${id}`);
    expect(got.status).toBe(200);
    expect(got.json).toMatchObject({ canEdit: false, hiddenRefs: true, missing: [], hidden: [{ path: 'definition.nodes.0.filters.0.ids', nodeId: 'w', field: 'account', kind: 'account', ids: [h.acct.wages] }] });
    expect(got.text).not.toContain('Canary');
    const list = await h.call('bk', 'GET', `${RB}/definitions`);
    const row = list.json.definitions.find((d: { id: string }) => d.id === id);
    expect(row).toMatchObject({ canEdit: false, hiddenRefs: true });
    expect(list.text).not.toContain('Canary');
    // A bookkeeper's own report naming only visible accounts stays editable.
    const mine = await h.call('bk', 'POST', `${RB}/definitions`, { name: 'Mine', definition: builder([section('s', { polarity: 'debit', filters: [{ field: 'account', op: 'in', ids: [h.acct.supplies] }] })]) });
    expect(mine.status).toBe(201);
    expect(mine.json.canEdit).toBe(true);
    expect(mine.json.hiddenRefs).toBeUndefined();

    const put = await h.call('bk', 'PUT', `${RB}/definitions/${id}`, { version: saved.json.version, name: 'Renamed' });
    expect(put.status).toBe(403);
    expect(put.json.error.code).toBe('SENSITIVE_DEFINITION');
    const del = await h.call('bk', 'DELETE', `${RB}/definitions/${id}?version=${saved.json.version}`);
    expect(del.status).toBe(403);
    expect(del.json.error.code).toBe('SENSITIVE_DEFINITION');

    const ran = await run('bk', { definitionId: id, version: saved.json.version, dates: R, fiscalYearStarts: FY, expandAll: true });
    expect(ran.status).toBe(200);
    expect(ran.json.meta.hiddenNotice).toBe(true);
    noCanary(ran.text);
    expect(totalCell(rowsOf(ran), 'w')).toBe('35.0000');
    const ownRan = await run('owner', { definitionId: id, version: saved.json.version, dates: R, fiscalYearStarts: FY, expandAll: true });
    expect(totalCell(rowsOf(ownRan), 'w')).toBe('1269.5700');
    // The owner may still change it.
    expect((await h.call('owner', 'PUT', `${RB}/definitions/${id}`, { version: saved.json.version, name: 'Renamed' })).status).toBe(200);
  });

  it('.clreport export names a hidden account {kind, missing}; the import preview never matches, offers or accepts one', async () => {
    const def = builder([section('w', { polarity: 'debit', filters: [{ field: 'account', op: 'in', ids: [h.acct.wages, h.acct.supplies] }] })]);
    const saved = await h.call('owner', 'POST', `${RB}/definitions`, { name: 'Export me', definition: def });
    const bk = await h.call('bk', 'POST', `${RB}/definitions/export`, { ids: [saved.json.id] });
    expect(bk.status).toBe(200);
    expect(bk.text).not.toContain('Canary');
    expect(bk.text).not.toContain('6999');
    expect(bk.json.reports[0].references).toEqual([
      { kind: 'account', missing: true },
      { kind: 'account', name: 'Supplies', number: '6000', accountType: 'expense' },
    ]);
    const own = await h.call('owner', 'POST', `${RB}/definitions/export`, { ids: [saved.json.id] });
    expect(own.json.reports[0].references[0]).toEqual({ kind: 'account', name: 'Canary Wages', number: '6999', accountType: 'expense' });

    const file = { reports: [{ ...own.json.reports[0], name: 'Imported' }] };
    const prev = await h.call('bk', 'POST', `${RB}/definitions/import/preview`, file);
    expect(prev.status).toBe(200);
    const rep = prev.json.reports[0];
    expect(rep.ready).toBe(false);
    expect(rep.unresolved.map((u: { ref: string }) => u.ref)).toEqual(['$ref:0']);
    expect(rep.unresolved[0].candidates).toEqual([]);
    expect(JSON.stringify(rep.definition)).not.toContain(h.acct.wages);
    // A reference by number alone: still no candidate.
    const byNumber = await h.call('bk', 'POST', `${RB}/definitions/import/preview`, {
      reports: [{ ...file.reports[0], references: [{ kind: 'account', name: 'Something else', number: '6999' }, file.reports[0].references[1]] }],
    });
    expect(byNumber.json.reports[0].unresolved[0].candidates).toEqual([]);
    // Choosing the hidden id is the error of an id not in this company.
    const chosen = await h.call('bk', 'POST', `${RB}/definitions/import/preview`, { ...file, choices: { '0:$ref:0': h.acct.wages } });
    const unknown = await h.call('bk', 'POST', `${RB}/definitions/import/preview`, { ...file, choices: { '0:$ref:0': '00000000-0000-4000-8000-000000000001' } });
    expect(chosen.status).toBe(400);
    expect(chosen.json).toEqual(unknown.json);
    // The owner's preview resolves it.
    const ownPrev = await h.call('owner', 'POST', `${RB}/definitions/import/preview`, file);
    expect(JSON.stringify(ownPrev.json.reports[0].definition)).toContain(h.acct.wages);
  });

  it('AI draft and Ask: hidden names are never sent, resolved or kept', async () => {
    await aiConsent.acceptSystemDisclosure(h.ownerId);
    await aiConfigService.updateConfig({ isEnabled: true, chatProvider: 'anthropic', chatModel: 'claude-test', anthropicApiKey: 'sk-test-fake-key' });
    const cfg = await aiConfigService.getRawConfig();
    await db.update(companies).set({
      aiEnabled: true, aiDisclosureAcceptedAt: new Date(), aiDisclosureAcceptedBy: h.ownerId,
      aiDisclosureVersion: cfg.disclosureVersion ?? 1, aiEnabledTasks: { report_summary: true },
    }).where(eq(companies.id, h.companyId));
    const draftReply = reply({
      title: 'Wages', dates: 'range', datePreset: null, basis: 'accrual', periods: null, agingBuckets: false, compare: [], percentOf: null,
      detailFields: ['date', 'account'], rows: [{ type: 'section', label: 'w', caption: 'Wages', source: 'gl', measure: 'amount', polarity: 'debit',
        filters: [{ field: 'account', op: 'in', names: ['Canary Wages', 'Supplies'] }], groupBy: [{ key: 'account' }] }],
    });
    const sentText = (from: number) => JSON.stringify(m.execute.mock.calls.slice(from));

    m.execute.mockReset().mockResolvedValue(draftReply);
    const bk = await h.call('bk', 'POST', `${RB}/draft`, { description: 'Wages and supplies by account', datePresets: [] });
    expect(bk.status, bk.text.slice(0, 300)).toBe(200);
    expect(sentText(0)).not.toContain('Canary');
    noCanary(bk.text);
    expect(bk.json.savable).toBe(false);
    expect(bk.json.unresolved).toEqual([expect.objectContaining({ kind: 'account', name: null, reason: 'not_found', candidates: [] })]);
    const before = m.execute.mock.calls.length;
    const own = await h.call('owner', 'POST', `${RB}/draft`, { description: 'Wages and supplies by account', datePresets: [] });
    expect(sentText(before)).toContain('Canary Wages');
    expect(own.json.savable).toBe(true);
    expect(own.text).toContain(h.acct.wages);

    m.execute.mockReset().mockResolvedValue(reply({
      reportKey: 'profit_and_loss', datePreset: null, from: '2026-01-01', to: '2026-12-31', asOf: null, basis: null, columns: null, extras: [],
      filters: { accountNames: ['Canary Wages'], contactNames: [], tagNames: [] },
    }));
    const askBody = { question: 'What did we spend this year?', datePresets: [], reports: [{ key: 'profit_and_loss', title: 'Profit and Loss', params: ['range', 'accounts'] }] };
    const ask = await h.call('bk', 'POST', '/api/v1/reports/ask', askBody);
    expect(sentText(0)).not.toContain('Canary');
    noCanary(ask.text);
    expect([200, 422]).toContain(ask.status);
    const ownBefore = m.execute.mock.calls.length;
    const ownAsk = await h.call('owner', 'POST', '/api/v1/reports/ask', askBody);
    expect(sentText(ownBefore)).toContain('Canary Wages');
    expect(ownAsk.status).toBe(200);
    expect(ownAsk.json.filters.accountIds).toEqual([h.acct.wages]);
  });
});
