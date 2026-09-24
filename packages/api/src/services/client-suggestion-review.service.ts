// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// PORTAL_CATEGORIZE_V1 — the STAFF half. Approve, override or reject the
// categories clients suggested.
//
// Approval reuses the existing posting primitives and writes no ledger code
// of its own:
//   * an unposted bank line -> bankFeedService.categorize, exactly what
//     practice-classification.approveSelected does;
//   * an amount already in suspense -> suspenseService.clearSuspense, which
//     runs ledger.bulkUpdateTransactions.
// Lock dates, void/AJE skips and reconciliation safety therefore come for
// free — that is the whole argument for the reuse.

import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  clientCategorySuggestions, accounts, bankFeedItems, transactions,
  tenants, companies, portalContacts, users, userTenantAccess, contacts } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import { env } from '../config/env.js';
import * as systemEmail from './system-email.service.js';
import * as bankFeedService from './bank-feed.service.js';
import * as suspenseService from './suspense.service.js';
import * as classificationService from './practice-classification.service.js';
import type { Submitter, LiveSuggestion } from './portal-categorization.service.js';
import { resolveReviewMode } from './suggestion-review-mode.service.js';

export interface SuggestionRow {
  id: string;
  targetKind: string;
  targetId: string;
  suggestedAccountId: string | null;
  suggestedLabel: string | null;
  clientNote: string | null;
  isPersonal: boolean;
  /** The payee the client picked (null for free text or a since-removed contact). */
  suggestedContactId: string | null;
  /** The payee as shown or typed; set whenever there is any payee answer. */
  suggestedContactLabel: string | null;
  /** Live display name of the picked contact, null when free text or gone. */
  suggestedContactName: string | null;
  resolvedContactId: string | null;
  status: string;
  submittedAt: string;
  reviewedAt: string | null;
  /** Display name of whoever answered — a portal contact or a team member. */
  contactName: string;
  submittedBy: 'portal_contact' | 'team_member';
  submittedByUserId: string | null;
  snapshotAmount: string;
  snapshotDate: string;
  snapshotDescription: string | null;
  /** Fields that changed since the client answered. Blocks bulk approval. */
  driftedFields: string[];
  /** The target no longer exists or was handled elsewhere. */
  isStale: boolean;
}

// ── Listing ─────────────────────────────────────────────────────

export async function listSuggestions(
  tenantId: string,
  opts: {
    companyId?: string; status?: string; unread?: boolean;
    limit?: number; offset?: number;
  } = {},
): Promise<{ rows: SuggestionRow[]; total: number }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500);
  const offset = Math.max(opts.offset ?? 0, 0);

  const conds = [eq(clientCategorySuggestions.tenantId, tenantId)];
  if (opts.companyId) conds.push(eq(clientCategorySuggestions.companyId, opts.companyId));
  if (opts.status) conds.push(eq(clientCategorySuggestions.status, opts.status));
  // Same predicate and param name as /practice/document-requests?unread=true.
  if (opts.unread) {
    conds.push(eq(clientCategorySuggestions.status, 'pending'));
    conds.push(sql`${clientCategorySuggestions.reviewedAt} IS NULL`);
  }
  const where = and(...conds);

  const counted = await db.select({ n: sql<number>`count(*)::int` })
    .from(clientCategorySuggestions).where(where);

  const rows = await db.select({
    s: clientCategorySuggestions,
    contactEmail: portalContacts.email,
    contactFirst: portalContacts.firstName,
    contactLast: portalContacts.lastName,
    userName: users.displayName,
    userEmail: users.email,
    payeeName: contacts.displayName,
  })
    .from(clientCategorySuggestions)
    .leftJoin(portalContacts, eq(portalContacts.id, clientCategorySuggestions.submittedByContactId))
    .leftJoin(users, eq(users.id, clientCategorySuggestions.submittedByUserId))
    .leftJoin(contacts, eq(contacts.id, clientCategorySuggestions.suggestedContactId))
    // Unread first, then newest — the doc-request queue's ordering.
    .orderBy(sql`(${clientCategorySuggestions.reviewedAt} IS NOT NULL), ${clientCategorySuggestions.submittedAt} DESC`)
    .where(where)
    .limit(limit).offset(offset);

  const out: SuggestionRow[] = [];
  for (const r of rows) {
    const drift = await driftFor(tenantId, r.s);
    out.push({
      id: r.s.id,
      targetKind: r.s.targetKind,
      targetId: (r.s.bankFeedItemId ?? r.s.transactionId)!,
      suggestedAccountId: r.s.suggestedAccountId,
      suggestedLabel: r.s.suggestedLabel,
      clientNote: r.s.clientNote,
      isPersonal: r.s.isPersonal,
      suggestedContactId: r.s.suggestedContactId ?? null,
      suggestedContactLabel: r.s.suggestedContactLabel ?? null,
      suggestedContactName: r.s.suggestedContactId ? (r.payeeName ?? null) : null,
      resolvedContactId: r.s.resolvedContactId ?? null,
      status: r.s.status,
      submittedAt: r.s.submittedAt.toISOString(),
      reviewedAt: r.s.reviewedAt ? r.s.reviewedAt.toISOString() : null,
      contactName: r.s.submittedByUserId
        ? (r.userName || r.userEmail || 'a former team member')
        : ([r.contactFirst, r.contactLast].filter(Boolean).join(' ') || (r.contactEmail ?? 'a client')),
      submittedBy: r.s.submittedByUserId ? 'team_member' : 'portal_contact',
      submittedByUserId: r.s.submittedByUserId ?? null,
      snapshotAmount: String(r.s.snapshotAmount),
      snapshotDate: r.s.snapshotDate,
      snapshotDescription: r.s.snapshotDescription,
      driftedFields: drift.fields,
      isStale: drift.stale,
    });
  }
  return { rows: out, total: counted[0]?.n ?? 0 };
}

