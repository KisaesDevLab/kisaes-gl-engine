// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Electronic sign-off on completed bank / credit-card reconciliations
// (migration 0214). Mirrors the TB leadsheet sign-offs (preparer → reviewer,
// one live signature per role, staleness evaluated on read) with the rules
// Kurt set for reconciliations:
//
//   * Only a COMPLETED reconciliation can be signed.
//   * Preparer: any user with banking write access in the tenant.
//   * Reviewer: a DIFFERENT user than the live preparer, who is firm staff
//     (active firm_admin / firm_staff member of a firm assigned to the tenant)
//     or a super admin, with the same banking write access; only after a live
//     preparer sign-off.
//   * Either signer can remove their OWN live sign-off; removing the
//     preparer's invalidates the reviewer's.
//   * A signature goes stale (invalidated_at + reason) when the
//     reconciliation's substance changes after signing — detected by
//     comparing the stored fingerprint with the current one on read (lazy,
//     persisted on first detection) and eagerly when the rec is undone.
//
// Fingerprint (computeReconFingerprint), all as of the statement date D:
//   h  md5(account | D | statement ending balance | beginning balance)
//   c  md5 of the sorted cleared set of THIS reconciliation: per distinct
//      journal line id → current account, transaction status, txn date and
//      signed amount (deleted lines hash as '-') — catches edits, deletes,
//      voids, re-dates and moves of any cleared item
//   b  the GL balance of the account at D (posted lines dated ≤ D)
//   o  md5 of the sorted outstanding set at D (posted lines dated ≤ D not
//      cleared here or on an earlier completed reconciliation) with dates
//      and amounts — catches backdated / edited / deleted outstanding items
// Recategorizing the income/expense side of a cleared transaction touches
// none of these (the reconciled bank line is unchanged), so it does not
// invalidate a signature — the same rule the proof's discrepancy check uses.

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  emptyReconSignoffEntry,
  type ReconSignoffEntry,
  type ReconSignoffInvalidReason,
  type ReconSignoffRole,
  type ReconSignoffSummary,
  type ReconSignoffView,
} from '@kis-books/shared';
import { db, type DbOrTx } from '../db/index.js';
import { firmUsers, firms, reconciliations, reconciliationSignoffs, tenantFirmAssignments, users } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';

const FINGERPRINT_VERSION = 'v1';
const PART_LABELS: Record<string, string> = {
  h: 'statement date or balance',
  c: 'cleared items',
  b: 'book balance at the statement date',
  o: 'outstanding items',
};

type SignoffRow = typeof reconciliationSignoffs.$inferSelect;

export interface SignoffActor {
  userId: string;
  isSuperAdmin?: boolean;
}

// ─── Fingerprint ──────────────────────────────────────────────────

export interface ReconFingerprint {
  status: string;
  fingerprint: string;
}

