// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// STATEMENT_CHECK_PAYEE_CATEGORY — categorizing by WHO the check was written
// to. A check's bank description is the same useless string on every row
// ("Taz-Boy's", "CHECK 3607"), so description matching can never categorize
// one; the payee read off the statement is the usable key.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { suggestAccountFromPayeeHistory, suggestCategorization } from './categorization-ai.service.js';

const tenantId = crypto.randomUUID();
const bankAccountId = crypto.randomUUID();
const suppliesId = crypto.randomUUID();
const repairsId = crypto.randomUUID();
const connectionId = crypto.randomUUID();

const steadyVendorId = crypto.randomUUID();  // always coded to Supplies (3x)
const splitVendorId = crypto.randomUUID();   // coded 2 ways
const onceVendorId = crypto.randomUUID();    // only one prior txn

const itemSteady = crypto.randomUUID();
const itemSplit = crypto.randomUUID();
const itemOnce = crypto.randomUUID();

async function postTo(contactId: string | null, accountId: string, payeeText: string | null) {
  const txnId = crypto.randomUUID();
  await db.execute(sql`
    INSERT INTO transactions (id, tenant_id, txn_type, txn_date, total, status, contact_id, payee_name_on_check)
    VALUES (${txnId}, ${tenantId}, 'check', '2026-05-01'::date, 100.00, 'posted', ${contactId}, ${payeeText})
  `);
  await db.execute(sql`
    INSERT INTO journal_lines (transaction_id, tenant_id, account_id, debit, credit)
    VALUES (${txnId}, ${tenantId}, ${accountId}, 100.00, 0)
  `);
}

beforeAll(async () => {
  await db.execute(sql`INSERT INTO tenants (id, name, slug) VALUES (${tenantId}, 'Payee Hist', ${'payeehist-' + tenantId.slice(0, 8)})`);
  await db.execute(sql`
    INSERT INTO accounts (id, tenant_id, name, account_type) VALUES
      (${bankAccountId}, ${tenantId}, 'PH Checking', 'bank'),
      (${suppliesId}, ${tenantId}, 'Supplies', 'expense'),
      (${repairsId}, ${tenantId}, 'Repairs', 'expense')
  `);
  await db.execute(sql`
    INSERT INTO contacts (id, tenant_id, contact_type, display_name) VALUES
      (${steadyVendorId}, ${tenantId}, 'vendor', 'Cosmos Granite'),
      (${splitVendorId}, ${tenantId}, 'vendor', 'Split Hardware'),
      (${onceVendorId}, ${tenantId}, 'vendor', 'One Timer')
  `);
  await db.execute(sql`
    INSERT INTO bank_connections (id, tenant_id, account_id, institution_name)
    VALUES (${connectionId}, ${tenantId}, ${bankAccountId}, 'PH Bank')
  `);

  for (let i = 0; i < 3; i++) await postTo(steadyVendorId, suppliesId, 'Cosmos Granite');
  await postTo(splitVendorId, suppliesId, 'Split Hardware');
  await postTo(splitVendorId, repairsId, 'Split Hardware');
  await postTo(onceVendorId, suppliesId, 'One Timer');

  // Feed rows share an identical, useless description on purpose.
  const mkItem = async (id: string, contactId: string, payee: string) => {
    await db.execute(sql`
      INSERT INTO bank_feed_items (id, tenant_id, bank_connection_id, feed_date, description, original_description, amount, status, check_number, payee_name_on_check, suggested_contact_id)
      VALUES (${id}, ${tenantId}, ${connectionId}, '2026-06-01', 'Taz-Boy''s', 'Taz-Boy''s', 150.00, 'pending', 4001, ${payee}, ${contactId})
    `);
  };
  await mkItem(itemSteady, steadyVendorId, 'Cosmos Granite');
  await mkItem(itemSplit, splitVendorId, 'Split Hardware');
  await mkItem(itemOnce, onceVendorId, 'One Timer');
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM bank_feed_items WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM bank_connections WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM journal_lines WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM transactions WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM contacts WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM accounts WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM audit_log WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM tenants WHERE id = ${tenantId}`);
});

describe('suggestAccountFromPayeeHistory', () => {
  it('returns the single account a payee has always been coded to', async () => {
    const r = await suggestAccountFromPayeeHistory(tenantId, { contactId: steadyVendorId });
    expect(r).not.toBeNull();
    expect(r!.accountId).toBe(suppliesId);
    expect(r!.timesSeen).toBe(3);
    expect(r!.confidence).toBeGreaterThan(0.75);
    expect(r!.confidence).toBeLessThanOrEqual(0.95);
  });

  it('matches on the payee text even with no contact link', async () => {
    const r = await suggestAccountFromPayeeHistory(tenantId, { payeeName: 'cosmos granite' });
    expect(r?.accountId).toBe(suppliesId);
  });

  it('refuses to guess when the payee was coded several ways', async () => {
    expect(await suggestAccountFromPayeeHistory(tenantId, { contactId: splitVendorId })).toBeNull();
  });

  it('refuses a single prior transaction as evidence', async () => {
    expect(await suggestAccountFromPayeeHistory(tenantId, { contactId: onceVendorId })).toBeNull();
  });

  it('returns null with nothing to go on', async () => {
    expect(await suggestAccountFromPayeeHistory(tenantId, {})).toBeNull();
    expect(await suggestAccountFromPayeeHistory(tenantId, { payeeName: 'Never Seen' })).toBeNull();
  });

  it('does not read another tenant history', async () => {
    expect(await suggestAccountFromPayeeHistory(crypto.randomUUID(), { payeeName: 'Cosmos Granite' })).toBeNull();
  });
});

describe('suggestCategorization with a check payee', () => {
  it('categorizes a check whose description is useless, via the payee', async () => {
    const r = await suggestCategorization(tenantId, itemSteady);
    expect(r).not.toBeNull();
    expect(r!.accountId).toBe(suppliesId);
    expect(r!.matchType).toBe('history');

    const row = await db.execute(sql`SELECT suggested_account_id FROM bank_feed_items WHERE id = ${itemSteady}`);
    expect((row.rows[0] as { suggested_account_id: string }).suggested_account_id).toBe(suppliesId);
  });

  it('leaves an ambiguous payee uncategorized rather than guessing', async () => {
    const r = await suggestCategorization(tenantId, itemSplit);
    // Falls through the payee step; the shared description matches nothing.
    expect(r?.accountId ?? null).not.toBe(repairsId);
    const row = await db.execute(sql`SELECT suggested_account_id FROM bank_feed_items WHERE id = ${itemSplit}`);
    expect((row.rows[0] as { suggested_account_id: string | null }).suggested_account_id).toBeNull();
  });
});
