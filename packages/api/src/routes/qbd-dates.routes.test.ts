// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.
//
// Conversion-date checks, history start and multi-year journals (U-266,
// qbd-dates-v1; ClientLedger P31 E2c). Synthetic QuickBooks Desktop files:
// reference files, open items and the valuation must be dated the conversion
// date (IMPORT_DATE_MISMATCH, every file named); journal rows after it are
// refused with their row numbers; historyFrom skips earlier rows and counts
// them (no mapping, no closing-date password needed for them); a gap between
// the opening balances and the first journal row is a warning; one journal
// file per year commits and undoes exactly; overlapping journal files are
// refused, also inside the job; an inventory balance with no valuation fails
// a conversion.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { companies, importBatches, inventoryMovements, transactions } from '../db/schema/index.js';
import { importsRouter } from './imports.routes.js';
import * as importsService from '../services/imports/imports.service.js';
import * as batchService from '../services/imports/import-batch.service.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';
import { Harness, type Co, key } from './receivables.test-support.js';
import { companySnapshot, cleanImports, batchRow } from './imports-batch.test-support.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = any;

const CONV = '2025-12-31';
const h = new Harness();
let c: Co;

beforeEach(async () => {
  h.extraCleanup = [cleanImports, async (tid) => {
    await db.delete(inventoryMovements).where(eq(inventoryMovements.tenantId, tid));
  }];
  await h.start([['/api/v1/imports', importsRouter]]);
  c = await h.company();
});
afterEach(async () => { await h.stop(); });

// ── Synthetic QuickBooks Desktop files ────────────────────────────

const COA = `,Account,Type,Balance Total,Description,Accnt. #,Tax Line
,"81010 · Checking",Bank,"1,000.00",,81010,
,"81300 · Inventory Asset",Other Current Asset,63.50,,81300,
,"83000 · Opening Balance Equity",Equity,"-1,063.50",,83000,
,"84000 · Sales",Income,0.00,,84000,
,"85000 · Cost of Goods Sold",Cost of Goods Sold,0.00,,85000,
,"86000 · Supplies",Expense,0.00,,86000,
`;

const asOf = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  const month = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][m! - 1];
  return `"As of ${month} ${d}, ${y}"`;
};

function tb(date: string, inventory = '0.00'): string {
  const inv = inventory === '0.00' ? '' : `"81300 · Inventory Asset",${inventory},\n`;
  const equity = (1000 + Number(inventory)).toFixed(2);
  return `"Trial Balance"\n${asOf(date)}\n,Debit,Credit\n"81010 · Checking","1,000.00",\n${inv}"83000 · Opening Balance Equity",,"${equity}"\nTOTAL,,\n`;
}

/** One check per day given (MM/DD/YYYY from ISO), Supplies against Checking; an `account` replaces Supplies. */
function journal(dates: string[], account = '86000 · Supplies'): string {
  const lines = [',Trans #,Type,Date,Num,Name,Memo,Account,Debit,Credit'];
  dates.forEach((iso, i) => {
    const [y, m, d] = iso.split('-');
    lines.push(`,${i + 1},Check,${m}/${d}/${y},${700 + i},,Paper,${account},12.25,`, ',,,,,,Paper,81010 · Checking,,12.25', ',,,,,,,,12.25,12.25');
  });
  return `${lines.join('\n')}\n`;
}

function openInvoices(date: string | null): string {
  return `"Open Invoices"\n${date ? `${asOf(date)}\n` : ''},,Type,Date,Num,Due Date,Amount,Open Balance\nTOTAL,,,,,,,0.00\n`;
}

const ITEMS = `,Item,Description,Type,Cost,Price,Sales Tax Code,Account,COGS Account,Asset Account,Preferred Vendor,Active Status
,Widget,Blue widget,Inventory Part,4.25,9.99,Tax,84000 · Sales,85000 · Cost of Goods Sold,81300 · Inventory Asset,,Active
`;

type Kind = 'coa' | 'trial_balance' | 'gl_transactions' | 'open_invoices' | 'unpaid_bills' | 'items' | 'inventory_valuation';

function valuation(date: string): string {
  return `"Inventory Valuation Summary"
${asOf(date)}
,,On Hand,Avg Cost,Asset Value
,"Widget",2,4.25,8.50
TOTAL,,2,,8.50
`;
}