type SuggestionDb = typeof clientCategorySuggestions.$inferSelect;

/**
 * Has the target moved since the client answered?
 *
 * Plaid rewrites amounts as a row goes pending -> posted, so an answer given
 * against $42.50 must not be swept through once the row reads $58.10. Staleness
 * is separate: the target vanished, was excluded, or someone else already
 * categorized it.
 */
async function driftFor(tenantId: string, s: SuggestionDb): Promise<{ fields: string[]; stale: boolean }> {
  const fields: string[] = [];
  if (s.targetKind === 'bank_feed_item' && s.bankFeedItemId) {
    const [item] = await db.select({
      amount: bankFeedItems.amount, feedDate: bankFeedItems.feedDate,
      description: bankFeedItems.description, status: bankFeedItems.status,
    })
      .from(bankFeedItems)
      .where(and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, s.bankFeedItemId)))
      .limit(1);
    if (!item) return { fields, stale: true };
    if (item.status !== 'pending') return { fields, stale: true };
    if (Number(item.amount) !== Number(s.snapshotAmount)) fields.push('amount');
    if (item.feedDate !== s.snapshotDate) fields.push('date');
    return { fields, stale: false };
  }

  if (s.transactionId) {
    const [txn] = await db.select({ status: transactions.status, txnDate: transactions.txnDate })
      .from(transactions)
      .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, s.transactionId)))
      .limit(1);
    if (!txn || txn.status === 'void') return { fields, stale: true };
    // Someone already moved it out of suspense — not the client's fault.
    if (!(await suspenseService.hasSuspenseLine(tenantId, s.transactionId))) {
      return { fields, stale: true };
    }
    if (txn.txnDate !== s.snapshotDate) fields.push('date');
  }
  return { fields, stale: false };
}

// ── Review actions ──────────────────────────────────────────────

export interface ApproveResult {
  approved: string[];
  failed: Array<{ id: string; reason: string }>;
}

/**
 * Approve suggestions, optionally overriding the client's pick.
 *
 * A drifted row is never posted without `confirmDrift`; it comes back in
 * `failed` with reason 'drifted' so a bulk approve can't silently post an
 * amount the client never saw.
 */
