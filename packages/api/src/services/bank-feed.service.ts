import { eq, and, sql, count } from 'drizzle-orm';
import type { BankFeedFilters, CategorizeInput, CsvColumnMapping } from '@kis-books/shared';
import { db } from '../db/index.js';
import { bankFeedItems, bankConnections, accounts } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import * as ledger from './ledger.service.js';
import { cleanBankDescription } from '../utils/bank-name-cleaner.js';
import { cleanNameViaRules } from './bank-rules.service.js';
import { updateLearning } from './categorization-ai.service.js';

export async function list(tenantId: string, filters: BankFeedFilters) {
  const conditions = [eq(bankFeedItems.tenantId, tenantId)];
  if (filters.status) conditions.push(eq(bankFeedItems.status, filters.status));
  if (filters.bankConnectionId) conditions.push(eq(bankFeedItems.bankConnectionId, filters.bankConnectionId));
  if (filters.startDate) conditions.push(sql`${bankFeedItems.feedDate} >= ${filters.startDate}`);
  if (filters.endDate) conditions.push(sql`${bankFeedItems.feedDate} <= ${filters.endDate}`);
  if ((filters as any).search) {
    const term = '%' + (filters as any).search + '%';
    conditions.push(sql`(${bankFeedItems.description} ILIKE ${term} OR ${bankFeedItems.category} ILIKE ${term})`);
  }

  const where = and(...conditions);

  const [data, total] = await Promise.all([
    db.select({
      id: bankFeedItems.id,
      tenantId: bankFeedItems.tenantId,
      bankConnectionId: bankFeedItems.bankConnectionId,
      providerTransactionId: bankFeedItems.providerTransactionId,
      feedDate: bankFeedItems.feedDate,
      description: bankFeedItems.description,
      originalDescription: bankFeedItems.originalDescription,
      amount: bankFeedItems.amount,
      category: bankFeedItems.category,
      status: bankFeedItems.status,
      matchedTransactionId: bankFeedItems.matchedTransactionId,
      suggestedAccountId: bankFeedItems.suggestedAccountId,
      suggestedContactId: bankFeedItems.suggestedContactId,
      confidenceScore: bankFeedItems.confidenceScore,
      createdAt: bankFeedItems.createdAt,
      updatedAt: bankFeedItems.updatedAt,
      bankAccountName: accounts.name,
      institutionName: bankConnections.institutionName,
    }).from(bankFeedItems)
      .leftJoin(bankConnections, eq(bankFeedItems.bankConnectionId, bankConnections.id))
      .leftJoin(accounts, eq(bankConnections.accountId, accounts.id))
      .where(where)
      .orderBy(sql`${bankFeedItems.feedDate} DESC`)
      .limit(filters.limit ?? 50)
      .offset(filters.offset ?? 0),
    db.select({ count: count() }).from(bankFeedItems).where(where),
  ]);

  return { data, total: total[0]?.count ?? 0 };
}

export async function updateFeedItem(tenantId: string, feedItemId: string, input: {
  feedDate?: string; description?: string; memo?: string; contactId?: string;
}) {
  const item = await db.query.bankFeedItems.findFirst({
    where: and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, feedItemId)),
  });
  if (!item) throw AppError.notFound('Bank feed item not found');

  const updates: Record<string, any> = { updatedAt: new Date() };
  if (input.feedDate !== undefined) updates.feedDate = input.feedDate;
  if (input.description !== undefined) updates.description = input.description;
  if (input.memo !== undefined) updates.category = input.memo;
  if (input.contactId !== undefined) updates.suggestedContactId = input.contactId || null;

  await db.update(bankFeedItems).set(updates).where(eq(bankFeedItems.id, feedItemId));
  return db.query.bankFeedItems.findFirst({ where: eq(bankFeedItems.id, feedItemId) });
}

