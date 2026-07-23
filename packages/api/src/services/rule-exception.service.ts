// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Rule-exception audit (Close Review → Buckets → Rules).
//
// Runs the tenant's Practice Rules against the period's POSTED transactions and
// flags any whose booked category account differs from what a rule would
// assign — e.g. a rule posts "AT&T" to Telephone but the transaction is booked
// to Repairs. The bookkeeper can ACCEPT (re-book the one transaction to the
// rule's account) or DISMISS (persist so it doesn't resurface).
//
// This is a read-only audit except accept, which mutates through the supported
// `ledger.bulkUpdateTransactions({ setCategoryAccountId })` path. The rule
// engine is the same one used at bank-feed categorization time; here we build
// the evaluation context from a posted transaction instead of a feed item.

import { sql } from 'drizzle-orm';
import type { Action, ConditionalRule, ConditionalRuleContext, RuleExceptionRow } from '@kis-books/shared';
import { db } from '../db/index.js';
import { ruleExceptionDismissals } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { listEvaluableRulesForTenant } from './conditional-rules.service.js';
import { evaluateRules } from './conditional-rules-engine.service.js';
import { resolveActionsForTenant } from './rule-symbol-resolution.service.js';
import { bulkUpdateTransactions } from './ledger.service.js';

// Kept in sync with ledger.service.ts — a "category" account is any account
// that is NOT the transaction's money/control side.
const NON_CATEGORY_DETAIL_TYPES = new Set(['bank', 'accounts_receivable', 'accounts_payable', 'credit_card']);
const NON_CATEGORY_SYSTEM_TAGS = new Set(['payments_clearing', 'undeposited_funds', 'sales_tax_payable']);

function isCategoryAccount(detailType: string | null, systemTag: string | null): boolean {
  return (
    (!detailType || !NON_CATEGORY_DETAIL_TYPES.has(detailType)) &&
    (!systemTag || !NON_CATEGORY_SYSTEM_TAGS.has(systemTag))
  );
}

interface LineRow {
  txn_id: string;
  txn_date: string;
  memo: string | null;
  contact_name: string | null;
  feed_desc: string | null;
  account_id: string;
  account_name: string;
  detail_type: string | null;
  system_tag: string | null;
  debit: string;
  credit: string;
}

export interface ListRuleExceptionsOpts {
  periodStart: string;
  periodEnd: string; // exclusive
  currentUserId: string | null;
  firmId: string | null;
  /** When set, restrict the audit to a single transaction (used by accept). */
  transactionId?: string;
}

/**
 * Audit the period's posted transactions against the tenant's Practice Rules
 * and return the exceptions (booked account ≠ the rule's account).
 */
