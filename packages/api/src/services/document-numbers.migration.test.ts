// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// U-111 / U-113: migration 0240 adds companies.document_numbers,
// invoice_templates.footer_overrides and transactions.print_later. Additive;
// the rollback drops them and the forward migration is idempotent. Every
// rollback runs in a transaction that is rolled back.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { db, type Tx } from '../db/index.js';

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');
const FORWARD = '0240_document_numbers.sql';
const ROLLBACK = '0240_document_numbers.rollback.sql';
const COLUMNS = [['companies', 'document_numbers'], ['invoice_templates', 'footer_overrides'], ['transactions', 'print_later']] as const;

async function run(tx: Tx, file: string): Promise<void> {
  const text = readFileSync(path.join(MIGRATIONS, file), 'utf8');
  for (const stmt of text.split('--> statement-breakpoint')) {
    const body = stmt.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim();
    if (body) await tx.execute(sql.raw(body));
  }
}

async function present(tx: Tx): Promise<boolean[]> {
  const out: boolean[] = [];
  for (const [t, c] of COLUMNS) {
    const r = await tx.execute(sql`SELECT 1 FROM information_schema.columns WHERE table_name = ${t} AND column_name = ${c}`);
    out.push(r.rows.length > 0);
  }
  return out;
}

class RolledBack extends Error {}

async function inRolledBackTx(fn: (tx: Tx) => Promise<void>): Promise<void> {
  await expect(db.transaction(async (tx) => {
    await fn(tx);
    throw new RolledBack('rollback');
  })).rejects.toBeInstanceOf(RolledBack);
}

describe('migration 0240 document numbers', () => {
  it('is in the journal after 0238 and is additive', () => {
    const fwd = readFileSync(path.join(MIGRATIONS, FORWARD), 'utf8');
    expect(fwd).not.toMatch(/drop\s+(table|column|constraint)/i);
    const journal = JSON.parse(readFileSync(path.join(MIGRATIONS, 'meta', '_journal.json'), 'utf8')) as { entries: Array<{ idx: number; tag: string; when: number }> };
    const entry = journal.entries.find((e) => e.tag === '0240_document_numbers');
    expect(entry?.idx).toBe(240);
    expect(entry!.when).toBeGreaterThan(journal.entries.find((e) => e.idx === 238)!.when);
  });

  it('rollback drops the columns; forward again (twice) restores them', async () => {
    await inRolledBackTx(async (tx) => {
      expect(await present(tx)).toEqual([true, true, true]);
      await run(tx, ROLLBACK);
      expect(await present(tx)).toEqual([false, false, false]);
      await run(tx, FORWARD);
      await run(tx, FORWARD);
      expect(await present(tx)).toEqual([true, true, true]);
    });
  });
});
