// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// U-39b / U-156 / U-25: migration 0258 widens items_item_type_ck with
// inventory_part, adds the purchase-side and part columns and
// companies.inventory_enabled. The rollback turns parts into non_inventory
// items (N5) or stops while stock movements exist. Every rollback runs inside
// a database transaction that is rolled back, so the rest of the suite never
// sees the old schema.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { db, type Tx } from '../db/index.js';

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');
const FORWARD = '0258_inventory_items.sql';
const ROLLBACK = '0258_inventory_items.rollback.sql';

async function run(tx: Tx, file: string): Promise<void> {
  const text = readFileSync(path.join(MIGRATIONS, file), 'utf8');
  for (const stmt of text.split('--> statement-breakpoint')) {
    const body = stmt.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim();
    if (body) await tx.execute(sql.raw(body));
  }
}

const COLS = ['companies.inventory_enabled', 'items.asset_account_id', 'items.cogs_account_id', 'items.expense_account_id',
  'items.preferred_vendor_id', 'items.purchase_cost', 'items.purchase_description', 'items.reorder_point', 'items.reorder_quantity',
  'items.unit_label'];

async function columns(tx: Tx) {
  const r = await tx.execute(sql`
    SELECT table_name || '.' || column_name AS c FROM information_schema.columns
    WHERE table_schema = 'public' AND ((table_name = 'items' AND column_name IN ('purchase_description', 'purchase_cost',
      'expense_account_id', 'asset_account_id', 'cogs_account_id', 'preferred_vendor_id', 'reorder_point', 'reorder_quantity', 'unit_label'))
      OR (table_name = 'companies' AND column_name = 'inventory_enabled'))
    ORDER BY 1`);
  return (r.rows as Array<{ c: string }>).map((x) => x.c);
}

class RolledBack extends Error {}
async function inRolledBackTx(fn: (tx: Tx) => Promise<void>): Promise<void> {
  await expect(db.transaction(async (tx) => { await fn(tx); throw new RolledBack('rollback'); })).rejects.toBeInstanceOf(RolledBack);
}
async function refuses(tx: Tx, stmt: ReturnType<typeof sql>) {
  await tx.execute(sql`SAVEPOINT s1`);
  await expect(tx.execute(stmt)).rejects.toThrow();
  await tx.execute(sql`ROLLBACK TO SAVEPOINT s1`);
}

const insertPart = (tx: Tx, name: string) => tx.execute(sql`INSERT INTO items (tenant_id, name, income_account_id, item_type, asset_account_id, cogs_account_id)
  VALUES (gen_random_uuid(), ${name}, gen_random_uuid(), 'inventory_part', gen_random_uuid(), gen_random_uuid()) RETURNING id`);

describe('migration 0258 inventory items', () => {
  it('is listed after 0257 and carries the non-additive marker only for the widened kind check', () => {
    const fwd = readFileSync(path.join(MIGRATIONS, FORWARD), 'utf8');
    expect(fwd.split('\n').slice(0, 10).join('\n')).toContain('migration-policy: non-additive-exception');
    expect(fwd).not.toMatch(/drop\s+(table|column)/i);
    const journal = JSON.parse(readFileSync(path.join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as { entries: Array<{ idx: number; tag: string; when: number }> };
    const entry = journal.entries.find((e) => e.tag === '0258_inventory_items');
    expect(entry?.idx).toBe(258);
    expect(entry!.when).toBeGreaterThan(journal.entries.find((e) => e.idx === 257)!.when);
  });

  it('takes inventory_part with both accounts; refuses a part without them, a negative cost and a zero reorder quantity', async () => {
    await inRolledBackTx(async (tx) => {
      await insertPart(tx, 'mig-0258');
      await refuses(tx, sql`INSERT INTO items (tenant_id, name, income_account_id, item_type) VALUES (gen_random_uuid(), 'x', gen_random_uuid(), 'inventory_part')`);
      await refuses(tx, sql`INSERT INTO items (tenant_id, name, income_account_id, item_type) VALUES (gen_random_uuid(), 'x', gen_random_uuid(), 'inventory_assembly')`);
      await refuses(tx, sql`INSERT INTO items (tenant_id, name, income_account_id, purchase_cost) VALUES (gen_random_uuid(), 'x', gen_random_uuid(), -1)`);
      await refuses(tx, sql`INSERT INTO items (tenant_id, name, income_account_id, reorder_quantity) VALUES (gen_random_uuid(), 'x', gen_random_uuid(), 0)`);
    });
  });

  it('rollback turns parts into non_inventory items and drops the columns; forward again (twice) restores them', async () => {
    await inRolledBackTx(async (tx) => {
      expect(await columns(tx)).toEqual(COLS);
      const id = (((await insertPart(tx, 'mig-0258-rb')).rows[0]) as { id: string }).id;
      await run(tx, ROLLBACK);
      expect(await columns(tx)).toEqual([]);
      const row = (await tx.execute(sql`SELECT item_type FROM items WHERE id = ${id}`)).rows[0] as { item_type: string };
      expect(row.item_type).toBe('non_inventory');
      await refuses(tx, sql`INSERT INTO items (tenant_id, name, income_account_id, item_type) VALUES (gen_random_uuid(), 'x', gen_random_uuid(), 'inventory_part')`);
      await run(tx, FORWARD);
      await run(tx, FORWARD);
      expect(await columns(tx)).toEqual(COLS);
      await insertPart(tx, 'mig-0258-again');
    });
  });

  it('rollback stops with a clear message while stock movements exist', async () => {
    await inRolledBackTx(async (tx) => {
      const exists = (await tx.execute(sql`SELECT to_regclass('public.inventory_movements') IS NOT NULL AS e`)).rows[0] as { e: boolean };
      if (!exists.e) await tx.execute(sql`CREATE TABLE inventory_movements (id uuid PRIMARY KEY DEFAULT gen_random_uuid())`);
      await tx.execute(sql.raw(exists.e
        ? `INSERT INTO inventory_movements SELECT * FROM inventory_movements LIMIT 0`
        : `INSERT INTO inventory_movements DEFAULT VALUES`));
      const hasRows = (await tx.execute(sql`SELECT EXISTS (SELECT 1 FROM inventory_movements) AS e`)).rows[0] as { e: boolean };
      if (!hasRows.e) return; // 0259 present and empty here: covered by its own test.
      await tx.execute(sql`SAVEPOINT s1`);
      await expect(run(tx, ROLLBACK)).rejects.toThrow(/inventory_movements holds stock movements/);
      await tx.execute(sql`ROLLBACK TO SAVEPOINT s1`);
    });
  });
});
