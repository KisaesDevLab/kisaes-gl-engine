// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import crypto from 'node:crypto';
import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  accounts,
  attachments,
  contacts,
  vendor1099Profile,
  vendor1099AccountMappings,
  w9Requests,
  annual1099Filings,
  transactions,
  journalLines,
} from '../db/schema/index.js';
import { encrypt, decrypt } from '../utils/encryption.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import { getSmtpSettings } from './admin.service.js';
import { getProviderForTenant } from './storage/storage-provider.factory.js';
import { htmlToPdf, w9HtmlTemplate } from './portal-pdf.service.js';
import { CSV_HEADER, buildCsvLine, maskTin } from './portal-1099.csv.js';
import {
  buildTinMatchFile,
  decodeMatchCode,
  parseTinMatchResult,
  type TinExportRow,
} from './portal-1099.tin-match.js';
import {
  decodeVendorStatus,
  isValidExclusionReason,
  type ExclusionReason,
  type VendorStatus,
} from './portal-1099.status.js';
import {
  BOX_THRESHOLDS,
  FORM_BOX_LABELS,
  FORM_1099_BOXES,
  formOf,
  isValidFormBox,
  type FormBox,
} from './portal-1099.boxes.js';
import nodemailer from 'nodemailer';

// VIBE_MYBOOKS_PRACTICE_BUILD_PLAN Phase 14 + 15 — 1099 / W-9.

const NEC_THRESHOLD = 600;
const W9_REQUEST_TTL_DAYS = 30;

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

// 14.4 — YTD totals per vendor for a given tax year. Excludes
// non-1099 transaction types (refunds, transfers). Implements as
// a plain query rather than a materialized view — refresh-on-write
// is overkill at the current scale and adds operational complexity.
export async function ytdTotals(
  tenantId: string,
  taxYear: number,
): Promise<Array<{ contactId: string; total: number }>> {
  const yearStart = `${taxYear}-01-01`;
  const yearEnd = `${taxYear}-12-31`;
  const rows = await db
    .select({
      contactId: transactions.contactId,
      total: sql<string>`COALESCE(SUM(${transactions.total}), 0)::text`,
    })
    .from(transactions)
    .where(
      and(
        eq(transactions.tenantId, tenantId),
        sql`${transactions.contactId} IS NOT NULL`,
        gte(transactions.txnDate, yearStart),
        lte(transactions.txnDate, yearEnd),
        // 1099-relevant txn types: bills, expense-classed transactions,
        // and bill payments. Refunds and transfers excluded.
        inArray(transactions.txnType, ['bill', 'bill_payment', 'expense', 'check']),
        // Drafts are not yet money out the door — exclude them.
        eq(transactions.status, 'posted'),
        sql`${transactions.voidedAt} IS NULL`,
      ),
    )
    .groupBy(transactions.contactId);
  return rows
    .filter((r): r is { contactId: string; total: string } => r.contactId !== null)
    .map((r) => ({ contactId: r.contactId, total: Number(r.total) }));
}

// Per-box YTD aggregator. Joins transactions → journal_lines →
// vendor_1099_account_mappings to attribute each expense leg to a
// (form, box) bucket, then groups by (contactId × form_box).
//
// Why we use journal_lines.debit − credit rather than transactions.total:
//   • A vendor credit reverses an expense — the journal entry has a
//     credit on the same expense account that the original bill
//     debited, so debit − credit nets the refund out automatically.
//   • A multi-line bill that splits one transaction across several
//     mapped accounts (e.g. legal services + court filing fees)
//     attributes correctly to each box rather than lumping under
//     whichever box the operator picked.
//
// Bill payments are intentionally omitted from the txnType filter:
// their journal lines hit AP and Cash, neither of which is a mapped
// expense account, so they'd contribute zero anyway. Skipping them
// is cheaper than joining them and filtering by mapped account.
export async function ytdTotalsByBox(
  tenantId: string,
  taxYear: number,
): Promise<Array<{ contactId: string; formBox: FormBox; total: number }>> {
  const yearStart = `${taxYear}-01-01`;
  const yearEnd = `${taxYear}-12-31`;
  const rows = await db
    .select({
      contactId: transactions.contactId,
      formBox: vendor1099AccountMappings.formBox,
      total: sql<string>`COALESCE(SUM(${journalLines.debit} - ${journalLines.credit}), 0)::text`,
    })
    .from(transactions)
    .innerJoin(
      journalLines,
      and(
        eq(journalLines.transactionId, transactions.id),
        eq(journalLines.tenantId, transactions.tenantId),
      ),
    )
    .innerJoin(
      vendor1099AccountMappings,
      and(
        eq(vendor1099AccountMappings.accountId, journalLines.accountId),
        eq(vendor1099AccountMappings.tenantId, transactions.tenantId),
      ),
    )
    .where(
      and(
        eq(transactions.tenantId, tenantId),
        sql`${transactions.contactId} IS NOT NULL`,
        gte(transactions.txnDate, yearStart),
        lte(transactions.txnDate, yearEnd),
        inArray(transactions.txnType, ['bill', 'expense', 'check']),
        eq(transactions.status, 'posted'),
        sql`${transactions.voidedAt} IS NULL`,
      ),
    )
    .groupBy(transactions.contactId, vendor1099AccountMappings.formBox);

  return rows
    .filter(
      (r): r is { contactId: string; formBox: string; total: string } =>
        r.contactId !== null && isValidFormBox(r.formBox),
    )
    .map((r) => ({
      contactId: r.contactId,
      formBox: r.formBox as FormBox,
      total: Number(r.total),
    }))
    .filter((r) => r.total > 0);
}

// 14.2 — landing summary for the bookkeeper dashboard.
export interface SummaryData {
  eligibleVendorCount: number;
  ytdPaymentTotal: number;
  vendorsOverThreshold: number;
  w9sMissing: number;
  w9sExpiring: number;
  excludedCount: number;
}

export async function summary(tenantId: string, taxYear: number): Promise<SummaryData> {
  const eligible = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(and(eq(contacts.tenantId, tenantId), eq(contacts.is1099Eligible, true)));
  const eligibleIds = new Set(eligible.map((c) => c.id));

  // Pull every profile in one shot — we use it both for the
  // exclusion filter and for the W-9 missing/expiring rollup.
  const profiles = eligibleIds.size
    ? await db
        .select()
        .from(vendor1099Profile)
        .where(
          and(
            eq(vendor1099Profile.tenantId, tenantId),
            inArray(vendor1099Profile.contactId, [...eligibleIds]),
          ),
        )
    : [];
  const profileMap = new Map(profiles.map((p) => [p.contactId, p]));
  const excludedIds = new Set(
    profiles.filter((p) => p.exclusionReason).map((p) => p.contactId),
  );

  // Excluded vendors stay out of every summary tile — they're an
  // explicit "not in scope" decision, not a 1099 candidate.
  const inScopeIds = new Set([...eligibleIds].filter((id) => !excludedIds.has(id)));

  const totals = await ytdTotals(tenantId, taxYear);
  const eligibleTotals = totals.filter((t) => inScopeIds.has(t.contactId));
  const ytdPaymentTotal = eligibleTotals.reduce((s, t) => s + t.total, 0);
  const vendorsOverThreshold = eligibleTotals.filter((t) => t.total >= NEC_THRESHOLD).length;

  let w9sMissing = 0;
  let w9sExpiring = 0;
  for (const id of inScopeIds) {
    const p = profileMap.get(id);
    if (!p || !p.w9OnFile) {
      w9sMissing++;
    } else if (p.w9ExpiresAt && p.w9ExpiresAt.getTime() < Date.now() + 90 * 24 * 60 * 60 * 1000) {
      w9sExpiring++;
    }
  }

  return {
    eligibleVendorCount: inScopeIds.size,
    ytdPaymentTotal,
    vendorsOverThreshold,
    w9sMissing,
    w9sExpiring,
    excludedCount: excludedIds.size,
  };
}

// 14.3 — vendor table.
export interface VendorRow {
  contactId: string;
  displayName: string;
  is1099Eligible: boolean;
  ytdTotal: number;
  w9OnFile: boolean;
  status: VendorStatus;
  taxId: string | null;
  // 15.5 — IRS Bulk TIN Match. null when the vendor has never been
  // submitted; otherwise pending → matched | mismatched | error.
  tinMatchStatus: string | null;
  tinMatchCode: string | null;
  tinMatchDate: Date | null;
  exclusionReason: string | null;
  exclusionNote: string | null;
  excludedAt: Date | null;
}

