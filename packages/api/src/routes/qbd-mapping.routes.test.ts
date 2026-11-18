// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.
//
// QBD names, account and class mapping, items and inventory valuation (U-265,
// qbd-mapping-v1; ClientLedger P31 E2b). A synthetic QuickBooks Desktop
// conversion (chart, customers with a job and an inactive name, vendors, Other
// Names, Item Listing, trial balance at the conversion date, Open Invoices,
// Unpaid Bills, Inventory Valuation Summary; Latin-1) is committed as one
// batch: one contact per name (both kinds), the job folded into its customer,
// items through the item service, opening stock at the report's exact values
// against "Inventory before conversion" (0.00 after), Inventory Asset equal to
// the valuation. Undo restores the company exactly, the contact made 'both'
// included. Mapping: accountMatches over every row, strict batches (no
// suspense, every unmapped key listed), accountMap, classMap; paycheck
// employee names never stored.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import { and, eq, inArray, sql } from 'drizzle-orm';
import DecimalLib from 'decimal.js';
import { db } from '../db/index.js';
import { accounts, contacts, companies, items, tags, tagGroups, transactions, inventoryMovements, importRows, journalLines } from '../db/schema/index.js';
import { importsRouter } from './imports.routes.js';
import { reportsRouter } from './reports.routes.js';
import * as importsService from '../services/imports/imports.service.js';
import * as batchService from '../services/imports/import-batch.service.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';
import { ensureInventoryAccounts } from '../services/inventory.service.js';
import { Harness, type Co, key, accountBalance } from './receivables.test-support.js';
import { companySnapshot, cleanImports, batchRow } from './imports-batch.test-support.js';

const Decimal = DecimalLib.default || DecimalLib;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = any;
const dec = (x: unknown) => new Decimal(String(x ?? '0'));

const CONV = '2026-10-31';
const h = new Harness();
let c: Co;

beforeEach(async () => {
  h.extraCleanup = [cleanImports, async (tid) => {
    await db.delete(inventoryMovements).where(eq(inventoryMovements.tenantId, tid));
  }];
  await h.start([['/api/v1/imports', importsRouter], ['/api/v1/reports', reportsRouter]]);
  c = await h.company();
});
afterEach(async () => { await h.stop(); });

// ── Synthetic QuickBooks Desktop files (Latin-1) ──────────────────

const COA = `,Account,Type,Balance Total,Description,Accnt. #,Tax Line
,"91010 · Checking",Bank,"1,500.00",,91010,
,"91200 · Accounts Receivable",Accounts Receivable,"1,200.00",,91200,
,"91300 · Inventory Asset",Other Current Asset,63.50,,91300,
,"92000 · Accounts Payable",Accounts Payable,400.00,,92000,
,"93000 · Opening Balance Equity",Equity,"-2,363.50",,93000,
,"94000 · Sales",Income,0.00,,94000,
,"94100 · Merchandise Sales",Income,0.00,,94100,
,"95000 · Cost of Goods Sold",Cost of Goods Sold,0.00,,95000,
,"96000 · Supplies",Expense,0.00,,96000,
`;

const CUSTOMERS = `,Active Status,Customer,Balance,Balance Total,Company,Main Phone
,Active,Alder Café,"1,000.00","1,000.00",Alder Café LLC,555-0101
,Active,Alder Café:Kitchen remodel,700.00,700.00,,
,Active,Birch & Co,200.00,200.00,Birch & Co,555-0102
,Inactive,Dogwood Ltd,0.00,0.00,Dogwood Ltd,555-0104
`;

const VENDORS = `,Active Status,Vendor,Balance,Balance Total,Company,Main Phone
,Active,Cedar Supply,150.00,150.00,Cedar Supply Inc,555-0201
,Active,Birch & Co,250.00,250.00,Birch & Co,555-0102
`;

const OTHER_NAMES = `,Active Status,Other Name,Company,Main Phone
,Active,Fir Lending,Fir Lending Co,555-0301
`;

const ITEMS = `,Item,Description,Type,Cost,Price,Sales Tax Code,Account,COGS Account,Asset Account,Preferred Vendor,Active Status
,Consulting,Hourly consulting,Service,0.00,125.00,Non,94000 · Sales,,,,Active
,Widget,Blue widget,Inventory Part,4.25,9.99,Tax,94100 · Merchandise Sales,95000 · Cost of Goods Sold,91300 · Inventory Asset,Cedar Supply,Active
,Widget:Mini,Small widget,Inventory Part,1.10,2.50,Tax,94100 · Merchandise Sales,95000 · Cost of Goods Sold,91300 · Inventory Asset,,Active
,Old Service,,Service,,50.00,Non,94000 · Sales,,,,Inactive
,Spring Promo,,Discount,,10.0%,Tax,94000 · Sales,,,,Active
,State Tax,,Sales Tax Item,,6.0%,,,,,,Active
`;

const TB = `"Shoal Creek Outfitters (synthetic)"
"Trial Balance"
"As of October 31, 2026"
,Debit,Credit
"91010 · Checking","1,500.00",
"91200 · Accounts Receivable","1,200.00",
"91300 · Inventory Asset",63.50,
"92000 · Accounts Payable",,400.00
"93000 · Opening Balance Equity",,"2,363.50"
TOTAL,"2,763.50","2,763.50"
`;