export async function categorize(tenantId: string, feedItemId: string, input: CategorizeInput, userId?: string) {
  const item = await db.query.bankFeedItems.findFirst({
    where: and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, feedItemId)),
  });
  if (!item) throw AppError.notFound('Bank feed item not found');

  // Determine if this is an expense (positive amount = money out) or deposit (negative = money in)
  const amount = Math.abs(parseFloat(item.amount));
  const isExpense = parseFloat(item.amount) > 0;

  // Get the bank account from the connection
  const conn = await db.query.bankConnections.findFirst({
    where: eq(bankConnections.id, item.bankConnectionId),
  });
  if (!conn) throw AppError.notFound('Bank connection not found');

  const txn = await ledger.postTransaction(tenantId, {
    txnType: isExpense ? 'expense' : 'deposit',
    txnDate: item.feedDate,
    contactId: input.contactId || (item.suggestedContactId ?? undefined),
    memo: input.memo || (item.category as string) || item.description || undefined,
    total: amount.toFixed(4),
    lines: isExpense
      ? [
          { accountId: input.accountId, debit: amount.toFixed(4), credit: '0', description: item.description || undefined },
          { accountId: conn.accountId, debit: '0', credit: amount.toFixed(4) },
        ]
      : [
          { accountId: conn.accountId, debit: amount.toFixed(4), credit: '0' },
          { accountId: input.accountId, debit: '0', credit: amount.toFixed(4), description: item.description || undefined },
        ],
  }, userId);

  await db.update(bankFeedItems).set({
    status: 'categorized',
    matchedTransactionId: txn.id,
    updatedAt: new Date(),
  }).where(eq(bankFeedItems.id, feedItemId));

  // Update categorization learning history
  updateLearning(
    tenantId,
    item.originalDescription || item.description || '',
    input.accountId,
    input.contactId || null,
    true,
  ).catch(() => {});

  return txn;
}

export async function match(tenantId: string, feedItemId: string, transactionId: string) {
  await db.update(bankFeedItems).set({
    status: 'matched',
    matchedTransactionId: transactionId,
    updatedAt: new Date(),
  }).where(and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, feedItemId)));
}

/**
 * Find candidate transactions that could match a bank feed item.
 *
 * Heuristic: same dollar amount, within ±5 days of the feed item's date,
 * not already matched to another feed item, and on the same bank account.
 *
 * Returns bill payments, write-checks (expense txns with check fields), and
 * other expense/deposit txns that touch the connected bank account. Bill
 * payments are prioritized so users can avoid creating duplicate expenses
 * for invoices they already paid through Pay Bills.
 */
export async function findMatchCandidates(tenantId: string, feedItemId: string) {
  const item = await db.query.bankFeedItems.findFirst({
    where: and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, feedItemId)),
  });
  if (!item) return [];

  // Resolve the connected bank account so we only suggest transactions that
  // touched the same physical account.
  if (!item.bankConnectionId) return [];
  const conn = await db.query.bankConnections.findFirst({
    where: eq(bankConnections.id, item.bankConnectionId),
  });
  if (!conn) return [];

  const feedAmount = parseFloat(String(item.amount || '0'));
  if (feedAmount === 0) return [];

  // ±5-day window
  const feedDate = new Date(item.feedDate);
  const start = new Date(feedDate);
  start.setDate(start.getDate() - 5);
  const end = new Date(feedDate);
  end.setDate(end.getDate() + 5);
  const startStr = start.toISOString().split('T')[0]!;
  const endStr = end.toISOString().split('T')[0]!;

  // Bank feed amounts are signed: negative = money leaving (expense, check,
  // bill payment), positive = money in (deposit). For matching we compare
  // absolute value against the txn total.
  const absAmount = Math.abs(feedAmount).toFixed(4);

  const rows = await db.execute(sql`
    SELECT t.id, t.txn_type, t.txn_number, t.txn_date, t.total, t.memo,
      t.check_number, t.print_status,
      c.display_name AS contact_name
    FROM transactions t
    LEFT JOIN contacts c ON c.id = t.contact_id
    WHERE t.tenant_id = ${tenantId}
      AND t.status = 'posted'
      AND t.txn_date >= ${startStr} AND t.txn_date <= ${endStr}
      AND ABS(CAST(t.total AS DECIMAL) - ${absAmount}) < 0.01
      AND t.txn_type IN ('bill_payment', 'expense', 'deposit', 'transfer')
      AND t.id IN (
        SELECT transaction_id FROM journal_lines
        WHERE tenant_id = ${tenantId}
          AND account_id = ${conn.accountId}
      )
      AND NOT EXISTS (
        SELECT 1 FROM bank_feed_items bfi
        WHERE bfi.tenant_id = ${tenantId}
          AND bfi.matched_transaction_id = t.id
          AND bfi.id != ${feedItemId}
      )
    ORDER BY
      CASE t.txn_type WHEN 'bill_payment' THEN 0 ELSE 1 END,
      ABS(EXTRACT(EPOCH FROM (t.txn_date::timestamp - ${item.feedDate}::timestamp))) ASC
    LIMIT 10
  `);

  return (rows.rows as any[]).map((r) => ({
    id: r.id,
    txnType: r.txn_type,
    txnNumber: r.txn_number,
    txnDate: r.txn_date,
    total: r.total,
    memo: r.memo,
    checkNumber: r.check_number,
    printStatus: r.print_status,
    contactName: r.contact_name,
  }));
}

