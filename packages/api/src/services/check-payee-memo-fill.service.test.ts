// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// The memo sweep inside backfillCheckPayees.
//
// payee_name_on_check is metadata almost nothing displays; the memo is what
// the register, the reports and the Uncategorized screen read. A bank-feed
// posting lands there with the bank's descriptor ("CHECK 3607", "Unknown"),
// so the payee the firm had already confirmed on Bank Feeds was invisible.
// The sweep repairs those rows WITHOUT touching a memo a person typed.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { backfillCheckPayees } from './check-payee-backfill.service.js';

const tenantId = crypto.randomUUID();
const accountId = crypto.randomUUID();
const connectionId = crypto.randomUUID();

const txnDescriptorMemo = crypto.randomUUID();  // memo == the feed descriptor
const txnUnknownMemo = crypto.randomUUID();     // memo == 'Unknown'
const txnBlankMemo = crypto.randomUUID();       // memo empty
const txnHumanMemo = crypto.randomUUID();       // a bookkeeper typed it
const txnNoPayee = crypto.randomUUID();         // nothing to fill from
const txnVoided = crypto.randomUUID();          // voided → never rewritten
const txnBareCheck = crypto.randomUUID();       // memo == 'Check', no feed row

beforeAll(async () => {
  await db.execute(sql`INSERT INTO tenants (id, name, slug) VALUES (${tenantId}, 'Memo Fill Test', ${'memofill-' + tenantId.slice(0, 8)})`);
  await db.execute(sql`
    INSERT INTO accounts (id, tenant_id, name, account_type)
    VALUES (${accountId}, ${tenantId}, 'Memo Fill Checking', 'bank')
  `);
  await db.execute(sql`
    INSERT INTO bank_connections (id, tenant_id, account_id, provider, institution_name)
    VALUES (${connectionId}, ${tenantId}, ${accountId}, 'manual', 'Test Bank')
  `);
  await db.execute(sql`
    INSERT INTO transactions (id, tenant_id, txn_type, txn_date, total, check_number, payee_name_on_check, memo, source)
    VALUES
      (${txnDescriptorMemo}, ${tenantId}, 'expense', '2026-07-15', 1000.00, 3607, 'Acme Supply Co', 'CHECK 3607', 'bank_feed'),
      (${txnUnknownMemo},    ${tenantId}, 'expense', '2026-07-17', 294.91,  3608, 'Beta Hardware',  'Unknown',    'bank_feed'),
      (${txnBlankMemo},      ${tenantId}, 'check',   '2026-08-13', 2600.00, NULL, 'Gamma Roofing',  '',           'bank_feed'),
      (${txnHumanMemo},      ${tenantId}, 'expense', '2026-08-14', 120.00,  3610, 'Delta Plumbing', 'Q3 deposit refund', 'bank_feed'),
      (${txnNoPayee},        ${tenantId}, 'expense', '2026-08-14', 150.50,  3611, NULL,             'CHECK 3611', 'bank_feed'),
      (${txnBareCheck},      ${tenantId}, 'expense', '2026-07-17', 294.91,  1744, 'Kobe Thomas',    'Check',      'bank_feed')
  `);
  await db.execute(sql`
    INSERT INTO transactions (id, tenant_id, txn_type, txn_date, total, check_number, payee_name_on_check, memo, source, voided_at)
    VALUES (${txnVoided}, ${tenantId}, 'expense', '2026-08-26', 449.55, 3612, 'Void Vendor', 'CHECK 3612', 'bank_feed', now())
  `);
  // The feed row whose description is still verbatim in txnDescriptorMemo's
  // memo — that equality is what marks the memo as untouched.
  await db.execute(sql`
    INSERT INTO bank_feed_items (tenant_id, bank_connection_id, feed_date, description, amount, status, matched_transaction_id, check_number)
    VALUES (${tenantId}, ${connectionId}, '2026-07-15', 'CHECK 3607', 1000.00, 'categorized', ${txnDescriptorMemo}, 3607)
  `);
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM bank_feed_items WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM bank_connections WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM transactions WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM accounts WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM audit_log WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM tenants WHERE id = ${tenantId}`);
});

async function memos(): Promise<Map<string, string | null>> {
  const rows = await db.execute(sql`
    SELECT id, memo FROM transactions WHERE tenant_id = ${tenantId}
  `);
  return new Map((rows.rows as Array<{ id: string; memo: string | null }>).map((r) => [r.id, r.memo]));
}

describe('backfillCheckPayees — memo sweep', () => {
  it('replaces untouched descriptor memos with the payee and leaves typed ones alone', async () => {
    const report = await backfillCheckPayees(tenantId);
    expect(report.memosFilled).toBe(4);

    const m = await memos();
    // Descriptor still matching its feed row → rewritten, check number kept.
    expect(m.get(txnDescriptorMemo)).toBe('Check 3607 - Acme Supply Co');
    // The literal "Unknown" carries no information either.
    expect(m.get(txnUnknownMemo)).toBe('Check 3608 - Beta Hardware');
    // No check number parsed → the bare payee.
    expect(m.get(txnBlankMemo)).toBe('Gamma Roofing');

    // A memo somebody typed is never overwritten.
    expect(m.get(txnHumanMemo)).toBe('Q3 deposit refund');
    // A bare "Check" descriptor with no feed row to compare against is still
    // recognised as the bank's text, not a person's.
    expect(m.get(txnBareCheck)).toBe('Check 1744 - Kobe Thomas');

    // No payee to fill from.
    expect(m.get(txnNoPayee)).toBe('CHECK 3611');
    // Voided rows are left exactly as posted.
    expect(m.get(txnVoided)).toBe('CHECK 3612');
  });

  it('is idempotent — a second run rewrites nothing', async () => {
    const report = await backfillCheckPayees(tenantId);
    expect(report.memosFilled).toBe(0);

    const m = await memos();
    expect(m.get(txnDescriptorMemo)).toBe('Check 3607 - Acme Supply Co');
    expect(m.get(txnHumanMemo)).toBe('Q3 deposit refund');
  });
});