export async function listRuleExceptions(
  tenantId: string,
  companyId: string | null,
  opts: ListRuleExceptionsOpts,
): Promise<RuleExceptionRow[]> {
  const rules = await listEvaluableRulesForTenant(tenantId, {
    currentUserId: opts.currentUserId,
    firmId: opts.firmId,
  });
  if (rules.length === 0) return [];
  const rulesById = new Map<string, ConditionalRule>(rules.map((r) => [r.id, r]));

  const result = await db.execute(sql`
    SELECT t.id AS txn_id, t.txn_date::text AS txn_date, t.memo AS memo,
           c.display_name AS contact_name,
           bfi.original_description AS feed_desc,
           jl.account_id AS account_id, a.name AS account_name,
           a.detail_type AS detail_type, a.system_tag AS system_tag,
           jl.debit::text AS debit, jl.credit::text AS credit
    FROM transactions t
    JOIN journal_lines jl ON jl.transaction_id = t.id AND jl.tenant_id = t.tenant_id
    JOIN accounts a ON a.id = jl.account_id
    LEFT JOIN contacts c ON c.id = t.contact_id
    LEFT JOIN bank_feed_items bfi ON t.source = 'bank_feed' AND t.source_id = bfi.id::text
    WHERE t.tenant_id = ${tenantId}
      AND t.status = 'posted'
      AND (${companyId}::uuid IS NULL OR t.company_id = ${companyId}::uuid)
      AND t.txn_date >= ${opts.periodStart} AND t.txn_date < ${opts.periodEnd}
      AND (${opts.transactionId ?? null}::uuid IS NULL OR t.id = ${opts.transactionId ?? null}::uuid)
      AND NOT EXISTS (
        SELECT 1 FROM rule_exception_dismissals d
        WHERE d.tenant_id = t.tenant_id AND d.transaction_id = t.id
      )
    ORDER BY t.id
  `);
  const lines = result.rows as unknown as LineRow[];

  // Tenant account id → name, for naming the rule's target account.
  const nameRows = await db.execute(sql`
    SELECT id, name FROM accounts WHERE tenant_id = ${tenantId}
  `);
  const accountNameById = new Map<string, string>(
    (nameRows.rows as unknown as Array<{ id: string; name: string }>).map((r) => [r.id, r.name]),
  );

  // Group journal lines by transaction.
  const byTxn = new Map<string, LineRow[]>();
  for (const ln of lines) {
    const arr = byTxn.get(ln.txn_id);
    if (arr) arr.push(ln);
    else byTxn.set(ln.txn_id, [ln]);
  }

  // Memo cache for global-rule account resolution (deterministic per tenant).
  const globalAccountCache = new Map<string, string | null>();

  const resolveSetAccountId = async (rule: ConditionalRule, applied: Action[]): Promise<string | null> => {
    // Last set_account wins if several were applied; splits have no single target.
    const setAccounts = applied.filter((a): a is Extract<Action, { type: 'set_account' }> => a.type === 'set_account');
    const target = setAccounts.at(-1);
    if (!target) return null;
    if (rule.scope !== 'global_firm') return target.accountId; // already tenant-local
    const cached = globalAccountCache.get(target.accountId);
    if (cached !== undefined) return cached;
    const resolved = await resolveActionsForTenant(tenantId, [target], { scope: 'global_firm' });
    const id = resolved.find((a) => a.type === 'set_account')?.accountId ?? null;
    globalAccountCache.set(target.accountId, id);
    return id;
  };

  const exceptions: RuleExceptionRow[] = [];

  for (const [txnId, txnLines] of byTxn) {
    const categoryLines = txnLines.filter((l) => isCategoryAccount(l.detail_type, l.system_tag));
    if (categoryLines.length !== 1) continue; // split / no category — ambiguous, skip
    const catLine = categoryLines[0]!;
    const sourceLines = txnLines.filter((l) => !isCategoryAccount(l.detail_type, l.system_tag));
    if (sourceLines.length === 0) continue;

    // account_source_id = the money/control leg the entry moved through; prefer
    // the bank/credit-card leg. signedAmount mirrors the feed convention
    // (negative = money out) via the source legs' net debit−credit.
    const bankLike =
      sourceLines.find((l) => l.detail_type === 'bank' || l.detail_type === 'credit_card') ?? sourceLines[0]!;
    const signedAmount = sourceLines.reduce(
      (sum, l) => sum + (parseFloat(l.debit) - parseFloat(l.credit)),
      0,
    );
    const sign: -1 | 0 | 1 = signedAmount > 0 ? 1 : signedAmount < 0 ? -1 : 0;
    const first = txnLines[0]!;
    const descriptor = [first.feed_desc, first.contact_name, first.memo]
      .map((s) => (s ?? '').trim())
      .filter(Boolean)
      .join(' ');
    const ctx: ConditionalRuleContext = {
      descriptor,
      amount: signedAmount,
      amount_sign: sign,
      account_source_id: bankLike.account_id,
      date: first.txn_date,
      day_of_week: new Date(first.txn_date + 'T00:00:00Z').getUTCDay(),
    };

    const matches = evaluateRules(rules, ctx);
    if (matches.length === 0) continue;

    // First match that yields a concrete set_account is the winner.
    let winnerRule: ConditionalRule | null = null;
    let targetAccountId: string | null = null;
    for (const m of matches) {
      const rule = rulesById.get(m.ruleId);
      if (!rule) continue;
      const acctId = await resolveSetAccountId(rule, m.appliedActions);
      if (acctId) {
        winnerRule = rule;
        targetAccountId = acctId;
        break;
      }
    }
    if (!winnerRule || !targetAccountId) continue;
    if (targetAccountId === catLine.account_id) continue; // already compliant

    exceptions.push({
      transactionId: txnId,
      date: first.txn_date,
      payee: first.contact_name,
      descriptor,
      amount: signedAmount.toFixed(2),
      currentAccountId: catLine.account_id,
      currentAccountName: catLine.account_name,
      ruleId: winnerRule.id,
      ruleName: winnerRule.name,
      ruleAccountId: targetAccountId,
      ruleAccountName: accountNameById.get(targetAccountId) ?? '(account)',
    });
  }

  // Newest first by date for a stable, useful order.
  exceptions.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return exceptions;
}

/**
 * Accept a rule exception: re-book the one transaction to the rule's account.
 * The exception is recomputed server-side (the client-supplied account is never
 * trusted); throws if the transaction is no longer an exception.
 */
export async function acceptRuleException(
  tenantId: string,
  companyId: string | null,
  userId: string,
  firmId: string | null,
  transactionId: string,
): Promise<{ ruleAccountId: string; ruleAccountName: string }> {
  const rows = await listRuleExceptions(tenantId, companyId, {
    // Wide window — accept targets a specific transaction regardless of period.
    periodStart: '1900-01-01',
    periodEnd: '9999-01-01',
    currentUserId: userId,
    firmId,
    transactionId,
  });
  const exc = rows[0];
  if (!exc) {
    throw AppError.conflict(
      'This transaction is no longer flagged by a rule (it may have changed).',
      'RULE_EXCEPTION_GONE',
    );
  }
  const res = await bulkUpdateTransactions(
    tenantId,
    { txnIds: [transactionId], setCategoryAccountId: exc.ruleAccountId },
    userId,
    companyId ?? undefined,
  );
  if (res.updated === 0) {
    const reason = res.skipped[0]?.reason ?? 'unknown';
    throw AppError.unprocessableEntity(
      `Could not re-book this transaction (${reason}).`,
      'RULE_EXCEPTION_REBOOK_SKIPPED',
      { skipped: res.skipped },
    );
  }
  return { ruleAccountId: exc.ruleAccountId, ruleAccountName: exc.ruleAccountName };
}

/** Dismiss a rule exception so it doesn't resurface. Idempotent per transaction. */
export async function dismissRuleException(
  tenantId: string,
  userId: string,
  transactionId: string,
  ruleId?: string | null,
): Promise<void> {
  await db
    .insert(ruleExceptionDismissals)
    .values({ tenantId, transactionId, ruleId: ruleId ?? null, dismissedBy: userId })
    .onConflictDoNothing();
}