/** The customer's own row under "<Customer> - Other", the job's under its own heading. */
const OPEN_INVOICES = `"Shoal Creek Outfitters (synthetic)"
"Open Invoices"
"As of October 31, 2026"
,,Type,Date,Num,Due Date,Amount,Open Balance
"Alder Café",,,,,,,
,"Alder Café - Other",,,,,,
,,Invoice,09/15/2026,1001,10/15/2026,300.00,300.00
,"Total Alder Café - Other",,,,,,300.00
,"Kitchen remodel",,,,,,
,,Invoice,10/01/2026,1002,10/31/2026,700.00,700.00
,"Total Kitchen remodel",,,,,,700.00
"Total Alder Café",,,,,,,"1,000.00"
"Birch & Co",,,,,,,
,,Invoice,10/05/2026,1003,11/04/2026,200.00,200.00
"Total Birch & Co",,,,,,,200.00
TOTAL,,,,,,,"1,200.00"
`;

const UNPAID_BILLS = `"Shoal Creek Outfitters (synthetic)"
"Unpaid Bills Detail"
"As of October 31, 2026"
,,Type,Date,Num,Due Date,Open Balance
"Birch & Co",,,,,,
,,Bill,10/10/2026,B-1,11/09/2026,250.00
"Cedar Supply",,,,,,
,,Bill,10/12/2026,B-2,11/11/2026,150.00
TOTAL,,,,,,400.00
`;

/** Widget's Avg Cost is printed rounded (4.33): 12 x 4.33 = 51.96, the report's value is 51.95. */
const VALUATION = `"Shoal Creek Outfitters (synthetic)"
"Inventory Valuation Summary"
"As of October 31, 2026"
,,,On Hand,Avg Cost,Asset Value,% of Tot Asset,Sales Price,Retail Value
"Inventory",,,,,,,,
,"Widget",,,,,,,
,,"Mini",10.5,1.10,11.55,18.2%,2.50,26.25
,,"Widget - Other",12,4.33,51.95,81.8%,9.99,119.88
,"Total Widget",,22.5,,63.50,100.0%,,146.13
"Total Inventory",,,22.5,,63.50,100.0%,,146.13
TOTAL,,,22.5,,63.50,100.0%,,146.13
`;

type Kind = 'coa' | 'contacts' | 'trial_balance' | 'gl_transactions' | 'open_invoices' | 'unpaid_bills' | 'items' | 'inventory_valuation';

async function upload(name: string, text: string, kind: Kind, options: Record<string, unknown> = {}) {
  return importsService.createSession({
    tenantId: c.tenantId, companyId: c.companyId, userId: c.userId,
    file: { originalname: name, buffer: Buffer.from(text, 'latin1') },
    kind, sourceSystem: 'quickbooks_desktop', options: options as never,
  });
}

async function uploadId(name: string, text: string, kind: Kind, options: Record<string, unknown> = {}) {
  const out = await upload(name, text, kind, options);
  expect(out.validationErrors, `${name}: ${JSON.stringify(out.validationErrors)}`).toEqual([]);
  return out.session.id;
}

async function uploadConversion() {
  return [
    await uploadId('accounts.csv', COA, 'coa'),
    await uploadId('customers.csv', CUSTOMERS, 'contacts', { contactKind: 'customer' }),
    await uploadId('vendors.csv', VENDORS, 'contacts', { contactKind: 'vendor' }),
    await uploadId('other-names.csv', OTHER_NAMES, 'contacts', { contactKind: 'other' }),
    await uploadId('items.csv', ITEMS, 'items'),
    await uploadId('tb.csv', TB, 'trial_balance'),
    await uploadId('open-invoices.csv', OPEN_INVOICES, 'open_invoices'),
    await uploadId('unpaid-bills.csv', UNPAID_BILLS, 'unpaid_bills'),
    await uploadId('valuation.csv', VALUATION, 'inventory_valuation'),
  ];
}

async function createBatch(sessionIds: string[], options: Record<string, unknown> = {}) {
  return h.request('POST', '/api/v1/imports/batches', c.token, {
    sourceSystem: 'quickbooks_desktop', kind: 'conversion', sessionIds, options: { conversionDate: CONV, ...options },
  });
}

/** Commits a batch; returns the 202 (or refusal) and, after the job, the batch. */
async function commit(sessionIds: string[], options: Record<string, unknown> = {}) {
  const r = await createBatch(sessionIds, options);
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  const id = String(r.json['batch'].id);
  const cm = await h.request('POST', `/api/v1/imports/batches/${id}/commit`, c.token, { backupRef: 'before-import.clb' }, { 'Idempotency-Key': key() });
  if (cm.status === 202) await batchService.__batchJobs.last;
  const b = await h.request('GET', `/api/v1/imports/batches/${id}`, c.token);
  return { id, commit: cm, batch: b.json['batch'] as Body, error: b.json['error'] as Body };
}

async function undo(id: string) {
  const u = await h.request('POST', `/api/v1/imports/batches/${id}/undo`, c.token, { backupRef: 'before-undo.clb' }, { 'Idempotency-Key': key() });
  expect(u.status, JSON.stringify(u.json)).toBe(202);
  await batchService.__batchJobs.last;
  expect((await batchRow(id)).status).toBe('undone');
}

