// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// U-101: migration 0238 adds companies.bill_discount_account_id and widens
// chk_bpa_amount_positive to (amount >= 0 AND amount + discount_amount > 0)
// (bill-discounts-v1). The constraint takes a discount-only row and still
// refuses a row with neither cash nor discount; the rollback is refused
// while a discount-only row exists and otherwise restores (amount > 0) and
// drops the column. Every rollback runs inside a database transaction that
// is rolled back, so the rest of the suite never sees the narrowed schema.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { db, type Tx } from '../db/index.js';
import { WIDENED_CHECKS } from './tenant-portability/compat.js';

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');
const FORWARD = '0238_pay_bills_discounts.sql';
const ROLLBACK = '0238_pay_bills_discounts.rollback.sql';

async function run(tx: Tx, file: string): Promise<void> {
  const text = readFileSync(path.join(MIGRATIONS, file), 'utf8');
  for (const stmt of text.split('--> statement-breakpoint')) {
    const body = stmt.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim();
    if (body) await tx.execute(sql.raw(body));
  }
}

async function constraintDef(tx: Tx): Promise<string> {
  const r = await tx.execute(sql`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint
    WHERE conname = 'chk_bpa_amount_positive' AND conrelid = 'bill_payment_applications'::regclass`);
  return String((r.rows[0] as { d: string } | undefined)?.d ?? '');
}

async function hasColumn(tx: Tx): Promise<boolean> {
  const r = await tx.execute(sql`SELECT 1 FROM information_schema.columns
    WHERE table_name = 'companies' AND column_name = 'bill_discount_account_id'`);
  return r.rows.length > 0;
}

async function insertApp(tx: Tx, amount: string, discount: string): Promise<void> {
  await tx.execute(sql`INSERT INTO bill_payment_applications (tenant_id, payment_id, bill_id, amount, discount_amount)
    VALUES (${crypto.randomUUID()}, ${crypto.randomUUID()}, ${crypto.randomUUID()}, ${amount}, ${discount})`);
}

class RolledBack extends Error {}

/** Runs `fn` in a transaction that is always rolled back. */
async function inRolledBackTx(fn: (tx: Tx) => Promise<void>): Promise<void> {
  await expect(db.transaction(async (tx) => {
    await fn(tx);
    throw new RolledBack('rollback');
  })).rejects.toBeInstanceOf(RolledBack);
}

describe('migration 0238 Pay Bills discounts', () => {
  it('is listed after 0237, carries the policy marker and a WIDENED_CHECKS entry', () => {
    const fwd = readFileSync(path.join(MIGRATIONS, FORWARD), 'utf8');
    expect(fwd.split('\n').slice(0, 10).join('\n')).toContain('-- migration-policy: non-additive-exception');
    expect(fwd).not.toMatch(/drop\s+(table|column)/i);
    const journal = JSON.parse(readFileSync(path.join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as { entries: Array<{ idx: number; tag: string; when: number }> };
    const entry = journal.entries.find((e) => e.tag === '0238_pay_bills_discounts');
    expect(entry?.idx).toBe(238);
    expect(entry!.when).toBeGreaterThan(journal.entries.find((e) => e.idx === 237)!.when);
    expect(WIDENED_CHECKS['bill_payment_applications.chk_bpa_amount_positive']).toEqual({ widenedIn: 239 });
  });

  it('the widened constraint takes a discount-only row and refuses a row with neither', async () => {
    await inRolledBackTx(async (tx) => {
      expect(await constraintDef(tx)).toContain('discount_amount');
      expect(await hasColumn(tx)).toBe(true);
      await insertApp(tx, '0', '4.37');
      await insertApp(tx, '10', '0');
      await expect(tx.transaction(async (sp) => { await insertApp(sp, '0', '0'); })).rejects.toThrow();
      await expect(tx.transaction(async (sp) => { await insertApp(sp, '-1', '5'); })).rejects.toThrow();
    });
  });

  it('rollback is refused while a discount-only row exists; otherwise it narrows the check and drops the column; forward again restores', async () => {
    await inRolledBackTx(async (tx) => {
      await insertApp(tx, '0', '1.00');
      await expect(tx.transaction(async (sp) => { await run(sp, ROLLBACK); })).rejects.toThrow(/rollback 0238 refused/);
    });
    await inRolledBackTx(async (tx) => {
      await tx.execute(sql`DELETE FROM bill_payment_applications WHERE amount <= 0`);
      await run(tx, ROLLBACK);
      expect(await constraintDef(tx)).not.toContain('discount_amount');
      expect(await hasColumn(tx)).toBe(false);
      await run(tx, FORWARD);
      await run(tx, FORWARD);
      expect(await constraintDef(tx)).toContain('discount_amount');
      expect(await hasColumn(tx)).toBe(true);
    });
  });
});
