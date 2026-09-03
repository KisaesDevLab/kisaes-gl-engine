// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { eq, and, sql, ilike } from 'drizzle-orm';
import { db } from '../db/index.js';
import { transactions, journalLines, contacts, bankFeedItems, categorizationHistory } from '../db/schema/index.js';
import { cleanBankDescription } from '../utils/bank-name-cleaner.js';

/**
 * Normalize a payee description into a lookup pattern.
 * Per AI_PROCESSING_PLAN.md §3.4: "lowercase, trim, remove transaction-specific suffixes (order numbers, dates)"
 *
 * This is THE canonical categorization_history key derivation. Both writers
 * (updateLearning here and recordUserDecision in ai-categorization.service)
 * and both readers derive keys with this function over
 * `originalDescription || description`; legacy rows keyed by the old raw
 * `description.toLowerCase().trim()` form are handled by a dual-read
 * (read both keys, write the normalized one) — no migration needed.
 */
export function normalizePayeePattern(description: string): string {
  // First apply the same cleaning as import
  let pattern = cleanBankDescription(description);
  // Then lowercase for matching
  return pattern.toLowerCase().trim();
}

/**
 * STATEMENT_CHECK_PAYEE_CATEGORY — how many prior posted transactions to the
 * same payee we require before treating "they always code to this account"
 * as a suggestion. One prior check is an anecdote (it could itself have been
 * mis-coded); two or more is a pattern. Kept below the categorization_history
 * threshold of 3 because this signal is stronger: it keys on an identified
 * payee, not on a fuzzy description pattern.
 */
const PAYEE_HISTORY_MIN_TXNS = 2;

/**
 * STATEMENT_CHECK_PAYEE_CATEGORY — suggest the expense account for a payee
 * from what this tenant has actually coded that payee to before.
 *
 * Why this exists: `suggestCategorization` below keys everything on the
 * DESCRIPTION. A check's description is whatever the bank prints, which for
 * real feeds is often the account nickname ("Taz-Boy's") or literally
 * "CHECK 3607" — identical across every payee, so description matching can
 * never categorize a check no matter how good the payee data is. Once a
 * statement has told us WHO the check was written to, the payee is the
 * reliable key.
 *
 * Deliberately unambiguous-only: we return an account solely when every
 * prior posted transaction for that payee hit the SAME expense account. A
 * payee split across several accounts (a hardware store coded to both
 * Supplies and Repairs) gets no suggestion rather than a coin-flip, and the
 * item stays pending for a human. Never guesses.
 */
export async function suggestAccountFromPayeeHistory(
  tenantId: string,
  opts: { contactId?: string | null; payeeName?: string | null; companyId?: string | null },
): Promise<{ accountId: string; timesSeen: number; confidence: number } | null> {
  const contactId = opts.contactId ?? null;
  const payeeName = (opts.payeeName ?? '').trim();
  if (!contactId && !payeeName) return null;

  // Match on the linked contact OR the literal payee text stamped on past
  // checks — early rows may carry payee_name_on_check without ever having
  // been linked to a contact.
  const rows = await db.execute(sql`
    SELECT jl.account_id, COUNT(DISTINCT t.id)::int AS times_seen
    FROM transactions t
    JOIN journal_lines jl ON jl.transaction_id = t.id AND jl.debit > 0
    JOIN accounts a ON a.id = jl.account_id
     AND a.account_type IN ('expense', 'cogs', 'other_expense')
    WHERE t.tenant_id = ${tenantId}
      AND t.status = 'posted'
      AND t.voided_at IS NULL
      AND (${opts.companyId ?? null}::uuid IS NULL
           OR t.company_id = ${opts.companyId ?? null}::uuid
           OR t.company_id IS NULL)
      AND (
        (${contactId}::uuid IS NOT NULL AND t.contact_id = ${contactId}::uuid)
        OR (${payeeName} <> '' AND LOWER(t.payee_name_on_check) = LOWER(${payeeName}))
      )
    GROUP BY jl.account_id
  `);

  const accounts = rows.rows as Array<{ account_id: string; times_seen: number }>;
  // Ambiguous (or unseen) payee → no suggestion, by design.
  if (accounts.length !== 1) return null;
  const only = accounts[0]!;
  const timesSeen = Number(only.times_seen);
  if (timesSeen < PAYEE_HISTORY_MIN_TXNS) return null;

  // Same shape as the categorization_history confidence curve: grows with
  // corroboration, capped below 1.0 so it never outranks an exact match.
  const confidence = Math.min(0.95, 0.75 + timesSeen * 0.02);
  return { accountId: only.account_id, timesSeen, confidence };
}