export async function exclude(tenantId: string, feedItemId: string) {
  await db.update(bankFeedItems).set({
    status: 'excluded',
    updatedAt: new Date(),
  }).where(and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, feedItemId)));
}

export async function bulkApprove(tenantId: string, feedItemIds: string[]) {
  let approved = 0;
  for (const id of feedItemIds) {
    const item = await db.query.bankFeedItems.findFirst({
      where: and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, id)),
    });
    if (item && item.status === 'pending' && item.suggestedAccountId) {
      await categorize(tenantId, id, { accountId: item.suggestedAccountId, contactId: item.suggestedContactId || undefined });
      approved++;
    }
  }
  return { approved };
}

export async function bulkCategorize(tenantId: string, feedItemIds: string[], accountId: string, contactId?: string, memo?: string, userId?: string) {
  let categorized = 0;
  for (const id of feedItemIds) {
    const item = await db.query.bankFeedItems.findFirst({
      where: and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, id)),
    });
    if (item && item.status === 'pending') {
      await categorize(tenantId, id, { accountId, contactId, memo }, userId);
      categorized++;
    }
  }
  return { categorized };
}

export async function bulkExclude(tenantId: string, feedItemIds: string[]) {
  let excluded = 0;
  for (const id of feedItemIds) {
    const item = await db.query.bankFeedItems.findFirst({
      where: and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, id)),
    });
    if (item && item.status === 'pending') {
      await exclude(tenantId, id);
      excluded++;
    }
  }
  return { excluded };
}

/**
 * Full cleansing pipeline per AI_PROCESSING_PLAN.md §3.1:
 *   1. Tenant bank rules (deterministic)
 *   2. Global bank rules (deterministic)
 *   3. Categorization history lookup (local, no AI)
 *   4. AI categorization (LLM — returns clean vendor name + category suggestion)
 *   5. Basic cleaning (last resort fallback if all above fail)
 *
 * Each step can produce a clean name. The first step that succeeds wins.
 * Steps 3 & 4 also set suggestedAccountId/suggestedContactId on the feed item.
 */
async function runCleansingPipeline(tenantId: string, items: any[]) {
  for (const item of items) {
    const raw = item.originalDescription || item.description || '';
    let cleanedName: string | null = null;

    // Step 1 & 2: Tenant rules, then global rules
    cleanedName = await cleanNameViaRules(tenantId, raw);

    // Step 3 & 4: Categorization history + AI (also sets suggestions on the feed item)
    if (!cleanedName) {
      try {
        const { getConfig } = await import('./ai-config.service.js');
        const config = await getConfig();

        // Try categorization history first (inside categorize())
        // Then AI if enabled — categorize() returns vendor_name from AI
        const { categorize: aiCategorize } = await import('./ai-categorization.service.js');
        const result = await aiCategorize(tenantId, item.id);

        if (result?.contactName) {
          cleanedName = result.contactName;
        }
      } catch {
        // AI/history is best-effort
      }
    }

    // Step 5: Basic cleaning (last resort)
    if (!cleanedName) {
      cleanedName = cleanBankDescription(raw);
    }

    // Update the description if it changed
    if (cleanedName && cleanedName !== item.description) {
      await db.update(bankFeedItems).set({ description: cleanedName, updatedAt: new Date() })
        .where(eq(bankFeedItems.id, item.id));
      (item as any).description = cleanedName;
    }
  }
}

