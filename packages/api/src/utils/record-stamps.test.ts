// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// Record stamps owned by the database (U-291a, stale-all-v1; T5, T7, T8, B3):
// the trigger catalogue, the desktop gate, a posting never moves an account's
// stamp, a save returns the stamp the next save needs, stale saves are 409,
// one of two racing saves wins, and bulk writes report stale items.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import pg from 'pg';
import { startLanEngine, DEVICE_A, DEVICE_B, type LanEngine } from '../desktop/lan.test-support.js';
import { STAMP_HEADERS, STAMP_CHILDREN } from './record-stamps.js';

let e: LanEngine;
let jwtA = '';
let jwtB = '';
let accA = '';
let accB = '';
const A = { device: DEVICE_A };
const B = { device: DEVICE_B };

// Every column of each stamped table. A new column fails here until it is
// classified: it bumps the stamp (nothing to do) or the engine maintains it
// (add it to STAMP_HEADERS, and to the trigger's ignore list in a migration).
const PINNED: Record<string, string> = {
  transactions: 'id tenant_id txn_type txn_number txn_date due_date status contact_id memo internal_notes payment_terms subtotal tax_amount total amount_paid balance_due invoice_status sent_at viewed_at paid_at is_recurring recurring_schedule_id source_estimate_id applied_to_invoice_id void_reason voided_at created_at updated_at check_number print_status payee_name_on_check payee_address printed_memo printed_at print_batch_id company_id bill_status terms_days credits_applied vendor_invoice_number source source_id public_token stripe_payment_intent_id basis aje_number print_signature_id payment_method reference_number is_adjusting reverses_transaction_id discount_percent discount_days discount_date due_date_overridden discount_date_overridden bill_received print_later is_check po_number customer_message hide_zero_lines invoice_layout_id source_txn_id source_payment_id holds_deposit from_deposit_id is_finance_charge sales_tax_id sales_tax_ssuta import_batch_id',
  accounts: 'id tenant_id account_number name account_type detail_type description is_active is_system system_tag parent_id balance created_at updated_at company_id card_last4 is_sensitive import_batch_id',
  contacts: 'id tenant_id contact_type display_name company_name first_name last_name email phone billing_line1 billing_line2 billing_city billing_state billing_zip billing_country shipping_line1 shipping_line2 shipping_city shipping_state shipping_zip shipping_country default_payment_terms opening_balance opening_balance_date default_expense_account_id tax_id is_1099_eligible notes is_active created_at updated_at company_id default_terms_days default_tag_id form_1099_type exempt_payee_code bill_lines_mode vendor_account_number default_discount_percent default_discount_days price_level_id default_markup_percent default_invoice_layout_id default_sales_tax_id tax_code_id import_batch_id',
  items: 'id tenant_id name description unit_price income_account_id is_taxable is_active created_at updated_at company_id default_tag_id item_type discount_percent tax_code_id purchase_description purchase_cost expense_account_id asset_account_id cogs_account_id preferred_vendor_id reorder_point reorder_quantity unit_label unit_set_id default_purchase_unit_id default_sale_unit_id import_batch_id',
  tags: 'id tenant_id name color created_at group_id description is_active usage_count sort_order updated_at company_id tag_number import_batch_id',
  tag_groups: 'id tenant_id name description is_single_select sort_order created_at updated_at company_id import_batch_id',
};

async function je(jwt: string, who = A, amount = '10.00') {
  const r = await e.call(who, '/api/v1/transactions', {
    method: 'POST', jwt, company: undefined,
    body: { txnType: 'journal_entry', txnDate: '2026-03-02', memo: 'stamp test', lines: [
      { accountId: accA, debit: amount, credit: '0' }, { accountId: accB, debit: '0', credit: amount }] },
  });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json.transaction as { id: string; updatedAt: string };
}