/**
 * Three-layer categorization per AI_PROCESSING_PLAN.md §3.1:
 *   1. Bank Rules (handled separately before this is called)
 *   2. Categorization history lookup (local, no AI)
 *   3. AI/pattern matching (transaction history fuzzy match)
 */
export async function suggestCategorization(tenantId: string, feedItemId: string) {
  const item = await db.query.bankFeedItems.findFirst({
    where: and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, feedItemId)),
  });
  // A check row can carry a useless description but a known payee, so a
  // missing description is no longer on its own a reason to give up.
  if (!item) return null;
  if (!item.description && !item.payeeNameOnCheck && !item.suggestedContactId) return null;

  // Use original description for matching if available, fall back to cleaned
  const rawDesc = (item.originalDescription || item.description || '').toLowerCase();
  const cleanedDesc = (item.description || '').toLowerCase();
  const payeePattern = normalizePayeePattern(item.originalDescription || item.description || '');

  // ── Step 2: Categorization history lookup ──────────────────────
  // Check if this payee pattern has been confirmed 3+ times
  const historyMatch = await db.query.categorizationHistory.findFirst({
    where: and(
      eq(categorizationHistory.tenantId, tenantId),
      eq(categorizationHistory.payeePattern, payeePattern),
    ),
  });

  if (historyMatch && (historyMatch.timesConfirmed ?? 0) >= 3) {
    const overrideRate = (historyMatch.timesOverridden ?? 0) / ((historyMatch.timesConfirmed ?? 0) + (historyMatch.timesOverridden ?? 0));
    // Only use if override rate is below 20%
    if (overrideRate < 0.2) {
      const confidence = Math.min(0.95, 0.80 + ((historyMatch.timesConfirmed ?? 0) * 0.02));
      await db.update(bankFeedItems).set({
        suggestedAccountId: historyMatch.accountId,
        suggestedContactId: historyMatch.contactId,
        confidenceScore: confidence.toFixed(2),
        matchType: 'history',
        updatedAt: new Date(),
      }).where(eq(bankFeedItems.id, feedItemId));

      // Update last_used_at
      await db.update(categorizationHistory).set({ lastUsedAt: new Date() })
        .where(eq(categorizationHistory.id, historyMatch.id));

      return { accountId: historyMatch.accountId, contactId: historyMatch.contactId, confidence, matchType: 'history' };
    }
  }

  // ── Step 2b: Payee history (STATEMENT_CHECK_PAYEE_CATEGORY) ────
  // Runs before the description passes below because when we know who the
  // check was written to, that beats anything the bank's description text
  // can tell us — for checks the description is usually the same string on
  // every row. Only fires for rows that actually have payee identity, so
  // ordinary card/ACH rows fall straight through to the existing logic.
  if (item.payeeNameOnCheck || item.suggestedContactId) {
    const byPayee = await suggestAccountFromPayeeHistory(tenantId, {
      contactId: item.suggestedContactId,
      payeeName: item.payeeNameOnCheck,
      companyId: item.companyId,
    });
    if (byPayee) {
      await db.update(bankFeedItems).set({
        suggestedAccountId: byPayee.accountId,
        // Keep whatever contact identity the row already had; this step
        // resolves the ACCOUNT, it does not re-decide the payee.
        confidenceScore: byPayee.confidence.toFixed(2),
        // Reuses the existing 'history' match type: it is history, just
        // keyed on the payee instead of the description, and this keeps the
        // feed UI's badge rendering unchanged.
        matchType: 'history',
        updatedAt: new Date(),
      }).where(eq(bankFeedItems.id, feedItemId));

      return {
        accountId: byPayee.accountId,
        contactId: item.suggestedContactId,
        confidence: byPayee.confidence,
        matchType: 'history',
      };
    }
  }

  // ── Step 3: Pattern matching against past transactions ─────────
  // Exact match on memo or contact name
  const exactMatch = await db.execute(sql`
    SELECT t.contact_id, jl.account_id, c.display_name
    FROM transactions t
    JOIN journal_lines jl ON jl.transaction_id = t.id AND jl.debit > 0
    JOIN accounts a ON a.id = jl.account_id AND a.account_type IN ('cogs', 'expense', 'other_expense')
    LEFT JOIN contacts c ON c.id = t.contact_id
    WHERE t.tenant_id = ${tenantId} AND t.status = 'posted'
      AND (LOWER(t.memo) = ${cleanedDesc} OR LOWER(c.display_name) = ${cleanedDesc})
    ORDER BY t.txn_date DESC LIMIT 1
  `);

  if ((exactMatch.rows as any[]).length > 0) {
    const row = (exactMatch.rows as any[])[0];
    await db.update(bankFeedItems).set({
      suggestedAccountId: row.account_id,
      suggestedContactId: row.contact_id,
      confidenceScore: '1.00',
      matchType: 'exact',
      updatedAt: new Date(),
    }).where(eq(bankFeedItems.id, feedItemId));

    return { accountId: row.account_id, contactId: row.contact_id, confidence: 1.0, matchType: 'exact' };
  }

  // Fuzzy match — check if description contains a known vendor name.
  // LOW: require the contact name to be at least 3 chars before it qualifies
  // for a substring match. A 1-2 char display name (e.g. an initials contact
  // "Al", or a stray "A") matched as `%A%` against nearly every descriptor and
  // stamped a bogus 0.80-confidence suggestion.
  const fuzzyMatch = await db.execute(sql`
    SELECT t.contact_id, jl.account_id, c.display_name
    FROM transactions t
    JOIN journal_lines jl ON jl.transaction_id = t.id AND jl.debit > 0
    JOIN accounts a ON a.id = jl.account_id AND a.account_type IN ('cogs', 'expense', 'other_expense')
    JOIN contacts c ON c.id = t.contact_id
    WHERE t.tenant_id = ${tenantId} AND t.status = 'posted'
      AND char_length(c.display_name) >= 3
      -- Escape LIKE metacharacters in the contact name (a contact literally
      -- named "%%%" would otherwise fuzzy-match every description).
      AND (${cleanedDesc} LIKE '%' || replace(replace(replace(LOWER(c.display_name), '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%'
           OR ${rawDesc} LIKE '%' || replace(replace(replace(LOWER(c.display_name), '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%')
    ORDER BY t.txn_date DESC LIMIT 1
  `);

  if ((fuzzyMatch.rows as any[]).length > 0) {
    const row = (fuzzyMatch.rows as any[])[0];
    await db.update(bankFeedItems).set({
      suggestedAccountId: row.account_id,
      suggestedContactId: row.contact_id,
      confidenceScore: '0.80',
      matchType: 'fuzzy',
      updatedAt: new Date(),
    }).where(eq(bankFeedItems.id, feedItemId));

    return { accountId: row.account_id, contactId: row.contact_id, confidence: 0.8, matchType: 'fuzzy' };
  }

  return null;
}

