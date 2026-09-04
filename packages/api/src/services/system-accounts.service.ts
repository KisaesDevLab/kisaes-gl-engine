// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Shared resolver for accounts the ledger addresses by ROLE rather than by id
// (`accounts.system_tag`). The catalog of roles lives in
// @kis-books/shared SYSTEM_ACCOUNT_ROLES; this module owns the *creation*
// specs — account number, name, detail type — for the roles that are created
// lazily on first use instead of being seeded by every COA template.
//
// Before this module the get-or-create logic lived privately inside
// daily-sales.service.ts. It is shared now because `suspense` needs the same
// behaviour from the banking, imports, and Practice surfaces.

import { and, eq, isNull, or, sql, inArray } from 'drizzle-orm';
import { DAILY_SALES_SYSTEM_ACCOUNTS, type AccountType } from '@kis-books/shared';
import { db } from '../db/index.js';
import { accounts, journalLines } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';

export const SUSPENSE_TAG = 'suspense';

/**
 * The ONE system role a bank feed may legitimately post into.
 *
 * Every other system-tagged account — payments_clearing, suspense, A/R, A/P,
 * retained_earnings — is a holding or control account, and wiring a bank feed
 * to one silently corrupts both it and the real bank balance. That is exactly
 * what happened when a client's Plaid feed landed on Payments Clearing, which
 * was selectable because its detail_type had drifted to 'bank'.
 *
 * Kept here rather than in the Plaid services because both the mapping guard
 * and the Bank Connections read model need the same answer, and a second copy
 * of this rule would drift.
 */
export const BANK_FEED_SYSTEM_TAG = 'cash_on_hand';

export interface SystemAccountSpec {
  systemTag: string;
  name: string;
  accountType: AccountType;
  detailType: string;
  accountNumber: string;
  /**
   * Account numbers of pre-existing, untagged accounts this role may ADOPT
   * rather than create alongside. Used for `suspense`, where every built-in
   * COA template but two already seeds `89999 Uncategorized` as a plain
   * editable expense account. Adopting it avoids leaving a tenant with two
   * near-identical "uncategorized" accounts.
   */
  adoptAccountNumbers?: string[];
  /** Same idea, matched on name (case-insensitive, exact). */
  adoptNames?: string[];
}

export const SYSTEM_ACCOUNT_SPECS: SystemAccountSpec[] = [
  ...DAILY_SALES_SYSTEM_ACCOUNTS.map((s) => ({ ...s })),
  {
    systemTag: SUSPENSE_TAG,
    name: 'Uncategorized',
    accountType: 'other_expense',
    detailType: 'other_expense',
    accountNumber: '89999',
    adoptAccountNumbers: ['89999'],
    adoptNames: ['uncategorized', 'ask my accountant', 'suspense'],
  },
];

const SPEC_BY_TAG = new Map(SYSTEM_ACCOUNT_SPECS.map((s) => [s.systemTag, s]));

/** Read-only lookup. Returns null when the role is unassigned for this tenant. */
export async function findSystemAccountId(tenantId: string, systemTag: string): Promise<string | null> {
  const existing = await db.query.accounts.findFirst({
    where: and(eq(accounts.tenantId, tenantId), eq(accounts.systemTag, systemTag)),
  });
  return existing?.id ?? null;
}

/**
 * Resolve a role to an account id, creating or adopting one when the tenant
 * has none. Order:
 *   1. an account already carrying the tag wins;
 *   2. else an untagged account of the right TYPE matching the spec's adopt
 *      list is stamped in place (system_tag + is_system);
 *   3. else a fresh account is inserted.
 *
 * `(tenant_id, account_number)` is unique, so step 3 falls back to a null
 * account number when the spec's number is already taken by something else.
 */