export async function listVendors(tenantId: string, taxYear: number): Promise<VendorRow[]> {
  const vendors = await db
    .select({
      contactId: contacts.id,
      displayName: contacts.displayName,
      is1099Eligible: contacts.is1099Eligible,
      taxId: contacts.taxId,
    })
    .from(contacts)
    .where(
      and(
        eq(contacts.tenantId, tenantId),
        sql`${contacts.contactType} IN ('vendor', 'both')`,
      ),
    );

  const totals = await ytdTotals(tenantId, taxYear);
  const totalMap = new Map(totals.map((t) => [t.contactId, t.total]));

  const profiles = await db
    .select()
    .from(vendor1099Profile)
    .where(eq(vendor1099Profile.tenantId, tenantId));
  const profileMap = new Map(profiles.map((p) => [p.contactId, p]));

  return vendors.map((v) => {
    const total = totalMap.get(v.contactId) ?? 0;
    const profile = profileMap.get(v.contactId);
    const w9 = profile?.w9OnFile ?? false;
    const status = decodeVendorStatus({
      is1099Eligible: !!v.is1099Eligible,
      ytdTotal: total,
      w9OnFile: w9,
      exclusionReason: profile?.exclusionReason ?? null,
      necThreshold: NEC_THRESHOLD,
    });
    return {
      contactId: v.contactId,
      displayName: v.displayName,
      is1099Eligible: !!v.is1099Eligible,
      ytdTotal: total,
      w9OnFile: w9,
      status,
      taxId: v.taxId,
      tinMatchStatus: profile?.tinMatchStatus ?? null,
      tinMatchCode: profile?.tinMatchCode ?? null,
      tinMatchDate: profile?.tinMatchDate ?? null,
      exclusionReason: profile?.exclusionReason ?? null,
      exclusionNote: profile?.exclusionNote ?? null,
      excludedAt: profile?.excludedAt ?? null,
    };
  });
}

// 14.5 — threshold scanner. Returns the list of vendors crossing
// thresholds without a W-9. The reminder + findings integration is
// done outside this module so the scanner stays pure.
export interface ThresholdHit {
  contactId: string;
  displayName: string;
  ytdTotal: number;
  hasW9: boolean;
  thresholdType: 'NEC' | 'ROYALTY';
}

export async function scanThresholds(
  tenantId: string,
  taxYear: number,
): Promise<ThresholdHit[]> {
  const rows = await listVendors(tenantId, taxYear);
  return rows
    .filter(
      (r) => r.is1099Eligible && !r.w9OnFile && !r.exclusionReason && r.ytdTotal >= NEC_THRESHOLD,
    )
    .map((r) => ({
      contactId: r.contactId,
      displayName: r.displayName,
      ytdTotal: r.ytdTotal,
      hasW9: r.w9OnFile,
      thresholdType: 'NEC' as const,
    }));
}

// ── Vendor profile CRUD (14.1) ──────────────────────────────────

export interface UpdateProfileInput {
  is1099Eligible?: boolean;
  form1099Type?: 'NEC' | 'MISC' | 'K' | null;
  exemptPayeeCode?: string | null;
  tin?: string | null;
  tinType?: 'SSN' | 'EIN' | null;
  backupWithholding?: boolean;
  notes?: string | null;
  // 1099 mailing address — separate from contacts.billing_*. Pass
  // an object to set/clear all four fields at once; pass null to
  // wipe; omit to leave unchanged.
  mailingAddress?: {
    line1: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
  } | null;
}

export async function updateProfile(
  tenantId: string,
  contactId: string,
  bookkeeperUserId: string,
  input: UpdateProfileInput,
): Promise<void> {
  const c = await db.query.contacts.findFirst({
    where: and(eq(contacts.tenantId, tenantId), eq(contacts.id, contactId)),
  });
  if (!c) throw AppError.notFound('Vendor not found');

  // form_1099_type and exempt_payee_code live in migration 0074 but
  // aren't in the Drizzle contacts schema definition. Use the
  // parameterized `sql` template tag for those.
  if (input.is1099Eligible !== undefined) {
    await db
      .update(contacts)
      .set({ is1099Eligible: input.is1099Eligible })
      .where(eq(contacts.id, contactId));
  }
  if (input.form1099Type !== undefined) {
    await db.execute(
      sql`UPDATE contacts SET form_1099_type = ${input.form1099Type} WHERE id = ${contactId}`,
    );
  }
  if (input.exemptPayeeCode !== undefined) {
    await db.execute(
      sql`UPDATE contacts SET exempt_payee_code = ${input.exemptPayeeCode} WHERE id = ${contactId}`,
    );
  }

  const tinEncrypted = input.tin ? encrypt(input.tin) : input.tin === null ? null : undefined;
  const profilePatch: {
    backupWithholding?: boolean;
    notes?: string | null;
    tinEncrypted?: string | null;
    tinType?: 'SSN' | 'EIN' | null;
    tinMatchStatus?: string | null;
    tinMatchCode?: string | null;
    tinMatchDate?: Date | null;
    addressLine1?: string | null;
    addressCity?: string | null;
    addressState?: string | null;
    addressZip?: string | null;
    updatedAt: Date;
  } = { updatedAt: new Date() };
  if (input.backupWithholding !== undefined) profilePatch.backupWithholding = input.backupWithholding;
  if (input.notes !== undefined) profilePatch.notes = input.notes;
  if (tinEncrypted !== undefined) profilePatch.tinEncrypted = tinEncrypted;
  if (input.tinType !== undefined) profilePatch.tinType = input.tinType;
  // Manual TIN change invalidates any prior match — operator must re-export
  // the bulk file and re-import results to confirm the new pair.
  if (tinEncrypted !== undefined || input.tinType !== undefined) {
    profilePatch.tinMatchStatus = null;
    profilePatch.tinMatchCode = null;
    profilePatch.tinMatchDate = null;
  }
  if (input.mailingAddress !== undefined) {
    if (input.mailingAddress === null) {
      profilePatch.addressLine1 = null;
      profilePatch.addressCity = null;
      profilePatch.addressState = null;
      profilePatch.addressZip = null;
    } else {
      profilePatch.addressLine1 = input.mailingAddress.line1;
      profilePatch.addressCity = input.mailingAddress.city;
      profilePatch.addressState = input.mailingAddress.state;
      profilePatch.addressZip = input.mailingAddress.zip;
    }
  }

  await db
    .insert(vendor1099Profile)
    .values({
      contactId,
      tenantId,
      ...profilePatch,
    })
    .onConflictDoUpdate({
      target: vendor1099Profile.contactId,
      set: profilePatch,
    });

  await auditLog(
    tenantId,
    'update',
    'vendor_1099_profile',
    contactId,
    null,
    // Don't log raw TIN — we audit only that it changed.
    { ...input, tin: input.tin !== undefined ? '[encrypted]' : undefined },
    bookkeeperUserId,
  );
}

export interface VendorAddressBlock {
  line1: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
}