export async function computeReconFingerprint(tenantId: string, reconciliationId: string, exec: DbOrTx = db): Promise<ReconFingerprint | null> {
  const res = await exec.execute(sql`
    WITH r AS (
      SELECT id, account_id, statement_date, statement_ending_balance, beginning_balance, status
      FROM reconciliations WHERE tenant_id = ${tenantId} AND id = ${reconciliationId}
    ),
    cl AS (
      SELECT DISTINCT rl.journal_line_id FROM reconciliation_lines rl
      WHERE rl.reconciliation_id = ${reconciliationId} AND rl.is_cleared = true
    ),
    done AS (
      SELECT DISTINCT rl.journal_line_id FROM reconciliation_lines rl
      JOIN reconciliations r2 ON r2.id = rl.reconciliation_id
      CROSS JOIN r
      WHERE r2.tenant_id = ${tenantId} AND r2.account_id = r.account_id AND rl.is_cleared = true
        AND (r2.id = r.id OR (r2.status = 'complete' AND r2.statement_date < r.statement_date))
    )
    SELECT r.status,
      md5(r.account_id::text || '|' || r.statement_date::text || '|' || r.statement_ending_balance::text
        || '|' || r.beginning_balance::text) AS h,
      (SELECT md5(COALESCE(string_agg(
          cl.journal_line_id::text || '|' || COALESCE(jl.account_id::text, '-') || '|' || COALESCE(t.status, '-')
            || '|' || COALESCE(t.txn_date::text, '-') || '|' || COALESCE((jl.debit - jl.credit)::text, '-'),
          ',' ORDER BY cl.journal_line_id), ''))
        FROM cl
        LEFT JOIN journal_lines jl ON jl.id = cl.journal_line_id AND jl.tenant_id = ${tenantId}
        LEFT JOIN transactions t ON t.id = jl.transaction_id AND t.tenant_id = ${tenantId}) AS c,
      (SELECT COALESCE(SUM(jl.debit - jl.credit), 0)::text
        FROM journal_lines jl
        JOIN transactions t ON t.id = jl.transaction_id AND t.tenant_id = jl.tenant_id
        WHERE jl.tenant_id = ${tenantId} AND jl.account_id = r.account_id
          AND t.status = 'posted' AND t.txn_date <= r.statement_date) AS b,
      (SELECT md5(COALESCE(string_agg(
          jl.id::text || '|' || t.txn_date::text || '|' || (jl.debit - jl.credit)::text, ',' ORDER BY jl.id), ''))
        FROM journal_lines jl
        JOIN transactions t ON t.id = jl.transaction_id AND t.tenant_id = jl.tenant_id
        WHERE jl.tenant_id = ${tenantId} AND jl.account_id = r.account_id
          AND t.status = 'posted' AND t.txn_date <= r.statement_date
          AND jl.id NOT IN (SELECT journal_line_id FROM done)) AS o
    FROM r
  `);
  const row = res.rows[0] as { status: string | null; h: string; c: string; b: string; o: string } | undefined;
  if (!row) return null;
  return {
    status: row.status ?? 'in_progress',
    fingerprint: `${FINGERPRINT_VERSION};h=${row.h};c=${row.c};b=${row.b};o=${row.o}`,
  };
}

function parseFingerprint(f: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of f.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
    else out['_v'] = part;
  }
  return out;
}

/** Human list of the fingerprint parts that differ ("cleared items; book balance at the statement date"). */
export function describeFingerprintChange(before: string, after: string): string {
  const a = parseFingerprint(before);
  const b = parseFingerprint(after);
  if (a['_v'] !== b['_v']) return 'reconciliation data';
  const changed = Object.keys(PART_LABELS).filter((k) => a[k] !== b[k]).map((k) => PART_LABELS[k]!);
  return changed.length ? changed.join('; ') : 'reconciliation data';
}

// ─── Invalidation ─────────────────────────────────────────────────

async function invalidateRows(
  tenantId: string,
  rows: SignoffRow[],
  reason: ReconSignoffInvalidReason,
  detail: string | null,
  byUserId: string | null,
  exec: DbOrTx,
): Promise<SignoffRow[]> {
  if (rows.length === 0) return [];
  // Guarded on invalidated_at IS NULL so two concurrent readers detecting
  // the same change invalidate (and audit) a row only once.
  const updated = await exec.update(reconciliationSignoffs).set({
    invalidatedAt: new Date(),
    invalidatedReason: reason,
    invalidatedDetail: detail,
    invalidatedBy: byUserId,
  }).where(and(
    eq(reconciliationSignoffs.tenantId, tenantId),
    inArray(reconciliationSignoffs.id, rows.map((r) => r.id)),
    isNull(reconciliationSignoffs.invalidatedAt),
  )).returning();
  for (const u of updated) {
    await auditLog(
      tenantId,
      reason === 'removed' ? 'unsign' : 'invalidate',
      'reconciliation_signoff',
      u.id,
      { reconciliationId: u.reconciliationId, role: u.role, signerName: u.signerName, signedAt: u.signedAt },
      { invalidatedReason: reason, invalidatedDetail: detail },
      byUserId ?? undefined,
      exec,
    );
  }
  return updated;
}

/**
 * Eager invalidation when the reconciliation is reopened (undo). Called inside
 * the undo transaction so the reopen and the invalidation commit together.
 */
export async function invalidateForReopen(tenantId: string, reconciliationId: string, byUserId: string | null, exec: DbOrTx = db): Promise<number> {
  const live = await exec.select().from(reconciliationSignoffs).where(and(
    eq(reconciliationSignoffs.tenantId, tenantId),
    eq(reconciliationSignoffs.reconciliationId, reconciliationId),
    isNull(reconciliationSignoffs.invalidatedAt),
  ));
  const done = await invalidateRows(tenantId, live, 'reconciliation_reopened', null, byUserId, exec);
  return done.length;
}

