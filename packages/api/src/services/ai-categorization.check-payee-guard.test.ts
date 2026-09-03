// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Regression: the AI categorization step wrote
//   suggestedContactId: matchedVendor?.id || null
// unconditionally. A check row whose payee had been read off the check image
// (contact linked at 0.95, matchType 'check_image') lost that link the moment
// the model failed to name a vendor from a description like "CHECK 7187" —
// which it always does, because the payee is not in the description. Observed
// in production as 27 statement checks with a visible payee, no payee link,
// and matchType 'ai' at 0.30.
//
// resolvePreAiLayers now also resolves a known payee to its usual account
// BEFORE any AI call, so those rows never reach the AI write path at all.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { resolvePreAiLayers } from './ai-categorization.service.js';

const tenantId = crypto.randomUUID();
const bankAccountId = crypto.randomUUID();
const suppliesId = crypto.randomUUID();
const repairsId = crypto.randomUUID();
const connectionId = crypto.randomUUID();
const knownVendorId = crypto.randomUUID();
const splitVendorId = crypto.randomUUID();

const itemKnownPayee = crypto.randomUUID();
const itemSplitPayee = crypto.randomUUID();
const itemNoPayee = crypto.randomUUID();

async function postTo(contactId: string, accountId: string, payee: string) {
  const txnId = crypto.randomUUID();
  await db.execute(sql`
    INSERT INTO transactions (id, tenant_id, txn_type, txn_date, total, status, contact_id, payee_name_on_check)
    VALUES (${txnId}, ${tenantId}, 'check', '2026-05-01'::date, 100.00, 'posted', ${contactId}, ${payee})
  `);
  await db.execute(sql`
    INSERT INTO journal_lines (transaction_id, tenant_id, account_id, debit, credit)
    VALUES (${txnId}, ${tenantId}, ${accountId}, 100.00, 0)
  `);
}

beforeAll(async () => {
  await db.execute(sql`INSERT INTO tenants (id, name, slug) VALUES (${tenantId}, 'Guard', ${'guard-' + tenantId.slice(0, 8)})`);
  await db.execute(sql`
    INSERT INTO accounts (id, tenant_id, name, account_type) VALUES
      (${bankAccountId}, ${tenantId}, 'Guard Checking', 'bank'),
      (${suppliesId}, ${tenantId}, 'Supplies', 'expense'),
      (${repairsId}, ${tenantId}, 'Repairs', 'expense')
  `);
  await db.execute(sql`
    INSERT INTO contacts (id, tenant_id, contact_type, display_name) VALUES
      (${knownVendorId}, ${tenantId}, 'vendor', 'CISAP'),
      (${splitVendorId}, ${tenantId}, 'vendor', 'Split Vendor')
  `);
  await db.execute(sql`
    INSERT INTO bank_connections (id, tenant_id, account_id, institution_name)
    VALUES (${connectionId}, ${tenantId}, ${bankAccountId}, 'Guard Bank')
  `);
  for (let i = 0; i < 3; i += 1) await postTo(knownVendorId, suppliesId, 'CISAP');
  await postTo(splitVendorId, suppliesId, 'Split Vendor');
  await postTo(splitVendorId, repairsId, 'Split Vendor');

  const mkItem = async (id: string, payee: string | null, contactId: string | null) => {
    await db.execute(sql`
      INSERT INTO bank_feed_items
        (id, tenant_id, bank_connection_id, feed_date, description, original_description, amount,
         status, check_number, payee_name_on_check, suggested_contact_id, match_type, confidence_score)
      VALUES (${id}, ${tenantId}, ${connectionId}, '2026-06-01', 'CHECK 7190', 'CHECK 7190', 250.00,
              'pending', 7190, ${payee}, ${contactId}::uuid,
              ${payee ? 'check_image' : null}, ${payee ? '0.95' : null})
    `);
  };
  await mkItem(itemKnownPayee, 'CISAP', knownVendorId);
  await mkItem(itemSplitPayee, 'Split Vendor', splitVendorId);
  await mkItem(itemNoPayee, null, null);
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM bank_feed_items WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM bank_connections WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM journal_lines WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM transactions WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM contacts WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM accounts WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM tenants WHERE id = ${tenantId}`);
});

const row = async (id: string) => {
  const r = await db.execute(sql`
    SELECT suggested_account_id, suggested_contact_id, match_type, confidence_score
    FROM bank_feed_items WHERE id = ${id}
  `);
  return r.rows[0] as {
    suggested_account_id: string | null;
    suggested_contact_id: string | null;
    match_type: string | null;
    confidence_score: string | null;
  };
};

describe('resolvePreAiLayers — check payee short-circuits before the AI', () => {
  it('categorizes a check from its payee history and keeps the contact', async () => {
    const item = {
      id: itemKnownPayee,
      description: 'CHECK 7190',
      originalDescription: 'CHECK 7190',
      suggestedAccountId: null,
      confidenceScore: '0.95',
      payeeNameOnCheck: 'CISAP',
      suggestedContactId: knownVendorId,
      companyId: null,
    };
    const pre = await resolvePreAiLayers(tenantId, item);
    expect(pre).not.toBeNull();
    expect(pre!.matchType).toBe('history');
    expect(pre!.accountId).toBe(suppliesId);
    // The whole point: the row never reaches the AI write path, so the
    // check-image contact survives.
    expect(pre!.contactId).toBe(knownVendorId);

    const after = await row(itemKnownPayee);
    expect(after.suggested_account_id).toBe(suppliesId);
    expect(after.suggested_contact_id).toBe(knownVendorId);
  });

  it('falls through to the AI when the payee was coded several ways', async () => {
    const pre = await resolvePreAiLayers(tenantId, {
      id: itemSplitPayee,
      description: 'CHECK 7190',
      originalDescription: 'CHECK 7190',
      suggestedAccountId: null,
      confidenceScore: '0.95',
      payeeNameOnCheck: 'Split Vendor',
      suggestedContactId: splitVendorId,
      companyId: null,
    });
    // Ambiguous history must not be resolved by guessing; the AI may still
    // take a view on the ACCOUNT, but the contact is protected downstream.
    expect(pre).toBeNull();
    const after = await row(itemSplitPayee);
    expect(after.suggested_contact_id).toBe(splitVendorId);
  });

  it('is a no-op for an ordinary row with no check payee', async () => {
    const pre = await resolvePreAiLayers(tenantId, {
      id: itemNoPayee,
      description: 'SOME CARD PURCHASE',
      originalDescription: 'SOME CARD PURCHASE',
      suggestedAccountId: null,
      confidenceScore: null,
      payeeNameOnCheck: null,
      suggestedContactId: null,
      companyId: null,
    });
    expect(pre).toBeNull();
    const after = await row(itemNoPayee);
    expect(after.suggested_account_id).toBeNull();
  });
});
