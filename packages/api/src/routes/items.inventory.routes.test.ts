// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// U-39b item-types-v1, U-156 inventory-account-v1, U-25 company-inventory-flag-v1
// (ClientLedger P24 E1): inventory part items with the purchase side, the
// company inventory switch, the inventory asset account and the account guards.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import 'express-async-errors';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { accounts, companies, contacts, items } from '../db/schema/index.js';
import { itemsRouter } from './items.routes.js';
import { companyRouter } from './company.routes.js';
import { accountsRouter } from './accounts.routes.js';
import * as ledger from '../services/ledger.service.js';
import { Harness, type Co, key } from './receivables.test-support.js';
import { DESKTOP_CAPABILITIES } from '../desktop/capabilities.js';

type Body = Record<string, any>;
const h = new Harness();
let c: Co;

beforeEach(async () => {
  await h.start([['/api/v1/items', itemsRouter], ['/api/v1/company', companyRouter], ['/api/v1/accounts', accountsRouter]]);
  c = await h.company();
});
afterEach(async () => { await h.stop(); });

const post = (p: string, body: unknown) => h.request('POST', `/api/v1${p}`, c.token, body, { 'Idempotency-Key': key() });
const put = (p: string, body: unknown) => h.request('PUT', `/api/v1${p}`, c.token, body);
const get = (p: string) => h.request('GET', `/api/v1${p}`, c.token);
const err = (r: { status: number; json: Body }) => [r.status, r.json['error']?.code];

async function turnOn() {
  const r = await put('/company/settings', { inventoryEnabled: true });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  expect(r.json['settings'].inventoryEnabled).toBe(true);
  const [asset] = await db.select().from(accounts).where(and(eq(accounts.tenantId, c.tenantId), eq(accounts.systemTag, 'inventory_asset')));
  const [cogs] = await db.select().from(accounts).where(and(eq(accounts.tenantId, c.tenantId), eq(accounts.accountType, 'cogs'), eq(accounts.isActive, true)));
  return { asset: asset!.id, cogs: cogs!.id };
}

const part = (acc: { asset: string; cogs: string }, extra: Body = {}) => ({
  name: 'Widget', itemType: 'inventory_part', unitPrice: '10.00', incomeAccountId: c.roles['income'],
  assetAccountId: acc.asset, cogsAccountId: acc.cogs, purchaseCost: '3.3333', purchaseDescription: 'Widget from the mill',
  reorderPoint: '5', reorderQuantity: '20', unitLabel: 'ea', ...extra,
});

describe('company-inventory-flag-v1 and inventory-account-v1 (U-25, U-156)', () => {
  it('is off by default (NULL); turning it on creates and tags Inventory Asset once and keeps a COGS account', async () => {
    expect((await get('/company/settings')).json['settings'].inventoryEnabled).toBe(false);
    const first = await turnOn();
    const again = await turnOn();
    expect(again).toEqual(first);
    const [asset] = await db.select().from(accounts).where(eq(accounts.id, first.asset));
    expect([asset!.name, asset!.accountType, asset!.detailType, asset!.isSystem]).toEqual(['Inventory Asset', 'asset', 'other_current_asset', false]);
    expect((await get('/company/settings')).json['settings'].inventoryEnabled).toBe(true);
    // Off is allowed while no item holds stock.
    const off = await put('/company/settings', { inventoryEnabled: false });
    expect([off.status, off.json['settings'].inventoryEnabled]).toEqual([200, false]);
  });

  it('adopts the one active other-current-asset "Inventory Asset" account and creates COGS when none is active', async () => {
    const [mine] = await db.insert(accounts).values({
      tenantId: c.tenantId, companyId: c.companyId, name: 'Inventory Asset', accountType: 'asset', detailType: 'other_current_asset',
    }).returning();
    await db.update(accounts).set({ isActive: false }).where(and(eq(accounts.tenantId, c.tenantId), eq(accounts.accountType, 'cogs')));
    const on = await turnOn();
    expect(on.asset).toBe(mine!.id);
    const [cogs] = await db.select().from(accounts).where(eq(accounts.id, on.cogs));
    expect([cogs!.name, cogs!.detailType]).toEqual(['Cost of Goods Sold', 'cost_of_goods_sold']);
  });

  it('keeps inventory accounts in place: deactivate, delete, merge and type change are 409 ACCOUNT_IN_USE', async () => {
    const acc = await turnOn();
    expect(err(await h.request('DELETE', `/api/v1/accounts/${acc.asset}`, c.token))).toEqual([409, 'ACCOUNT_IN_USE']);
    expect(err(await put(`/accounts/${acc.asset}`, { isActive: false }))).toEqual([409, 'ACCOUNT_IN_USE']);
    expect(err(await put(`/accounts/${acc.asset}`, { accountType: 'expense', detailType: null }))).toEqual([409, 'ACCOUNT_IN_USE']);
    const [other] = await db.insert(accounts).values({
      tenantId: c.tenantId, companyId: c.companyId, name: 'Other stock', accountType: 'asset', detailType: 'other_current_asset',
    }).returning();
    expect(err(await post('/accounts/merge', { sourceId: acc.asset, targetId: other!.id }))).toEqual([409, 'ACCOUNT_IN_USE']);
    // An account an active part names (its COGS account) is kept too; an inactive part frees it.
    const created = await post('/items', part({ asset: other!.id, cogs: acc.cogs }));
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    expect(err(await h.request('DELETE', `/api/v1/accounts/${other!.id}`, c.token))).toEqual([409, 'ACCOUNT_IN_USE']);
    await h.request('DELETE', `/api/v1/items/${created.json['item'].id}`, c.token);
    expect((await h.request('DELETE', `/api/v1/accounts/${other!.id}`, c.token)).status).toBe(200);
  });
});