/**
 * Lazy staleness: compare each live signature's fingerprint with the current
 * one and invalidate mismatches (persisted + audited, so a signature never
 * silently becomes valid again if the data is changed back).
 */
async function refreshLiveRows(tenantId: string, reconciliationId: string, rows: SignoffRow[], exec: DbOrTx): Promise<void> {
  const live = rows.filter((r) => r.invalidatedAt === null);
  if (live.length === 0) return;
  const fp = await computeReconFingerprint(tenantId, reconciliationId, exec);
  if (!fp) return;
  if (fp.status !== 'complete') {
    const done = await invalidateRows(tenantId, live, 'reconciliation_reopened', null, null, exec);
    mergeUpdates(rows, done);
    return;
  }
  const byDetail = new Map<string, SignoffRow[]>();
  for (const r of live) {
    if (r.fingerprint === fp.fingerprint) continue;
    const detail = describeFingerprintChange(r.fingerprint, fp.fingerprint);
    byDetail.set(detail, [...(byDetail.get(detail) ?? []), r]);
  }
  for (const [detail, group] of byDetail) {
    const done = await invalidateRows(tenantId, group, 'data_changed', detail, null, exec);
    mergeUpdates(rows, done);
  }
}

function mergeUpdates(rows: SignoffRow[], updated: SignoffRow[]) {
  for (const u of updated) {
    const i = rows.findIndex((r) => r.id === u.id);
    if (i >= 0) rows[i] = u;
  }
}

// ─── Summaries ────────────────────────────────────────────────────