export async function getProfile(tenantId: string, contactId: string): Promise<{
  contactId: string;
  is1099Eligible: boolean;
  w9OnFile: boolean;
  w9CapturedAt: Date | null;
  w9ExpiresAt: Date | null;
  tinMasked: string | null;
  tinType: string | null;
  backupWithholding: boolean;
  notes: string | null;
  legalName: string | null;
  businessName: string | null;
  tinMatchStatus: string | null;
  tinMatchCode: string | null;
  tinMatchDate: Date | null;
  mailingAddress: VendorAddressBlock;
  contactBillingAddress: VendorAddressBlock;
  exclusionReason: string | null;
  exclusionNote: string | null;
  excludedAt: Date | null;
  excludedBy: string | null;
}> {
  const c = await db.query.contacts.findFirst({
    where: and(eq(contacts.tenantId, tenantId), eq(contacts.id, contactId)),
  });
  if (!c) throw AppError.notFound('Vendor not found');
  const p = await db.query.vendor1099Profile.findFirst({
    where: eq(vendor1099Profile.contactId, contactId),
  });
  let tinMasked: string | null = null;
  if (p?.tinEncrypted) {
    try {
      const plain = decrypt(p.tinEncrypted);
      // Mask everything except last 4.
      tinMasked = `***-**-${plain.slice(-4)}`;
    } catch {
      tinMasked = '***-**-****';
    }
  }
  return {
    contactId,
    is1099Eligible: !!c.is1099Eligible,
    w9OnFile: p?.w9OnFile ?? false,
    w9CapturedAt: p?.w9CapturedAt ?? null,
    w9ExpiresAt: p?.w9ExpiresAt ?? null,
    tinMasked,
    tinType: p?.tinType ?? null,
    backupWithholding: p?.backupWithholding ?? false,
    notes: p?.notes ?? null,
    legalName: p?.legalName ?? null,
    businessName: p?.businessName ?? null,
    tinMatchStatus: p?.tinMatchStatus ?? null,
    tinMatchCode: p?.tinMatchCode ?? null,
    tinMatchDate: p?.tinMatchDate ?? null,
    mailingAddress: {
      line1: p?.addressLine1 ?? null,
      city: p?.addressCity ?? null,
      state: p?.addressState ?? null,
      zip: p?.addressZip ?? null,
    },
    contactBillingAddress: {
      line1: c.billingLine1 ?? null,
      city: c.billingCity ?? null,
      state: c.billingState ?? null,
      zip: c.billingZip ?? null,
    },
    exclusionReason: p?.exclusionReason ?? null,
    exclusionNote: p?.exclusionNote ?? null,
    excludedAt: p?.excludedAt ?? null,
    excludedBy: p?.excludedBy ?? null,
  };
}

// 15.0 — explicit "apply 1099 mailing address to contact billing".
// Kept as its own entry point (rather than an auto-overwrite on
// W-9 completion) so the operator owns the call. See the comment
// on migration 0079 for why we don't silently overwrite.
export async function applyW9AddressToContact(
  tenantId: string,
  bookkeeperUserId: string,
  contactId: string,
): Promise<void> {
  const profile = await db.query.vendor1099Profile.findFirst({
    where: and(
      eq(vendor1099Profile.tenantId, tenantId),
      eq(vendor1099Profile.contactId, contactId),
    ),
  });
  if (!profile) throw AppError.notFound('No 1099 profile for this vendor');
  if (!profile.addressLine1) {
    throw AppError.badRequest('No 1099 mailing address captured for this vendor');
  }
  const c = await db.query.contacts.findFirst({
    where: and(eq(contacts.tenantId, tenantId), eq(contacts.id, contactId)),
  });
  if (!c) throw AppError.notFound('Vendor not found');

  await db
    .update(contacts)
    .set({
      billingLine1: profile.addressLine1,
      billingCity: profile.addressCity,
      billingState: profile.addressState,
      billingZip: profile.addressZip,
      updatedAt: new Date(),
    })
    .where(and(eq(contacts.tenantId, tenantId), eq(contacts.id, contactId)));

  await auditLog(
    tenantId,
    'update',
    'contact',
    contactId,
    {
      billingLine1: c.billingLine1,
      billingCity: c.billingCity,
      billingState: c.billingState,
      billingZip: c.billingZip,
    },
    {
      billingLine1: profile.addressLine1,
      billingCity: profile.addressCity,
      billingState: profile.addressState,
      billingZip: profile.addressZip,
      source: 'w9_mailing_address',
    },
    bookkeeperUserId,
  );
}

// ── 14.x — exclusion (not subject to 1099 reporting) ────────────
//
// Operator-driven mark with a canonical reason. Distinct from the
// is_1099_eligible boolean: eligibility = "vendors of this type can
// trigger 1099 reporting"; exclusion = "this specific vendor is
// exempt for {reason}, here's the audit trail".
//
// Once set:
//   • Status pill flips to 'excluded' regardless of YTD/W-9.
//   • Vendor is omitted from summary tiles, threshold scanner,
//     filing exports, and the Bulk TIN Match file.
//   • Review-checks/handlers/vendor-1099-threshold-no-w9 stops
//     generating findings for the row.

export async function setExclusion(
  tenantId: string,
  bookkeeperUserId: string,
  contactId: string,
  reason: ExclusionReason,
  note?: string | null,
): Promise<void> {
  if (!isValidExclusionReason(reason)) {
    throw AppError.badRequest('Unknown exclusion reason');
  }
  if (reason === 'other' && !(note && note.trim())) {
    throw AppError.badRequest('A note is required when the reason is "Other"');
  }
  const c = await db.query.contacts.findFirst({
    where: and(eq(contacts.tenantId, tenantId), eq(contacts.id, contactId)),
  });
  if (!c) throw AppError.notFound('Vendor not found');

  const stamp = new Date();
  await db
    .insert(vendor1099Profile)
    .values({
      contactId,
      tenantId,
      exclusionReason: reason,
      exclusionNote: note?.trim() || null,
      excludedAt: stamp,
      excludedBy: bookkeeperUserId,
    })
    .onConflictDoUpdate({
      target: vendor1099Profile.contactId,
      set: {
        exclusionReason: reason,
        exclusionNote: note?.trim() || null,
        excludedAt: stamp,
        excludedBy: bookkeeperUserId,
        updatedAt: stamp,
      },
    });

  await auditLog(
    tenantId,
    'update',
    'vendor_1099_profile_exclusion',
    contactId,
    null,
    { reason, note: note?.trim() || null },
    bookkeeperUserId,
  );
}

export async function clearExclusion(
  tenantId: string,
  bookkeeperUserId: string,
  contactId: string,
): Promise<void> {
  const profile = await db.query.vendor1099Profile.findFirst({
    where: and(
      eq(vendor1099Profile.tenantId, tenantId),
      eq(vendor1099Profile.contactId, contactId),
    ),
  });
  if (!profile?.exclusionReason) {
    // Nothing to clear — succeed idempotently rather than 404, so
    // the UI doesn't have to track local state for the toggle.
    return;
  }
  await db
    .update(vendor1099Profile)
    .set({
      exclusionReason: null,
      exclusionNote: null,
      excludedAt: null,
      excludedBy: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(vendor1099Profile.tenantId, tenantId),
        eq(vendor1099Profile.contactId, contactId),
      ),
    );

  await auditLog(
    tenantId,
    'update',
    'vendor_1099_profile_exclusion',
    contactId,
    {
      reason: profile.exclusionReason,
      note: profile.exclusionNote,
      excludedAt: profile.excludedAt,
    },
    null,
    bookkeeperUserId,
  );
}

// ── account → (form, box) mapping ───────────────────────────────
//
// Each Chart-of-Accounts expense account associates with at most
// one (form, box). The bookkeeper picks a (form, box) in the 1099
// Center, then checks the accounts that belong under it; the
// service guarantees the "one account in only one box" invariant
// at the DB level (UNIQUE on tenant_id, account_id) and at the
// service level (atomic delete-then-insert during reassignment).
//
// The exporter that consumes this mapping is a follow-up — this
// module is infrastructure-only.

export interface AccountMappingAccount {
  id: string;
  accountNumber: string | null;
  name: string;
}

export interface AccountMappingGroup {
  formBox: FormBox;
  label: string;
  accounts: AccountMappingAccount[];
}

export interface AccountMappingsView {
  mappings: AccountMappingGroup[];
  unmapped: AccountMappingAccount[];
}

