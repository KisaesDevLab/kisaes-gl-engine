// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// PORTAL_CATEGORIZE_V1 — the CLIENT half. A portal contact sees the activity
// nobody has classified yet and suggests a category for it.
//
// Two hard rules govern this module:
//
//  1. A portal write can only ever produce status='pending'. This module
//     imports NOTHING from ledger.service or bank-feed.service, and a test
//     asserts that. Client input is data, never an instruction to post.
//  2. Every read is an explicit ALLOWLIST projection. Never `select()` a row
//     and spread it — the bank feed carries the raw provider descriptor, the
//     AI's guess and its confidence, and vendor enrichment, none of which a
//     client should see.

import { and, eq, sql, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { accounts, companies, clientCategorySuggestions, portalContactCompanies } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { tenantHasSingleCompany } from './portal-banking.service.js';

/**
 * Throws unless the contact is linked to this company with categorize_access.
 * The innerJoin on companies scoped to the session's tenant is what blocks a
 * cross-tenant probe — do not simplify it away.
 */
export async function assertCategorizeAccess(
  tenantId: string,
  contactId: string,
  companyId: string,
): Promise<void> {
  const link = await db
    .select({ categorizeAccess: portalContactCompanies.categorizeAccess })
    .from(portalContactCompanies)
    .innerJoin(companies, eq(companies.id, portalContactCompanies.companyId))
    .where(and(
      eq(portalContactCompanies.contactId, contactId),
      eq(portalContactCompanies.companyId, companyId),
      eq(companies.tenantId, tenantId),
    ))
    .limit(1);
  if (link.length === 0 || !link[0]?.categorizeAccess) {
    throw AppError.forbidden(
      'Categorizing is not enabled for your account',
      'CATEGORIZE_NOT_ENABLED',
    );
  }
}

// ── The category picker ─────────────────────────────────────────

export interface PortalCategory {
  id: string;
  label: string;
  group: string;
  hint: string | null;
}

/**
 * The sanitized category list. This is NOT a proxy for /api/v1/accounts:
 * that endpoint carries balances and the whole chart of accounts.
 *
 * Income and expense accounts only. No balance-sheet accounts (so no bank,
 * A/R, A/P, loans or owner equity), nothing carrying a system role, and no
 * account numbers — they leak the firm's CoA structure and mean nothing to a
 * client anyway.
 */
export async function listPortalCategories(
  tenantId: string,
  companyId: string,
): Promise<PortalCategory[]> {
  const singleCompany = await tenantHasSingleCompany(tenantId);
  const rows = await db.execute(sql`
    SELECT a.id, a.name, a.account_type, a.detail_type, a.description
    FROM accounts a
    WHERE a.tenant_id = ${tenantId}
      AND a.is_active = true
      AND a.system_tag IS NULL
      AND a.account_type IN ('expense', 'cogs', 'revenue', 'other_expense', 'other_revenue')
      AND (a.detail_type IS NULL OR a.detail_type NOT IN ('accounts_receivable', 'accounts_payable'))
      AND (a.company_id = ${companyId} OR (a.company_id IS NULL AND ${singleCompany}))
    ORDER BY a.name
  `);

  return (rows.rows as Array<Record<string, unknown>>).map((r) => ({
    id: String(r['id']),
    label: String(r['name']),
    group: groupFor(String(r['account_type'])),
    hint: (r['description'] as string | null) ?? null,
  }));
}

function groupFor(accountType: string): string {
  if (accountType === 'revenue' || accountType === 'other_revenue') return 'Money in';
  if (accountType === 'cogs') return 'Cost of sales';
  return 'Money out';
}

// ── The queue ───────────────────────────────────────────────────

export interface PortalQueueItem {
  targetKind: 'bank_feed_item' | 'transaction';
  targetId: string;
  date: string;
  description: string;
  /** Signed, 2dp. Positive means money left the account. */
  amount: string;
  direction: 'money_out' | 'money_in';
  existingSuggestion: {
    id: string;
    status: string;
    label: string | null;
    note: string | null;
    rejectionReason: string | null;
  } | null;
}

/**
 * What this client may categorize, for one company.
 *
 * Deliberately NOT every pending bank line. Only rows the firm's own
 * categorizer could not place (needs_review with no suggestion) plus anything
 * already sitting in suspense. Showing a client a row the AI classified
 * confidently invites them to contradict a correct answer and manufactures
 * review work for the bookkeeper.
 */
export async function listPortalQueue(
  tenantId: string,
  companyId: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<{ items: PortalQueueItem[]; total: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const singleCompany = await tenantHasSingleCompany(tenantId);

  const base = sql`
    FROM (
      -- 1. Bank lines the categorizer could not place.
      SELECT
        'bank_feed_item'::text AS target_kind,
        b.id                   AS target_id,
        b.feed_date            AS the_date,
        COALESCE(b.description, '(no description)') AS description,
        b.amount               AS amount
      FROM bank_feed_items b
      JOIN transaction_classification_state tcs
        ON tcs.bank_feed_item_id = b.id AND tcs.tenant_id = b.tenant_id
      WHERE b.tenant_id = ${tenantId}
        AND b.status = 'pending'
        AND tcs.bucket = 'needs_review'
        AND tcs.suggested_account_id IS NULL
        AND (b.company_id = ${companyId} OR (b.company_id IS NULL AND ${singleCompany}))

      UNION ALL

      -- 2. Amounts already posted to suspense.
      SELECT
        'transaction'::text AS target_kind,
        t.id                AS target_id,
        t.txn_date          AS the_date,
        COALESCE(t.memo, '(no description)') AS description,
        (SELECT COALESCE(SUM(jl.debit), 0) - COALESCE(SUM(jl.credit), 0)
           FROM journal_lines jl
          WHERE jl.transaction_id = t.id AND jl.tenant_id = t.tenant_id
            AND jl.account_id = (
              SELECT id FROM accounts
              WHERE tenant_id = ${tenantId} AND system_tag = 'suspense' LIMIT 1
            )) AS amount
      FROM transactions t
      WHERE t.tenant_id = ${tenantId}
        AND t.status <> 'void'
        AND (t.company_id = ${companyId} OR (t.company_id IS NULL AND ${singleCompany}))
        AND EXISTS (
          SELECT 1 FROM journal_lines jl
          WHERE jl.transaction_id = t.id AND jl.tenant_id = t.tenant_id
            AND jl.account_id = (
              SELECT id FROM accounts
              WHERE tenant_id = ${tenantId} AND system_tag = 'suspense' LIMIT 1
            )
        )
    ) q
  `;

  const counted = await db.execute<{ n: string }>(sql`SELECT COUNT(*)::text AS n ${base}`);
  const total = Number((counted.rows as Array<{ n: string }>)[0]?.n ?? '0');

  const res = await db.execute(sql`
    SELECT q.* ${base}
    ORDER BY q.the_date DESC, q.target_id
    LIMIT ${limit} OFFSET ${offset}
  `);

  const rows = res.rows as Array<Record<string, unknown>>;
  const ids = rows.map((r) => String(r['target_id']));
  const live = ids.length > 0 ? await liveSuggestionsFor(tenantId, ids) : new Map();

  return {
    total,
    items: rows.map((r) => {
      const amountNum = Number(r['amount'] ?? 0);
      const targetId = String(r['target_id']);
      const s = live.get(targetId) ?? null;
      return {
        targetKind: String(r['target_kind']) as PortalQueueItem['targetKind'],
        targetId,
        date: String(r['the_date']),
        description: String(r['description']),
        amount: amountNum.toFixed(2),
        direction: amountNum >= 0 ? 'money_out' : 'money_in',
        existingSuggestion: s,
      };
    }),
  };
}

async function liveSuggestionsFor(tenantId: string, targetIds: string[]) {
  const rows = await db
    .select({
      id: clientCategorySuggestions.id,
      status: clientCategorySuggestions.status,
      label: clientCategorySuggestions.suggestedLabel,
      note: clientCategorySuggestions.clientNote,
      rejectionReason: clientCategorySuggestions.rejectionReason,
      bankFeedItemId: clientCategorySuggestions.bankFeedItemId,
      transactionId: clientCategorySuggestions.transactionId,
    })
    .from(clientCategorySuggestions)
    .where(and(
      eq(clientCategorySuggestions.tenantId, tenantId),
      inArray(clientCategorySuggestions.status, ['pending', 'approving']),
    ));

  const map = new Map<string, PortalQueueItem['existingSuggestion']>();
  for (const r of rows) {
    const key = r.bankFeedItemId ?? r.transactionId;
    if (!key || !targetIds.includes(key)) continue;
    map.set(key, {
      id: r.id, status: r.status, label: r.label,
      note: r.note, rejectionReason: r.rejectionReason,
    });
  }
  return map;
}

// ── Submitting ──────────────────────────────────────────────────

export interface SuggestionInput {
  targetKind: 'bank_feed_item' | 'transaction';
  targetId: string;
  /** An account id from listPortalCategories, or one of the two pseudo-picks. */
  categoryId: string | 'personal' | 'not_sure';
  note?: string;
}

export interface SubmitResult {
  accepted: string[];
  failed: Array<{ targetId: string; reason: string }>;
}

/**
 * Record one batch of client answers. Per-item outcomes; a bad row never
 * aborts the batch, matching approveSelected's contract.
 *
 * Every targetId is re-checked against the queue query for THIS company —
 * the client's own claim about what it is pointing at is never trusted. A
 * miss is reported as not_found, the same posture the portal register takes,
 * so "exists in another tenant" is indistinguishable from "does not exist".
 */
export async function submitSuggestions(
  tenantId: string,
  companyId: string,
  contactId: string,
  items: SuggestionInput[],
): Promise<SubmitResult> {
  if (items.length === 0) throw AppError.badRequest('Nothing to submit.');
  if (items.length > 100) throw AppError.badRequest('Submit at most 100 answers at a time.');

  // One queue read for the whole batch, then membership is a set lookup.
  const { items: queue } = await listPortalQueue(tenantId, companyId, { limit: 200, offset: 0 });
  const byId = new Map(queue.map((q) => [q.targetId, q]));

  const categories = await listPortalCategories(tenantId, companyId);
  const categoryById = new Map(categories.map((c) => [c.id, c]));

  const accepted: string[] = [];
  const failed: SubmitResult['failed'] = [];

  for (const item of items) {
    const target = byId.get(item.targetId);
    if (!target || target.targetKind !== item.targetKind) {
      failed.push({ targetId: item.targetId, reason: 'not_found' });
      continue;
    }

    const isPersonal = item.categoryId === 'personal';
    const notSure = item.categoryId === 'not_sure';
    const category = !isPersonal && !notSure ? categoryById.get(item.categoryId) : undefined;

    // A raw account id that is not in the sanitized list is rejected here, so
    // the type allowlist is enforced on WRITE and not only on read.
    if (!isPersonal && !notSure && !category) {
      failed.push({ targetId: item.targetId, reason: 'invalid_category' });
      continue;
    }
    if (notSure && !item.note?.trim()) {
      failed.push({ targetId: item.targetId, reason: 'note_required' });
      continue;
    }

    try {
      await db.transaction(async (tx) => {
        // A re-answer supersedes rather than duplicating. The partial unique
        // index makes the race safe if two devices submit at once.
        await tx.update(clientCategorySuggestions)
          .set({ status: 'superseded', updatedAt: new Date() })
          .where(and(
            eq(clientCategorySuggestions.tenantId, tenantId),
            inArray(clientCategorySuggestions.status, ['pending']),
            item.targetKind === 'bank_feed_item'
              ? eq(clientCategorySuggestions.bankFeedItemId, item.targetId)
              : eq(clientCategorySuggestions.transactionId, item.targetId),
          ));

        await tx.insert(clientCategorySuggestions).values({
          tenantId,
          companyId,
          targetKind: item.targetKind,
          bankFeedItemId: item.targetKind === 'bank_feed_item' ? item.targetId : null,
          transactionId: item.targetKind === 'transaction' ? item.targetId : null,
          suggestedAccountId: category?.id ?? null,
          suggestedLabel: category?.label ?? (isPersonal ? 'Personal / not business' : 'Not sure'),
          clientNote: item.note?.trim() || null,
          isPersonal,
          status: 'pending',
          submittedByContactId: contactId,
          snapshotAmount: target.amount,
          snapshotDate: target.date,
          snapshotDescription: target.description.slice(0, 500),
        });
      });
      accepted.push(item.targetId);
    } catch (err) {
      failed.push({
        targetId: item.targetId,
        reason: err instanceof Error && /unique/i.test(err.message) ? 'already_answered' : 'write_failed',
      });
    }
  }

  return { accepted, failed };
}

// ── History ─────────────────────────────────────────────────────

export interface PortalHistoryRow {
  id: string;
  date: string;
  description: string | null;
  amount: string;
  label: string | null;
  note: string | null;
  status: string;
  rejectionReason: string | null;
  submittedAt: string;
}

/**
 * Company-wide, not per-contact: colleagues share the same books, and seeing
 * what a co-worker already answered is the point. Closing the loop — showing
 * approved and declined outcomes — is what stops a client answering twice.
 */
export async function listPortalHistory(
  tenantId: string,
  companyId: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<{ rows: PortalHistoryRow[]; total: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);

  const where = and(
    eq(clientCategorySuggestions.tenantId, tenantId),
    eq(clientCategorySuggestions.companyId, companyId),
  );

  const counted = await db.select({ n: sql<number>`count(*)::int` })
    .from(clientCategorySuggestions).where(where);

  const rows = await db.select({
    id: clientCategorySuggestions.id,
    date: clientCategorySuggestions.snapshotDate,
    description: clientCategorySuggestions.snapshotDescription,
    amount: clientCategorySuggestions.snapshotAmount,
    label: clientCategorySuggestions.suggestedLabel,
    note: clientCategorySuggestions.clientNote,
    status: clientCategorySuggestions.status,
    rejectionReason: clientCategorySuggestions.rejectionReason,
    submittedAt: clientCategorySuggestions.submittedAt,
  })
    .from(clientCategorySuggestions)
    .where(where)
    .orderBy(sql`${clientCategorySuggestions.submittedAt} DESC`)
    .limit(limit).offset(offset);

  return {
    total: counted[0]?.n ?? 0,
    rows: rows.map((r) => ({
      ...r,
      amount: String(r.amount),
      submittedAt: r.submittedAt.toISOString(),
    })),
  };
}

/** Withdraw a still-pending answer. Only the contact who made it may. */
export async function withdrawSuggestion(
  tenantId: string,
  contactId: string,
  suggestionId: string,
): Promise<void> {
  const res = await db.update(clientCategorySuggestions)
    .set({ status: 'superseded', updatedAt: new Date() })
    .where(and(
      eq(clientCategorySuggestions.tenantId, tenantId),
      eq(clientCategorySuggestions.id, suggestionId),
      eq(clientCategorySuggestions.submittedByContactId, contactId),
      eq(clientCategorySuggestions.status, 'pending'),
    ))
    .returning({ id: clientCategorySuggestions.id });
  if (res.length === 0) {
    throw AppError.conflict('That answer has already been reviewed.', 'SUGGESTION_ALREADY_RESOLVED');
  }
}