async function upload(name: string, text: string, kind: Kind, role: 'post' | 'reference' = 'post', options: Record<string, unknown> = {}) {
  const out = await importsService.createSession({
    tenantId: c.tenantId, companyId: c.companyId, userId: c.userId,
    file: { originalname: name, buffer: Buffer.from(text, 'latin1') },
    kind, sourceSystem: 'quickbooks_desktop', options: options as never, role,
  });
  expect(out.validationErrors, `${name}: ${JSON.stringify(out.validationErrors)}`).toEqual([]);
  return out.session.id;
}

async function createBatch(sessionIds: string[], options: Record<string, unknown> = {}) {
  return h.request('POST', '/api/v1/imports/batches', c.token, {
    sourceSystem: 'quickbooks_desktop', kind: 'conversion', sessionIds, options: { conversionDate: CONV, ...options },
  });
}

async function commitId(id: string, body: Record<string, unknown> = {}) {
  const cm = await h.request('POST', `/api/v1/imports/batches/${id}/commit`, c.token, { backupRef: 'before-import.clb', ...body }, { 'Idempotency-Key': key() });
  if (cm.status === 202) await batchService.__batchJobs.last;
  const b = await h.request('GET', `/api/v1/imports/batches/${id}`, c.token);
  return { commit: cm, batch: b.json['batch'] as Body, error: b.json['error'] as Body };
}

async function commit(sessionIds: string[], options: Record<string, unknown> = {}) {
  const r = await createBatch(sessionIds, options);
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const id = String(r.json['batch'].id);
  return { id, created: r.json['batch'] as Body, ...(await commitId(id)) };
}

async function undo(id: string) {
  const u = await h.request('POST', `/api/v1/imports/batches/${id}/undo`, c.token, { backupRef: 'before-undo.clb' }, { 'Idempotency-Key': key() });
  expect(u.status, JSON.stringify(u.json)).toBe(202);
  await batchService.__batchJobs.last;
  expect((await batchRow(id)).status).toBe('undone');
}

const posted = async () => (await db.select({ d: transactions.txnDate }).from(transactions)
  .where(and(eq(transactions.tenantId, c.tenantId), eq(transactions.txnType, 'journal_entry')))).map((t) => String(t.d).slice(0, 10)).sort();