export async function listAccountMappings(tenantId: string): Promise<AccountMappingsView> {
  // One LEFT JOIN: every active expense account, with its current
  // mapping (if any). Cheaper than two queries + an in-memory join,
  // and the result naturally shapes both buckets.
  const rows = await db
    .select({
      accountId: accounts.id,
      accountNumber: accounts.accountNumber,
      accountName: accounts.name,
      formBox: vendor1099AccountMappings.formBox,
    })
    .from(accounts)
    .leftJoin(
      vendor1099AccountMappings,
      and(
        eq(vendor1099AccountMappings.accountId, accounts.id),
        eq(vendor1099AccountMappings.tenantId, tenantId),
      ),
    )
    .where(
      and(
        eq(accounts.tenantId, tenantId),
        eq(accounts.accountType, 'expense'),
        eq(accounts.isActive, true),
      ),
    );

  const groupMap = new Map<FormBox, AccountMappingAccount[]>();
  const unmapped: AccountMappingAccount[] = [];
  for (const r of rows) {
    const acct: AccountMappingAccount = {
      id: r.accountId,
      accountNumber: r.accountNumber ?? null,
      name: r.accountName,
    };
    if (r.formBox && isValidFormBox(r.formBox)) {
      const arr = groupMap.get(r.formBox) ?? [];
      arr.push(acct);
      groupMap.set(r.formBox, arr);
    } else {
      unmapped.push(acct);
    }
  }

  // Stable order per group so the UI doesn't shuffle on re-fetch.
  const sortAccounts = (a: AccountMappingAccount, b: AccountMappingAccount) => {
    const an = a.accountNumber ?? '';
    const bn = b.accountNumber ?? '';
    if (an && bn && an !== bn) return an.localeCompare(bn);
    return a.name.localeCompare(b.name);
  };
  unmapped.sort(sortAccounts);
  const mappings: AccountMappingGroup[] = [];
  for (const [formBox, accts] of groupMap) {
    accts.sort(sortAccounts);
    mappings.push({ formBox, label: FORM_BOX_LABELS[formBox], accounts: accts });
  }
  // Sort groups by the label so the UI render order is predictable.
  mappings.sort((a, b) => a.label.localeCompare(b.label));

  return { mappings, unmapped };
}

export async function setAccountMappings(
  tenantId: string,
  bookkeeperUserId: string,
  formBox: FormBox,
  accountIds: string[],
): Promise<void> {
  if (!isValidFormBox(formBox)) throw AppError.badRequest('Unknown form/box');

  // Confirm every requested account belongs to this tenant before
  // we touch any rows — prevents a bad client from inserting a row
  // referencing an account in another tenant via the UNIQUE index
  // back-channel (the FK ON DELETE CASCADE would still fire, but
  // belt-and-suspenders).
  if (accountIds.length > 0) {
    const valid = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(
        and(
          eq(accounts.tenantId, tenantId),
          eq(accounts.accountType, 'expense'),
          inArray(accounts.id, accountIds),
        ),
      );
    if (valid.length !== accountIds.length) {
      throw AppError.badRequest('One or more accounts are not expense accounts in this tenant');
    }
  }

  // Snapshot prior state for the audit trail. Two slices:
  //   • prior bucket per requested account (could be a different
  //     box, or null = newly mapped),
  //   • accounts currently in this box that the new set drops
  //     (so the audit shows their unassignment).
  const prior = await db
    .select({
      accountId: vendor1099AccountMappings.accountId,
      formBox: vendor1099AccountMappings.formBox,
    })
    .from(vendor1099AccountMappings)
    .where(eq(vendor1099AccountMappings.tenantId, tenantId));
  const priorByAccount = new Map(prior.map((p) => [p.accountId, p.formBox]));
  const previouslyInThisBox = prior
    .filter((p) => p.formBox === formBox)
    .map((p) => p.accountId);
  const droppedAccountIds = previouslyInThisBox.filter((id) => !accountIds.includes(id));

  await db.transaction(async (tx) => {
    // 1. Drop any rows for accounts moving INTO this box from
    //    another box, so the unique index doesn't fire on insert.
    if (accountIds.length > 0) {
      await tx
        .delete(vendor1099AccountMappings)
        .where(
          and(
            eq(vendor1099AccountMappings.tenantId, tenantId),
            inArray(vendor1099AccountMappings.accountId, accountIds),
          ),
        );
    }
    // 2. Drop any rows in this box that the new set excludes
    //    (operator unchecked them).
    if (droppedAccountIds.length > 0) {
      await tx
        .delete(vendor1099AccountMappings)
        .where(
          and(
            eq(vendor1099AccountMappings.tenantId, tenantId),
            eq(vendor1099AccountMappings.formBox, formBox),
            inArray(vendor1099AccountMappings.accountId, droppedAccountIds),
          ),
        );
    }
    // 3. Insert the new rows.
    if (accountIds.length > 0) {
      await tx.insert(vendor1099AccountMappings).values(
        accountIds.map((accountId) => ({
          tenantId,
          accountId,
          formBox,
          createdBy: bookkeeperUserId,
        })),
      );
    }
  });

  await auditLog(
    tenantId,
    'update',
    'vendor_1099_account_mapping',
    null,
    {
      formBox,
      previouslyInThisBox,
      // Per-account moves: which box did each requested account
      // come from? null = was unmapped.
      priorAssignments: accountIds.map((id) => ({
        accountId: id,
        priorFormBox: priorByAccount.get(id) ?? null,
      })),
    },
    {
      formBox,
      assignedAccountIds: accountIds,
      droppedAccountIds,
    },
    bookkeeperUserId,
  );
}

export async function clearAccountMapping(
  tenantId: string,
  bookkeeperUserId: string,
  accountId: string,
): Promise<void> {
  const existing = await db.query.vendor1099AccountMappings.findFirst({
    where: and(
      eq(vendor1099AccountMappings.tenantId, tenantId),
      eq(vendor1099AccountMappings.accountId, accountId),
    ),
  });
  if (!existing) return; // idempotent — no-op when nothing to clear

  await db
    .delete(vendor1099AccountMappings)
    .where(
      and(
        eq(vendor1099AccountMappings.tenantId, tenantId),
        eq(vendor1099AccountMappings.accountId, accountId),
      ),
    );

  await auditLog(
    tenantId,
    'update',
    'vendor_1099_account_mapping',
    accountId,
    { formBox: existing.formBox },
    null,
    bookkeeperUserId,
  );
}

// ── 15.1 — W-9 request flow ──────────────────────────────────────

interface MailerHandle {
  send: (to: string, subject: string, html: string, text: string) => Promise<void>;
  isStub: boolean;
}

async function getMailer(): Promise<MailerHandle> {
  const smtp = await getSmtpSettings();
  const from = smtp.smtpFrom || 'noreply@example.com';
  if (!smtp.smtpHost) {
    return {
      isStub: true,
      send: async (to, subject, _html, text) => {
        // eslint-disable-next-line no-console
        console.log(
          JSON.stringify({
            ts: new Date().toISOString(),
            level: 'info',
            component: 'w9-mail-stub',
            event: 'send',
            to,
            subject,
            preview: text.slice(0, 400),
          }),
        );
      },
    };
  }
  const transport = nodemailer.createTransport({
    host: smtp.smtpHost,
    port: smtp.smtpPort,
    secure: smtp.smtpPort === 465,
    auth: smtp.smtpUser ? { user: smtp.smtpUser, pass: smtp.smtpPass } : undefined,
  });
  return {
    isStub: false,
    send: async (to, subject, html, text) => {
      await transport.sendMail({ from, to, subject, html, text });
    },
  };
}

/**
 * Compose the SMS body for a W-9 invite. Targets a single GSM-7
 * segment (160 chars) for short links — the body's fixed overhead
 * is ~50 chars so any link up to ~110 chars stays single-segment.
 * Magic-link tokens are 64 hex chars; with a typical "https://yourfirm.com/w9/<token>"
 * deployment URL (~95 chars) the message comes in around 145.
 *
 * The operator's personal `message` is intentionally NOT appended —
 * the SMS channel is for the link, the email channel is where prose
 * lives.
 */
export function buildW9SmsBody(link: string): string {
  return `W-9 request from your accountant: ${link} (expires in ${W9_REQUEST_TTL_DAYS} days)`;
}

