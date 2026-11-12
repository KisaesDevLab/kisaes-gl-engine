// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.
//
// U-119 (ClientLedger A07 PR-B, R-T2): migration 0277 makes the ledger stamp
// move when an application changes — applying a credit memo or payment to an
// invoice, a bill payment or a vendor credit to a bill, and changing or
// removing one — with no journal line written. The payment's company is the
// one whose stamp moves. The rollback removes the triggers (the stamp then
// stays put); the forward file is applied again at the end.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { billPaymentApplications, paymentApplications, transactions, vendorCreditApplications } from '../db/schema/index.js';
import { getLedgerVersion } from './ledger-version.service.js';
import { makeCompany, cleanTenant, type Co } from './templates/templates.test-helpers.js';

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

async function run(file: string): Promise<void> {
  const text = readFileSync(path.join(MIGRATIONS, file), 'utf8');
  for (const stmt of text.split('--> statement-breakpoint')) {
    const body = stmt.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim();
    if (body) await db.execute(sql.raw(body));
  }
}

const tenantIds: string[] = [];
let c: Co;

async function txn(txnType: string, companyId: string | null = c.companyId): Promise<string> {
  const [t] = await db.insert(transactions).values({
    tenantId: c.tenantId, companyId, txnType: txnType as never, txnDate: '2026-07-01', status: 'posted', total: '10.0000',
  }).returning();
  return t!.id;
}

beforeAll(async () => {
  c = await makeCompany('u119s', tenantIds);
});

afterAll(async () => {
  await run('0277_ledger_stamp_applications.sql');
  for (const t of [paymentApplications, billPaymentApplications, vendorCreditApplications]) {
    await db.delete(t).where(eq(t.tenantId, c.tenantId));
  }
  while (tenantIds.length) await cleanTenant(tenantIds.pop()!);
});

describe('migration 0277 ledger stamp on applications', () => {
  it('is listed after 0276 and additive', () => {
    const fwd = readFileSync(path.join(MIGRATIONS, '0277_ledger_stamp_applications.sql'), 'utf8');
    expect(fwd).not.toMatch(/migration-policy/);
    expect(fwd).not.toMatch(/drop\s+(table|column)/i);
    const journal = JSON.parse(readFileSync(path.join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as { entries: Array<{ idx: number; tag: string; when: number }> };
    const entry = journal.entries.find((e) => e.tag === '0277_ledger_stamp_applications');
    expect(entry?.idx).toBe(277);
    expect(entry!.when).toBeGreaterThan(journal.entries.find((e) => e.idx === 276)!.when);
  });

  it('applying, changing and removing an application moves the stamp of the payment\'s company', async () => {
    const memo = await txn('credit_memo');
    const invoice = await txn('invoice');
    const billPay = await txn('bill_payment');
    const bill = await txn('bill');
    const credit = await txn('vendor_credit');
    const other = await txn('invoice', c.companyB);

    const moves = async (f: () => Promise<unknown>) => {
      const a = await getLedgerVersion(c.tenantId, c.companyId);
      const b = await getLedgerVersion(c.tenantId, c.companyB);
      await f();
      return { own: (await getLedgerVersion(c.tenantId, c.companyId)) - a, other: (await getLedgerVersion(c.tenantId, c.companyB)) - b };
    };

    // A credit memo applied to an invoice (R-T2).
    let id = '';
    expect(await moves(async () => {
      const [r] = await db.insert(paymentApplications).values({ tenantId: c.tenantId, companyId: c.companyId, paymentId: memo, invoiceId: invoice, amount: '4.0000' }).returning();
      id = r!.id;
    })).toEqual({ own: 1, other: 0 });
    expect((await moves(() => db.update(paymentApplications).set({ voidedAt: new Date() }).where(eq(paymentApplications.id, id)))).own).toBe(1);
    expect((await moves(() => db.delete(paymentApplications).where(eq(paymentApplications.id, id)))).own).toBe(1);

    expect((await moves(() => db.insert(billPaymentApplications).values({ tenantId: c.tenantId, companyId: c.companyId, paymentId: billPay, billId: bill, amount: '3.0000' }))).own).toBe(1);
    expect((await moves(() => db.update(billPaymentApplications).set({ amount: '2.0000' }).where(eq(billPaymentApplications.paymentId, billPay)))).own).toBe(1);
    expect((await moves(() => db.insert(vendorCreditApplications).values({ tenantId: c.tenantId, companyId: c.companyId, paymentId: billPay, creditId: credit, billId: bill, amount: '1.0000' }))).own).toBe(1);
    expect((await moves(() => db.delete(vendorCreditApplications).where(eq(vendorCreditApplications.paymentId, billPay)))).own).toBe(1);
    // A statement that touches nothing moves nothing.
    expect((await moves(() => db.delete(billPaymentApplications).where(eq(billPaymentApplications.paymentId, other)))).own).toBe(0);

    // Rolled back: the stamp stays put; forward again: it moves.
    await run('0277_ledger_stamp_applications.rollback.sql');
    expect((await moves(() => db.delete(billPaymentApplications).where(eq(billPaymentApplications.paymentId, billPay)))).own).toBe(0);
    await run('0277_ledger_stamp_applications.sql');
    await run('0277_ledger_stamp_applications.sql');
    expect((await moves(() => db.insert(billPaymentApplications).values({ tenantId: c.tenantId, companyId: c.companyId, paymentId: billPay, billId: bill, amount: '3.0000' }))).own).toBe(1);
  });
});