function jeBody(stamp: string | undefined, amount: string, memo = 'stamp test') {
  return {
    txnType: 'journal_entry', txnDate: '2026-03-02', memo,
    ...(stamp ? { expectedUpdatedAt: stamp } : {}),
    lines: [{ accountId: accA, debit: amount, credit: '0' }, { accountId: accB, debit: '0', credit: amount }],
  };
}

async function stampOf(table: string, id: string): Promise<string> {
  const [row] = await e.query<{ s: string }>(`SELECT to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS s FROM ${table} WHERE id = $1`, [id]);
  return row!.s;
}

beforeAll(async () => {
  e = await startLanEngine();
  jwtA = await e.signIn(A);
  jwtB = await e.signIn(B);
  const r = await e.call(A, '/api/v1/accounts', { jwt: jwtA });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  const list = (r.json.data ?? r.json.accounts ?? r.json) as Array<{ id: string; accountType: string; isSystem?: boolean }>;
  const expense = list.filter((a) => a.accountType === 'expense');
  accA = expense[0]!.id;
  accB = expense[1]!.id;
}, 300_000);

afterAll(async () => {
  await e?.close();
});

describe('catalogue and gate', () => {
  it('every stamped table has its trigger and a pinned column set', async () => {
    const trig = await e.query<{ tbl: string; tgname: string }>(
      "SELECT c.relname AS tbl, t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE t.tgname LIKE 'mybooks_stamp%'");
    const has = (tbl: string, name: string) => trig.some((x) => x.tbl === tbl && x.tgname === name);
    for (const tbl of Object.keys(STAMP_HEADERS)) {
      expect(has(tbl, 'mybooks_stamp'), tbl).toBe(true);
      expect(has(tbl, 'mybooks_stamp_ins'), tbl).toBe(true);
      const cols = await e.query<{ c: string }>(
        "SELECT column_name AS c FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 ORDER BY ordinal_position", [tbl]);
      expect(cols.map((x) => x.c).join(' '), `${tbl}: classify new columns in STAMP_HEADERS`).toBe(PINNED[tbl]);
      for (const ign of STAMP_HEADERS[tbl]!) expect(cols.map((x) => x.c), `${tbl}.${ign}`).toContain(ign);
    }
    for (const tbl of [...Object.keys(STAMP_CHILDREN), 'attachments']) expect(has(tbl, 'mybooks_stamp_child'), tbl).toBe(true);
  });

  it('desktop connections turn the triggers on; others do not', async () => {
    const { db } = await import('../db/index.js');
    const { sql } = await import('drizzle-orm');
    const on = await db.execute(sql`SELECT current_setting('mybooks.desktop', true) AS v`);
    expect((on.rows[0] as { v: string }).v).toBe('on');
    // A plain connection (the server appliance's pool): the code's stamp is kept.
    const c = new pg.Client({ connectionString: e.dbUrl });
    await c.connect();
    try {
      const [acc] = (await c.query('SELECT id FROM accounts WHERE id = $1', [accA])).rows;
      await c.query("UPDATE accounts SET updated_at = '2001-01-01T00:00:00Z' WHERE id = $1", [acc.id]);
      expect(await stampOf('accounts', accA)).toBe('2001-01-01T00:00:00.000Z');
    } finally {
      await c.end();
    }
  });
});

