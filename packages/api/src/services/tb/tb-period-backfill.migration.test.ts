// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Migration 0208 backfill rules, replayed against seeded rows inside a
// transaction that is always rolled back:
//   tickmark applications: tax_year 2026 → 2026-07-31 when that date is
//     inside TY2026 for the company (FY start 1 or 8–12), else FY end;
//   notes + sign-offs (incl. invalidated): FY end of tax_year;
//   orphan company / NULL FY start → calendar year.
// The UPDATE statements are read straight from the migration file so the
// test can't drift from what ships.

import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../../db/index.js';

const MIGRATION = join(dirname(fileURLToPath(import.meta.url)), '../../db/migrations/0208_tb_period_scoped_workpapers.sql');

function backfillStatements(): string[] {
  return readFileSync(MIGRATION, 'utf8')
    .split('--> statement-breakpoint')
    .map((chunk) => chunk.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n').trim())
    .filter((stmt) => /^UPDATE\s/i.test(stmt));
}

afterAll(async () => { await pool.end(); });

describe('0208 backfill', () => {
  it('has one UPDATE per table', () => {
    const stmts = backfillStatements();
    expect(stmts).toHaveLength(3);
    expect(stmts.map((s) => s.split(/\s+/)[1])).toEqual(['tb_tickmark_applications', 'tb_notes', 'tb_leadsheet_signoffs']);
  });

  it('assigns period ends per the owner-approved rules', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const t of ['tb_tickmark_applications', 'tb_notes', 'tb_leadsheet_signoffs']) {
        await client.query(`ALTER TABLE ${t} ALTER COLUMN period_end DROP NOT NULL`);
      }
      const tenant = (await client.query(`INSERT INTO tenants (name, slug) VALUES ('bf', 'bf-${Date.now()}') RETURNING id`)).rows[0].id as string;
      const co = async (m: number | null) => (await client.query(
        'INSERT INTO companies (tenant_id, business_name, fiscal_year_start_month) VALUES ($1, $2, $3) RETURNING id', [tenant, `FY${m}`, m],
      )).rows[0].id as string;
      const cal = await co(1);
      const jul = await co(7);
      const sep = await co(9);
      const nul = await co(null);
      const orphan = '00000000-0000-0000-0000-0000000000ff';
      const mark = (await client.query(`INSERT INTO tb_tickmarks (tenant_id, symbol, description) VALUES ($1, 'F', 'Footed') RETURNING id`, [tenant])).rows[0].id as string;
      const grouping = (await client.query(`INSERT INTO tb_groupings (tenant_id, company_id, name) VALUES ($1, $2, 'Cash') RETURNING id`, [tenant, cal])).rows[0].id as string;

      const apps: Array<[string, number, string]> = [
        [cal, 2026, '2026-07-31'],   // owner's rule (prod's 4 marks)
        [cal, 2025, '2025-12-31'],
        [jul, 2026, '2026-06-30'],   // 07/31/2026 is TY2027 for a July FY → FY end instead
        [sep, 2026, '2026-07-31'],   // Sep FY: TY2026 runs to 08/31/2026, 07/31 is inside
        [nul, 2026, '2026-07-31'],
        [orphan, 2027, '2027-12-31'],
      ];
      for (const [c, ty, expected] of apps) {
        await client.query(
          `INSERT INTO tb_tickmark_applications (tenant_id, company_id, tax_year, account_id, "column", tickmark_id, note, period_end)
           VALUES ($1, $2, $3, gen_random_uuid(), 'adjusted', $4, $5, NULL)`, [tenant, c, ty, mark, expected]);
      }
      const notes: Array<[string, number, string]> = [
        [cal, 2026, '2026-12-31'], [jul, 2026, '2026-06-30'], [sep, 2025, '2025-08-31'], [orphan, 2026, '2026-12-31'],
      ];
      for (const [c, ty, expected] of notes) {
        await client.query('INSERT INTO tb_notes (tenant_id, company_id, tax_year, body, period_end) VALUES ($1, $2, $3, $4, NULL)', [tenant, c, ty, expected]);
      }
      // Sign-offs: an invalidated pair + one live (prod has 7, all invalidated).
      for (const [role, inv] of [['preparer', true], ['preparer', false], ['reviewer', true]] as const) {
        await client.query(
          `INSERT INTO tb_leadsheet_signoffs (tenant_id, company_id, tax_year, grouping_id, role, user_id, gl_version_stamp_at_signoff, invalidated_at, period_end)
           VALUES ($1, $2, 2026, $3, $4, gen_random_uuid(), 1, ${inv ? 'now()' : 'NULL'}, NULL)`, [tenant, cal, grouping, role]);
      }

      for (const stmt of backfillStatements()) await client.query(stmt);

      const a = await client.query(`SELECT note, period_end::text AS pe FROM tb_tickmark_applications WHERE tenant_id = $1 OR company_id = $2`, [tenant, orphan]);
      expect(a.rows).toHaveLength(apps.length);
      for (const r of a.rows) expect(r.pe, r.note).toBe(r.note);
      const n = await client.query(`SELECT body, period_end::text AS pe FROM tb_notes WHERE tenant_id = $1`, [tenant]);
      expect(n.rows).toHaveLength(notes.length);
      for (const r of n.rows) expect(r.pe, r.body).toBe(r.body);
      const s = await client.query(`SELECT period_end::text AS pe, invalidated_at FROM tb_leadsheet_signoffs WHERE tenant_id = $1`, [tenant]);
      expect(s.rows).toHaveLength(3);
      expect(s.rows.every((r) => r.pe === '2026-12-31')).toBe(true);
      expect(s.rows.filter((r) => r.invalidated_at !== null)).toHaveLength(2);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
