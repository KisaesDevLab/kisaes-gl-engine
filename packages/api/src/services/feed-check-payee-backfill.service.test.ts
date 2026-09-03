// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// STATEMENT_CHECK_PAYEE_FEED — filling payee + category on UNPOSTED check
// rows in the bank feed from statement lines already on file.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { backfillFeedItemCheckPayees } from './check-payee-backfill.service.js';

const tenantId = crypto.randomUUID();
const otherTenantId = crypto.randomUUID();
const bankAccountId = crypto.randomUUID();
const expenseAccountId = crypto.randomUUID();
const otherExpenseId = crypto.randomUUID();
const connectionId = crypto.randomUUID();
const statementId = crypto.randomUUID();
const knownVendorId = crypto.randomUUID();
const splitVendorId = crypto.randomUUID();

// Feed items under test
const itemHistoryVendor = crypto.randomUUID();  // payee + unambiguous history → category too
const itemNewVendor = crypto.randomUUID();      // payee, no history → needs a category
const itemWrongAmount = crypto.randomUUID();    // check# matches, amount contradicts → untouched
const itemDeposit = crypto.randomUUID();        // money IN with a check# → never touched
const itemHasPayee = crypto.randomUUID();       // already has a payee → not a target
const itemSplitVendor = crypto.randomUUID();    // payee coded 2 ways before → payee only
const itemPosted = crypto.randomUUID();         // already categorized → not a target

beforeAll(async () => {
  await db.execute(sql`INSERT INTO tenants (id, name, slug) VALUES (${tenantId}, 'Feed Payee Test', ${'feedpayee-' + tenantId.slice(0, 8)})`);
  await db.execute(sql`INSERT INTO tenants (id, name, slug) VALUES (${otherTenantId}, 'Feed Payee Other', ${'feedother-' + otherTenantId.slice(0, 8)})`);
  await db.execute(sql`
    INSERT INTO accounts (id, tenant_id, name, account_type) VALUES
      (${bankAccountId}, ${tenantId}, 'Feed Payee Checking', 'bank'),
      (${expenseAccountId}, ${tenantId}, 'Stone Supplies', 'expense'),
      (${otherExpenseId}, ${tenantId}, 'Repairs', 'expense')
  `);
  await db.execute(sql`
    INSERT INTO contacts (id, tenant_id, contact_type, display_name) VALUES
      (${knownVendorId}, ${tenantId}, 'vendor', 'Cosmos Granite'),
      (${splitVendorId}, ${tenantId}, 'vendor', 'Split Hardware')
  `);
  await db.execute(sql`
    INSERT INTO bank_connections (id, tenant_id, account_id, institution_name)
    VALUES (${connectionId}, ${tenantId}, ${bankAccountId}, 'Test Bank')
  `);

  // Prior posted history: Cosmos Granite always coded to Stone Supplies (3x)
  for (let i = 0; i < 3; i++) {
    const txnId = crypto.randomUUID();
    await db.execute(sql`
      INSERT INTO transactions (id, tenant_id, txn_type, txn_date, total, status, contact_id)
      VALUES (${txnId}, ${tenantId}, 'check', ${`2026-05-0${i + 1}`}::date, 100.00, 'posted', ${knownVendorId})
    `);
    await db.execute(sql`
      INSERT INTO journal_lines (transaction_id, tenant_id, account_id, debit, credit)
      VALUES (${txnId}, ${tenantId}, ${expenseAccountId}, 100.00, 0)
    `);
  }
  // Split Hardware coded two different ways → ambiguous, must yield no category
  for (const acct of [expenseAccountId, otherExpenseId]) {
    for (let i = 0; i < 2; i++) {
      const txnId = crypto.randomUUID();
      await db.execute(sql`
        INSERT INTO transactions (id, tenant_id, txn_type, txn_date, total, status, contact_id)
        VALUES (${txnId}, ${tenantId}, 'check', '2026-05-10', 50.00, 'posted', ${splitVendorId})
      `);
      await db.execute(sql`
        INSERT INTO journal_lines (transaction_id, tenant_id, account_id, debit, credit)
        VALUES (${txnId}, ${tenantId}, ${acct}, 50.00, 0)
      `);
    }
  }

  await db.execute(sql`
    INSERT INTO bank_statements (id, tenant_id, account_id, period_end, closing_balance)
    VALUES (${statementId}, ${tenantId}, ${bankAccountId}, '2026-06-30', 1000.00)
  `);
  // Statement amounts are credit-positive, so checks are negative.
  await db.execute(sql`
    INSERT INTO bank_statement_lines (tenant_id, statement_id, line_date, description, amount, check_number, payee) VALUES
      (${tenantId}, ${statementId}, '2026-06-01', 'CHECK 3001', -150.00, '3001', 'Cosmos Granite'),
      (${tenantId}, ${statementId}, '2026-06-02', 'CHECK 3002', -275.50, '3002', 'KL2 Stone'),
      (${tenantId}, ${statementId}, '2026-06-03', 'CHECK 3003', -111.00, '3003', 'Wrong Amount Payee'),
      (${tenantId}, ${statementId}, '2026-06-04', 'CHECK 3004', -60.00, '3004', 'Deposit Trap Payee'),
      (${tenantId}, ${statementId}, '2026-06-05', 'CHECK 3005', -90.00, '3005', 'Should Not Apply'),
      (${tenantId}, ${statementId}, '2026-06-06', 'CHECK 3006', -70.00, '3006', 'Split Hardware'),
      (${tenantId}, ${statementId}, '2026-06-07', 'CHECK 3007', -80.00, '3007', 'Posted Already')
  `);

  const mkItem = async (id: string, checkNo: number, amount: string, status: string, payee: string | null) => {
    await db.execute(sql`
      INSERT INTO bank_feed_items (id, tenant_id, bank_connection_id, feed_date, description, amount, status, check_number, payee_name_on_check)
      VALUES (${id}, ${tenantId}, ${connectionId}, '2026-06-01', 'Taz-Boy''s', ${amount}::numeric, ${status}, ${checkNo}, ${payee})
    `);
  };
  await mkItem(itemHistoryVendor, 3001, '150.00', 'pending', null);
  await mkItem(itemNewVendor, 3002, '275.50', 'pending', null);
  await mkItem(itemWrongAmount, 3003, '999.00', 'pending', null);
  await mkItem(itemDeposit, 3004, '-60.00', 'pending', null);       // money IN
  await mkItem(itemHasPayee, 3005, '90.00', 'pending', 'Already Set');
  await mkItem(itemSplitVendor, 3006, '70.00', 'pending', null);
  await mkItem(itemPosted, 3007, '80.00', 'categorized', null);
});