export async function suggestForBatch(tenantId: string, feedItemIds: string[]) {
  const results = [];
  for (const id of feedItemIds) {
    const suggestion = await suggestCategorization(tenantId, id);
    results.push({ feedItemId: id, suggestion });
  }
  return results;
}

/**
 * Update categorization learning per AI_PROCESSING_PLAN.md §3.4.
 * Called after a user accepts, modifies, or overrides a suggestion.
 */
export async function updateLearning(
  tenantId: string, rawDescription: string, accountId: string, contactId: string | null, accepted: boolean,
) {
  const payeePattern = normalizePayeePattern(rawDescription);
  if (!payeePattern) return;

  const existing = await db.query.categorizationHistory.findFirst({
    where: and(
      eq(categorizationHistory.tenantId, tenantId),
      eq(categorizationHistory.payeePattern, payeePattern),
      eq(categorizationHistory.accountId, accountId),
    ),
  });

  if (existing) {
    if (accepted) {
      await db.update(categorizationHistory).set({
        timesConfirmed: sql`${categorizationHistory.timesConfirmed} + 1`,
        contactId: contactId || existing.contactId,
        lastUsedAt: new Date(),
        updatedAt: new Date(),
      }).where(eq(categorizationHistory.id, existing.id));
    } else {
      await db.update(categorizationHistory).set({
        timesOverridden: sql`${categorizationHistory.timesOverridden} + 1`,
        updatedAt: new Date(),
      }).where(eq(categorizationHistory.id, existing.id));
    }
  } else if (accepted) {
    await db.insert(categorizationHistory).values({
      tenantId,
      payeePattern,
      accountId,
      contactId,
      timesConfirmed: 1,
      timesOverridden: 0,
    });
  }
}
