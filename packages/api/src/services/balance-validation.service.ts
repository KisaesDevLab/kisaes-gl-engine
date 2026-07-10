// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// CLAUDE.md rule 24 made real: periodically validate the denormalized
// accounts.balance column against SUM(debit) − SUM(credit) over POSTED
// journal lines, and repair any drift. Until now the rule was
// aspirational — no scheduler compared the two, so drift (historical
// Plaid balance clobbers, crashed half-writes, manual DB surgery) was
// permanent. Runs daily in the worker under an advisory lock, same
// pattern as backup-scheduler / recurring-scheduler.

import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { auditLog } from '../middleware/audit.js';

export interface BalanceDrift {
  accountId: string;
  accountName: string;
  storedBalance: string;
  ledgerBalance: string;
}

/**
 * Compare accounts.balance to the posted-lines ledger sum for one
 * tenant. When `repair` is set, drifted rows are rewritten to the
 * ledger-derived value (the ledger is the source of truth) and the
 * repair is audit-logged.
 */
export async function validateTenantBalances(
  tenantId: string,
  options: { repair?: boolean } = {},
): Promise<BalanceDrift[]> {
  const drifted = await db.execute(sql`
    SELECT a.id, a.name, a.balance::text AS stored,
      COALESCE(s.total, 0)::text AS actual
    FROM accounts a
    LEFT JOIN (
      SELECT jl.account_id, SUM(jl.debit - jl.credit) AS total
      FROM journal_lines jl
      JOIN transactions t ON t.id = jl.transaction_id
      WHERE jl.tenant_id = ${tenantId} AND t.status = 'posted'
      GROUP BY jl.account_id
    ) s ON s.account_id = a.id
    WHERE a.tenant_id = ${tenantId}
      AND a.balance::numeric IS DISTINCT FROM COALESCE(s.total, 0)
  `);

  const drifts: BalanceDrift[] = (drifted.rows as Array<{ id: string; name: string; stored: string; actual: string }>).map((r) => ({
    accountId: r.id,
    accountName: r.name,
    storedBalance: r.stored,
    ledgerBalance: r.actual,
  }));

  if (options.repair && drifts.length > 0) {
    for (const d of drifts) {
      await db.execute(sql`
        UPDATE accounts SET balance = ${d.ledgerBalance}::decimal, updated_at = now()
        WHERE tenant_id = ${tenantId} AND id = ${d.accountId}
      `);
    }
    await auditLog(
      tenantId, 'update', 'account_balance_repair', null,
      { drifted: drifts.map((d) => ({ accountId: d.accountId, stored: d.storedBalance })) },
      { repairedTo: drifts.map((d) => ({ accountId: d.accountId, ledger: d.ledgerBalance })) },
    );
  }

  return drifts;
}

/** One cycle: validate + repair every tenant. */
export async function runBalanceValidationCycle(): Promise<{ tenantsChecked: number; accountsRepaired: number }> {
  const tenantsResult = await db.execute(sql`SELECT id FROM tenants`);
  let accountsRepaired = 0;
  for (const row of tenantsResult.rows as { id: string }[]) {
    try {
      const drifts = await validateTenantBalances(row.id, { repair: true });
      if (drifts.length > 0) {
        console.warn(`[Balance Validation] tenant ${row.id}: repaired ${drifts.length} drifted account balance(s)`);
        accountsRepaired += drifts.length;
      }
    } catch (err) {
      console.error(`[Balance Validation] tenant ${row.id} failed:`, err);
    }
  }
  return { tenantsChecked: tenantsResult.rows.length, accountsRepaired };
}

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
const INITIAL_DELAY_MS = 10 * 60 * 1000; // 10 minutes after boot

export function startBalanceValidationScheduler(): void {
  console.log('[Balance Validation] Registered (daily, first run in 10 min)');
  const runCycle = async () => {
    try {
      const { withSchedulerLock } = await import('../utils/scheduler-lock.js');
      await withSchedulerLock('balance-validation-scheduler', runBalanceValidationCycle);
    } catch (err) {
      console.error('[Balance Validation] cycle failed:', err);
    }
  };
  setTimeout(() => { runCycle(); }, INITIAL_DELAY_MS);
  setInterval(() => { runCycle(); }, CHECK_INTERVAL_MS);
}