describe('stamps (B3, T5)', () => {
  it('a posting moves an account balance but not its stamp; a rename moves it', async () => {
    const before = await stampOf('accounts', accA);
    await je(jwtA);
    expect(await stampOf('accounts', accA)).toBe(before);
    const r = await e.call(A, `/api/v1/accounts/${accA}`, { method: 'PUT', jwt: jwtA, body: { name: 'Stamp Test Expense', expectedUpdatedAt: before } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const after = await stampOf('accounts', accA);
    expect(after > before).toBe(true);
    // The old stamp is now stale.
    const stale = await e.call(B, `/api/v1/accounts/${accA}`, { method: 'PUT', jwt: jwtB, body: { name: 'Other', expectedUpdatedAt: before } });
    expect(stale.status).toBe(409);
    expect(stale.json.error.code).toBe('STALE');
    expect(stale.json.error.details.updatedAt).toBe(after);
  });

  it('a save returns the stamp the next save needs; an old stamp is 409', async () => {
    const t = await je(jwtA);
    const s0 = await stampOf('transactions', t.id);
    expect(new Date(t.updatedAt).toISOString()).toBe(s0);
    const r1 = await e.call(A, `/api/v1/transactions/${t.id}`, { method: 'PUT', jwt: jwtA, body: jeBody(s0, '11.00') });
    expect(r1.status, JSON.stringify(r1.json)).toBe(200);
    const s1 = await stampOf('transactions', t.id);
    expect(s1 > s0).toBe(true);
    expect(new Date(r1.json.transaction.updatedAt).toISOString()).toBe(s1);
    // Lines only, with the returned stamp: no self-conflict, and the stamp moves once.
    const r2 = await e.call(A, `/api/v1/transactions/${t.id}`, { method: 'PUT', jwt: jwtA, body: jeBody(r1.json.transaction.updatedAt, '12.00') });
    expect(r2.status, JSON.stringify(r2.json)).toBe(200);
    expect(new Date(r2.json.transaction.updatedAt).toISOString()).toBe(await stampOf('transactions', t.id));
    const old = await e.call(B, `/api/v1/transactions/${t.id}`, { method: 'PUT', jwt: jwtB, body: jeBody(s0, '13.00') });
    expect(old.status).toBe(409);
    expect(old.json.error.code).toBe('STALE');
    // Without a stamp: last write wins, as before (U-292 makes it required in LAN mode).
    expect((await e.call(B, `/api/v1/transactions/${t.id}`, { method: 'PUT', jwt: jwtB, body: jeBody(undefined, '14.00') })).status).toBe(200);
  });

  it('two saves on the same stamp: one wins, the other is 409 (50 runs)', async () => {
    const t = await je(jwtA);
    let stamp = await stampOf('transactions', t.id);
    for (let i = 0; i < 50; i++) {
      const [x, y] = await Promise.all([
        e.call(A, `/api/v1/transactions/${t.id}`, { method: 'PUT', jwt: jwtA, body: jeBody(stamp, `${20 + i}.00`, `a${i}`) }),
        e.call(B, `/api/v1/transactions/${t.id}`, { method: 'PUT', jwt: jwtB, body: jeBody(stamp, `${90 + i}.00`, `b${i}`) }),
      ]);
      expect([x.status, y.status].sort(), `run ${i}: ${JSON.stringify([x.json, y.json])}`).toEqual([200, 409]);
      stamp = await stampOf('transactions', t.id);
    }
  });

  it('contacts: stale edit 409, racing edits one wins', async () => {
    const c = await e.call(A, '/api/v1/contacts', { method: 'POST', jwt: jwtA, body: { contactType: 'customer', displayName: 'Stamp Customer' } });
    expect(c.status, JSON.stringify(c.json)).toBe(201);
    const id = (c.json.contact ?? c.json).id as string;
    let stamp = await stampOf('contacts', id);
    for (let i = 0; i < 20; i++) {
      const [x, y] = await Promise.all([
        e.call(A, `/api/v1/contacts/${id}`, { method: 'PUT', jwt: jwtA, body: { displayName: `A ${i}`, expectedUpdatedAt: stamp } }),
        e.call(B, `/api/v1/contacts/${id}`, { method: 'PUT', jwt: jwtB, body: { displayName: `B ${i}`, expectedUpdatedAt: stamp } }),
      ]);
      expect([x.status, y.status].sort(), `run ${i}: ${JSON.stringify([x.json, y.json])}`).toEqual([200, 409]);
      stamp = await stampOf('contacts', id);
    }
  });

  it('tagging a transaction moves its stamp; bulk tag skips stale items (T8)', async () => {
    const g = await e.call(A, '/api/v1/tags', { method: 'POST', jwt: jwtA, body: { name: 'Stamp Tag' } });
    expect(g.status, JSON.stringify(g.json)).toBe(201);
    const tagId = (g.json.tag ?? g.json).id as string;
    const t1 = await je(jwtA);
    const t2 = await je(jwtA);
    const s1 = await stampOf('transactions', t1.id);
    const s2 = await stampOf('transactions', t2.id);
    const r = await e.call(A, `/api/v1/tags/transactions/${t1.id}`, { method: 'PUT', jwt: jwtA, body: { tagIds: [tagId], expectedUpdatedAt: s1 } });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(await stampOf('transactions', t1.id) > s1).toBe(true);
    // t1's stamp is now stale; t2's is current.
    const bulk = await e.call(A, '/api/v1/tags/bulk-untag', {
      method: 'POST', jwt: jwtA, body: { transactionIds: [t1.id, t2.id], tagIds: [tagId], stamps: { [t1.id]: s1, [t2.id]: s2 } },
    });
    expect(bulk.status, JSON.stringify(bulk.json)).toBe(200);
    expect(bulk.json.stale.map((x: { id: string }) => x.id)).toEqual([t1.id]);
  });

  it('bulk tagging against saves of the same entries: no deadlock (20 runs)', async () => {
    const g = await e.call(A, '/api/v1/tags', { method: 'POST', jwt: jwtA, body: { name: 'Race Tag' } });
    const tagId = (g.json.tag ?? g.json).id as string;
    const ids = [(await je(jwtA)).id, (await je(jwtA)).id, (await je(jwtA)).id];
    for (let i = 0; i < 20; i++) {
      const results = await Promise.all([
        e.call(A, '/api/v1/tags/bulk-tag', { method: 'POST', jwt: jwtA, body: { transactionIds: [...ids].reverse(), tagIds: [tagId] } }),
        ...ids.map((id) => e.call(B, `/api/v1/transactions/${id}`, { method: 'PUT', jwt: jwtB, body: jeBody(undefined, `${30 + i}.00`) })),
        e.call(A, '/api/v1/tags/bulk-untag', { method: 'POST', jwt: jwtA, body: { transactionIds: ids, tagIds: [tagId] } }),
      ]);
      for (const r of results) expect(r.status, JSON.stringify(r.json)).toBeLessThan(500);
    }
  });

  it('bulk update skips stale entries and updates the rest (T8)', async () => {
    const t1 = await je(jwtA);
    const t2 = await je(jwtA);
    const s1 = await stampOf('transactions', t1.id);
    const s2 = await stampOf('transactions', t2.id);
    await e.call(B, `/api/v1/transactions/${t1.id}`, { method: 'PUT', jwt: jwtB, body: jeBody(undefined, '15.00', 'moved') });
    const g = await e.call(A, '/api/v1/tags', { method: 'POST', jwt: jwtA, body: { name: 'Bulk Update Tag' } });
    const tagId = (g.json.tag ?? g.json).id as string;
    const r = await e.call(A, '/api/v1/transactions/bulk-update', {
      method: 'POST', jwt: jwtA, body: { txnIds: [t1.id, t2.id], setTagId: tagId, stamps: { [t1.id]: s1, [t2.id]: s2 } },
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.skipped).toEqual([{ id: t1.id, reason: 'stale', updatedAt: await stampOf('transactions', t1.id) }]);
    expect(r.json.updated).toBe(1);
  });

  it('a transaction of another company is not found (GET and void)', async () => {
    const t = await je(jwtA);
    const other = '00000000-0000-4000-8000-000000000001';
    expect((await e.call(A, `/api/v1/transactions/${t.id}`, { jwt: jwtA, headers: { 'x-company-id': other } })).status).not.toBe(200);
    expect((await e.call(A, `/api/v1/transactions/${t.id}/void`, { method: 'POST', jwt: jwtA, headers: { 'x-company-id': other }, body: { reason: 'x' } })).status).not.toBe(200);
  });
});