afterAll(async () => {
  for (const t of [tenantId, otherTenantId]) {
    await db.execute(sql`DELETE FROM bank_feed_items WHERE tenant_id = ${t}`);
    await db.execute(sql`DELETE FROM bank_statement_lines WHERE tenant_id = ${t}`);
    await db.execute(sql`DELETE FROM bank_statements WHERE tenant_id = ${t}`);
    await db.execute(sql`DELETE FROM bank_connections WHERE tenant_id = ${t}`);
    await db.execute(sql`DELETE FROM journal_lines WHERE tenant_id = ${t}`);
    await db.execute(sql`DELETE FROM transactions WHERE tenant_id = ${t}`);
    await db.execute(sql`DELETE FROM contacts WHERE tenant_id = ${t}`);
    await db.execute(sql`DELETE FROM accounts WHERE tenant_id = ${t}`);
    await db.execute(sql`DELETE FROM audit_log WHERE tenant_id = ${t}`);
    await db.execute(sql`DELETE FROM tenants WHERE id = ${t}`);
  }
});

const itemRow = async (id: string) => {
  const r = await db.execute(sql`
    SELECT payee_name_on_check, suggested_contact_id, suggested_account_id, match_type, confidence_score, status
    FROM bank_feed_items WHERE id = ${id}
  `);
  return r.rows[0] as {
    payee_name_on_check: string | null;
    suggested_contact_id: string | null;
    suggested_account_id: string | null;
    match_type: string | null;
    confidence_score: string | null;
    status: string;
  };
};