export async function getOrCreateSystemAccount(
  tenantId: string,
  systemTag: string,
  companyId?: string,
  actingUserId?: string,
): Promise<string> {
  const tagged = await findSystemAccountId(tenantId, systemTag);
  if (tagged) return tagged;

  const spec = SPEC_BY_TAG.get(systemTag);
  if (!spec) throw AppError.internal(`No creation spec for system account '${systemTag}'.`);

  // ── 2. Adopt ──────────────────────────────────────────────────
  // Only ever adopt an UNTAGGED account of the correct type. Stealing another
  // role's tag would silently break that role, and adopting a wrong-typed
  // account would fail assignSystemAccount's own type check later.
  const numbers = spec.adoptAccountNumbers ?? [];
  const names = (spec.adoptNames ?? []).map((n) => n.toLowerCase());
  if (numbers.length > 0 || names.length > 0) {
    const matchers = [
      ...(numbers.length > 0 ? [inArray(accounts.accountNumber, numbers)] : []),
      ...(names.length > 0 ? [inArray(sql`lower(${accounts.name})`, names)] : []),
    ];
    const candidate = await db.query.accounts.findFirst({
      where: and(
        eq(accounts.tenantId, tenantId),
        isNull(accounts.systemTag),
        eq(accounts.accountType, spec.accountType),
        or(...matchers),
      ),
      orderBy: (a, { asc }) => [asc(a.accountNumber), asc(a.createdAt)],
    });
    if (candidate) {
      await db.update(accounts)
        .set({ systemTag: spec.systemTag, isSystem: true, updatedAt: new Date() })
        .where(and(eq(accounts.tenantId, tenantId), eq(accounts.id, candidate.id)));
      await auditLog(
        tenantId, 'update', 'system_account_role', candidate.id,
        { systemTag: null, isSystem: candidate.isSystem },
        { systemTag: spec.systemTag, isSystem: true, adopted: true },
        actingUserId,
      );
      return candidate.id;
    }
  }

  // ── 3. Create ─────────────────────────────────────────────────
  const numTaken = await db.query.accounts.findFirst({
    where: and(eq(accounts.tenantId, tenantId), eq(accounts.accountNumber, spec.accountNumber)),
  });
  const [created] = await db.insert(accounts).values({
    tenantId,
    companyId: companyId ?? null,
    accountNumber: numTaken ? null : spec.accountNumber,
    name: spec.name,
    accountType: spec.accountType,
    detailType: spec.detailType,
    isSystem: true,
    systemTag: spec.systemTag,
    isActive: true,
  }).returning();
  if (!created) throw AppError.internal(`Could not create the '${systemTag}' system account.`);
  await auditLog(tenantId, 'create', 'system_account_role', created.id, null,
    { systemTag: spec.systemTag, accountNumber: created.accountNumber }, actingUserId);
  return created.id;
}

/** Convenience wrapper. Every suspense consumer goes through this. */
export async function getSuspenseAccountId(
  tenantId: string,
  companyId?: string,
  actingUserId?: string,
): Promise<string> {
  return getOrCreateSystemAccount(tenantId, SUSPENSE_TAG, companyId, actingUserId);
}

// ── Consolidation ───────────────────────────────────────────────
// A tenant that has been running for a while may have several hand-made
// "uncategorized"-ish accounts. Consolidation folds them into the one tagged
// suspense account so the review screen shows a single number. It rewrites
// posted journal lines, so it is admin-triggered, previewable, and audited —
// never a side effect of a migration.

const LOOKALIKE_SQL = sql`(
  lower(${accounts.name}) LIKE '%uncategoriz%'
  OR lower(${accounts.name}) LIKE '%suspense%'
  OR lower(${accounts.name}) LIKE '%ask my accountant%'
)`;

export interface ConsolidationCandidate {
  id: string;
  accountNumber: string | null;
  name: string;
  accountType: string;
  balance: string;
  lineCount: number;
  blockedReason: string | null;
}

/** Dry run. Lists look-alike accounts that could fold into suspense. */
export async function previewSuspenseConsolidation(tenantId: string): Promise<{
  suspenseAccountId: string | null;
  candidates: ConsolidationCandidate[];
}> {
  const suspenseAccountId = await findSystemAccountId(tenantId, SUSPENSE_TAG);

  const rows = await db.select({
    id: accounts.id,
    accountNumber: accounts.accountNumber,
    name: accounts.name,
    accountType: accounts.accountType,
    balance: accounts.balance,
  })
    .from(accounts)
    .where(and(
      eq(accounts.tenantId, tenantId),
      isNull(accounts.systemTag),
      LOOKALIKE_SQL,
    ));

  const candidates: ConsolidationCandidate[] = [];
  for (const r of rows) {
    if (suspenseAccountId && r.id === suspenseAccountId) continue;
    const blocked = await blockedLineReason(tenantId, r.id);
    const counted = await db.execute<{ n: string }>(sql`
      SELECT COUNT(*)::text AS n FROM ${journalLines}
      WHERE tenant_id = ${tenantId} AND account_id = ${r.id}
    `);
    candidates.push({
      ...r,
      balance: r.balance ?? '0',
      lineCount: Number((counted.rows as Array<{ n: string }>)[0]?.n ?? '0'),
      blockedReason: blocked,
    });
  }
  return { suspenseAccountId, candidates };
}

/**
 * Why this account's lines cannot be moved, or null when they can.
 * Mirrors the guards bulkUpdateTransactions applies per transaction: a line
 * cleared in a completed reconciliation must not move, and neither must a
 * line inside a closed period or on a void/adjusting entry.
 */
export async function blockedLineReason(tenantId: string, accountId: string): Promise<string | null> {
  const res = await db.execute<{ reason: string }>(sql`
    SELECT 'reconciled' AS reason
    FROM journal_lines jl
    JOIN reconciliation_lines rl ON rl.journal_line_id = jl.id
    JOIN reconciliations r ON r.id = rl.reconciliation_id
    WHERE jl.tenant_id = ${tenantId} AND jl.account_id = ${accountId}
      AND r.status = 'complete' AND rl.is_cleared = true
    UNION ALL
    SELECT 'locked' AS reason
    FROM journal_lines jl
    JOIN transactions t ON t.id = jl.transaction_id
    LEFT JOIN companies c ON c.id = t.company_id
    WHERE jl.tenant_id = ${tenantId} AND jl.account_id = ${accountId}
      AND c.lock_date IS NOT NULL AND t.txn_date <= c.lock_date
    UNION ALL
    SELECT 'aje' AS reason
    FROM journal_lines jl
    JOIN transactions t ON t.id = jl.transaction_id
    WHERE jl.tenant_id = ${tenantId} AND jl.account_id = ${accountId}
      AND t.txn_type = 'aje'
    LIMIT 1
  `);
  return (res.rows as Array<{ reason: string }>)[0]?.reason ?? null;
}