async function inventoryOn(on = true) {
  await db.update(companies).set({ inventoryEnabled: on }).where(eq(companies.id, c.companyId));
}

async function accountByNumber(n: string) {
  const [a] = await db.select().from(accounts).where(and(eq(accounts.tenantId, c.tenantId), eq(accounts.accountNumber, n)));
  return a;
}

async function accountByName(name: string) {
  const [a] = await db.select().from(accounts).where(and(eq(accounts.tenantId, c.tenantId), eq(accounts.name, name)));
  return a;
}

async function contactsNamed(name: string) {
  return db.select().from(contacts).where(and(eq(contacts.tenantId, c.tenantId), eq(contacts.displayName, name)));
}

async function bsDiff(asOf: string, basis: 'accrual' | 'cash' = 'accrual') {
  const r = await h.request('GET', `/api/v1/reports/balance-sheet?exact=1&basis=${basis}&as_of_date=${asOf}`, c.token);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  return dec(r.json['totalAssetsExact']).minus(dec(r.json['totalLiabilitiesExact'])).minus(dec(r.json['totalEquityExact'])).toFixed(4);
}

describe('U-265 capability and parsers', () => {
  it('advertises qbd-mapping-v1', () => {
    expect(DESKTOP_CAPABILITIES).toContain('qbd-mapping-v1');
  });

  it('reads the Item Listing: kinds, exact prices, percent discounts, accounts, inactive; sales tax items listed, not imported', async () => {
    const out = await upload('items.csv', ITEMS, 'items');
    expect(out.validationErrors).toEqual([]);
    const rows = out.preview.sampleRows as Body[];
    expect(rows.map((r) => [r.name, r.itemType, r.skipReason ?? null, r.unitPrice ?? null, r.discountPercent ?? null, r.isActive])).toEqual([
      ['Consulting', 'service', null, '125.00', null, true],
      ['Widget', 'inventory_part', null, '9.99', null, true],
      ['Widget:Mini', 'inventory_part', null, '2.50', null, true],
      ['Old Service', 'service', null, '50.00', null, false],
      ['Spring Promo', 'discount', null, null, '10', true],
      ['State Tax', null, 'sales_tax', null, null, true],
    ]);
    expect(rows[1]).toMatchObject({
      purchaseCost: '4.25', isTaxable: true, preferredVendor: 'Cedar Supply',
      incomeAccount: { accountNumber: '94100' }, cogsAccount: { accountNumber: '95000' }, assetAccount: { accountNumber: '91300' },
    });
    // Every account the list names, matched against the chart as it is: no number exists yet; the company has a
    // "Cost of Goods Sold" account, matched by name.
    expect(out.preview.accountMatches!.map((m) => `${m.sourceKey}:${m.match}:${m.rows}:${m.matchedBy ?? ''}`)).toEqual([
      '91300:unmatched:2:', '94000:unmatched:3:', '94100:unmatched:2:', '95000:existing:2:name',
    ]);

    const bad = `Item,Type,Price,Account
Gizmo,Assembly Kit,5.00,4000
Gadget,Service,1e3,4000
Gadget,Service,5.00,4000
NoAcct,Service,5.00,
`;
    const b = await importsService.createSession({
      tenantId: c.tenantId, companyId: c.companyId, userId: c.userId,
      file: { originalname: 'generic-items.csv', buffer: Buffer.from(bad, 'utf8') }, kind: 'items', sourceSystem: 'generic', options: {},
    });
    expect(b.validationErrors.map((e) => `${e.rowNumber}:${e.code}`)).toEqual(['2:IMPORT_UNKNOWN_TYPE', '3:IMPORT_AMOUNT_INVALID', '4:IMPORT_DUPLICATE_ITEM', '5:IMPORT_ITEM_NO_ACCOUNT']);
  });

  it('reads the Inventory Valuation Summary exactly: sub-items as Parent:Sub, "<Parent> - Other" is the parent, never qty x avg cost; refuses rows an opening adjustment cannot bring in', async () => {
    const out = await upload('valuation.csv', VALUATION, 'inventory_valuation');
    expect(out.validationErrors).toEqual([]);
    expect(out.session.reportDate).toBe(CONV);
    expect(out.preview.valuationTotal).toBe('63.50');
    expect(out.preview.sampleRows).toEqual([
      { rowNumber: 7, item: 'Widget:Mini', onHand: '10.5', assetValue: '11.55' },
      { rowNumber: 8, item: 'Widget', onHand: '12', assetValue: '51.95' },
    ]);
    const bad = `"Inventory Valuation Summary"
"As of October 31, 2026"
Item,On Hand,Asset Value
Neg,-1,5.00
Ghost,0,5.00
Fine,1,5.005
Zero,0,0.00
`;
    const b = await upload('bad-valuation.csv', bad, 'inventory_valuation');
    expect(b.validationErrors.map((e) => `${e.rowNumber}:${e.code}`)).toEqual(['4:IMPORT_VALUATION_NEGATIVE', '5:IMPORT_VALUATION_NO_QUANTITY', '6:IMPORT_VALUATION_CENTS']);
    const undated = await importsService.createSession({
      tenantId: c.tenantId, companyId: c.companyId, userId: c.userId,
      file: { originalname: 'v.csv', buffer: Buffer.from('Item,On Hand,Asset Value\nWidget,1,2.00\n', 'utf8') }, kind: 'inventory_valuation', sourceSystem: 'generic', options: {},
    });
    expect(undated.validationErrors.map((e) => e.code)).toEqual(['IMPORT_BAD_DATE']);
  });

  it('reads Other Names as vendors and keeps inactive names and jobs on the customer list; contactKind other is QBD only', async () => {
    const o = await upload('other.csv', OTHER_NAMES, 'contacts', { contactKind: 'other' });
    expect((o.preview.sampleRows as Body[]).map((r) => [r.displayName, r.contactType])).toEqual([['Fir Lending', 'vendor']]);
    const cu = await upload('customers.csv', CUSTOMERS, 'contacts', { contactKind: 'customer' });
    expect((cu.preview.sampleRows as Body[]).map((r) => [r.displayName, r.jobOf ?? null, r.isActive ?? true])).toEqual([
      ['Alder Café', null, true], ['Alder Café:Kitchen remodel', 'Alder Café', true], ['Birch & Co', null, true], ['Dogwood Ltd', null, false],
    ]);
    await expect(importsService.createSession({
      tenantId: c.tenantId, companyId: c.companyId, userId: c.userId,
      file: { originalname: 'x.csv', buffer: Buffer.from('Display Name,Type\nX,vendor\n', 'utf8') }, kind: 'contacts', sourceSystem: 'generic', options: { contactKind: 'other' },
    })).rejects.toMatchObject({ code: 'IMPORT_CONTACT_KIND_UNSUPPORTED' });
  });
});