/**
 * Post-import categorization pipeline:
 *   1. Bank rules with autoConfirm → auto-categorize matching items
 *   2. AI suggestions on remaining pending items
 */
export async function runCategorizationPipeline(tenantId: string, items: any[]) {
  const bankRulesService = await import('./bank-rules.service.js');
  const categorizationService = await import('./categorization-ai.service.js');

  for (const item of items) {
    // Skip if already categorized (e.g., by the cleansing pipeline's AI step)
    const current = await db.query.bankFeedItems.findFirst({ where: eq(bankFeedItems.id, item.id) });
    if (!current || current.status !== 'pending') continue;

    const ruleResult = await bankRulesService.evaluateRules(tenantId, {
      description: current.description,
      amount: parseFloat(current.amount),
    });
    if (ruleResult.matched && ruleResult.autoConfirm && ruleResult.assignAccountId) {
      await categorize(tenantId, item.id, {
        accountId: ruleResult.assignAccountId,
        contactId: ruleResult.assignContactId || undefined,
        memo: ruleResult.assignMemo || undefined,
      });
    }
  }

  // AI suggestions on remaining pending items
  const pendingIds = [];
  for (const item of items) {
    const current = await db.query.bankFeedItems.findFirst({ where: eq(bankFeedItems.id, item.id) });
    if (current && current.status === 'pending') pendingIds.push(item.id);
  }
  if (pendingIds.length > 0) {
    await categorizationService.suggestForBatch(tenantId, pendingIds).catch(() => {});
  }
}

export async function bulkRecleanse(tenantId: string, feedItemIds: string[]) {
  const items = [];
  for (const id of feedItemIds) {
    const item = await db.query.bankFeedItems.findFirst({
      where: and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, id)),
    });
    if (item) items.push(item);
  }
  await runCleansingPipeline(tenantId, items);
  return { cleansed: items.length };
}

export async function importFromCsv(
  tenantId: string,
  bankConnectionId: string,
  csvText: string,
  mapping: CsvColumnMapping,
) {
  const lines = csvText.split('\n').filter((l) => l.trim());
  if (lines.length < 2) throw AppError.badRequest('CSV must have header + data rows');

  const items: Array<typeof bankFeedItems.$inferInsert> = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i]!.split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
    const dateStr = cols[mapping.date] || '';
    const description = cols[mapping.description] || '';

    let amount: number;
    if (mapping.debitColumn !== undefined && mapping.creditColumn !== undefined) {
      const debit = parseFloat(cols[mapping.debitColumn] || '0') || 0;
      const credit = parseFloat(cols[mapping.creditColumn] || '0') || 0;
      amount = debit - credit; // positive = spend, negative = deposit
    } else {
      amount = parseFloat(cols[mapping.amount] || '0') || 0;
    }

    if (!dateStr || amount === 0) continue;

    items.push({
      tenantId,
      bankConnectionId,
      feedDate: dateStr,
      description: description, // raw — will be cleaned after insert
      originalDescription: description,
      amount: amount.toFixed(4),
      status: 'pending',
    });
  }

  if (items.length === 0) throw AppError.badRequest('No valid rows found in CSV');

  // Duplicate detection: skip items that already exist (same date + amount + original description)
  const deduped = [];
  for (const item of items) {
    const existing = await db.query.bankFeedItems.findFirst({
      where: and(
        eq(bankFeedItems.tenantId, tenantId),
        eq(bankFeedItems.bankConnectionId, bankConnectionId),
        sql`${bankFeedItems.feedDate} = ${item.feedDate}`,
        sql`${bankFeedItems.amount} = ${item.amount}`,
        sql`${bankFeedItems.originalDescription} = ${item.originalDescription}`,
      ),
    });
    if (!existing) deduped.push(item);
  }

  if (deduped.length === 0) return [];

  const inserted = await db.insert(bankFeedItems).values(deduped).returning();

  // Run full cleansing pipeline on each item
  await runCleansingPipeline(tenantId, inserted);

  // Run categorization pipeline (rules autoConfirm + AI suggestions)
  await runCategorizationPipeline(tenantId, inserted);

  return inserted;
}