/**
 * Re-point every journal line on `fromAccountId` onto `toAccountId` and shift
 * the denormalised balances to match. Returns how many lines moved.
 *
 * Amounts are unchanged, so the trial balance still balances; only the
 * per-account split moves. Callers MUST check `blockedLineReason` first — this
 * helper deliberately does no guarding of its own so the two callers
 * (consolidation, and sweeping a balance off an outgoing role account) cannot
 * drift apart on what "safe to move" means.
 */
export async function moveAllLinesBetweenAccounts(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  tenantId: string,
  fromAccountId: string,
  toAccountId: string,
): Promise<number> {
  const sums = await tx.execute<{ d: string; c: string; n: string }>(sql`
    SELECT COALESCE(SUM(debit), 0)::text AS d,
           COALESCE(SUM(credit), 0)::text AS c,
           COUNT(*)::text AS n
    FROM journal_lines
    WHERE tenant_id = ${tenantId} AND account_id = ${fromAccountId}
  `);
  const row = (sums.rows as Array<{ d: string; c: string; n: string }>)[0];
  const lines = Number(row?.n ?? '0');
  if (lines === 0) return 0;

  const debit = row?.d ?? '0';
  const credit = row?.c ?? '0';

  await tx.update(journalLines)
    .set({ accountId: toAccountId })
    .where(and(eq(journalLines.tenantId, tenantId), eq(journalLines.accountId, fromAccountId)));

  // Debit-positive convention, matching updateAccountBalances in the ledger
  // service: balance moves by (debit - credit). The subtraction happens in
  // Postgres `numeric` so it is exact at any magnitude.
  await tx.execute(sql`
    UPDATE accounts SET balance = balance - (${debit}::numeric - ${credit}::numeric),
           updated_at = now()
     WHERE tenant_id = ${tenantId} AND id = ${fromAccountId}
  `);
  await tx.execute(sql`
    UPDATE accounts SET balance = balance + (${debit}::numeric - ${credit}::numeric),
           updated_at = now()
     WHERE tenant_id = ${tenantId} AND id = ${toAccountId}
  `);
  return lines;
}

export interface ConsolidationResult {
  suspenseAccountId: string;
  moved: Array<{ accountId: string; lines: number; deactivated: boolean }>;
  skipped: Array<{ accountId: string; reason: string }>;
}

/**
 * Re-point every journal line on the given accounts onto the tagged suspense
 * account, shift the denormalised balances, and deactivate the emptied
 * accounts. All-or-nothing: one DB transaction for the whole batch.
 */
export async function consolidateIntoSuspense(
  tenantId: string,
  accountIds: string[],
  actingUserId?: string,
): Promise<ConsolidationResult> {
  if (accountIds.length === 0) throw AppError.badRequest('Pick at least one account to consolidate.');

  const suspenseAccountId = await getSuspenseAccountId(tenantId, undefined, actingUserId);
  const moved: ConsolidationResult['moved'] = [];
  const skipped: ConsolidationResult['skipped'] = [];

  return await db.transaction(async (tx) => {
    for (const accountId of accountIds) {
      if (accountId === suspenseAccountId) {
        skipped.push({ accountId, reason: 'is_suspense_account' });
        continue;
      }
      const [acct] = await tx.select().from(accounts)
        .where(and(eq(accounts.tenantId, tenantId), eq(accounts.id, accountId)))
        .for('update').limit(1);
      if (!acct) { skipped.push({ accountId, reason: 'not_found' }); continue; }
      if (acct.systemTag) { skipped.push({ accountId, reason: 'is_system_role' }); continue; }

      const blocked = await blockedLineReason(tenantId, accountId);
      if (blocked) { skipped.push({ accountId, reason: blocked }); continue; }

      const lines = await moveAllLinesBetweenAccounts(tx, tenantId, accountId, suspenseAccountId);

      await tx.update(accounts)
        .set({ isActive: false, updatedAt: new Date() })
        .where(and(eq(accounts.tenantId, tenantId), eq(accounts.id, accountId)));

      moved.push({ accountId, lines, deactivated: true });
      await auditLog(
        tenantId, 'update', 'account', accountId,
        { name: acct.name, balance: acct.balance, isActive: acct.isActive },
        { consolidatedInto: suspenseAccountId, linesMoved: lines, isActive: false },
        actingUserId,
      );
    }
    return { suspenseAccountId, moved, skipped };
  });
}
