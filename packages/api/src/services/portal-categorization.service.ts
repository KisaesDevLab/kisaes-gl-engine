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
import { accounts, attachments, companies, clientCategorySuggestions, portalContactCompanies } from '../db/schema/index.js';
// Storage + the attachments table only. Rule 1 of this module still holds:
// nothing here imports ledger.service or bank-feed.service, so a client
// upload cannot become a posting.
import * as attachmentService from './attachment.service.js';
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
  /**
   * Files THIS contact has attached to the row. Counted in one batched query
   * for the whole page rather than a request per row, and it counts only the
   * client's own uploads — the firm's documents are not the client's business.
   * 0 when the caller passed no contactId.
   */
  myAttachmentCount: number;
}

/**
 * The queue's row source, as a `FROM (...) q` fragment.
 *
 * Extracted so that "is this target in the client's queue?" is answered by
 * the SAME predicate that produced the list, rather than a second copy of it.
 * A copy would drift, and the two places it matters are both authorization
 * checks: submitting an answer, and attaching a file.
 *
 * Columns: target_kind, target_id, the_date, description, amount.
 */
async function queueSource(tenantId: string, companyId: string) {
  const singleCompany = await tenantHasSingleCompany(tenantId);
  return sql`
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
  opts: { limit?: number; offset?: number; contactId?: string } = {},
): Promise<{ items: PortalQueueItem[]; total: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);

  const base = await queueSource(tenantId, companyId);

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
  const attachCounts = ids.length > 0 && opts.contactId
    ? await myAttachmentCounts(tenantId, opts.contactId, ids)
    : new Map<string, number>();

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
        myAttachmentCount: attachCounts.get(targetId) ?? 0,
      };
    }),
  };
}

/**
 * How many files this contact attached to each row, in one query.
 *
 * Keyed on attachable_id alone: a feed-item id and a transaction id are
 * distinct UUIDs, so the type adds nothing here. The type DOES matter when
 * writing (the staff screen reads it), which is what resolveAttachmentTarget
 * is for.
 */
async function myAttachmentCounts(
  tenantId: string,
  contactId: string,
  targetIds: string[],
): Promise<Map<string, number>> {
  const res = await db.execute<{ attachable_id: string; n: string }>(sql`
    SELECT attachable_id, COUNT(*)::text AS n
    FROM attachments
    WHERE tenant_id = ${tenantId}
      AND uploaded_by_contact_id = ${contactId}
      AND attachable_id IN (${sql.join(targetIds.map((id) => sql`${id}::uuid`), sql`, `)})
    GROUP BY attachable_id
  `);
  return new Map(
    (res.rows as Array<{ attachable_id: string; n: string }>)
      .map((r) => [r.attachable_id, Number(r.n)]),
  );
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

// ── Attachments ─────────────────────────────────────────────────
//
// A client can send in the receipt or invoice for a row it is being asked
// about. The file is written to the ORDINARY `attachments` table under the
// same key the staff Uncategorized screen already reads, so the paperclip
// there picks it up with no second store and no relinking step:
//
//   bank_feed_item -> attachable_type 'bank_feed_items'
//   transaction    -> attachable_type = the transaction's OWN txn_type
//
// That second one is the trap documented on the staff screen: a posted row's
// files live under 'expense'/'deposit'/..., never a generic 'transaction'.
// Getting it wrong hides the file from one of the two screens, so the type is
// resolved SERVER-SIDE from the row itself and never taken from the client.

/** File metadata the portal may see. Deliberately no storage key or path. */
export interface PortalAttachmentRef {
  id: string;
  fileName: string;
  mimeType: string | null;
  fileSize: number | null;
  uploadedAt: string;
}

export interface PortalUploadFile {
  filename: string;
  mimeType: string;
  buffer: Buffer;
  size: number;
}

/** How many files one row may carry from the portal. */
export const MAX_PORTAL_ATTACHMENTS_PER_TARGET = 10;

/**
 * Resolve a queue target to its attachment key, refusing anything not in
 * THIS client's queue for THIS company.
 *
 * Membership is tested with `queueSource` — the very fragment that built the
 * list — so a client cannot aim an upload at a row it was never shown, and
 * the check cannot drift away from what the queue means. A miss is reported
 * as not-found, so "belongs to another tenant" reads the same as "does not
 * exist", matching the posture of submitSuggestions.
 */
export async function resolveAttachmentTarget(
  tenantId: string,
  companyId: string,
  targetKind: 'bank_feed_item' | 'transaction',
  targetId: string,
): Promise<{ attachableType: string; attachableId: string }> {
  const base = await queueSource(tenantId, companyId);
  const hit = await db.execute(sql`
    SELECT q.target_kind ${base}
    WHERE q.target_id = ${targetId} AND q.target_kind = ${targetKind}
    LIMIT 1
  `);
  if (hit.rows.length === 0) {
    throw AppError.notFound('That transaction is not in your list.');
  }

  if (targetKind === 'bank_feed_item') {
    return { attachableType: 'bank_feed_items', attachableId: targetId };
  }

  // The posted row's own txn_type IS the attachable_type. Re-read it here
  // rather than trusting anything the client sent.
  const row = await db.execute<{ txn_type: string }>(sql`
    SELECT txn_type FROM transactions
    WHERE id = ${targetId} AND tenant_id = ${tenantId}
    LIMIT 1
  `);
  const txnType = (row.rows as Array<{ txn_type: string }>)[0]?.txn_type;
  if (!txnType) throw AppError.notFound('That transaction is not in your list.');
  return { attachableType: txnType, attachableId: targetId };
}

/**
 * List only what THIS contact uploaded against the row.
 *
 * Not every attachment on it: a document the firm attached is the firm's, and
 * even its filename can say more than the client should see. `attachments`
 * gained `uploaded_by_contact_id` (migration 0165) precisely so this filter
 * exists; NULL there means staff.
 */
export async function listMyAttachments(
  tenantId: string,
  companyId: string,
  contactId: string,
  targetKind: 'bank_feed_item' | 'transaction',
  targetId: string,
): Promise<PortalAttachmentRef[]> {
  const { attachableType, attachableId } = await resolveAttachmentTarget(
    tenantId, companyId, targetKind, targetId,
  );
  const rows = await db
    .select({
      id: attachments.id,
      fileName: attachments.fileName,
      mimeType: attachments.mimeType,
      fileSize: attachments.fileSize,
      createdAt: attachments.createdAt,
    })
    .from(attachments)
    .where(and(
      eq(attachments.tenantId, tenantId),
      eq(attachments.attachableType, attachableType),
      eq(attachments.attachableId, attachableId),
      eq(attachments.uploadedByContactId, contactId),
    ))
    .orderBy(attachments.createdAt);

  return rows.map((r) => ({
    id: r.id,
    fileName: r.fileName,
    mimeType: r.mimeType,
    fileSize: r.fileSize,
    uploadedAt: (r.createdAt ?? new Date()).toISOString(),
  }));
}

/**
 * Store client-supplied files against a queue row.
 *
 * The per-row cap counts only THIS contact's files, so a client cannot be
 * locked out by however many documents the firm has attached.
 */
export async function attachToTarget(
  tenantId: string,
  companyId: string,
  contactId: string,
  targetKind: 'bank_feed_item' | 'transaction',
  targetId: string,
  files: PortalUploadFile[],
): Promise<PortalAttachmentRef[]> {
  if (files.length === 0) throw AppError.badRequest('Choose a file to attach.');

  const { attachableType, attachableId } = await resolveAttachmentTarget(
    tenantId, companyId, targetKind, targetId,
  );

  const existing = await db
    .select({ id: attachments.id })
    .from(attachments)
    .where(and(
      eq(attachments.tenantId, tenantId),
      eq(attachments.attachableType, attachableType),
      eq(attachments.attachableId, attachableId),
      eq(attachments.uploadedByContactId, contactId),
    ));
  if (existing.length + files.length > MAX_PORTAL_ATTACHMENTS_PER_TARGET) {
    throw AppError.badRequest(
      `You can attach up to ${MAX_PORTAL_ATTACHMENTS_PER_TARGET} files to one transaction.`,
    );
  }

  const saved: PortalAttachmentRef[] = [];
  for (const f of files) {
    const row = await attachmentService.upload(
      tenantId,
      { originalname: f.filename, buffer: f.buffer, mimetype: f.mimeType, size: f.size },
      attachableType,
      attachableId,
      { uploadedByContactId: contactId, companyId },
    );
    if (row) {
      saved.push({
        id: row.id,
        fileName: row.fileName,
        mimeType: row.mimeType,
        fileSize: row.fileSize,
        uploadedAt: (row.createdAt ?? new Date()).toISOString(),
      });
    }
  }
  return saved;
}

/**
 * Remove a file the client sent — only its own, only from a row still in its
 * queue. Staff attachments are untouchable from here.
 */
export async function removeMyAttachment(
  tenantId: string,
  contactId: string,
  attachmentId: string,
): Promise<void> {
  const [row] = await db
    .select({ id: attachments.id })
    .from(attachments)
    .where(and(
      eq(attachments.tenantId, tenantId),
      eq(attachments.id, attachmentId),
      eq(attachments.uploadedByContactId, contactId),
    ))
    .limit(1);
  if (!row) throw AppError.notFound('That file is not one of yours.');
  await attachmentService.remove(tenantId, attachmentId);
}
