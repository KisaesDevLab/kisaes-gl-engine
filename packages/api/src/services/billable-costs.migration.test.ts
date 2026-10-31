// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// U-128: migration 0245 adds billable_cost_links, journal_lines.
// billable_source_line_id, contacts.default_markup_percent and
// companies.billable_markup_account_id (billable-costs-v1). Additive; the
// rollback drops them and leaves billed_status alone; the forward migration
// is idempotent. Every rollback runs inside a database transaction that is
// rolled back, so the rest of the suite never sees the old schema.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { db, type Tx } from '../db/index.js';

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');
const FORWARD = '0245_billable_costs.sql';
const ROLLBACK = '0245_billable_costs.rollback.sql';

async function run(tx: Tx, file: string): Promise<void> {
  const text = readFileSync(path.join(MIGRATIONS, file), 'utf8');
  for (const stmt of text.split('--> statement-breakpoint')) {
    const body = stmt.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim();
    if (body) await tx.execute(sql.raw(body));
  }
}

async function columns(tx: Tx, table: string): Promise<string[]> {
  const cols = await tx.execute(sql`
    SELECT column_name AS c FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = ${table} ORDER BY 1`);
  return (cols.rows as Array<{ c: string }>).map((r) => r.c);
}

class RolledBack extends Error {}

async function inRolledBackTx(fn: (tx: Tx) => Promise<void>): Promise<void> {
  await expect(db.transaction(async (tx) => {
    await fn(tx);
    throw new RolledBack('rollback');
  })).rejects.toBeInstanceOf(RolledBack);
}

const LINK_COLS = [
  'company_id', 'cost_amount', 'created_at', 'created_by', 'id', 'invoice_id', 'markup_account_id', 'markup_amount',
  'markup_percent', 'release_reason', 'released_at', 'released_by', 'source_line_id', 'source_transaction_id', 'tenant_id',
];

async function added(tx: Tx) {
  return {
    links: await columns(tx, 'billable_cost_links'),
    jl: (await columns(tx, 'journal_lines')).includes('billable_source_line_id'),
    contact: (await columns(tx, 'contacts')).includes('default_markup_percent'),
    company: (await columns(tx, 'companies')).includes('billable_markup_account_id'),
    billed: (await columns(tx, 'journal_lines')).includes('billed_status'),
  };
}

describe('migration 0245 billable costs', () => {
  it('is listed after 0244 and is additive', () => {
    const fwd = readFileSync(path.join(MIGRATIONS, FORWARD), 'utf8');
    expect(fwd).not.toMatch(/drop\s+(table|column|constraint)/i);
    const journal = JSON.parse(readFileSync(path.join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as { entries: Array<{ idx: number; tag: string; when: number }> };
    const entry = journal.entries.find((e) => e.tag === '0245_billable_costs');
    expect(entry?.idx).toBe(245);
    expect(entry!.when).toBeGreaterThan(journal.entries.find((e) => e.idx === 244)!.when);
  });

  it('one active link per cost line; released links may repeat', async () => {
    await inRolledBackTx(async (tx) => {
      expect(await added(tx)).toEqual({ links: LINK_COLS, jl: true, contact: true, company: true, billed: true });
      const t = '00000000-0000-4000-8000-000000000001';
      const line = '00000000-0000-4000-8000-000000000002';
      const ins = (released: boolean) => tx.execute(sql`INSERT INTO billable_cost_links
        (tenant_id, source_transaction_id, source_line_id, invoice_id, cost_amount, released_at, release_reason)
        VALUES (${t}, gen_random_uuid(), ${line}, gen_random_uuid(), 10,
          ${released ? sql`now()` : sql`NULL`}, ${released ? 'removed' : null})`);
      await ins(true);
      await ins(true);
      await ins(false);
      await expect(tx.transaction(async (sp) => {
        await sp.execute(sql`INSERT INTO billable_cost_links (tenant_id, source_transaction_id, source_line_id, invoice_id, cost_amount)
          VALUES (${t}, gen_random_uuid(), ${line}, gen_random_uuid(), 10)`);
      })).rejects.toThrow();
      const chk = await tx.execute(sql`SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint
        WHERE conname = 'contacts_default_markup_percent_chk'`);
      expect(String((chk.rows[0] as { d: string }).d)).toMatch(/1000/);
    });
  });

  it('rollback drops the additions and keeps billed_status; forward again (twice) restores them', async () => {
    await inRolledBackTx(async (tx) => {
      await run(tx, ROLLBACK);
      expect(await added(tx)).toEqual({ links: [], jl: false, contact: false, company: false, billed: true });
      await run(tx, FORWARD);
      await run(tx, FORWARD);
      expect(await added(tx)).toEqual({ links: LINK_COLS, jl: true, contact: true, company: true, billed: true });
    });
  });
});