describe('U-266 conversion date', () => {
  it('advertises qbd-dates-v1', () => {
    expect(DESKTOP_CAPABILITIES).toContain('qbd-dates-v1');
  });

  it('names every file not dated the conversion date (422 IMPORT_DATE_MISMATCH); a posted trial balance may be earlier, never later', async () => {
    const ids = [
      await upload('coa.csv', COA, 'coa'),
      await upload('opening-tb.csv', tb('2024-12-31'), 'trial_balance'),
      await upload('tb-ref.csv', tb('2025-11-30'), 'trial_balance', 'reference'),
      await upload('open-invoices.csv', openInvoices('2025-12-30'), 'open_invoices'),
      await upload('unpaid-bills.csv', '"Unpaid Bills Detail"\n,,Type,Date,Num,Due Date,Open Balance\nTOTAL,,,,,,0.00\n', 'unpaid_bills'),
      await upload('valuation.csv', valuation('2025-12-01'), 'inventory_valuation'),
    ];
    const r = await createBatch(ids);
    expect(r.status, JSON.stringify(r.json)).toBe(422);
    expect(r.json['error'].code).toBe('IMPORT_DATE_MISMATCH');
    const files = (r.json['error'].details.files as Body[]).map((f) => [f.originalFilename, f.reportDate, f.reason]).sort();
    expect(files).toEqual([
      ['open-invoices.csv', '2025-12-30', 'not_conversion_date'],
      ['tb-ref.csv', '2025-11-30', 'not_conversion_date'],
      ['unpaid-bills.csv', null, 'no_date'],
      ['valuation.csv', '2025-12-01', 'not_conversion_date'],
    ]);
    expect(r.json['error'].details.conversionDate).toBe(CONV);

    const late = await upload('tb-late.csv', tb('2026-01-31'), 'trial_balance');
    const r2 = await createBatch([late]);
    expect([r2.status, r2.json['error'].code, r2.json['error'].details.files[0].reason]).toEqual([422, 'IMPORT_DATE_MISMATCH', 'after_conversion']);

    // The same files with the right dates make a batch; without conversionDate nothing is checked.
    const ok = await createBatch([await upload('tb-ref2.csv', tb(CONV), 'trial_balance', 'reference'),
      await upload('oi2.csv', openInvoices(CONV), 'open_invoices')]);
    expect(ok.status, JSON.stringify(ok.json)).toBe(201);
    const free = await h.request('POST', '/api/v1/imports/batches', c.token, { sourceSystem: 'quickbooks_desktop', kind: 'single', sessionIds: [ids[2]] });
    expect(free.status, JSON.stringify(free.json)).toBe(201);
  });

  it('refuses journal rows after the conversion date with their row numbers; historyFrom after it is 400', async () => {
    const gl = await upload('journal-2025.csv', journal(['2025-06-15', '2026-01-02', '2026-01-05']), 'gl_transactions');
    const r = await createBatch([gl]);
    expect(r.status, JSON.stringify(r.json)).toBe(422);
    expect(r.json['error'].code).toBe('IMPORT_JOURNAL_AFTER_CONVERSION');
    expect(r.json['error'].details.rowCount).toBe(2);
    expect((r.json['error'].details.rows as Body[]).map((x) => [x.sessionId, x.rowNumber, x.date, x.code])).toEqual([
      [gl, 5, '2026-01-02', 'IMPORT_JOURNAL_AFTER_CONVERSION'],
      [gl, 8, '2026-01-05', 'IMPORT_JOURNAL_AFTER_CONVERSION'],
    ]);
    const bad = await createBatch([gl], { historyFrom: '2026-02-01' });
    expect([bad.status, bad.json['error'].code]).toEqual([400, 'IMPORT_BAD_DATE']);
    expect(await db.select().from(importBatches).where(eq(importBatches.tenantId, c.tenantId))).toEqual([]);
  });
});