export async function approveSuggestions(
  tenantId: string,
  ids: string[],
  opts: { overrideAccountId?: string; overrideContactId?: string; confirmDrift?: boolean } = {},
  userId?: string,
): Promise<ApproveResult> {
  if (ids.length === 0) throw AppError.badRequest('Select at least one suggestion.');
  if (ids.length > 200) throw AppError.badRequest('Approve at most 200 at a time.');

  if (opts.overrideAccountId) await assertUsableCategory(tenantId, opts.overrideAccountId);
  if (opts.overrideContactId) await assertUsableContact(tenantId, opts.overrideContactId);

  const approved: string[] = [];
  const failed: ApproveResult['failed'] = [];

  for (const id of ids) {
    // Atomic claim. The posting services open their own transactions, so the
    // row cannot be held under FOR UPDATE across the post; this is the same
    // trick bankFeedService.categorize uses on a feed item.
    const claimed = await db.update(clientCategorySuggestions)
      .set({ status: 'approving', updatedAt: new Date() })
      .where(and(
        eq(clientCategorySuggestions.tenantId, tenantId),
        eq(clientCategorySuggestions.id, id),
        eq(clientCategorySuggestions.status, 'pending'),
      ))
      .returning();
    const s = claimed[0];
    if (!s) { failed.push({ id, reason: 'not_pending_or_not_found' }); continue; }

    try {
      const accountId = opts.overrideAccountId ?? s.suggestedAccountId;
      if (!accountId) {
        // "Not sure" and "personal" carry no account: they route the client's
        // note to a human, who overrides with a real one.
        throw new ReviewError(s.isPersonal ? 'personal_needs_account' : 'no_category');
      }

      const drift = await driftFor(tenantId, s);
      if (drift.stale) throw new ReviewError('stale');
      if (drift.fields.length > 0 && !opts.confirmDrift) throw new ReviewError('drifted');

      // The payee: staff override, else the contact the client picked. A
      // free-text name has no id and applies nothing until staff resolve it
      // through the override (quick-add lives in that picker).
      const contactId = opts.overrideContactId ?? s.suggestedContactId ?? undefined;

      let postedTransactionId: string;
      if (s.targetKind === 'bank_feed_item' && s.bankFeedItemId) {
        const txn = await bankFeedService.categorize(
          tenantId, s.bankFeedItemId, { accountId, contactId }, userId, s.companyId,
        );
        // Keep Close Review's audit trail consistent, exactly as
        // approveSelected does after categorize.
        await classificationService.stampTransactionId(tenantId, s.bankFeedItemId, txn.id)
          .catch(() => { /* no state row is fine — the posting already happened */ });
        postedTransactionId = txn.id;
      } else {
        // The payee rides in the same bulk update as the move, so the two
        // land in one DB transaction or not at all.
        await suspenseService.clearSuspense(
          tenantId, [s.transactionId!], accountId, userId, s.companyId,
          contactId ? { payeeContactId: contactId } : {},
        );
        // No new transaction and no new number: the money moved in place.
        postedTransactionId = s.transactionId!;
      }

      const accountOverridden = !!opts.overrideAccountId && opts.overrideAccountId !== s.suggestedAccountId;
      const payeeOverridden = !!opts.overrideContactId && opts.overrideContactId !== s.suggestedContactId;
      await db.update(clientCategorySuggestions).set({
        status: 'approved',
        resolution: accountOverridden || payeeOverridden ? 'overridden' : 'accepted_as_suggested',
        resolvedAccountId: accountId,
        resolvedContactId: contactId ?? null,
        postedTransactionId,
        reviewedAt: new Date(), reviewedBy: userId ?? null, updatedAt: new Date(),
      }).where(eq(clientCategorySuggestions.id, id));

      await auditLog(tenantId, 'update', 'client_category_suggestion', id,
        { status: 'pending' },
        { status: 'approved', accountId, contactId: contactId ?? null, postedTransactionId }, userId);
      approved.push(id);
    } catch (err) {
      const reason = err instanceof ReviewError
        ? err.reason
        : err instanceof Error ? err.message : 'unknown_error';
      // Release the claim so the row stays actionable, unless it is genuinely
      // stale, in which case it retires with its own status.
      await db.update(clientCategorySuggestions)
        .set({ status: reason === 'stale' ? 'stale' : 'pending', updatedAt: new Date() })
        .where(eq(clientCategorySuggestions.id, id));
      failed.push({ id, reason });
    }
  }
  return { approved, failed };
}

class ReviewError extends Error {
  constructor(public reason: string) { super(reason); }
}

/** The destination must be a real category, never a control/system account. */
async function assertUsableCategory(tenantId: string, accountId: string): Promise<void> {
  const [a] = await db.select({
    id: accounts.id, isActive: accounts.isActive, systemTag: accounts.systemTag,
  })
    .from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), eq(accounts.id, accountId)))
    .limit(1);
  if (!a) throw AppError.badRequest('Category account not found.', 'ACCOUNT_NOT_FOUND');
  if (!a.isActive) throw AppError.badRequest('That category account is inactive.', 'ACCOUNT_INACTIVE');
  if (a.systemTag) {
    throw AppError.badRequest('A system account cannot be a category here.', 'SYSTEM_ACCOUNT_TARGET');
  }
}

/** An override payee must be a live contact of this tenant. */
async function assertUsableContact(tenantId: string, contactId: string): Promise<void> {
  const [c] = await db.select({ id: contacts.id, isActive: contacts.isActive })
    .from(contacts)
    .where(and(eq(contacts.tenantId, tenantId), eq(contacts.id, contactId)))
    .limit(1);
  if (!c) throw AppError.badRequest('Payee contact not found.', 'CONTACT_NOT_FOUND');
  if (!c.isActive) throw AppError.badRequest('That payee contact is inactive.', 'CONTACT_INACTIVE');
}