export async function requestW9(args: {
  tenantId: string;
  bookkeeperUserId: string;
  contactId: string;
  email?: string;
  phone?: string;
  message?: string;
  baseUrl: string;
}): Promise<{ requestId: string; channels: Array<'email' | 'sms'> }> {
  const email = args.email?.trim().toLowerCase() || null;
  const phone = args.phone?.trim() || null;
  if (!email && !phone) {
    throw AppError.badRequest('Provide an email address, a phone number, or both');
  }

  const c = await db.query.contacts.findFirst({
    where: and(eq(contacts.tenantId, args.tenantId), eq(contacts.id, args.contactId)),
  });
  if (!c) throw AppError.notFound('Vendor not found');

  const token = generateToken();
  const tokenHash = sha256Hex(token);
  const expiresAt = new Date(Date.now() + W9_REQUEST_TTL_DAYS * 24 * 60 * 60 * 1000);

  const inserted = await db
    .insert(w9Requests)
    .values({
      tenantId: args.tenantId,
      contactId: args.contactId,
      requestedContactEmail: email,
      requestedContactPhone: phone,
      magicLinkTokenHash: tokenHash,
      message: args.message ?? null,
      status: 'sent',
      expiresAt,
      createdBy: args.bookkeeperUserId,
    })
    .returning({ id: w9Requests.id });
  const row = inserted[0];
  if (!row) throw AppError.badRequest('Insert failed');

  const link = `${args.baseUrl.replace(/\/$/, '')}/w9/${encodeURIComponent(token)}`;
  const channels: Array<'email' | 'sms'> = [];
  let viaEmailStub = false;
  let smsResult: { success: boolean; error?: string } | null = null;

  if (email) {
    const text = `Hello,\n\nWe need a Form W-9 from you for IRS reporting. Click the link below to complete it securely. The link is valid for ${W9_REQUEST_TTL_DAYS} days.\n\n${link}\n\n${args.message ?? ''}`;
    const html = `<p>Hello,</p><p>We need a Form W-9 from you for IRS reporting. Click the button below to complete it securely.</p><p><a href="${link}" style="display:inline-block;background:#4f46e5;color:#fff;padding:10px 16px;text-decoration:none;border-radius:6px">Complete W-9</a></p><p style="color:#888;font-size:12px">Link valid for ${W9_REQUEST_TTL_DAYS} days. If you didn't expect this, you can ignore this message.</p>${args.message ? `<hr><p>${args.message}</p>` : ''}`;
    const mailer = await getMailer();
    await mailer.send(email, 'Action requested: Complete your W-9', html, text);
    viaEmailStub = mailer.isStub;
    channels.push('email');
  }

  if (phone) {
    smsResult = await sendW9Sms(phone, buildW9SmsBody(link));
    if (!smsResult.success) {
      // If SMS was the only channel we were asked to use, fail loud.
      // If email also went out, surface a partial-success warning by
      // recording the SMS error in the audit log but returning OK.
      if (!email) {
        throw AppError.badRequest(
          smsResult.error
            ? `SMS delivery failed: ${smsResult.error}`
            : 'SMS delivery failed',
        );
      }
    } else {
      channels.push('sms');
    }
  }

  await auditLog(args.tenantId, 'create', 'w9_request', row.id, null, {
    contactId: args.contactId,
    email,
    phone,
    channels,
    viaEmailStub,
    smsError: smsResult && !smsResult.success ? smsResult.error : undefined,
  }, args.bookkeeperUserId);

  return { requestId: row.id, channels };
}

/**
 * Thin wrapper that resolves the system-wide SMS provider config and
 * sends a single transactional message. Stubs to console.log when no
 * provider is configured so dev environments can exercise the flow
 * without provisioning Twilio credentials.
 */
async function sendW9Sms(
  phone: string,
  body: string,
): Promise<{ success: boolean; error?: string; isStub?: boolean }> {
  try {
    const { getRawConfig } = await import('./tfa-config.service.js');
    const cfg = await getRawConfig();
    if (!cfg.smsProvider) {
      // eslint-disable-next-line no-console
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: 'info',
          component: 'w9-sms-stub',
          event: 'send',
          to: phone,
          preview: body.slice(0, 200),
        }),
      );
      return { success: true, isStub: true };
    }
    const { getSmsProvider } = await import('./sms-providers/index.js');
    const provider = getSmsProvider(cfg);
    const result = await provider.sendText(phone, body);
    return { success: result.success, error: result.error };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : 'SMS dispatch failed',
    };
  }
}

// 15.2 — public form load by token. Returns request metadata
// (no TIN — that's the form input). Marks the request `viewed`.
export async function loadW9ByToken(token: string): Promise<{
  requestId: string;
  contactId: string;
  contactName: string;
  expiresAt: Date;
}> {
  const tokenHash = sha256Hex(token);
  const req = await db.query.w9Requests.findFirst({
    where: eq(w9Requests.magicLinkTokenHash, tokenHash),
  });
  if (!req) throw AppError.notFound('Invalid or expired link');
  if (req.status === 'completed') throw AppError.badRequest('This W-9 has already been submitted', 'COMPLETED');
  if (req.expiresAt.getTime() < Date.now()) {
    await db
      .update(w9Requests)
      .set({ status: 'expired' })
      .where(eq(w9Requests.id, req.id));
    throw AppError.badRequest('This W-9 link has expired', 'EXPIRED');
  }
  if (!req.viewedAt) {
    await db
      .update(w9Requests)
      .set({ viewedAt: new Date(), status: 'viewed' })
      .where(eq(w9Requests.id, req.id));
  }
  const c = await db.query.contacts.findFirst({ where: eq(contacts.id, req.contactId) });
  return {
    requestId: req.id,
    contactId: req.contactId,
    contactName: c?.displayName ?? '',
    expiresAt: req.expiresAt,
  };
}

export interface CompleteW9Input {
  token: string;
  legalName: string;
  businessName?: string;
  taxClassification: string; // sole-prop / corp / etc
  exemptPayeeCode?: string;
  address: { line1: string; city: string; state: string; zip: string };
  tin: string;
  tinType: 'SSN' | 'EIN';
  backupWithholding: boolean;
  signatureName: string;
  consent: boolean;
  ipAddress?: string;
  userAgent?: string;
}