describe('U-266 history start and several journal files', () => {
  it('one journal file per year commits as one batch, no warnings; undo restores exactly', async () => {
    const before = await companySnapshot(c);
    const ids = [
      await upload('coa.csv', COA, 'coa'),
      await upload('opening-tb.csv', tb('2023-12-31'), 'trial_balance'),
      await upload('journal-2024.csv', journal(['2024-01-01', '2024-07-01', '2024-12-31']), 'gl_transactions'),
      await upload('journal-2025.csv', journal(['2025-01-01', '2025-12-31']), 'gl_transactions'),
      await upload('tb-ref.csv', tb(CONV), 'trial_balance', 'reference'),
    ];
    const { id, created, batch, error } = await commit(ids);
    expect(created.dateCheck).toEqual({
      conversionDate: CONV, historyFrom: null, historySkipped: 0, openingBalanceDate: '2023-12-31', firstJournalDate: '2024-01-01', warnings: [],
    });
    expect(batch.status, JSON.stringify(error)).toBe('committed');
    expect(batch.dateCheck).toEqual(created.dateCheck);
    expect(batch.result.dateCheck).toEqual(created.dateCheck);
    expect(await posted()).toEqual(['2023-12-31', '2024-01-01', '2024-07-01', '2024-12-31', '2025-01-01', '2025-12-31']);
    await undo(id);
    expect(await companySnapshot(c)).toEqual(before);
  });

  it('two journal files sharing a day are refused (409 IMPORT_PERIOD_OVERLAP), in one batch and against a committed one', async () => {
    const a = await upload('journal-2024.csv', journal(['2024-03-01', '2024-12-31']), 'gl_transactions');
    const b = await upload('journal-2025.csv', journal(['2024-12-31', '2025-05-01']), 'gl_transactions');
    const coa = await upload('coa.csv', COA, 'coa');
    const r = await createBatch([coa, a, b]);
    expect([r.status, r.json['error'].code, r.json['error'].details.from, r.json['error'].details.to]).toEqual([409, 'IMPORT_PERIOD_OVERLAP', '2024-12-31', '2024-12-31']);
    const first = await commit([coa, a]);
    expect(first.batch.status, JSON.stringify(first.error)).toBe('committed');
    const again = await createBatch([b]);
    expect([again.status, again.json['error'].code]).toEqual([409, 'IMPORT_PERIOD_OVERLAP']);
  });

  it('the commit job re-checks overlap under the company lock: a batch prechecked before another committed fails, nothing posted', async () => {
    const coa = await upload('coa.csv', COA, 'coa');
    const a = await upload('journal-a.csv', journal(['2025-02-01', '2025-03-01']), 'gl_transactions');
    const b = await upload('journal-b.csv', journal(['2025-03-01', '2025-04-01']), 'gl_transactions');
    const ra = await createBatch([coa, a]);
    const rb = await createBatch([b]);
    expect([ra.status, rb.status]).toEqual([201, 201]);
    const first = await commitId(String(ra.json['batch'].id));
    expect(first.batch.status, JSON.stringify(first.error)).toBe('committed');
    const snap = await companySnapshot(c);
    // As if b's precheck had passed before a committed: claim it and run its job directly.
    const bid = String(rb.json['batch'].id);
    await db.update(importBatches).set({ status: 'committing' }).where(eq(importBatches.id, bid));
    await expect(batchService.runCommitJob({ tenantId: c.tenantId, companyId: c.companyId, userId: c.userId, batchId: bid }))
      .rejects.toMatchObject({ code: 'IMPORT_PERIOD_OVERLAP' });
    const row = await batchRow(bid);
    expect([row.status, (row.error as Body).code]).toEqual(['failed', 'IMPORT_PERIOD_OVERLAP']);
    expect(await companySnapshot(c)).toEqual(snap);
  });

  it('an open-items file is never refused for overlapping a committed journal', async () => {
    const coa = await upload('coa.csv', COA, 'coa');
    const first = await commit([coa, await upload('journal.csv', journal(['2025-10-01', '2025-12-31']), 'gl_transactions')]);
    expect(first.batch.status, JSON.stringify(first.error)).toBe('committed');
    const oi = `"Open Invoices"\n${asOf(CONV)}\n,,Type,Date,Num,Due Date,Amount,Open Balance\n"Elm Ltd",,,,,,,\n,,Invoice,11/15/2025,2001,12/15/2025,80.00,80.00\n"Total Elm Ltd",,,,,,,80.00\nTOTAL,,,,,,,80.00\n`;
    const r = await createBatch([await upload('open-invoices.csv', oi, 'open_invoices')]);
    expect(r.status, JSON.stringify(r.json)).toBe(201);
  });

  it('historyFrom skips earlier rows and counts them: no mapping or closing-date password for them; a gap is a warning', async () => {
    const before = await companySnapshot(c);
    const ids = [
      await upload('coa.csv', COA, 'coa'),
      await upload('tb-ref.csv', tb(CONV), 'trial_balance', 'reference'),
      await upload('journal-2025.csv', journal(['2025-01-10', '2025-02-20', '2025-03-15', '2025-06-15']), 'gl_transactions'),
      // Rows before historyFrom name an account no chart has: skipped rows need no mapping.
      await upload('journal-2024.csv', journal(['2024-05-05', '2024-09-09'], '89999 · Gone'), 'gl_transactions'),
    ];
    // The closing date is in the skipped part: no password is asked for.
    await db.update(companies).set({ lockDate: '2025-02-28' }).where(eq(companies.id, c.companyId));
    const lockedBefore = await companySnapshot(c);
    const r = await createBatch(ids, { historyFrom: '2025-03-01' });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    // The reference balances are not posted, so there is no opening date yet: no warning.
    expect(r.json['batch'].dateCheck).toMatchObject({ historySkipped: 4, openingBalanceDate: null, firstJournalDate: '2025-03-15', warnings: [] });
    const run = await commitId(String(r.json['batch'].id));
    expect([run.commit.status, run.batch.status], JSON.stringify(run)).toEqual([202, 'committed']);
    const gl = (run.batch.sessions as Body[]).filter((s) => s.kind === 'gl_transactions').map((s) => [s.originalFilename, s.commitResult.created, s.commitResult.skippedBeforeHistory]).sort();
    expect(gl).toEqual([['journal-2024.csv', 0, 2], ['journal-2025.csv', 2, 2]]);
    expect(await posted()).toEqual(['2025-03-15', '2025-06-15']);
    await undo(String(r.json['batch'].id));
    expect(await companySnapshot(c)).toEqual(lockedBefore);
    await db.update(companies).set({ lockDate: null }).where(eq(companies.id, c.companyId));
    expect(await companySnapshot(c)).toEqual(before);

    // Posted opening balances of Dec 31 and history from Mar 1: the gap is reported, never a refusal.
    const ids2 = [
      await upload('coa2.csv', COA.replace('Supplies', 'Office supplies'), 'coa'),
      await upload('opening-tb2.csv', tb('2024-12-31'), 'trial_balance'),
      await upload('journal-2025b.csv', journal(['2025-02-01', '2025-03-04']), 'gl_transactions'),
    ];
    const { batch, created, error } = await commit(ids2, { historyFrom: '2025-03-01' });
    expect(batch.status, JSON.stringify(error)).toBe('committed');
    expect(created.dateCheck.warnings).toEqual([expect.objectContaining({
      code: 'IMPORT_HISTORY_GAP', openingBalanceDate: '2024-12-31', firstJournalDate: '2025-03-04', days: 62,
    })]);
    expect(batch.result.dateCheck.historySkipped).toBe(1);
  });

  it('journal rows on or before the opening balances are a warning (they count twice)', async () => {
    const ids = [
      await upload('coa.csv', COA, 'coa'),
      await upload('opening-tb.csv', tb('2024-12-31'), 'trial_balance'),
      await upload('journal.csv', journal(['2024-12-31', '2025-01-01']), 'gl_transactions'),
    ];
    const r = await createBatch(ids);
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect((r.json['batch'].dateCheck.warnings as Body[]).map((w) => w.code)).toEqual(['IMPORT_JOURNAL_BEFORE_OPENING']);
    const g = await h.request('GET', `/api/v1/imports/batches/${String(r.json['batch'].id)}`, c.token);
    expect(g.json['batch'].dateCheck).toEqual(r.json['batch'].dateCheck);
    const fixed = await createBatch([await upload('journal-b.csv', journal(['2025-01-01']), 'gl_transactions')], { historyFrom: '2025-01-01' });
    expect(fixed.status, JSON.stringify(fixed.json)).toBe(201);
  });
});