export async function rejectSuggestions(
  tenantId: string, ids: string[], reason: string, userId?: string,
): Promise<{ rejected: string[] }> {
  if (!reason.trim()) throw AppError.badRequest('Give the client a reason.', 'REASON_REQUIRED');
  const res = await db.update(clientCategorySuggestions)
    .set({
      status: 'rejected', rejectionReason: reason.trim(), resolution: 'rejected',
      reviewedAt: new Date(), reviewedBy: userId ?? null, updatedAt: new Date(),
    })
    .where(and(
      eq(clientCategorySuggestions.tenantId, tenantId),
      inArray(clientCategorySuggestions.id, ids),
      eq(clientCategorySuggestions.status, 'pending'),
    ))
    .returning({ id: clientCategorySuggestions.id });
  for (const r of res) {
    await auditLog(tenantId, 'update', 'client_category_suggestion', r.id,
      { status: 'pending' }, { status: 'rejected', reason }, userId);
  }
  return { rejected: res.map((r) => r.id) };
}

/**
 * Clear the unread badge without approving. A bookkeeper who has looked but
 * is not ready to post should not keep seeing a red count.
 */
export async function markReviewed(
  tenantId: string, ids: string[] | null, companyId: string | null, userId?: string,
): Promise<{ marked: number }> {
  const conds = [
    eq(clientCategorySuggestions.tenantId, tenantId),
    eq(clientCategorySuggestions.status, 'pending'),
    sql`${clientCategorySuggestions.reviewedAt} IS NULL`,
  ];
  if (ids && ids.length > 0) conds.push(inArray(clientCategorySuggestions.id, ids));
  if (companyId) conds.push(eq(clientCategorySuggestions.companyId, companyId));

  const res = await db.update(clientCategorySuggestions)
    .set({ reviewedAt: new Date(), reviewedBy: userId ?? null, updatedAt: new Date() })
    .where(and(...conds))
    .returning({ id: clientCategorySuggestions.id });
  return { marked: res.length };
}

/** Count for the dashboard badge — the partial-index predicate exactly. */
export async function countUnread(tenantId: string, companyId?: string): Promise<number> {
  const conds = [
    eq(clientCategorySuggestions.tenantId, tenantId),
    eq(clientCategorySuggestions.status, 'pending'),
    sql`${clientCategorySuggestions.reviewedAt} IS NULL`,
  ];
  if (companyId) conds.push(eq(clientCategorySuggestions.companyId, companyId));
  const [row] = await db.select({ n: sql<number>`count(*)::int` })
    .from(clientCategorySuggestions).where(and(...conds));
  return row?.n ?? 0;
}

// ── Notification ────────────────────────────────────────────────

/**
 * Tell staff a client answered. Contract copied from
 * notifyStaffOfSubmission: never throws, re-validates recipients at send
 * time, and logs structured JSON. One email per batch, not per answer.
 */
