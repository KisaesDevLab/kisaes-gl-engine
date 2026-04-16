import { eq, and, sql, ilike } from 'drizzle-orm';
import { db } from '../db/index.js';
import { transactions, journalLines, contacts, bankFeedItems, categorizationHistory } from '../db/schema/index.js';
import { cleanBankDescription } from '../utils/bank-name-cleaner.js';

/**
 * Normalize a payee description into a lookup pattern.
 * Per AI_PROCESSING_PLAN.md §3.4: "lowercase, trim, remove transaction-specific suffixes (order numbers, dates)"
 */
function normalizePayeePattern(description: string): string {
  // First apply the same cleaning as import
  let pattern = cleanBankDescription(description);
  // Then lowercase for matching
  return pattern.toLowerCase().trim();
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
  if (!item || !item.description) return null;

  // Use original description for matching if available, fall back to cleaned
  const rawDesc = (item.originalDescription || item.description || '').toLowerCase();
  const cleanedDesc = item.description.toLowerCase();
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

  // Fuzzy match — check if description contains a known vendor name
  const fuzzyMatch = await db.execute(sql`
    SELECT t.contact_id, jl.account_id, c.display_name
    FROM transactions t
    JOIN journal_lines jl ON jl.transaction_id = t.id AND jl.debit > 0
    JOIN accounts a ON a.id = jl.account_id AND a.account_type IN ('cogs', 'expense', 'other_expense')
    JOIN contacts c ON c.id = t.contact_id
    WHERE t.tenant_id = ${tenantId} AND t.status = 'posted'
      AND (${cleanedDesc} LIKE '%' || LOWER(c.display_name) || '%'
           OR ${rawDesc} LIKE '%' || LOWER(c.display_name) || '%')
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