describe('item-types-v1 (U-39b)', () => {
  it('refuses a part while inventory is off (400 INVENTORY_OFF)', async () => {
    const asset = (await db.insert(accounts).values({
      tenantId: c.tenantId, companyId: c.companyId, name: 'Stock', accountType: 'asset', detailType: 'other_current_asset',
    }).returning())[0]!.id;
    const [cogs] = await db.select().from(accounts).where(and(eq(accounts.tenantId, c.tenantId), eq(accounts.accountType, 'cogs')));
    expect(err(await post('/items', part({ asset, cogs: cogs!.id })))).toEqual([400, 'INVENTORY_OFF']);
  });

  it('creates a part with the purchase side; parts carry string stock figures, other kinds null', async () => {
    const acc = await turnOn();
    const vendor = (await db.insert(contacts).values({ tenantId: c.tenantId, companyId: c.companyId, contactType: 'vendor', displayName: 'Mill' }).returning())[0]!.id;
    const r = await post('/items', part(acc, { preferredVendorId: vendor, expenseAccountId: c.roles['expense'] }));
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const it1 = r.json['item'];
    expect([it1.itemType, it1.assetAccountId, it1.cogsAccountId, it1.preferredVendorId, it1.unitLabel, it1.purchaseDescription])
      .toEqual(['inventory_part', acc.asset, acc.cogs, vendor, 'ea', 'Widget from the mill']);
    expect([it1.purchaseCost, it1.reorderPoint, it1.reorderQuantity]).toEqual(['3.3333', '5.0000', '20.0000']);
    expect([it1.quantityOnHand, it1.averageCost, it1.assetValue]).toEqual(['0.0000', '0.000000', '0.00']);
    const svc = await post('/items', { name: 'Labor', incomeAccountId: c.roles['income'], purchaseCost: '12.50', expenseAccountId: c.roles['expense'] });
    expect(svc.status, JSON.stringify(svc.json)).toBe(201);
    expect([svc.json['item'].itemType, svc.json['item'].purchaseCost, svc.json['item'].quantityOnHand, svc.json['item'].averageCost])
      .toEqual(['service', '12.5000', null, null]);
    const one = await get(`/items/${it1.id}`);
    expect([one.json['item'].quantityOnHand, one.json['item'].assetValue]).toEqual(['0.0000', '0.00']);
    const list = await get('/items?itemType=inventory_part');
    expect((list.json['data'] as Body[]).map((i) => [i['name'], i['averageCost']])).toEqual([['Widget', '0.000000']]);
  });

  it('validates parts: accounts required and of the right type, part-only fields, vendor, numbers as strings', async () => {
    const acc = await turnOn();
    const bank = c.roles['checking'];
    expect(err(await post('/items', part(acc, { assetAccountId: undefined })))).toEqual([400, 'VALIDATION_ERROR']);
    expect(err(await post('/items', part(acc, { cogsAccountId: null })))).toEqual([400, 'VALIDATION_ERROR']);
    expect(err(await post('/items', part(acc, { assetAccountId: bank })))).toEqual([400, 'VALIDATION_ERROR']);
    expect(err(await post('/items', part(acc, { cogsAccountId: c.roles['expense'] })))).toEqual([400, 'VALIDATION_ERROR']);
    expect(err(await post('/items', part(acc, { preferredVendorId: c.customer })))).toEqual([400, 'VALIDATION_ERROR']);
    expect(err(await post('/items', part(acc, { purchaseCost: 3.5 })))).toEqual([400, 'VALIDATION_ERROR']);
    expect(err(await post('/items', part(acc, { purchaseCost: '-1' })))).toEqual([400, 'VALIDATION_ERROR']);
    expect(err(await post('/items', part(acc, { reorderQuantity: '0' })))).toEqual([400, 'VALIDATION_ERROR']);
    expect(err(await post('/items', part(acc, { unitLabel: 'eleven-char' })))).toEqual([400, 'VALIDATION_ERROR']);
    expect(err(await post('/items', { name: 'Svc', incomeAccountId: c.roles['income'], reorderPoint: '1' }))).toEqual([400, 'VALIDATION_ERROR']);
    expect(err(await post('/items', { name: 'Svc', incomeAccountId: c.roles['income'], assetAccountId: acc.asset }))).toEqual([400, 'VALIDATION_ERROR']);
  });

  it('PUT locks and checks expectedUpdatedAt (409 STALE); a used name is 409', async () => {
    const acc = await turnOn();
    const created = (await post('/items', part(acc))).json['item'];
    await post('/items', { name: 'Gadget', incomeAccountId: c.roles['income'] });
    const stale = await put(`/items/${created.id}`, { unitPrice: '11.00', expectedUpdatedAt: '2020-01-01T00:00:00.000Z' });
    expect(err(stale)).toEqual([409, 'STALE']);
    expect(stale.json['error'].details.updatedAt).toBe(created.updatedAt);
    const ok = await put(`/items/${created.id}`, { unitPrice: '11.00', expectedUpdatedAt: created.updatedAt });
    expect([ok.status, ok.json['item'].unitPrice, ok.json['item'].quantityOnHand]).toEqual([200, '11.0000', '0.0000']);
    expect((await put(`/items/${created.id}`, { name: 'Gadget' })).status).toBe(409);
  });

  it('kind moves to or from inventory_part: 409 ITEM_IN_USE with posted lines; otherwise allowed and part fields cleared', async () => {
    const acc = await turnOn();
    const svc = (await post('/items', { name: 'Labor', incomeAccountId: c.roles['income'] })).json['item'];
    const moved = await put(`/items/${svc.id}`, { itemType: 'inventory_part', assetAccountId: acc.asset, cogsAccountId: acc.cogs });
    expect([moved.status, moved.json['item'].itemType, moved.json['item'].quantityOnHand]).toEqual([200, 'inventory_part', '0.0000']);
    const back = await put(`/items/${svc.id}`, { itemType: 'non_inventory' });
    expect([back.status, back.json['item'].assetAccountId, back.json['item'].cogsAccountId, back.json['item'].averageCost])
      .toEqual([200, null, null, null]);
    // A posted line names the item: the kind can't move any more.
    await ledger.postTransaction(c.tenantId, {
      txnType: 'journal_entry', txnDate: '2026-01-02',
      lines: [
        { accountId: c.roles['checking'], debit: '5', credit: '0', itemId: svc.id },
        { accountId: c.roles['income'], debit: '0', credit: '5' },
      ],
    } as never, c.userId, c.companyId);
    expect(err(await put(`/items/${svc.id}`, { itemType: 'inventory_part', assetAccountId: acc.asset, cogsAccountId: acc.cogs })))
      .toEqual([409, 'ITEM_IN_USE']);
    // Other edits still work.
    expect((await put(`/items/${svc.id}`, { purchaseCost: '2.00' })).status).toBe(200);
    // Inventory off: a part can't be made or converted to.
    await put('/company/settings', { inventoryEnabled: false });
    const other = (await post('/items', { name: 'Other', incomeAccountId: c.roles['income'] })).json['item'];
    expect(err(await put(`/items/${other.id}`, { itemType: 'inventory_part', assetAccountId: acc.asset, cogsAccountId: acc.cogs })))
      .toEqual([400, 'INVENTORY_OFF']);
  });

  it('a part of another tenant is not found; items are deactivated, never deleted', async () => {
    const acc = await turnOn();
    const created = (await post('/items', part(acc))).json['item'];
    expect((await h.request('DELETE', `/api/v1/items/${created.id}`, c.token)).status).toBe(200);
    const [row] = await db.select().from(items).where(eq(items.id, created.id));
    expect(row!.isActive).toBe(false);
    const other = await h.company();
    expect((await h.request('GET', `/api/v1/items/${created.id}`, other.token)).status).toBe(404);
    void companies;
  });

  it('advertises item-types-v1, inventory-account-v1, company-inventory-flag-v1', () => {
    for (const cap of ['item-types-v1', 'inventory-account-v1', 'company-inventory-flag-v1']) expect(DESKTOP_CAPABILITIES).toContain(cap);
  });
});