describe('U-266 inventory valuation required', () => {
  it('a conversion whose conversion-date trial balance shows inventory and has no valuation fails (422 IMPORT_VALUATION_REQUIRED), nothing posted', async () => {
    await db.update(companies).set({ inventoryEnabled: true }).where(eq(companies.id, c.companyId));
    const before = await companySnapshot(c);
    const ids = [
      await upload('coa.csv', COA, 'coa'),
      await upload('items.csv', ITEMS, 'items'),
      await upload('tb.csv', tb(CONV, '63.50'), 'trial_balance'),
    ];
    const { batch, error } = await commit(ids);
    expect(batch.status).toBe('failed');
    expect(error, JSON.stringify(error)).toMatchObject({ code: 'IMPORT_VALUATION_REQUIRED', status: 422, details: { accounts: [{ sourceKey: '81300', balance: '63.50' }] } });
    expect(await companySnapshot(c)).toEqual(before);

    // The same with a reference trial balance at the conversion date (the opening balances carry none).
    const ref = await commit([
      await upload('coa-r.csv', COA.replace('Checking', 'Main checking'), 'coa'),
      await upload('items-r.csv', ITEMS.replace('Blue widget', 'Blue widget (r)'), 'items'),
      await upload('tb-ref.csv', `"Shoal Creek (synthetic)"\n${tb(CONV, '63.50')}`, 'trial_balance', 'reference'),
    ]);
    expect(ref.batch.status).toBe('failed');
    expect(ref.error).toMatchObject({ code: 'IMPORT_VALUATION_REQUIRED', details: { accounts: [{ sourceKey: '81300', balance: '63.50' }] } });
    expect(await companySnapshot(c)).toEqual(before);

    // No inventory on the trial balance: nothing to value, the conversion commits.
    const { batch: ok, error: e2 } = await commit([await upload('tb2.csv', tb(CONV), 'trial_balance', 'reference'),
      await upload('coa2.csv', COA.replace('Sales', 'Revenue'), 'coa')]);
    expect(ok.status, JSON.stringify(e2)).toBe('committed');
  });
});