describe('U-265 QBD conversion with names, items and inventory', () => {
  it('one contact per name, the job folded into its customer, items, Inventory Asset = valuation and its history account 0.00; undo restores exactly', async () => {
    await inventoryOn();
    // A vendor of the QBD file that the company already has as a customer: it becomes 'both' (Q-77); undo gives it back.
    const [cedar0] = await db.insert(contacts).values({ tenantId: c.tenantId, companyId: c.companyId, contactType: 'customer', displayName: 'Cedar Supply' }).returning();
    const before = await companySnapshot(c);
    const { id, batch, error } = await commit(await uploadConversion());
    expect(batch.status, JSON.stringify(error)).toBe('committed');
    const sessions = batch.sessions as Body[];
    const result = (file: string) => sessions.find((s) => s.originalFilename === file)!.commitResult;

    // Names.
    expect(result('customers.csv')).toEqual({ created: 3, skipped: 0, accountsLinked: 0, inactive: 1, jobsFolded: 1 });
    expect(result('vendors.csv')).toEqual({ created: 0, skipped: 0, accountsLinked: 0, mergedToBoth: 2 });
    expect(result('other-names.csv')).toEqual({ created: 1, skipped: 0, accountsLinked: 0 });
    const kinds = async (name: string) => (await contactsNamed(name)).map((x) => [x.contactType, x.isActive]);
    expect(await kinds('Alder Café')).toEqual([['customer', true]]);
    expect(await kinds('Alder Café:Kitchen remodel')).toEqual([]);
    expect(await kinds('Birch & Co')).toEqual([['both', true]]);
    expect(await kinds('Cedar Supply')).toEqual([['both', true]]);
    expect(await kinds('Dogwood Ltd')).toEqual([['customer', false]]);
    expect(await kinds('Fir Lending')).toEqual([['vendor', true]]);

    // Open items: the job's invoice is the customer's, with the job in the memo; "- Other" rows are the customer's own.
    const [alder] = await contactsNamed('Alder Café');
    const docs = await db.select().from(transactions).where(and(eq(transactions.tenantId, c.tenantId), eq(transactions.importBatchId, id)));
    const byNum = (n: string) => docs.find((t) => t.txnNumber === n || t.vendorInvoiceNumber === n)!;
    expect([byNum('1001').contactId, byNum('1002').contactId]).toEqual([alder!.id, alder!.id]);
    expect(byNum('1002').memo).toContain('; job Kitchen remodel');
    expect(byNum('1001').memo).not.toContain('job');
    expect(byNum('B-2').contactId).toBe(cedar0!.id);
    expect(result('open-invoices.csv')).toEqual({ created: 3, skipped: 0, documents: { invoice: 3 } });

    // Items, through the item service.
    expect(result('items.csv')).toEqual({ created: 5, skipped: 1, itemsSkipped: { sales_tax: 1 }, inactive: 1 });
    const all = await db.select().from(items).where(eq(items.tenantId, c.tenantId));
    const item = (n: string) => all.find((x) => x.name === n)!;
    const inv = (await accountByNumber('91300'))!;
    expect([item('Widget').itemType, item('Widget').assetAccountId, item('Widget').cogsAccountId, item('Widget').incomeAccountId])
      .toEqual(['inventory_part', inv.id, (await accountByNumber('95000'))!.id, (await accountByNumber('94100'))!.id]);
    expect([dec(item('Widget').unitPrice).toFixed(2), dec(item('Widget').purchaseCost).toFixed(2), item('Widget').preferredVendorId]).toEqual(['9.99', '4.25', cedar0!.id]);
    expect([item('Spring Promo').itemType, dec(item('Spring Promo').discountPercent).toFixed(0)]).toEqual(['discount', '10']);
    expect(item('Old Service').isActive).toBe(false);
    expect(all.some((x) => x.name === 'State Tax')).toBe(false);
    expect(all.filter((x) => x.importBatchId === id)).toHaveLength(5);

    // Inventory: exactly the valuation (51.95, not 12 x 4.33), the history account 0.00.
    const hist = (await accountByName('Inventory before conversion'))!;
    expect([hist.accountType, hist.detailType, hist.systemTag, hist.importBatchId]).toEqual(['asset', 'other_current_asset', null, id]);
    expect(batch.result.historyAccounts).toMatchObject({ inventory: hist.id });
    expect(batch.result.redirectedAccountKeys).toEqual(['91200', '91300', '92000']);
    expect(await accountBalance(c, inv.id, CONV)).toBe('63.50');
    expect(await accountBalance(c, hist.id, CONV)).toBe('0.00');
    const mv = await db.select().from(inventoryMovements).where(eq(inventoryMovements.tenantId, c.tenantId));
    expect(mv.map((m) => [all.find((x) => x.id === m.itemId)!.name, dec(m.quantity).toFixed(4), dec(m.value).toFixed(2)]).sort())
      .toEqual([['Widget', '12.0000', '51.95'], ['Widget:Mini', '10.5000', '11.55']]);
    expect(result('valuation.csv')).toEqual({ created: 1, skipped: 0, itemsValued: 2, valuationTotal: '63.50' });
    for (const basis of ['accrual', 'cash'] as const) expect(await bsDiff(CONV, basis), basis).toBe('0.0000');

    await undo(id);
    expect((await contactsNamed('Cedar Supply')).map((x) => x.contactType)).toEqual(['customer']);
    expect(await companySnapshot(c)).toEqual(before);
  });

  it('QuickBooks without account numbers, inventory turned on in settings: chart rows are the company\'s same-named accounts, history nets to 0.00 on both bases; undo exact', async () => {
    // As the settings switch does: "Inventory Asset" (tagged) and "Cost of Goods Sold".
    await db.transaction(async (tx) => {
      await ensureInventoryAccounts(tx, c.tenantId, c.companyId, c.userId);
      await tx.update(companies).set({ inventoryEnabled: true }).where(eq(companies.id, c.companyId));
    });
    const tagged = (await db.select().from(accounts).where(and(eq(accounts.tenantId, c.tenantId), eq(accounts.systemTag, 'inventory_asset'))))[0]!;
    const before = await companySnapshot(c);
    const coa = `,Account,Type,Balance Total,Description
,Checking,Bank,960.00,
,Inventory Asset,Other Current Asset,63.50,
,Opening Balance Equity,Equity,"-1,023.50",
,Merchandise Sales,Income,0.00,
,Cost of Goods Sold,Cost of Goods Sold,0.00,
`;
    const itemList = `,Item,Description,Type,Cost,Price,Sales Tax Code,Account,COGS Account,Asset Account,Preferred Vendor,Active Status
,Widget,Blue widget,Inventory Part,4.25,9.99,Tax,Merchandise Sales,Cost of Goods Sold,Inventory Asset,,Active
,Widget:Mini,Small widget,Inventory Part,1.10,2.50,Tax,Merchandise Sales,Cost of Goods Sold,Inventory Asset,,Active
`;
    const tb = `"Trial Balance"
"As of September 30, 2026"
,Debit,Credit
"Checking","1,000.00",
"Inventory Asset",23.50,
"Opening Balance Equity",,"1,023.50"
TOTAL,"1,023.50","1,023.50"
`;
    const journal = `,Trans #,Type,Date,Num,Name,Memo,Account,Debit,Credit
,1,Check,10/01/2026,501,,Restock,Inventory Asset,40.00,
,,,,,,Restock,Checking,,40.00
,,,,,,,,40.00,40.00
`;
    const chart = await upload('accounts.csv', coa, 'coa');
    const m = (k: string) => chart.preview.accountMatches!.find((x) => x.sourceKey === k)!;
    expect([m('Inventory Asset').match, m('Inventory Asset').accountId, m('Inventory Asset').matchedBy]).toEqual(['existing', tagged.id, 'name']);
    expect(m('Merchandise Sales').match).toBe('create');
    const ids = [chart.session.id, await uploadId('items.csv', itemList, 'items'), await uploadId('tb.csv', tb, 'trial_balance'),
      await uploadId('journal.csv', journal, 'gl_transactions'), await uploadId('valuation.csv', VALUATION, 'inventory_valuation')];
    const { id, batch, error } = await commit(ids);
    expect(batch.status, JSON.stringify(error)).toBe('committed');

    const named = async (n: string) => db.select().from(accounts).where(and(eq(accounts.tenantId, c.tenantId), eq(accounts.name, n)));
    expect((await named('Inventory Asset')).map((a) => a.id)).toEqual([tagged.id]);
    expect(await named('Cost of Goods Sold')).toHaveLength(1);
    const widget = (await db.select().from(items).where(and(eq(items.tenantId, c.tenantId), eq(items.name, 'Widget'))))[0]!;
    expect(widget.assetAccountId).toBe(tagged.id);
    const hist = (await accountByName('Inventory before conversion'))!;
    expect(batch.result.redirectedAccountKeys).toEqual(['Inventory Asset']);
    expect([await accountBalance(c, hist.id, '2026-09-30'), await accountBalance(c, hist.id, '2026-10-15'), await accountBalance(c, hist.id, CONV)])
      .toEqual(['23.50', '63.50', '0.00']);
    expect(await accountBalance(c, tagged.id, CONV)).toBe('63.50');
    for (const d of ['2026-09-30', '2026-10-15', CONV]) {
      for (const basis of ['accrual', 'cash'] as const) expect(await bsDiff(d, basis), `${basis} ${d}`).toBe('0.0000');
    }
    await undo(id);
    expect(await companySnapshot(c)).toEqual(before);
  });

  it('refuses before the 202: inventory off (IMPORT_INVENTORY_OFF), opening stock on or before the closing date (INVENTORY_PERIOD_CLOSED)', async () => {
    await inventoryOn(false);
    const ids = await uploadConversion();
    const r = await createBatch(ids);
    const id = String(r.json['batch'].id);
    const off = await h.request('POST', `/api/v1/imports/batches/${id}/commit`, c.token, {}, { 'Idempotency-Key': key() });
    expect([off.status, off.json['error'].code]).toEqual([409, 'IMPORT_INVENTORY_OFF']);
    await inventoryOn();
    await db.update(companies).set({ lockDate: CONV }).where(eq(companies.id, c.companyId));
    const closed = await h.request('POST', `/api/v1/imports/batches/${id}/commit`, c.token, { confirmClosedPeriod: true }, { 'Idempotency-Key': key() });
    expect([closed.status, closed.json['error'].code]).toEqual([409, 'INVENTORY_PERIOD_CLOSED']);
    expect((await batchRow(id)).status).toBe('draft');
  });

  it('a valuation item that is not an inventory item of the company fails the batch, nothing posted', async () => {
    await inventoryOn();
    const before = await companySnapshot(c);
    const val = `"Inventory Valuation Summary"
"As of October 31, 2026"
Item,On Hand,Asset Value
Nowhere Gizmo,2,8.00
`;
    const { batch, error } = await commit([await uploadId('valuation.csv', val, 'inventory_valuation')]);
    expect(batch.status).toBe('failed');
    expect(error).toMatchObject({ code: 'IMPORT_UNKNOWN_ITEM', rowNumber: 4, details: { items: [{ rowNumber: 4, item: 'Nowhere Gizmo', reason: 'unknown' }] } });
    expect(await companySnapshot(c)).toEqual(before);
  });
});

