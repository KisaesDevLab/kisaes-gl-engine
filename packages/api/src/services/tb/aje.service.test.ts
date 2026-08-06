// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Phase 5: AJE numbering (per company per FY, concurrency-safe),
// closing-date exemption (D10), reverse/duplicate semantics, listing.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, pool } from '../../db/index.js';
import { accounts, companies, journalLines, tenants, transactions } from '../../db/schema/index.js';
import { sql } from 'drizzle-orm';
import * as ledger from '../ledger.service.js';
import {
  createAje, duplicateAje, firstOfNextMonth, listAjes, reverseAje, updateAje, voidAje,
} from './aje.service.js';

let tenantId: string;
let companyId: string;
let cashId: string;
let expenseId: string;

const line = (accountId: string, debit: number, credit: number) => ({
  accountId, debit: String(debit), credit: String(credit),
  isTaxable: false, taxRate: '0', taxAmount: '0',
});

beforeAll(async () => {
  const [t] = await db.insert(tenants).values({ name: 'tb-aje-test', slug: `tb-aje-${Date.now()}` }).returning();
  tenantId = t!.id;
  const [c] = await db.insert(companies).values({ tenantId, businessName: 'AJE Test Co', fiscalYearStartMonth: 1 }).returning();
  companyId = c!.id;
  const [cash] = await db.insert(accounts).values({ tenantId, companyId, accountNumber: '1000', name: 'Cash', accountType: 'asset' }).returning();
  const [exp] = await db.insert(accounts).values({ tenantId, companyId, accountNumber: '5000', name: 'Expense', accountType: 'expense' }).returning();
  cashId = cash!.id;
  expenseId = exp!.id;
});

afterAll(async () => {
  await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
  await db.execute(sql`DELETE FROM tb_aje_sequences WHERE tenant_id = ${tenantId}`);
  await db.execute(sql`DELETE FROM gl_version_stamps WHERE tenant_id = ${tenantId}`);
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  await pool.end();
});

describe('AJE workflow', () => {
  it('numbers AJE-001 per company per fiscal year, resetting across years (D17)', async () => {
    const a1 = await createAje(tenantId, companyId, {
      txnDate: '2026-03-01', memo: 'first', basis: 'both',
      lines: [line(expenseId, 100, 0), line(cashId, 0, 100)],
    });
    const a2 = await createAje(tenantId, companyId, {
      txnDate: '2026-04-01', memo: 'second', basis: 'both',
      lines: [line(expenseId, 50, 0), line(cashId, 0, 50)],
    });
    const prior = await createAje(tenantId, companyId, {
      txnDate: '2025-06-01', memo: 'prior year', basis: 'both',
      lines: [line(expenseId, 25, 0), line(cashId, 0, 25)],
    });
    expect(a1.ajeNumberLabel).toBe('AJE-001');
    expect(a2.ajeNumberLabel).toBe('AJE-002');
    expect(prior.ajeNumberLabel).toBe('AJE-001'); // FY2025 sequence
  });

  it('claims unique numbers under concurrency', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, (_, i) =>
      createAje(tenantId, companyId, {
        txnDate: '2027-02-01', memo: `conc ${i}`, basis: 'both',
        lines: [line(expenseId, 10 + i, 0), line(cashId, 0, 10 + i)],
      })));
    const numbers = results.map((r) => r.ajeNumber).sort((a, b) => a - b);
    expect(numbers).toEqual([1, 2, 3, 4, 5]);
  });

  it('bypasses the closing-date lock while regular JEs stay blocked (D10)', async () => {
    await db.update(companies).set({ lockDate: '2027-12-31' }).where(eq(companies.id, companyId));
    try {
      // Regular JE into the locked period → blocked.
      await expect(ledger.postTransaction(tenantId, {
        txnType: 'journal_entry', txnDate: '2027-06-15',
        lines: [line(expenseId, 5, 0), line(cashId, 0, 5)],
      }, undefined, companyId)).rejects.toMatchObject({ statusCode: 400 });

      // AJE into the same locked period → allowed; edit + void too.
      const aje = await createAje(tenantId, companyId, {
        txnDate: '2027-06-15', memo: 'locked-period AJE', basis: 'both',
        lines: [line(expenseId, 5, 0), line(cashId, 0, 5)],
      });
      await updateAje(tenantId, companyId, aje.id, {
        txnDate: '2027-06-15', memo: 'locked-period AJE (edited)', basis: 'both',
        lines: [line(expenseId, 7, 0), line(cashId, 0, 7)],
      });
      await voidAje(tenantId, aje.id, 'test void');
      const [voided] = await db.select({ status: transactions.status }).from(transactions)
        .where(eq(transactions.id, aje.id));
      expect(voided?.status).toBe('void');
    } finally {
      await db.update(companies).set({ lockDate: null }).where(eq(companies.id, companyId));
    }
  });

  it('reverses onto the first day of the next period with swapped lines', async () => {
    const original = await createAje(tenantId, companyId, {
      txnDate: '2026-11-30', memo: 'accrue bonus', basis: 'both',
      lines: [line(expenseId, 300, 0), line(cashId, 0, 300)],
    });
    const reversal = await reverseAje(tenantId, companyId, original.id);
    expect(reversal.txnDate).toBe('2026-12-01');
    expect(reversal.memo).toContain(`Reversal of ${original.ajeNumberLabel}`);
    const revLines = await db.select().from(journalLines)
      .where(eq(journalLines.transactionId, reversal.id))
      .orderBy(journalLines.lineOrder);
    expect(Number(revLines[0]!.credit)).toBe(300); // swapped
    expect(Number(revLines[0]!.debit)).toBe(0);
    expect(firstOfNextMonth('2026-12-31')).toBe('2027-01-01');
  });

  it('duplicates with a fresh number on the same date', async () => {
    const { ajes: before } = await listAjes(tenantId, companyId, { fiscalYear: 2026, limit: 100, offset: 0 });
    const source = before.find((a) => a.memo === 'accrue bonus')!;
    const dup = await duplicateAje(tenantId, companyId, source.id);
    expect(dup.txnDate).toBe('2026-11-30');
    expect(dup.ajeNumber).toBeGreaterThan(source.ajeNumber!);
  });

  it('lists per fiscal year with lines and labels', async () => {
    const { ajes, total } = await listAjes(tenantId, companyId, { fiscalYear: 2026, limit: 100, offset: 0 });
    expect(total).toBeGreaterThanOrEqual(4);
    expect(ajes.every((a) => a.txnDate >= '2026-01-01' && a.txnDate <= '2026-12-31')).toBe(true);
    expect(ajes.every((a) => a.ajeNumberLabel?.startsWith('AJE-'))).toBe(true);
    expect(ajes.every((a) => a.lines.length >= 2)).toBe(true);
    const { total: fy2025 } = await listAjes(tenantId, companyId, { fiscalYear: 2025, limit: 10, offset: 0 });
    expect(fy2025).toBe(1);
  });
});
