// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Electronic sign-off on a completed bank / credit-card reconciliation
// (migration 0214). A Preparer signs, then a Reviewer — a DIFFERENT user who
// is firm staff. Each signature stores the signer's name at signing, the time,
// and a fingerprint of the reconciliation's substance; when that substance
// changes (rec reopened / undone, a cleared item edited / deleted / voided /
// re-dated / moved, the book balance or outstanding items at the statement
// date change) the signature goes STALE and must be re-signed. Shared by the
// Reconcile screen, the Reconciliation Detail / Summary reports (screen, PDF,
// CSV), the Report Pack bank-rec pages and the reconciliation history list.

export type ReconSignoffRole = 'preparer' | 'reviewer';

/** Why a stored sign-off stopped being live. 'removed' = the signer withdrew it (shows as not signed). */
export type ReconSignoffInvalidReason = 'removed' | 'preparer_removed' | 'reconciliation_reopened' | 'data_changed';

/** signed = live and current; stale = invalidated by a change (re-sign required); unsigned = none / withdrawn. */
export type ReconSignoffState = 'signed' | 'stale' | 'unsigned';

export interface ReconSignoffEntry {
  role: ReconSignoffRole;
  state: ReconSignoffState;
  signoffId: string | null;
  userId: string | null;
  /** Display name captured when the user signed. */
  signerName: string | null;
  signedAt: string | null;
  invalidatedAt: string | null;
  invalidatedReason: ReconSignoffInvalidReason | null;
  /** For data_changed: which parts changed (e.g. "cleared items; book balance at the statement date"). */
  invalidatedDetail: string | null;
}

export interface ReconSignoffSummary {
  preparer: ReconSignoffEntry;
  reviewer: ReconSignoffEntry;
  /** Only a completed reconciliation can be signed. */
  signable: boolean;
}

/** GET /banking/reconciliations/:id/signoffs — the sign-offs plus what the current user may do. */
export interface ReconSignoffView {
  signoffs: ReconSignoffSummary;
  viewer: {
    canSignPreparer: boolean;
    preparerBlockedReason: string | null;
    canSignReviewer: boolean;
    reviewerBlockedReason: string | null;
    canRemovePreparer: boolean;
    canRemoveReviewer: boolean;
  };
}

export function emptyReconSignoffEntry(role: ReconSignoffRole): ReconSignoffEntry {
  return {
    role, state: 'unsigned', signoffId: null, userId: null, signerName: null, signedAt: null,
    invalidatedAt: null, invalidatedReason: null, invalidatedDetail: null,
  };
}

export function emptyReconSignoffSummary(signable = false): ReconSignoffSummary {
  return { preparer: emptyReconSignoffEntry('preparer'), reviewer: emptyReconSignoffEntry('reviewer'), signable };
}

export const RECON_SIGNOFF_ROLE_LABEL: Record<ReconSignoffRole, string> = {
  preparer: 'Prepared by',
  reviewer: 'Reviewed by',
};

/** "10/12/2026 3:04 PM CDT" — the signing time in the given IANA zone (UTC when absent / invalid). */
export function formatReconSignoffTime(iso: string | null | undefined, timeZone?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  let tz = timeZone || 'UTC';
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
  } catch {
    tz = 'UTC';
  }
  const s = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short',
  }).format(d);
  // ICU puts a narrow no-break space before AM/PM; PDFs / CSVs want a plain space.
  return s.replace(',', '').replace(/[  ]/g, ' ');
}

/** "/s/ Kurt Kisaes, 10/12/2026 3:04 PM CDT" */
export function reconSignoffStamp(e: Pick<ReconSignoffEntry, 'signerName' | 'signedAt'>, timeZone?: string | null): string {
  return `/s/ ${e.signerName ?? 'Unknown user'}, ${formatReconSignoffTime(e.signedAt, timeZone)}`;
}

/** Why a stale sign-off went stale, in words. */
export function reconSignoffInvalidReasonLabel(reason: ReconSignoffInvalidReason | null, detail?: string | null): string {
  switch (reason) {
    case 'preparer_removed': return 'the preparer sign-off was removed';
    case 'reconciliation_reopened': return 'the reconciliation was reopened';
    case 'data_changed': return detail ? `data changed since (${detail})` : 'data changed since';
    case 'removed': return 'removed by the signer';
    default: return 'data changed since';
  }
}

/** "Signed off by Name on 10/12/2026 3:04 PM CDT — data changed since (cleared items); re-sign required" */
export function reconSignoffStaleText(e: ReconSignoffEntry, timeZone?: string | null): string {
  return `Signed off by ${e.signerName ?? 'Unknown user'} on ${formatReconSignoffTime(e.signedAt, timeZone)} — `
    + `${reconSignoffInvalidReasonLabel(e.invalidatedReason, e.invalidatedDetail)}; re-sign required`;
}

/** Short status for a table cell: the stamp, "Stale — data changed after sign-off", or "Not signed". */
export function reconSignoffShortText(e: ReconSignoffEntry, timeZone?: string | null): string {
  if (e.state === 'signed') return reconSignoffStamp(e, timeZone);
  if (e.state === 'stale') {
    if (e.invalidatedReason === 'preparer_removed') return 'Stale — preparer sign-off removed';
    if (e.invalidatedReason === 'reconciliation_reopened') return 'Stale — reconciliation reopened';
    return 'Stale — data changed after sign-off';
  }
  return 'Not signed';
}

/**
 * One-line status for reports:
 *   signed   → "/s/ Name, 10/12/2026 3:04 PM CDT"
 *   stale    → "Stale — Signed off by Name on … — data changed since (…); re-sign required"
 *   unsigned → "Not signed"
 */
export function reconSignoffStatusText(e: ReconSignoffEntry, timeZone?: string | null): string {
  if (e.state === 'signed') return reconSignoffStamp(e, timeZone);
  if (e.state === 'stale') return `Stale — ${reconSignoffStaleText(e, timeZone)}`;
  return 'Not signed';
}

export type ReconSignoffBadge = 'reviewed' | 'prepared' | 'stale' | 'unsigned';

/**
 * Overall badge for the history list / pack summary:
 *   reviewed = live preparer + live reviewer; prepared = live preparer only;
 *   stale = any sign-off went stale and nothing is live to replace it on that role;
 *   unsigned = nothing.
 */
export function reconSignoffBadge(s: ReconSignoffSummary): ReconSignoffBadge {
  const p = s.preparer.state;
  const r = s.reviewer.state;
  if (p === 'signed' && r === 'signed') return 'reviewed';
  if (p === 'stale' || r === 'stale') return 'stale';
  if (p === 'signed') return 'prepared';
  return 'unsigned';
}

export const RECON_SIGNOFF_BADGE_LABEL: Record<ReconSignoffBadge, string> = {
  reviewed: 'Prepared & reviewed',
  prepared: 'Prepared — awaiting review',
  stale: 'Stale — re-sign required',
  unsigned: 'Not signed',
};
