// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// U-162 (ClientLedger PR-4): migration 0261 adds
// inventory_movements.correction_share and puts source_transaction_id and id
// in the position index. Additive; the rollback restores the 0259 index and
// drops the column (always allowed), and the forward migration is
// idempotent. Every rollback runs inside a database transaction that is
// rolled back, so the rest of the suite never sees the old schema.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { db, type Tx } from '../db/index.js';

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');
const FORWARD = '0261_inventory_position.sql';
const ROLLBACK = '0261_inventory_position.rollback.sql';

async function run(tx: Tx, file: string): Promise<void> {
  const text = readFileSync(path.join(MIGRATIONS, file), 'utf8');
  for (const stmt of text.split('--> statement-breakpoint')) {
    const body = stmt.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim();
    if (body) await tx.execute(sql.raw(body));
  }
}

async function shape(tx: Tx) {
  const col = await tx.execute(sql`SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
    AND table_name = 'inventory_movements' AND column_name = 'correction_share'`);
  const idx = await tx.execute(sql`SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_inventory_movements_position'`);
  return { column: col.rows.length === 1, index: String((idx.rows[0] as { indexdef?: string } | undefined)?.indexdef ?? '') };
}

class RolledBack extends Error {}
async function inRolledBackTx(fn: (tx: Tx) => Promise<void>): Promise<void> {
  await expect(db.transaction(async (tx) => { await fn(tx); throw new RolledBack('rollback'); })).rejects.toBeInstanceOf(RolledBack);
}

describe('migration 0261 inventory position', () => {
  it('is listed after 0260 and is additive', () => {
    const fwd = readFileSync(path.join(MIGRATIONS, FORWARD), 'utf8');
    expect(fwd).not.toMatch(/drop\s+(table|column|constraint)/i);
    expect(fwd).not.toContain('migration-policy: non-additive-exception');
    const journal = JSON.parse(readFileSync(path.join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as { entries: Array<{ idx: number; tag: string; when: number }> };
    const entry = journal.entries.find((e) => e.tag === '0261_inventory_position');
    expect(entry?.idx).toBe(261);
    expect(entry!.when).toBeGreaterThan(journal.entries.find((e) => e.idx === 260)!.when);
  });

  it('forward: the column and the full position index; rollback restores 0259; forward again (twice) restores it', async () => {
    await inRolledBackTx(async (tx) => {
      const now = await shape(tx);
      expect(now.column).toBe(true);
      expect(now.index).toMatch(/transaction_id, source_transaction_id NULLS FIRST, id\)/);
      await run(tx, ROLLBACK);
      const old = await shape(tx);
      expect(old.column).toBe(false);
      expect(old.index).toMatch(/\(company_id, item_id, movement_date, txn_created_at, transaction_id\)$/);
      await run(tx, FORWARD);
      await run(tx, FORWARD);
      expect(await shape(tx)).toEqual(now);
    });
  });
});