export async function notifyStaffOfSuggestions(
  tenantId: string,
  companyId: string,
  submitter: Submitter,
  count: number,
): Promise<{ sent: number; skipped: string | null }> {
  const contactId = 'contactId' in submitter ? submitter.contactId : null;
  const submitterUserId = 'userId' in submitter ? submitter.userId : null;
  const log = (event: string, extra: Record<string, unknown> = {}) => {
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      level: event === 'error' ? 'warn' : 'info',
      component: 'client-suggestion-notify',
      event, tenantId, companyId, contactId, submitterUserId, count, ...extra,
    }));
  };
  try {
    if (!systemEmail.isSmtpConfigured()) return { sent: 0, skipped: 'smtp_not_configured' };

    // Membership is re-checked HERE, not at submission time: a staffer removed
    // from the client since then must stop receiving their data.
    const candidates = await db
      .select({ id: users.id, email: users.email, role: userTenantAccess.role })
      .from(users)
      .innerJoin(userTenantAccess, eq(userTenantAccess.userId, users.id))
      .where(and(
        eq(userTenantAccess.tenantId, tenantId),
        eq(userTenantAccess.isActive, true),
        eq(users.isActive, true),
        sql`${users.userType} <> 'client'`,
        inArray(users.role, ['owner', 'accountant', 'bookkeeper']),
      ));
    // Only people who can actually REVIEW get the mail (firm staff of the
    // managing firm, or the owner of self-managed books) — and never the
    // team member who just submitted.
    const recipients: Array<{ id: string; email: string }> = [];
    let managedByFirm = false;
    for (const u of candidates) {
      if (submitterUserId && u.id === submitterUserId) continue;
      const m = await resolveReviewMode(tenantId, u.id, u.role ?? undefined, false);
      managedByFirm = m.managedByFirm;
      if (m.canReview) recipients.push({ id: u.id, email: u.email });
    }
    if (recipients.length === 0) return { sent: 0, skipped: 'no_eligible_recipients' };

    const [tenant, company, contact, submitterUser] = await Promise.all([
      db.query.tenants.findFirst({ where: eq(tenants.id, tenantId), columns: { name: true } }),
      db.query.companies.findFirst({ where: eq(companies.id, companyId), columns: { businessName: true } }),
      contactId ? db.query.portalContacts.findFirst({ where: eq(portalContacts.id, contactId) }) : Promise.resolve(null),
      submitterUserId ? db.query.users.findFirst({ where: eq(users.id, submitterUserId), columns: { displayName: true, email: true } }) : Promise.resolve(null),
    ]);
    const isTeam = !!submitterUserId;
    const contactName = isTeam
      ? (submitterUser?.displayName || submitterUser?.email || 'a team member')
      : ([contact?.firstName, contact?.lastName].filter(Boolean).join(' ') || contact?.email || 'a client contact');
    const clientName = tenant?.name ?? 'a client';
    const plural = count === 1 ? '' : 's';
    const subject = isTeam
      ? `${clientName}: team member ${contactName} suggested categories for ${count} transaction${plural}`
      : `${clientName}: ${contactName} categorized ${count} transaction${plural}`;
    const base = env.PUBLIC_URL.replace(/\/+$/, '');
    const reviewSpot = managedByFirm ? 'Practice → Uncategorized → Client suggested' : 'Banking → Uncategorized → Suggested';
    const url = managedByFirm
      ? `${base}/practice/uncategorized?tab=client-suggested&filter=unread`
      : `${base}/banking/uncategorized?tab=suggested`;
    const lines = [
      isTeam
        ? `${contactName} suggested categories from Banking → Uncategorized.`
        : `${contactName} suggested categories through the client portal.`,
      '',
      `Client: ${clientName}${company?.businessName ? ` — ${company.businessName}` : ''}`,
      `Answers: ${count}`,
      `Received: ${new Date().toLocaleString('en-US', { timeZone: 'UTC' })} UTC`,
      '',
      `Nothing has posted. Open ${reviewSpot} to approve,`,
      'override or send them back.',
      'If you are signed in to a different client, switch to this client first.',
    ];

    let sent = 0;
    for (const u of recipients) {
      try {
        await systemEmail.sendActionEmail({
          to: u.email, subject, bodyText: lines.join('\n'),
          cta: { label: 'Review suggestions', url },
        });
        sent += 1;
      } catch (e) {
        log('error', { userId: u.id, error: e instanceof Error ? e.message : String(e) });
      }
    }
    log('sent', { sent, recipients: recipients.length });
    return { sent, skipped: null };
  } catch (e) {
    log('error', { error: e instanceof Error ? e.message : String(e) });
    return { sent: 0, skipped: 'error' };
  }
}

/**
 * Display names for the submitters of a set of live suggestions — one users
 * query + one portal_contacts query, never per row. Used to decorate the
 * in-suspense list with "a teammate already suggested X".
 */
export async function submitterNames(
  live: Iterable<LiveSuggestion>,
): Promise<{ users: Map<string, string>; contacts: Map<string, string> }> {
  const userIds = new Set<string>();
  const contactIds = new Set<string>();
  for (const l of live) {
    if (l.submittedByUserId) userIds.add(l.submittedByUserId);
    if (l.submittedByContactId) contactIds.add(l.submittedByContactId);
  }
  const out = { users: new Map<string, string>(), contacts: new Map<string, string>() };
  if (userIds.size > 0) {
    const rows = await db.select({ id: users.id, displayName: users.displayName, email: users.email })
      .from(users).where(inArray(users.id, [...userIds]));
    for (const r of rows) out.users.set(r.id, r.displayName || r.email);
  }
  if (contactIds.size > 0) {
    const rows = await db.select({
      id: portalContacts.id, first: portalContacts.firstName, last: portalContacts.lastName, email: portalContacts.email,
    }).from(portalContacts).where(inArray(portalContacts.id, [...contactIds]));
    for (const r of rows) out.contacts.set(r.id, [r.first, r.last].filter(Boolean).join(' ') || r.email || 'a client');
  }
  return out;
}