describe('backfillFeedItemCheckPayees', () => {
  it('dry run reports the matches and writes nothing', async () => {
    const report = await backfillFeedItemCheckPayees(tenantId, { dryRun: true });
    expect(report.dryRun).toBe(true);
    // 3001, 3002, 3006 match. 3003 amount contradicts, 3004 is a deposit,
    // 3005 already has a payee, 3007 is already categorized.
    expect(report.matched).toBe(3);
    expect(report.payeesApplied).toBe(0);
    expect(report.matches.map((m) => m.checkNumber).sort()).toEqual([3001, 3002, 3006]);

    // Nothing was written.
    expect((await itemRow(itemHistoryVendor)).payee_name_on_check).toBeNull();

    // The preview already knows which rows would get a category.
    const cosmos = report.matches.find((m) => m.checkNumber === 3001)!;
    expect(cosmos.suggestedAccountName).toBe('Stone Supplies');
    expect(cosmos.contactAction).toBe('linked');
    const kl2 = report.matches.find((m) => m.checkNumber === 3002)!;
    expect(kl2.suggestedAccountId).toBeNull();
    expect(kl2.contactAction).toBe('created');
    expect(report.categoriesSuggested).toBe(1);
    expect(report.needsCategory).toBe(2);
  });

  it('applies payee, links the known vendor, and sets the category from unambiguous history', async () => {
    const report = await backfillFeedItemCheckPayees(tenantId, { dryRun: false });
    expect(report.payeesApplied).toBe(3);
    expect(report.contactsLinked).toBe(2);   // Cosmos Granite + Split Hardware
    expect(report.contactsCreated).toBe(1);  // KL2 Stone
    expect(report.categoriesSuggested).toBe(1);

    const cosmos = await itemRow(itemHistoryVendor);
    expect(cosmos.payee_name_on_check).toBe('Cosmos Granite');
    expect(cosmos.suggested_contact_id).toBe(knownVendorId);
    expect(cosmos.suggested_account_id).toBe(expenseAccountId);
    expect(cosmos.status).toBe('pending'); // never posts
  });

  it('gives a payee but NO category when the payee was coded several ways before', async () => {
    const split = await itemRow(itemSplitVendor);
    expect(split.payee_name_on_check).toBe('Split Hardware');
    expect(split.suggested_contact_id).toBe(splitVendorId);
    // Ambiguous history must not be resolved by guessing.
    expect(split.suggested_account_id).toBeNull();
    expect(split.match_type).toBe('check_image');
  });

  it('creates a vendor for an unknown payee and leaves the category for a human', async () => {
    const kl2 = await itemRow(itemNewVendor);
    expect(kl2.payee_name_on_check).toBe('KL2 Stone');
    expect(kl2.suggested_contact_id).not.toBeNull();
    expect(kl2.suggested_account_id).toBeNull();
    const created = await db.execute(sql`
      SELECT contact_type FROM contacts WHERE tenant_id = ${tenantId} AND display_name = 'KL2 Stone'
    `);
    expect((created.rows[0] as { contact_type: string }).contact_type).toBe('vendor');
  });

  it('never touches a contradicting amount, a deposit, an already-named row, or a posted row', async () => {
    expect((await itemRow(itemWrongAmount)).payee_name_on_check).toBeNull();
    expect((await itemRow(itemDeposit)).payee_name_on_check).toBeNull();
    expect((await itemRow(itemHasPayee)).payee_name_on_check).toBe('Already Set');
    expect((await itemRow(itemPosted)).payee_name_on_check).toBeNull();
  });

  it('is idempotent — a second run finds nothing left to do', async () => {
    const again = await backfillFeedItemCheckPayees(tenantId, { dryRun: false });
    expect(again.matched).toBe(0);
    expect(again.payeesApplied).toBe(0);
  });

  it('does not read another tenant statements', async () => {
    const report = await backfillFeedItemCheckPayees(otherTenantId, { dryRun: true });
    expect(report.scannedItems).toBe(0);
    expect(report.matched).toBe(0);
  });

  it('respects createMissingContacts: false', async () => {
    // Reset one row and re-run with contact creation disabled.
    await db.execute(sql`
      UPDATE bank_feed_items SET payee_name_on_check = NULL, suggested_contact_id = NULL,
        suggested_account_id = NULL, match_type = NULL WHERE id = ${itemNewVendor}
    `);
    await db.execute(sql`DELETE FROM contacts WHERE tenant_id = ${tenantId} AND display_name = 'KL2 Stone'`);
    const report = await backfillFeedItemCheckPayees(tenantId, { dryRun: false, createMissingContacts: false });
    expect(report.contactsCreated).toBe(0);
    const row = await itemRow(itemNewVendor);
    // Payee text still lands; only the contact link is withheld.
    expect(row.payee_name_on_check).toBe('KL2 Stone');
    expect(row.suggested_contact_id).toBeNull();
  });
});