export async function completeW9(input: CompleteW9Input): Promise<{ ok: true }> {
  if (!input.consent) throw AppError.badRequest('You must check the consent box');
  if (!/^\d{9}$/.test(input.tin.replace(/[-\s]/g, ''))) {
    throw AppError.badRequest('TIN must be 9 digits');
  }

  const tokenHash = sha256Hex(input.token);
  const req = await db.query.w9Requests.findFirst({
    where: eq(w9Requests.magicLinkTokenHash, tokenHash),
  });
  if (!req) throw AppError.notFound('Invalid or expired link');
  if (req.status === 'completed') throw AppError.badRequest('Already submitted', 'COMPLETED');
  if (req.expiresAt.getTime() < Date.now()) throw AppError.badRequest('Expired', 'EXPIRED');

  const tinClean = input.tin.replace(/[-\s]/g, '');
  const tinEncrypted = encrypt(tinClean);

  // 15.4 — render the captured W-9 to PDF and persist as an
  // `attachments` row (attachable_type='vendor_1099_profile') so the
  // bookkeeper UI can stream it back via the standard download path.
  // If PDF generation fails we still record the data — the audit log +
  // DB row are the legal record; the PDF is a convenience artifact.
  const signedAt = new Date();
  const tinMasked = `***-**-${tinClean.slice(-4)}`;
  const expiresAt = new Date(signedAt.getTime() + 3 * 365 * 24 * 60 * 60 * 1000);
  let attachmentId: string | null = null;
  try {
    const html = w9HtmlTemplate({
      legalName: input.legalName,
      businessName: input.businessName,
      taxClassification: input.taxClassification,
      exemptPayeeCode: input.exemptPayeeCode,
      address: input.address,
      tinMasked,
      tinType: input.tinType,
      signedAt,
      signatureName: input.signatureName,
      ipAddress: input.ipAddress ?? null,
    });
    const pdfBuf = await htmlToPdf(html);
    const provider = await getProviderForTenant(req.tenantId);
    const storageKey = `w9/${req.tenantId}/${req.contactId}-${signedAt.getTime()}.pdf`;
    const upload = await provider.upload(storageKey, pdfBuf, {
      fileName: 'W-9.pdf',
      mimeType: 'application/pdf',
      sizeBytes: pdfBuf.length,
    });
    const inserted = await db
      .insert(attachments)
      .values({
        tenantId: req.tenantId,
        fileName: `W-9 ${input.legalName}.pdf`.replace(/[\\/:*?"<>|]/g, '_'),
        filePath: `/uploads/${storageKey}`,
        fileSize: pdfBuf.length,
        mimeType: 'application/pdf',
        attachableType: 'vendor_1099_profile',
        attachableId: req.contactId,
        storageKey,
        storageProvider: provider.name,
        providerFileId: upload.providerFileId ?? null,
      })
      .returning({ id: attachments.id });
    attachmentId = inserted[0]?.id ?? null;
  } catch {
    attachmentId = null;
  }

  await db.transaction(async (tx) => {
    await tx
      .insert(vendor1099Profile)
      .values({
        contactId: req.contactId,
        tenantId: req.tenantId,
        w9OnFile: true,
        w9CapturedAt: signedAt,
        // W-9 itself doesn't expire, but TIN match resets and
        // verification-on-file rules typically require revalidation
        // every 3 years.
        w9ExpiresAt: expiresAt,
        w9DocumentId: attachmentId,
        tinEncrypted,
        tinType: input.tinType,
        legalName: input.legalName,
        businessName: input.businessName ?? null,
        addressLine1: input.address.line1,
        addressCity: input.address.city,
        addressState: input.address.state,
        addressZip: input.address.zip,
        // Re-submission resets any prior TIN match — IRS rematches
        // the new TIN/name pair on the next bulk run.
        tinMatchStatus: null,
        tinMatchCode: null,
        tinMatchDate: null,
        backupWithholding: input.backupWithholding,
      })
      .onConflictDoUpdate({
        target: vendor1099Profile.contactId,
        set: {
          w9OnFile: true,
          w9CapturedAt: signedAt,
          w9ExpiresAt: expiresAt,
          w9DocumentId: attachmentId,
          tinEncrypted,
          tinType: input.tinType,
          legalName: input.legalName,
          businessName: input.businessName ?? null,
          addressLine1: input.address.line1,
          addressCity: input.address.city,
          addressState: input.address.state,
          addressZip: input.address.zip,
          tinMatchStatus: null,
          tinMatchCode: null,
          tinMatchDate: null,
          backupWithholding: input.backupWithholding,
          updatedAt: new Date(),
        },
      });

    await tx
      .update(w9Requests)
      .set({ status: 'completed', completedAt: signedAt, w9DocumentId: attachmentId })
      .where(eq(w9Requests.id, req.id));
  });

  await auditLog(req.tenantId, 'create', 'w9_completion', req.contactId, null, {
    requestId: req.id,
    legalName: input.legalName,
    tinType: input.tinType,
    backupWithholding: input.backupWithholding,
    signatureName: input.signatureName,
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
  });

  return { ok: true };
}

// 15.7 — generic CSV exporter. Tax1099 / Track1099 / IRS FIRE all
// use slight variants on the same column set; the generic exporter
// is the lowest common denominator and is acceptable for any one of
// the three at a manual upload step.
export interface ExportInput {
  taxYear: number;
  formType: '1099-NEC' | '1099-MISC';
}

// 15.8 — per-vendor snapshot persisted on each filing so corrections
// reference the exact figures that were filed even if the underlying
// ledger has moved since.
//
// `formBox` is the per-row IRS form-box assignment (e.g. 'NEC-1',
// 'MISC-10'). Null on filings created before the per-box exporter
// rewrite — the correction modal handles that legacy shape by
// surfacing the row without a box badge.
export interface FilingDetailRow {
  contactId: string;
  displayName: string;
  amount: number;
  formBox: FormBox | null;
  tinMasked: string | null;
  tinType: 'SSN' | 'EIN' | null;
  backupWithholding: boolean;
}

export async function exportFiling(
  tenantId: string,
  bookkeeperUserId: string,
  input: ExportInput,
): Promise<{ csv: string; vendorCount: number; totalAmount: number; filingId: string }> {
  // Per-box aggregator: each row is a (vendor, formBox) bucket
  // populated from journal_lines via the account → form_box mapping.
  const byBox = await ytdTotalsByBox(tenantId, input.taxYear);

  // Filter to the requested form. The operator picks "1099-NEC" or
  // "1099-MISC" at export time; we emit every (vendor, formBox) row
  // whose form matches and whose amount clears the box-specific
  // threshold (royalties at $10, everything else at $600).
  const formMatches = byBox.filter(
    (r) => formOf(r.formBox) === input.formType && r.total >= BOX_THRESHOLDS[r.formBox],
  );

  if (formMatches.length === 0) {
    throw AppError.badRequest(
      `No vendor activity above threshold for ${input.formType}. ` +
        'Check that the relevant expense accounts are mapped in the 1099 Account Mapping panel.',
    );
  }

  // Pull the contacts and profiles needed to emit each row.
  const contactIds = [...new Set(formMatches.map((r) => r.contactId))];
  const [vendorRows, profileRows] = await Promise.all([
    db
      .select({
        id: contacts.id,
        displayName: contacts.displayName,
        is1099Eligible: contacts.is1099Eligible,
      })
      .from(contacts)
      .where(and(eq(contacts.tenantId, tenantId), inArray(contacts.id, contactIds))),
    db
      .select()
      .from(vendor1099Profile)
      .where(
        and(
          eq(vendor1099Profile.tenantId, tenantId),
          inArray(vendor1099Profile.contactId, contactIds),
        ),
      ),
  ]);
  const vendorById = new Map(vendorRows.map((v) => [v.id, v]));
  const profileById = new Map(profileRows.map((p) => [p.contactId, p]));

  const lines: string[] = [CSV_HEADER];
  const details: FilingDetailRow[] = [];
  let totalAmount = 0;
  const distinctVendors = new Set<string>();

  // Stable row order — vendor display name, then box code — so
  // re-running the export produces a byte-identical CSV when
  // nothing changed.
  formMatches.sort((a, b) => {
    const av = vendorById.get(a.contactId)?.displayName ?? '';
    const bv = vendorById.get(b.contactId)?.displayName ?? '';
    if (av !== bv) return av.localeCompare(bv);
    return a.formBox.localeCompare(b.formBox);
  });

  for (const r of formMatches) {
    const v = vendorById.get(r.contactId);
    if (!v) continue;
    // Honour the "not subject to 1099" exclusion + the eligibility
    // boolean. Excluded vendors don't make it into the filing even
    // when their account-level postings hit a mapped box.
    const profile = profileById.get(r.contactId);
    if (!v.is1099Eligible) continue;
    if (profile?.exclusionReason) continue;

    const plainTin = profile?.tinEncrypted ? decrypt(profile.tinEncrypted) : '';
    const meta = FORM_1099_BOXES.find((b) => b.value === r.formBox);
    const boxNumber = meta?.box ?? '';
    lines.push(
      buildCsvLine({
        recipientName: v.displayName,
        tin: plainTin,
        tinType: profile?.tinType ?? '',
        amount: r.total,
        formType: input.formType,
        box: boxNumber,
        taxYear: input.taxYear,
        backupWithholding: !!profile?.backupWithholding,
        correctionType: '',
      }),
    );
    details.push({
      contactId: r.contactId,
      displayName: v.displayName,
      amount: r.total,
      formBox: r.formBox,
      tinMasked: plainTin ? maskTin(plainTin) : null,
      tinType: (profile?.tinType as 'SSN' | 'EIN' | null) ?? null,
      backupWithholding: !!profile?.backupWithholding,
    });
    totalAmount += r.total;
    distinctVendors.add(r.contactId);
  }

  if (details.length === 0) {
    throw AppError.badRequest(
      `No 1099-eligible vendors above threshold for ${input.formType} after applying ` +
        'eligibility and exclusion filters.',
    );
  }

  const inserted = await db
    .insert(annual1099Filings)
    .values({
      tenantId,
      taxYear: input.taxYear,
      formType: input.formType,
      exportFormat: 'generic',
      // vendor_count = distinct vendors, not row count: a vendor
      // who lands on both NEC-1 and MISC-10 still counts once.
      vendorCount: distinctVendors.size,
      totalAmount: totalAmount.toFixed(4),
      exportedBy: bookkeeperUserId,
      detailsJson: details,
    })
    .returning({ id: annual1099Filings.id });
  const filing = inserted[0];
  if (!filing) throw AppError.badRequest('Filing record insert failed');

  await auditLog(tenantId, 'create', 'annual_1099_filing', filing.id, null, {
    taxYear: input.taxYear,
    formType: input.formType,
    vendorCount: distinctVendors.size,
    rowCount: details.length,
    totalAmount,
    boxes: [...new Set(details.map((d) => d.formBox))].filter(Boolean),
  }, bookkeeperUserId);

  return {
    csv: lines.join('\n') + '\n',
    vendorCount: distinctVendors.size,
    totalAmount,
    filingId: filing.id,
  };
}

// 15.8 — corrections workflow.
//
// IRS Pub 1220 distinguishes two correction types per detail record:
//   • "C" — Corrected amount: the recipient still gets a 1099 but the
//     dollar figure was wrong. The corrected return is filed with the
//     new amount and box "CORRECTED".
//   • "G" — Voided (zero-out): the recipient should not have been
//     issued a 1099 (e.g. corporation mis-flagged eligible). The
//     correction filing reports $0.00 with box "CORRECTED" so the
//     IRS removes the original from the recipient's record.
//
// Adding *new* vendors that were missed in the original filing is not
// a correction in IRS terms — it's a supplemental original filing.
// That stays out of scope here; bookkeepers re-run the standard
// export with only the missed vendors selected.
export type CorrectionType = 'C' | 'G';

export interface CorrectionAdjustment {
  contactId: string;
  type: CorrectionType;
  // Required when type='C'; ignored (zeroed) when type='G'.
  newAmount?: number;
}

export interface CorrectionInput {
  originalFilingId: string;
  adjustments: CorrectionAdjustment[];
  notes?: string;
}

export async function exportCorrection(
  tenantId: string,
  bookkeeperUserId: string,
  input: CorrectionInput,
): Promise<{ csv: string; vendorCount: number; totalAmount: number; filingId: string }> {
  if (input.adjustments.length === 0) {
    throw AppError.badRequest('At least one adjustment is required');
  }

  const original = await db.query.annual1099Filings.findFirst({
    where: and(
      eq(annual1099Filings.tenantId, tenantId),
      eq(annual1099Filings.id, input.originalFilingId),
    ),
  });
  if (!original) throw AppError.notFound('Original filing not found');
  if (original.correctionOf) {
    throw AppError.badRequest(
      'You cannot file a correction of a correction — amend the original filing instead',
    );
  }

  // Originals filed before 0077 may have null details_json. We can
  // still produce a correction file as long as the operator's
  // adjustments name vendors we can resolve from the contacts table —
  // but the per-row "what was originally filed" context is lost, so
  // we surface that in the audit trail.
  const originalDetails = (original.detailsJson as FilingDetailRow[] | null) ?? null;
  const originalById = new Map<string, FilingDetailRow>();
  if (originalDetails) {
    for (const row of originalDetails) originalById.set(row.contactId, row);
  }

  const adjustmentByContact = new Map<string, CorrectionAdjustment>();
  for (const adj of input.adjustments) {
    if (adjustmentByContact.has(adj.contactId)) {
      throw AppError.badRequest(`Vendor ${adj.contactId} listed twice`);
    }
    if (adj.type === 'C') {
      if (typeof adj.newAmount !== 'number' || !Number.isFinite(adj.newAmount) || adj.newAmount < 0) {
        throw AppError.badRequest('Corrected amount must be a non-negative number');
      }
    }
    adjustmentByContact.set(adj.contactId, adj);
  }

  const contactIds = [...adjustmentByContact.keys()];
  const contactRows = await db
    .select({ id: contacts.id, displayName: contacts.displayName })
    .from(contacts)
    .where(and(eq(contacts.tenantId, tenantId), inArray(contacts.id, contactIds)));
  const contactById = new Map(contactRows.map((c) => [c.id, c]));
  for (const id of contactIds) {
    if (!contactById.has(id)) throw AppError.notFound(`Vendor ${id} not found in this tenant`);
  }

  const profileRows = await db
    .select()
    .from(vendor1099Profile)
    .where(
      and(
        eq(vendor1099Profile.tenantId, tenantId),
        inArray(vendor1099Profile.contactId, contactIds),
      ),
    );
  const profileMap = new Map(profileRows.map((p) => [p.contactId, p]));

  const lines: string[] = [CSV_HEADER];
  const details: FilingDetailRow[] = [];
  let totalAmount = 0;

  for (const adj of input.adjustments) {
    const contact = contactById.get(adj.contactId)!;
    const profile = profileMap.get(adj.contactId);
    const plainTin = profile?.tinEncrypted ? decrypt(profile.tinEncrypted) : '';
    const amount = adj.type === 'G' ? 0 : (adj.newAmount ?? 0);
    // Carry the formBox forward from the original detail row so the
    // correction CSV's box column is identical to the row it amends.
    // Pre-rewrite filings have no per-row formBox — we leave the
    // column blank, which still matches the IRS' "by form, not by
    // box" semantics for those legacy filings.
    const priorRow = originalById.get(adj.contactId);
    const formBox: FormBox | null = priorRow?.formBox ?? null;
    const boxNumber = formBox
      ? FORM_1099_BOXES.find((b) => b.value === formBox)?.box ?? ''
      : '';
    lines.push(
      buildCsvLine({
        recipientName: contact.displayName,
        tin: plainTin,
        tinType: profile?.tinType ?? '',
        amount,
        formType: original.formType,
        box: boxNumber,
        taxYear: original.taxYear,
        backupWithholding: !!profile?.backupWithholding,
        correctionType: adj.type,
      }),
    );
    details.push({
      contactId: contact.id,
      displayName: contact.displayName,
      amount,
      formBox,
      tinMasked: plainTin ? maskTin(plainTin) : null,
      tinType: (profile?.tinType as 'SSN' | 'EIN' | null) ?? null,
      backupWithholding: !!profile?.backupWithholding,
    });
    totalAmount += amount;
  }

  const inserted = await db
    .insert(annual1099Filings)
    .values({
      tenantId,
      taxYear: original.taxYear,
      formType: original.formType,
      exportFormat: 'generic',
      vendorCount: input.adjustments.length,
      totalAmount: totalAmount.toFixed(4),
      exportedBy: bookkeeperUserId,
      correctionOf: original.id,
      detailsJson: details,
      notes: input.notes ?? null,
    })
    .returning({ id: annual1099Filings.id });
  const filing = inserted[0];
  if (!filing) throw AppError.badRequest('Correction filing insert failed');

  await auditLog(tenantId, 'create', 'annual_1099_filing_correction', filing.id, null, {
    originalFilingId: original.id,
    taxYear: original.taxYear,
    formType: original.formType,
    adjustments: input.adjustments.map((a) => {
      const prior = originalById.get(a.contactId);
      return {
        contactId: a.contactId,
        type: a.type,
        priorAmount: prior?.amount ?? null,
        newAmount: a.type === 'G' ? 0 : (a.newAmount ?? 0),
      };
    }),
  }, bookkeeperUserId);

  return {
    csv: lines.join('\n') + '\n',
    vendorCount: input.adjustments.length,
    totalAmount,
    filingId: filing.id,
  };
}

export async function listFilings(tenantId: string) {
  return db
    .select()
    .from(annual1099Filings)
    .where(eq(annual1099Filings.tenantId, tenantId))
    .orderBy(desc(annual1099Filings.exportedAt));
}

// 15.8 — operator-friendly view of a single filing, used by the
// correction modal to drive the adjustment table. Returns the
// snapshot if persisted; null when the filing predates 0077 so the
// UI can prompt the operator to enter vendors manually.
export async function getFilingDetails(
  tenantId: string,
  filingId: string,
): Promise<{
  filing: typeof annual1099Filings.$inferSelect;
  details: FilingDetailRow[] | null;
}> {
  const filing = await db.query.annual1099Filings.findFirst({
    where: and(
      eq(annual1099Filings.tenantId, tenantId),
      eq(annual1099Filings.id, filingId),
    ),
  });
  if (!filing) throw AppError.notFound('Filing not found');
  const details = (filing.detailsJson as FilingDetailRow[] | null) ?? null;
  return { filing, details };
}

// 15.1 — per-vendor W-9 request history. Powers the inline status
// readout in the 1099 Center vendor row and the vendor detail page.
export async function listRequestsForContact(tenantId: string, contactId: string) {
  return db
    .select({
      id: w9Requests.id,
      status: w9Requests.status,
      requestedContactEmail: w9Requests.requestedContactEmail,
      requestedContactPhone: w9Requests.requestedContactPhone,
      sentAt: w9Requests.sentAt,
      viewedAt: w9Requests.viewedAt,
      completedAt: w9Requests.completedAt,
      expiresAt: w9Requests.expiresAt,
    })
    .from(w9Requests)
    .where(and(eq(w9Requests.tenantId, tenantId), eq(w9Requests.contactId, contactId)))
    .orderBy(desc(w9Requests.sentAt));
}

// 15.4 — fetch the captured W-9 PDF for a vendor. Streams via the
// tenant's configured storage provider, falling back to the local
// filesystem path stored on the attachments row. Tenant-scoped on
// purpose: the PDF contains the masked TIN + signature audit trail.
export async function getW9Document(
  tenantId: string,
  contactId: string,
): Promise<{ stream: NodeJS.ReadableStream; fileName: string; mimeType: string }> {
  const profile = await db.query.vendor1099Profile.findFirst({
    where: and(
      eq(vendor1099Profile.tenantId, tenantId),
      eq(vendor1099Profile.contactId, contactId),
    ),
  });
  if (!profile?.w9DocumentId) {
    throw AppError.notFound('No W-9 document on file for this vendor');
  }
  const att = await db.query.attachments.findFirst({
    where: and(eq(attachments.tenantId, tenantId), eq(attachments.id, profile.w9DocumentId)),
  });
  if (!att) throw AppError.notFound('W-9 document not found');

  const provider = await getProviderForTenant(tenantId);
  const key = att.providerFileId || att.storageKey || att.filePath;
  if (!key) throw AppError.notFound('W-9 document storage key missing');
  const data = await provider.download(key);
  const { Readable } = await import('node:stream');
  return {
    stream: Readable.from(data),
    fileName: att.fileName || 'W-9.pdf',
    mimeType: att.mimeType || 'application/pdf',
  };
}

// ── 15.5 — IRS Bulk TIN Matching (Pub 2108A) ────────────────────
//
// Two operator-driven steps, hours apart:
//
//   1. POST /tin-match/export — we generate a pipe-delimited .txt
//      file of every vendor with a TIN on file and mark each row
//      `tin_match_status='pending'`. The operator uploads it to the
//      IRS e-Services portal.
//
//   2. POST /tin-match/import — IRS posts a result file ~24h later;
//      the operator uploads it back into the appliance and we
//      decode the per-row match code into matched / mismatched /
//      error and stamp `tin_match_code`/`tin_match_date`.

export interface TinMatchExportResult {
  fileName: string;
  body: string;
  recordCount: number;
  skipped: Array<{ contactId: string; displayName: string; reason: string }>;
}

export async function exportBulkTinMatch(
  tenantId: string,
  bookkeeperUserId: string,
): Promise<TinMatchExportResult> {
  const profileRows = await db
    .select({
      contactId: vendor1099Profile.contactId,
      tinEncrypted: vendor1099Profile.tinEncrypted,
      tinType: vendor1099Profile.tinType,
      legalName: vendor1099Profile.legalName,
      businessName: vendor1099Profile.businessName,
      displayName: contacts.displayName,
    })
    .from(vendor1099Profile)
    .innerJoin(contacts, eq(contacts.id, vendor1099Profile.contactId))
    .where(
      and(
        eq(vendor1099Profile.tenantId, tenantId),
        sql`${vendor1099Profile.tinEncrypted} IS NOT NULL`,
        eq(contacts.is1099Eligible, true),
        sql`${vendor1099Profile.exclusionReason} IS NULL`,
      ),
    );

  if (profileRows.length === 0) {
    throw AppError.badRequest('No vendors with a TIN on file are 1099-eligible');
  }

  // For EIN matching IRS expects the *business* legal name; for SSN
  // it expects the individual's legal name. We prefer the W-9-captured
  // values; fall back to display_name when the profile pre-dates 0078.
  const exportRows: TinExportRow[] = [];
  const includedContactIds: string[] = [];
  const sourceByContact = new Map<string, { name: string; tinType: 'SSN' | 'EIN' | null }>();
  for (const r of profileRows) {
    const plainTin = r.tinEncrypted ? decrypt(r.tinEncrypted) : '';
    const tinType = (r.tinType as 'SSN' | 'EIN' | null) ?? null;
    const name =
      tinType === 'EIN'
        ? r.businessName || r.legalName || r.displayName
        : r.legalName || r.displayName;
    exportRows.push({
      tinType,
      tin: plainTin,
      name,
      // Use the contact_id as the IRS account-number column so the
      // result file can be correlated back without name/TIN guesswork.
      // UUIDs lose their hyphens after sanitizeAccount() but stay
      // unique within the tenant.
      accountNumber: r.contactId,
    });
    includedContactIds.push(r.contactId);
    sourceByContact.set(r.contactId, { name, tinType });
  }

  const built = buildTinMatchFile(exportRows);

  // Map skipped account_numbers (sanitized contact_id) back to a
  // display-friendly entry for the UI.
  const skipped: Array<{ contactId: string; displayName: string; reason: string }> = [];
  for (const s of built.skipped) {
    const matchedRow = profileRows.find(
      (r) => r.contactId.replace(/[^A-Za-z0-9-]/g, '').toUpperCase().slice(0, 20) === s.accountNumber,
    );
    skipped.push({
      contactId: matchedRow?.contactId ?? s.accountNumber,
      displayName: matchedRow?.displayName ?? '(unknown)',
      reason: s.reason,
    });
  }

  // Mark each successfully-included vendor as pending.
  const skippedContactIds = new Set(skipped.map((s) => s.contactId));
  const submittedIds = includedContactIds.filter((id) => !skippedContactIds.has(id));
  if (submittedIds.length > 0) {
    await db
      .update(vendor1099Profile)
      .set({ tinMatchStatus: 'pending', updatedAt: new Date() })
      .where(
        and(
          eq(vendor1099Profile.tenantId, tenantId),
          inArray(vendor1099Profile.contactId, submittedIds),
        ),
      );
  }

  await auditLog(tenantId, 'create', 'tin_match_export', null, null, {
    recordCount: built.recordCount,
    skippedCount: skipped.length,
  }, bookkeeperUserId);

  const fileName = `bulk-tin-match-${new Date().toISOString().slice(0, 10)}.txt`;
  return { fileName, body: built.body, recordCount: built.recordCount, skipped };
}

export interface TinMatchImportResult {
  matched: number;
  mismatched: number;
  errors: number;
  unknownAccount: number;
  malformedLineNumbers: number[];
}

export async function importBulkTinMatchResults(
  tenantId: string,
  bookkeeperUserId: string,
  fileContent: string,
): Promise<TinMatchImportResult> {
  const parsed = parseTinMatchResult(fileContent);
  let matched = 0;
  let mismatched = 0;
  let errors = 0;
  let unknownAccount = 0;
  const stamp = new Date();

  // Pre-load every profile in this tenant so we can correlate the
  // sanitized account_number back to a contact_id without one DB
  // round-trip per result row.
  const allProfiles = await db
    .select({ contactId: vendor1099Profile.contactId })
    .from(vendor1099Profile)
    .where(eq(vendor1099Profile.tenantId, tenantId));
  const idByAccount = new Map<string, string>();
  for (const p of allProfiles) {
    const account = p.contactId.replace(/[^A-Za-z0-9-]/g, '').toUpperCase().slice(0, 20);
    idByAccount.set(account, p.contactId);
  }

  for (const row of parsed.rows) {
    const contactId = idByAccount.get(row.accountNumber);
    if (!contactId) {
      unknownAccount++;
      continue;
    }
    const decoded = decodeMatchCode(row.matchCode);
    if (decoded.status === 'matched') matched++;
    else if (decoded.status === 'mismatched') mismatched++;
    else errors++;

    await db
      .update(vendor1099Profile)
      .set({
        tinMatchStatus: decoded.status,
        tinMatchCode: row.matchCode,
        tinMatchDate: stamp,
        updatedAt: stamp,
      })
      .where(
        and(
          eq(vendor1099Profile.tenantId, tenantId),
          eq(vendor1099Profile.contactId, contactId),
        ),
      );
  }

  await auditLog(tenantId, 'update', 'tin_match_import', null, null, {
    matched,
    mismatched,
    errors,
    unknownAccount,
    malformedLineCount: parsed.malformedLineNumbers.length,
  }, bookkeeperUserId);

  return { matched, mismatched, errors, unknownAccount, malformedLineNumbers: parsed.malformedLineNumbers };
}
