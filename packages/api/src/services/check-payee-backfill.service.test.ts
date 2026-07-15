// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { backfillCheckPayees } from './check-payee-backfill.service.js';

const tenantId = crypto.randomUUID();
const contactId = crypto.randomUUID();
const txnMatched = crypto.randomUUID(); // statement-line payee, amount confirms
const txnWrongAmount = crypto.randomUUID(); // same check# but amount differs → untouched
const txnHasPayee = crypto.randomUUID(); // already has payee → not a target
const statementId = crypto.randomUUID();
const accountId = crypto.randomUUID();

beforeAll(async () => {
  await db.execute(sql`INSERT INTO tenants (id, name, slug) VALUES (${tenantId}, 'Backfill Test', ${'backfill-' + tenantId.slice(0, 8)})`);
  await db.execute(sql`
    INSERT INTO contacts (id, tenant_id, contact_type, display_name)
    VALUES (${contactId}, ${tenantId}, 'vendor', 'Acme Lawn Care')
  `);
  await db.execute(sql`
    INSERT INTO transactions (id, tenant_id, txn_type, txn_date, total, check_number)
    VALUES
      (${txnMatched}, ${tenantId}, 'check', '2026-06-01', 150.00, 1234),
      (${txnWrongAmount}, ${tenantId}, 'check', '2026-06-02', 999.00, 5678),
      (${txnHasPayee}, ${tenantId}, 'check', '2026-06-03', 25.00, 9012)
  `);
  await db.execute(sql`
    UPDATE transactions SET payee_name_on_check = 'Already Set' WHERE id = ${txnHasPayee}
  `);
  await db.execute(sql`
    INSERT INTO accounts (id, tenant_id, name, account_type)
    VALUES (${accountId}, ${tenantId}, 'Backfill Test Checking', 'bank')
  `);
  await db.execute(sql`
    INSERT INTO bank_statements (id, tenant_id, account_id, period_end, closing_balance)
    VALUES (${statementId}, ${tenantId}, ${accountId}, '2026-06-30', 1000.00)
  `);
  await db.execute(sql`
    INSERT INTO bank_statement_lines (tenant_id, statement_id, line_date, description, amount, check_number, payee)
    VALUES
      (${tenantId}, ${statementId}, '2026-06-01', 'CHECK 1234', -150.00, '1234', 'Acme Lawn Care'),
      (${tenantId}, ${statementId}, '2026-06-02', 'CHECK 5678', -111.00, '5678', 'Wrong Amount Payee'),
      (${tenantId}, ${statementId}, '2026-06-02', 'CHECK 5678 AGAIN', -222.00, '5678', 'Second Different Payee')
  `);
});

afterAll(async () => {
  await db.execute(sql`DELETE FROM bank_statement_lines WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM bank_statements WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM transactions WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM accounts WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM audit_log WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM contacts WHERE id = ${contactId}`);
  await db.execute(sql`DELETE FROM tenants WHERE id = ${tenantId}`);
});

describe('backfillCheckPayees', () => {
  it('applies statement-line payees to payee-less checks by check#+amount and links contacts', async () => {
    const report = await backfillCheckPayees(tenantId);

    // Only txnMatched qualifies: amount confirms within a cent AND the
    // contact resolves. txnWrongAmount has two conflicting candidate payees
    // and no amount match → left alone, never guessed.
    expect(report.scannedTransactions).toBe(2); // txnHasPayee excluded up front
    expect(report.payeesApplied).toBe(1);
    expect(report.fromStatementLines).toBe(1);
    expect(report.contactsLinked).toBe(1);

    const rows = await db.execute(sql`
      SELECT id, payee_name_on_check, contact_id FROM transactions WHERE tenant_id = ${tenantId} ORDER BY check_number
    `);
    const byId = new Map((rows.rows as Array<{ id: string; payee_name_on_check: string | null; contact_id: string | null }>).map((r) => [r.id, r]));
    expect(byId.get(txnMatched)!.payee_name_on_check).toBe('Acme Lawn Care');
    expect(byId.get(txnMatched)!.contact_id).toBe(contactId);
    expect(byId.get(txnWrongAmount)!.payee_name_on_check).toBeNull();
    expect(byId.get(txnHasPayee)!.payee_name_on_check).toBe('Already Set');
  });

  it('is idempotent — a second run finds nothing left to apply', async () => {
    const report = await backfillCheckPayees(tenantId);
    expect(report.payeesApplied).toBe(0);
  });
});