describe('U-265 account mapping', () => {
  const unknownTb = `"Trial Balance"
"As of October 31, 2026"
,Debit,Credit
"91010 · Checking",100.00,
"99001 · Mystery One",,60.00
"Mystery Two",,40.00
TOTAL,100.00,100.00
`;

  it('accountMatches covers every row, not the preview sample', async () => {
    const coa = await uploadId('accounts.csv', COA, 'coa');
    void coa;
    // 5,002 one-line-pair entries; the only entry naming 77777 is the last, past the 5,000-row sample.
    const lines = [',Trans #,Type,Date,Num,Name,Memo,Account,Debit,Credit'];
    for (let i = 1; i <= 5002; i++) {
      const acct = i === 5002 ? '77777 · Late Account' : '96000 · Supplies';
      lines.push(`,${i},Check,10/01/2026,${i},,,${acct},1.00,`, ',,,,,,,91010 · Checking,,1.00', ',,,,,,,,1.00,1.00');
    }
    const out = await upload('big-journal.csv', `${lines.join('\n')}\n`, 'gl_transactions');
    expect(out.preview.sampleRows).toHaveLength(5000);
    const m = out.preview.accountMatches!;
    expect(m.find((x) => x.sourceKey === '77777')).toEqual({ sourceKey: '77777', number: '77777', name: 'Late Account', match: 'unmatched', rows: 1 });
    expect(m.find((x) => x.sourceKey === '96000')).toMatchObject({ match: 'unmatched', rows: 5001 });
    // The same list on a re-read of the session.
    const again = await importsService.getSession(c.tenantId, c.companyId, out.session.id);
    expect(again!.preview.accountMatches).toEqual(m);
    // Against the company's chart: by number, else by name; a chart file's rows are existing or create.
    const [checking] = await db.select().from(accounts).where(eq(accounts.id, c.roles['checking']!));
    const tb = await upload('tb.csv', `"As of October 31, 2026"\n,Debit,Credit\n"${checking!.name}",1.00,\n"88888 · Nope",,1.00\n`, 'trial_balance');
    expect(tb.preview.accountMatches).toEqual([
      { sourceKey: '88888', number: '88888', name: 'Nope', match: 'unmatched', rows: 1 },
      { sourceKey: checking!.name, name: checking!.name, match: 'existing', accountId: checking!.id, matchedBy: 'name', rows: 1 },
    ]);
    const chart = await upload('accounts2.csv', COA.replace('91010', '91011').replace('91010', '91011'), 'coa');
    expect(chart.preview.accountMatches!.find((x) => x.sourceKey === '91200')).toMatchObject({ match: 'create', systemRole: 'accounts_receivable' });
  });

  it('a batch never posts to suspense: every unmapped key in one error; the accountMap settles them; a foreign id is 400', async () => {
    const before = await companySnapshot(c);
    const tb = await uploadId('tb.csv', unknownTb, 'trial_balance');
    const failed = await commit([tb]);
    expect(failed.batch.status).toBe('failed');
    expect(failed.error).toMatchObject({
      code: 'IMPORT_UNMAPPED_ACCOUNT', sessionId: tb,
      details: { unmappedAccountKeys: ['91010', '99001', 'Mystery Two'], unmappedCount: 3 },
    });
    expect(await companySnapshot(c)).toEqual(before);
    expect(await accountByName('Suspense')).toBeUndefined();

    const bad = await createBatch([await uploadId('tb2.csv', unknownTb.replace('100.00,', '100.00 ,'), 'trial_balance')],
      { accountMap: { '99001': '00000000-0000-4000-8000-000000000000' } });
    expect([bad.status, bad.json['error'].code, bad.json['error'].details.keys]).toEqual([400, 'IMPORT_ACCOUNT_MAP_INVALID', ['99001']]);

    // The retry path the desktop has: a failed batch's options can't change and its session can't join another
    // batch, so DELETE the session, upload the same file again, and create a new batch with the map.
    const reused = await createBatch([tb]);
    expect([reused.status, reused.json['error'].code]).toEqual([409, 'IMPORT_SESSION_IN_BATCH']);
    const del = await h.request('DELETE', `/api/v1/imports/${tb}`, c.token, undefined, { 'Idempotency-Key': key() });
    expect([200, 204], JSON.stringify(del.json)).toContain(del.status);
    const tb3 = await uploadId('tb3.csv', unknownTb, 'trial_balance');
    const ok = await commit([tb3], { accountMap: { '91010': c.roles['checking']!, '99001': c.roles['sales']!, 'Mystery Two': c.roles['sales']! } });
    expect(ok.batch.status, JSON.stringify(ok.error)).toBe('committed');
    const [je] = await db.select().from(transactions).where(and(eq(transactions.tenantId, c.tenantId), eq(transactions.importBatchId, ok.id)));
    const jl = await db.select().from(journalLines).where(eq(journalLines.transactionId, je!.id));
    expect(jl.filter((l) => l.accountId === c.roles['sales']).map((l) => dec(l.credit).toFixed(2)).sort()).toEqual(['40.00', '60.00']);
  });

  it('a chart row mapped to an existing account is not created; its lines post there', async () => {
    const coa = `,Account,Type,Accnt. #
,"91010 · Checking",Bank,91010
,"96000 · Supplies",Expense,96000
`;
    const tb = `"As of October 31, 2026"
,Debit,Credit
"91010 · Checking",10.00,
"96000 · Supplies",,10.00
`;
    const ids = [await uploadId('coa.csv', coa, 'coa'), await uploadId('tb.csv', tb, 'trial_balance')];
    const was = dec(await accountBalance(c, c.roles['checking']!, CONV));
    const { id, batch, error } = await commit(ids, { accountMap: { '91010': c.roles['checking']!, '96000': 'create' } });
    expect(batch.status, JSON.stringify(error)).toBe('committed');
    expect(await accountByNumber('91010')).toBeUndefined();
    expect((await accountByNumber('96000'))!.importBatchId).toBe(id);
    expect(dec(await accountBalance(c, c.roles['checking']!, CONV)).minus(was).toFixed(2)).toBe('10.00');
  });
});