export async function importFromOfx(tenantId: string, bankConnectionId: string, ofxContent: string) {
  // Simple OFX/QFX parser — extract STMTTRN elements
  const txnRegex = /<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi;
  const items: Array<typeof bankFeedItems.$inferInsert> = [];
  let match;

  while ((match = txnRegex.exec(ofxContent)) !== null) {
    const block = match[1]!;
    const getTag = (tag: string) => {
      const m = block.match(new RegExp(`<${tag}>([^<\\n]+)`, 'i'));
      return m?.[1]?.trim() || '';
    };

    const dateRaw = getTag('DTPOSTED');
    const amount = parseFloat(getTag('TRNAMT'));
    const name = getTag('NAME') || getTag('MEMO');
    const fitid = getTag('FITID');

    if (!dateRaw || isNaN(amount)) continue;

    // Parse OFX date format: YYYYMMDD or YYYYMMDDHHMMSS
    const feedDate = `${dateRaw.slice(0, 4)}-${dateRaw.slice(4, 6)}-${dateRaw.slice(6, 8)}`;

    items.push({
      tenantId,
      bankConnectionId,
      providerTransactionId: fitid || null,
      feedDate,
      description: name, // raw — will be cleaned after insert
      originalDescription: name,
      amount: (-amount).toFixed(4), // OFX: negative = spend, but we want positive = spend
      status: 'pending',
    });
  }

  if (items.length === 0) throw AppError.badRequest('No transactions found in OFX file');

  // Duplicate detection: OFX has FITID (provider transaction ID) — skip if already imported
  const dedupedOfx = [];
  for (const item of items) {
    if (item.providerTransactionId) {
      const existing = await db.query.bankFeedItems.findFirst({
        where: and(
          eq(bankFeedItems.tenantId, tenantId),
          eq(bankFeedItems.providerTransactionId, item.providerTransactionId),
        ),
      });
      if (existing) continue;
    } else {
      const existing = await db.query.bankFeedItems.findFirst({
        where: and(
          eq(bankFeedItems.tenantId, tenantId),
          eq(bankFeedItems.bankConnectionId, bankConnectionId),
          sql`${bankFeedItems.feedDate} = ${item.feedDate}`,
          sql`${bankFeedItems.amount} = ${item.amount}`,
          sql`${bankFeedItems.originalDescription} = ${item.originalDescription}`,
        ),
      });
      if (existing) continue;
    }
    dedupedOfx.push(item);
  }

  if (dedupedOfx.length === 0) return [];

  const insertedOfx = await db.insert(bankFeedItems).values(dedupedOfx).returning();

  // Run full cleansing pipeline on each item
  await runCleansingPipeline(tenantId, insertedOfx);

  // Run categorization pipeline (rules autoConfirm + AI suggestions)
  await runCategorizationPipeline(tenantId, insertedOfx);

  return insertedOfx;
}

export async function importStatementItems(
  tenantId: string,
  bankConnectionId: string,
  transactions: Array<{ date: string; description: string; amount: string; type?: string }>,
) {
  const items: Array<typeof bankFeedItems.$inferInsert> = transactions.map((txn) => ({
    tenantId,
    bankConnectionId,
    feedDate: txn.date,
    description: txn.description,
    originalDescription: txn.description,
    amount: txn.amount,
    status: 'pending' as const,
  }));

  // Duplicate detection
  const dedupedStmt = [];
  for (const item of items) {
    const existing = await db.query.bankFeedItems.findFirst({
      where: and(
        eq(bankFeedItems.tenantId, tenantId),
        sql`${bankFeedItems.feedDate} = ${item.feedDate}`,
        sql`${bankFeedItems.amount} = ${item.amount}`,
        sql`${bankFeedItems.originalDescription} = ${item.originalDescription}`,
      ),
    });
    if (!existing) dedupedStmt.push(item);
  }

  if (dedupedStmt.length === 0) return { imported: 0, skipped: transactions.length };

  const insertedStmt = await db.insert(bankFeedItems).values(dedupedStmt).returning();

  // Run full cleansing pipeline (rules → history → AI → basic cleaning)
  await runCleansingPipeline(tenantId, insertedStmt);

  // Run categorization pipeline (rules autoConfirm + AI suggestions)
  await runCategorizationPipeline(tenantId, insertedStmt);

  return { imported: insertedStmt.length, skipped: transactions.length - insertedStmt.length };
}