function iso(v: Date | string | null): string | null {
  if (v === null) return null;
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

function entryFor(role: ReconSignoffRole, rows: SignoffRow[]): ReconSignoffEntry {
  const mine = rows.filter((r) => r.role === role);
  if (mine.length === 0) return emptyReconSignoffEntry(role);
  const live = mine.find((r) => r.invalidatedAt === null);
  const latest = live ?? mine.reduce((a, b) => (new Date(a.signedAt).getTime() >= new Date(b.signedAt).getTime() ? a : b));
  const reason = (latest.invalidatedReason as ReconSignoffInvalidReason | null) ?? null;
  const state = latest.invalidatedAt === null ? 'signed' : reason === 'removed' ? 'unsigned' : 'stale';
  if (state === 'unsigned') return emptyReconSignoffEntry(role);
  return {
    role,
    state,
    signoffId: latest.id,
    userId: latest.userId,
    signerName: latest.signerName,
    signedAt: iso(latest.signedAt),
    invalidatedAt: iso(latest.invalidatedAt),
    invalidatedReason: reason,
    invalidatedDetail: latest.invalidatedDetail ?? null,
  };
}

function summarize(rows: SignoffRow[], status: string | null): ReconSignoffSummary {
  return {
    preparer: entryFor('preparer', rows),
    reviewer: entryFor('reviewer', rows),
    signable: status === 'complete',
  };
}

async function loadRows(tenantId: string, reconciliationIds: string[], exec: DbOrTx): Promise<SignoffRow[]> {
  if (reconciliationIds.length === 0) return [];
  return exec.select().from(reconciliationSignoffs).where(and(
    eq(reconciliationSignoffs.tenantId, tenantId),
    inArray(reconciliationSignoffs.reconciliationId, reconciliationIds),
  ));
}

/** Current sign-off state of one reconciliation (evaluates staleness first). */
export async function getReconSignoffs(tenantId: string, reconciliationId: string, exec: DbOrTx = db, statusHint?: string): Promise<ReconSignoffSummary> {
  let status = statusHint ?? null;
  if (status === null) {
    const [rec] = await exec.select({ status: reconciliations.status }).from(reconciliations)
      .where(and(eq(reconciliations.tenantId, tenantId), eq(reconciliations.id, reconciliationId))).limit(1);
    if (!rec) throw AppError.notFound('Reconciliation not found');
    status = rec.status ?? 'in_progress';
  }
  const rows = await loadRows(tenantId, [reconciliationId], exec);
  await refreshLiveRows(tenantId, reconciliationId, rows, exec);
  return summarize(rows, status);
}

/**
 * Sign-off state for a list of reconciliations (history list). Only the recs
 * that still have a live signature need their fingerprint recomputed.
 */
export async function getReconSignoffsForMany(
  tenantId: string,
  recs: Array<{ id: string; status: string | null }>,
): Promise<Map<string, ReconSignoffSummary>> {
  const rows = await loadRows(tenantId, recs.map((r) => r.id), db);
  const byRec = new Map<string, SignoffRow[]>();
  for (const r of rows) byRec.set(r.reconciliationId, [...(byRec.get(r.reconciliationId) ?? []), r]);
  const out = new Map<string, ReconSignoffSummary>();
  for (const rec of recs) {
    const mine = byRec.get(rec.id) ?? [];
    await refreshLiveRows(tenantId, rec.id, mine, db);
    out.set(rec.id, summarize(mine, rec.status));
  }
  return out;
}

// ─── Permissions ──────────────────────────────────────────────────

/** Active firm_admin / firm_staff member of an active firm assigned to this tenant. */
export async function isFirmStaffForTenant(userId: string, tenantId: string): Promise<boolean> {
  const [m] = await db.select({ id: firmUsers.id })
    .from(firmUsers)
    .innerJoin(firms, eq(firms.id, firmUsers.firmId))
    .innerJoin(tenantFirmAssignments, eq(tenantFirmAssignments.firmId, firmUsers.firmId))
    .where(and(
      eq(firmUsers.userId, userId),
      eq(firmUsers.isActive, true),
      inArray(firmUsers.firmRole, ['firm_admin', 'firm_staff']),
      eq(firms.isActive, true),
      eq(tenantFirmAssignments.tenantId, tenantId),
      eq(tenantFirmAssignments.isActive, true),
    ))
    .limit(1);
  return !!m;
}

async function canReview(actor: SignoffActor, tenantId: string): Promise<boolean> {
  return !!actor.isSuperAdmin || isFirmStaffForTenant(actor.userId, tenantId);
}

const NOT_COMPLETE = 'Only a completed reconciliation can be signed off.';
const SAME_USER = 'The reviewer must be a different person than the preparer.';
const NOT_FIRM = 'Only firm staff can sign as reviewer.';
const NEED_PREPARER = 'The preparer must sign off before the reviewer.';

/** What the current user may do (drives the panel buttons). The routes re-check everything. */
export async function getReconSignoffView(
  tenantId: string,
  reconciliationId: string,
  actor: SignoffActor & { canWrite: boolean },
): Promise<ReconSignoffView> {
  const signoffs = await getReconSignoffs(tenantId, reconciliationId);
  const p = signoffs.preparer;
  const r = signoffs.reviewer;
  const noWrite = 'You need write access to Banking to sign off.';
  let preparerBlockedReason: string | null = null;
  if (!signoffs.signable) preparerBlockedReason = NOT_COMPLETE;
  else if (!actor.canWrite) preparerBlockedReason = noWrite;
  else if (p.state === 'signed') preparerBlockedReason = 'Already signed by the preparer.';
  else if (r.state === 'signed' && r.userId === actor.userId) preparerBlockedReason = SAME_USER;

  let reviewerBlockedReason: string | null = null;
  if (!signoffs.signable) reviewerBlockedReason = NOT_COMPLETE;
  else if (!actor.canWrite) reviewerBlockedReason = noWrite;
  else if (r.state === 'signed') reviewerBlockedReason = 'Already signed by the reviewer.';
  else if (p.state !== 'signed') reviewerBlockedReason = NEED_PREPARER;
  else if (p.userId === actor.userId) reviewerBlockedReason = SAME_USER;
  else if (!(await canReview(actor, tenantId))) reviewerBlockedReason = NOT_FIRM;

  return {
    signoffs,
    viewer: {
      canSignPreparer: preparerBlockedReason === null,
      preparerBlockedReason,
      canSignReviewer: reviewerBlockedReason === null,
      reviewerBlockedReason,
      canRemovePreparer: actor.canWrite && p.state === 'signed' && p.userId === actor.userId,
      canRemoveReviewer: actor.canWrite && r.state === 'signed' && r.userId === actor.userId,
    },
  };
}

// ─── Sign / remove ────────────────────────────────────────────────

async function lockRec(tenantId: string, reconciliationId: string, tx: DbOrTx) {
  const [rec] = await tx.select({ id: reconciliations.id, status: reconciliations.status })
    .from(reconciliations)
    .where(and(eq(reconciliations.tenantId, tenantId), eq(reconciliations.id, reconciliationId)))
    .for('update')
    .limit(1);
  if (!rec) throw AppError.notFound('Reconciliation not found');
  return rec;
}

export async function signReconciliation(
  tenantId: string,
  reconciliationId: string,
  role: ReconSignoffRole,
  actor: SignoffActor,
): Promise<ReconSignoffSummary> {
  // Firm membership is read outside the rec lock (it does not depend on it).
  const reviewerOk = role === 'reviewer' ? await canReview(actor, tenantId) : true;
  const [user] = await db.select({ displayName: users.displayName, email: users.email })
    .from(users).where(eq(users.id, actor.userId)).limit(1);
  const signerName = (user?.displayName || user?.email || 'Unknown user').slice(0, 255);

  return db.transaction(async (tx) => {
    const rec = await lockRec(tenantId, reconciliationId, tx);
    if (rec.status !== 'complete') throw AppError.unprocessableEntity(NOT_COMPLETE, 'RECON_SIGNOFF_NOT_COMPLETE');
    const rows = await loadRows(tenantId, [reconciliationId], tx);
    await refreshLiveRows(tenantId, reconciliationId, rows, tx);
    const live = rows.filter((r) => r.invalidatedAt === null);
    const livePrep = live.find((r) => r.role === 'preparer');
    const liveRev = live.find((r) => r.role === 'reviewer');

    if (role === 'preparer') {
      if (livePrep) throw AppError.conflict('This reconciliation is already signed by the preparer.', 'RECON_SIGNOFF_ALREADY_SIGNED');
      if (liveRev && liveRev.userId === actor.userId) throw AppError.unprocessableEntity(SAME_USER, 'RECON_SIGNOFF_SAME_USER');
    } else {
      if (liveRev) throw AppError.conflict('This reconciliation is already signed by the reviewer.', 'RECON_SIGNOFF_ALREADY_SIGNED');
      if (!livePrep) throw AppError.unprocessableEntity(NEED_PREPARER, 'RECON_SIGNOFF_ORDER');
      if (livePrep.userId === actor.userId) throw AppError.unprocessableEntity(SAME_USER, 'RECON_SIGNOFF_SAME_USER');
      if (!reviewerOk) throw AppError.forbidden(NOT_FIRM, 'RECON_SIGNOFF_REVIEWER_NOT_FIRM');
    }

    const fp = await computeReconFingerprint(tenantId, reconciliationId, tx);
    if (!fp) throw AppError.notFound('Reconciliation not found');
    const [row] = await tx.insert(reconciliationSignoffs).values({
      tenantId,
      reconciliationId,
      role,
      userId: actor.userId,
      signerName,
      fingerprint: fp.fingerprint,
    }).returning();
    if (!row) throw AppError.internal('Sign-off insert failed');
    await auditLog(tenantId, 'signoff', 'reconciliation_signoff', row.id, null,
      { reconciliationId, role, signerName, signedAt: row.signedAt, fingerprint: fp.fingerprint },
      actor.userId, tx);
    rows.push(row);
    return summarize(rows, rec.status);
  });
}

export async function removeReconSignoff(
  tenantId: string,
  reconciliationId: string,
  role: ReconSignoffRole,
  actor: SignoffActor,
): Promise<ReconSignoffSummary> {
  return db.transaction(async (tx) => {
    const rec = await lockRec(tenantId, reconciliationId, tx);
    const rows = await loadRows(tenantId, [reconciliationId], tx);
    const target = rows.find((r) => r.role === role && r.invalidatedAt === null);
    if (!target) throw AppError.notFound('There is no current sign-off to remove.');
    if (target.userId !== actor.userId) {
      throw AppError.forbidden('Only the person who signed can remove this sign-off.', 'RECON_SIGNOFF_NOT_SIGNER');
    }
    mergeUpdates(rows, await invalidateRows(tenantId, [target], 'removed', null, actor.userId, tx));
    if (role === 'preparer') {
      const rev = rows.filter((r) => r.role === 'reviewer' && r.invalidatedAt === null);
      mergeUpdates(rows, await invalidateRows(tenantId, rev, 'preparer_removed', null, actor.userId, tx));
    }
    return summarize(rows, rec.status);
  });
}