describe('U-265 classes and paychecks', () => {
  const coa = `,Account,Type,Accnt. #
,"91010 · Checking",Bank,91010
,"96000 · Supplies",Expense,96000
,"96500 · Payroll Expenses",Expense,96500
`;
  const journal = `,Trans #,Type,Date,Num,Name,Memo,Account,Class,Debit,Credit
,1,Check,10/01/2026,101,Cedar Supply,Paper,96000 · Supplies,East:Retail,25.00,
,,,,,Cedar Supply,Paper,91010 · Checking,,,25.00
,,,,,,,,,25.00,25.00
,2,Paycheck,10/15/2026,102,Jane Q Employee,Jane Q Employee pay,96500 · Payroll Expenses,West,900.00,
,,,,,Jane Q Employee,Jane Q Employee pay,91010 · Checking,,,900.00
,,,,,,,,,900.00,900.00
`;

  it('classMap makes a class a tag in a group; an unmapped class keeps its name; undo removes both', async () => {
    const before = await companySnapshot(c);
    const ids = [await uploadId('coa.csv', coa, 'coa'), await uploadId('journal.csv', journal, 'gl_transactions')];
    const { id, batch, error } = await commit(ids, { classMap: { 'East:Retail': { group: 'Region', tag: 'East Retail' } } });
    expect(batch.status, JSON.stringify(error)).toBe('committed');
    const gl = (batch.sessions as Body[]).find((s) => s.kind === 'gl_transactions')!.commitResult;
    expect([gl.tagsCreated, gl.classesMapped]).toEqual([2, 1]);
    const [group] = await db.select().from(tagGroups).where(and(eq(tagGroups.tenantId, c.tenantId), eq(tagGroups.name, 'Region')));
    const made = await db.select().from(tags).where(and(eq(tags.tenantId, c.tenantId), eq(tags.importBatchId, id)));
    expect(made.map((t) => [t.name, t.groupId]).sort()).toEqual([['East Retail', group!.id], ['West', null]]);
    expect(group!.importBatchId).toBe(id);
    await undo(id);
    expect(await companySnapshot(c)).toEqual(before);
  });

  it('a paycheck\'s employee name is never stored: not in import_rows, the preview or the posted memo (Q-P31m)', async () => {
    const out = await upload('journal.csv', journal, 'gl_transactions');
    expect(JSON.stringify(out.preview)).not.toContain('Jane');
    const stored = await db.select({ data: importRows.data }).from(importRows).where(eq(importRows.sessionId, out.session.id));
    expect(stored).toHaveLength(2);
    expect(JSON.stringify(stored)).not.toContain('Jane');
    expect(JSON.stringify(stored)).toContain('Cedar Supply'); // other names stay
    const { batch, error } = await commit([await uploadId('coa.csv', coa, 'coa'), out.session.id]);
    expect(batch.status, JSON.stringify(error)).toBe('committed');
    const posted = await db.select({ memo: transactions.memo }).from(transactions).where(and(eq(transactions.tenantId, c.tenantId), eq(transactions.txnNumber, '102')));
    expect(posted.map((p) => p.memo)).toEqual(['[QBD:Paycheck]']);
    const lineMemos = await db.execute(sql`SELECT jl.description FROM journal_lines jl JOIN transactions t ON t.id = jl.transaction_id WHERE t.tenant_id = ${c.tenantId} AND t.txn_number = '102'`);
    expect(JSON.stringify(lineMemos.rows)).not.toContain('Jane');
  });
});

