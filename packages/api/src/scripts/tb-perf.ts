// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// TB balance-engine load fixture + timing harness (Phase 4.5).
// Target: < 1.5s uncached for a 2,000-account company with 100k
// transactions.
//
//   npm run -w @kis-books/api tb:perf            # generate, time, clean up
//   npm run -w @kis-books/api tb:perf -- --keep  # keep the fixture tenant
//   npm run -w @kis-books/api tb:perf -- --accounts 2000 --txns 100000
//
// Point DATABASE_URL at a THROWAWAY/TEST database — this inserts ~300k
// journal lines.

import { sql } from 'drizzle-orm';
import { db, pool } from '../db/index.js';
import { computeWorkpaper } from '../services/tb/balance-engine.service.js';

function arg(name: string, dflt: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return dflt;
  return Number(process.argv[i + 1]) || dflt;
}

async function main() {
  const ACCOUNTS = arg('accounts', 2000);
  const TXNS = arg('txns', 100_000);
  const keep = process.argv.includes('--keep');

  console.log(`[tb-perf] fixture: ${ACCOUNTS} accounts, ${TXNS} transactions`);
  const t0 = Date.now();

  const tRes = await db.execute(sql`
    INSERT INTO tenants (name, slug) VALUES ('tb-perf', ${'tb-perf-' + Date.now()}) RETURNING id
  `);
  const tenantId = (tRes.rows as Array<{ id: string }>)[0]!.id;
  const cRes = await db.execute(sql`
    INSERT INTO companies (tenant_id, business_name, fiscal_year_start_month)
    VALUES (${tenantId}, 'Perf Co', 1) RETURNING id
  `);
  const companyId = (cRes.rows as Array<{ id: string }>)[0]!.id;

  // Accounts: 40% expense, 20% revenue, 40% balance sheet.
  await db.execute(sql`
    INSERT INTO accounts (tenant_id, company_id, account_number, name, account_type)
    SELECT ${tenantId}, ${companyId},
      LPAD((1000 + g)::text, 5, '0'),
      'Perf Account ' || g,
      CASE WHEN g % 5 IN (0, 1) THEN 'expense'
           WHEN g % 5 = 2 THEN 'revenue'
           WHEN g % 5 = 3 THEN 'asset'
           ELSE 'liability' END
    FROM generate_series(1, ${ACCOUNTS}) g
  `);

  // Transactions: two-line balanced JEs spread over two fiscal years,
  // ~2% AJEs, dates 2025-01-01 .. 2026-12-31. Set-based generation so
  // the fixture builds in seconds, not minutes.
  await db.execute(sql`
    INSERT INTO transactions (id, tenant_id, company_id, txn_type, txn_date, status, basis)
    SELECT gen_random_uuid(), ${tenantId}, ${companyId},
      CASE WHEN g % 50 = 0 THEN 'aje' ELSE 'journal_entry' END,
      DATE '2025-01-01' + (g % 730),
      'posted', 'both'
    FROM generate_series(1, ${TXNS}) g
  `);
  await db.execute(sql`
    WITH t AS (
      SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS rn
      FROM transactions WHERE tenant_id = ${tenantId}
    ), a AS (
      SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS rn, COUNT(*) OVER () AS cnt
      FROM accounts WHERE tenant_id = ${tenantId}
    )
    INSERT INTO journal_lines (tenant_id, transaction_id, account_id, debit, credit, line_order)
    SELECT ${tenantId}, t.id, a.id,
      CASE WHEN side.s = 0 THEN 100.00 ELSE 0 END,
      CASE WHEN side.s = 1 THEN 100.00 ELSE 0 END,
      side.s
    FROM t
    CROSS JOIN (VALUES (0), (1)) AS side(s)
    JOIN a ON a.rn = ((t.rn * 7 + side.s * 13) % a.cnt) + 1
  `);
  console.log(`[tb-perf] fixture built in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  for (const basis of ['accrual', 'cash'] as const) {
    // Warm the OS/page cache once, then measure the uncached compute
    // (skipCache bypasses Redis; the target is engine time).
    await computeWorkpaper(tenantId, companyId, { periodEnd: '2026-12-31', basis, skipCache: true });
    const runs: number[] = [];
    for (let i = 0; i < 3; i++) {
      const wp = await computeWorkpaper(tenantId, companyId, { periodEnd: '2026-12-31', basis, skipCache: true });
      runs.push(wp.computeMs);
    }
    const best = Math.min(...runs);
    const status = best < 1500 ? 'PASS' : 'FAIL';
    console.log(`[tb-perf] ${basis}: runs ${runs.join('/')}ms — best ${best}ms → ${status} (<1500ms target)`);
  }

  if (!keep) {
    await db.execute(sql`DELETE FROM journal_lines WHERE tenant_id = ${tenantId}`);
    await db.execute(sql`DELETE FROM transactions WHERE tenant_id = ${tenantId}`);
    await db.execute(sql`DELETE FROM accounts WHERE tenant_id = ${tenantId}`);
    await db.execute(sql`DELETE FROM gl_version_stamps WHERE tenant_id = ${tenantId}`);
    await db.execute(sql`DELETE FROM companies WHERE tenant_id = ${tenantId}`);
    await db.execute(sql`DELETE FROM tenants WHERE id = ${tenantId}`);
    console.log('[tb-perf] fixture cleaned up');
  } else {
    console.log(`[tb-perf] fixture kept: tenant ${tenantId}, company ${companyId}`);
  }
  await pool.end();
}

main().catch((err) => {
  console.error('[tb-perf] failed:', err);
  process.exit(1);
});