describe('U-265 the old one-session commit keeps its behaviour', () => {
  it('a vendor list on POST /imports/:id/commit: a separate vendor next to the customer of that name, inactive names left out', async () => {
    const s = await uploadId('vendors.csv', `,Active Status,Vendor
,Active,Bluestem Veterinary Clinic
,Inactive,Gone Vendor
`, 'contacts', { contactKind: 'vendor' });
    const r = await h.request('POST', `/api/v1/imports/${s}/commit`, c.token, {}, { 'Idempotency-Key': key() });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json['result']).toMatchObject({ created: 1, skipped: 0 });
    expect((await contactsNamed('Bluestem Veterinary Clinic')).map((x) => x.contactType).sort()).toEqual(['customer', 'vendor']);
    expect(await contactsNamed('Gone Vendor')).toEqual([]);
    void inArray;
  });
});

describe('U-267 tie-out with inventory (imports-tieout-v1)', () => {
  it('valuation rows tie by source row, Inventory before conversion is 0.00 and the asset accounts equal the valuation', async () => {
    await inventoryOn();
    const ref = await importsService.createSession({
      tenantId: c.tenantId, companyId: c.companyId, userId: c.userId,
      // The same bytes as the posted trial balance: the upload guard is per role.
      file: { originalname: 'tb-reference.csv', buffer: Buffer.from(TB, 'latin1') },
      kind: 'trial_balance', sourceSystem: 'quickbooks_desktop', options: {} as never, role: 'reference',
    });
    const { id, batch, error } = await commit([...(await uploadConversion()), ref.session.id]);
    expect(batch.status, JSON.stringify(error)).toBe('committed');
    const r = await h.request('POST', `/api/v1/imports/batches/${id}/tieout`, c.token, {}, { 'Idempotency-Key': key() });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const t = r.json as Body;
    expect(t.allZero, JSON.stringify({ a: t.accounts, b: t.balanceRows, i: t.inventoryItems })).toBe(true);
    expect(t.inventoryItems.map((x: Body) => [x.item, x.sourceQuantity, x.booksQuantity, x.sourceExact, x.booksExact])).toEqual([
      ['Widget:Mini', '10.5', '10.5', '11.55', '11.55'], ['Widget', '12', '12', '51.95', '51.95'],
    ]);
    expect(t.inventoryItems.every((x: Body) => typeof x.sourceRow === 'number' && x.itemId)).toBe(true);
    expect(t.totals.inventory).toEqual({ sourceExact: '63.50', booksExact: '63.50', diffExact: '0.00' });
    expect(t.balanceRows.map((x: Body) => [x.key, x.booksExact, x.diffExact])).toEqual([
      ['history_ar', '0.00', '0.00'], ['history_ap', '0.00', '0.00'], ['history_inventory', '0.00', '0.00'], ['valuation_vs_asset', '63.50', '0.00'],
    ]);
    // The job's invoice went to its customer: the item keeps its source row and name.
    expect(t.arItems.map((x: Body) => [x.contactName, x.number, x.diffExact])).toEqual([
      ['Alder Café', '1001', '0.00'], ['Alder Café:Kitchen remodel', '1002', '0.00'], ['Birch & Co', '1003', '0.00'],
    ]);
  });
});