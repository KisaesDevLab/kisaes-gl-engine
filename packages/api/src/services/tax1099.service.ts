// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// Tax1099.com e-filing submission service. Bridges the tenant-scoped
// 1099 Center to the FIRM-scoped integration credentials:
//   - credentials live on the tenant's managing firm (firm_integrations,
//     configured by a firm admin in Firm Settings)
//   - submission is allowed only for super-admins, the firm's
//     firm_admins, or users with the tenant 'accountant' role
// The vendor/amount assembly mirrors portal-1099.exportFiling exactly
// (same thresholds, eligibility, exclusions, account→box mapping) so a
// CSV export and an API submission of the same year always agree.

import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { contacts, companies, annual1099Filings, firms } from '../db/schema/index.js';
import { vendor1099Profile } from '../db/schema/portal-1099.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import { decrypt } from '../utils/encryption.js';
import { ytdTotalsByBox } from './portal-1099.service.js';
import { BOX_THRESHOLDS, formOf, FORM_1099_BOXES, type FormBox } from './portal-1099.boxes.js';
import { getActiveForTenant } from './tenant-firm-assignment.service.js';
import * as firmUsersService from './firm-users.service.js';
import * as firmIntegrations from './firm-integrations.service.js';
import * as tax1099Client from './tax1099-client.js';
import { maskTin } from './portal-1099.csv.js';

export interface SubmitterContext {
  userId: string;
  userRole: string | undefined;
  isSuperAdmin: boolean;
}

/**
 * Who may SUBMIT filings: super-admin, the managing firm's firm_admin,
 * or a tenant 'accountant'. (Per spec: "only submitted by either the
 * admin or an accountant" — bookkeeper/readonly/owner see the Center
 * but cannot e-file.)
 */
export async function canSubmit(tenantId: string, ctx: SubmitterContext): Promise<{ allowed: boolean; firmId: string | null }> {
  const assignment = await getActiveForTenant(tenantId);
  const firmId = assignment?.firmId ?? null;
  if (ctx.isSuperAdmin) return { allowed: true, firmId };
  if (ctx.userRole === 'accountant') return { allowed: true, firmId };
  if (firmId) {
    const role = await firmUsersService.getRoleForUser(firmId, ctx.userId);
    if (role === 'firm_admin') return { allowed: true, firmId };
  }
  return { allowed: false, firmId };
}

/** Context the 1099 Center UI uses to render/gate the e-file panel. */
export async function getEfileContext(tenantId: string, ctx: SubmitterContext) {
  const { allowed, firmId } = await canSubmit(tenantId, ctx);
  if (!firmId) {
    return { available: false, reason: 'This company is not managed by a firm.', canSubmit: false, isEnabled: false, environment: null as string | null, firmName: null as string | null };
  }
  const [settings, [firm]] = await Promise.all([
    firmIntegrations.getTax1099Settings(firmId),
    db.select({ name: firms.name }).from(firms).where(eq(firms.id, firmId)).limit(1),
  ]);
  const configured = settings.hasApiKey && settings.hasUsername && settings.hasPassword;
  return {
    available: true,
    reason: settings.isEnabled && configured ? null
      : 'Tax1099 e-filing is not configured. A firm admin can set it up under Firm → Settings.',
    canSubmit: allowed && settings.isEnabled && configured,
    isEnabled: settings.isEnabled && configured,
    environment: settings.environment,
    firmName: firm?.name ?? null,
  };
}

export interface SubmitFilingInput {
  taxYear: number;
  formType: '1099-NEC' | '1099-MISC';
}

/**
 * Submit the year's above-threshold, eligible, non-excluded vendors to
 * Tax1099 and record the filing (export_format 'tax1099') with the
 * provider's submission reference.
 */
export async function submitFilings(tenantId: string, ctx: SubmitterContext, input: SubmitFilingInput) {
  const { allowed, firmId } = await canSubmit(tenantId, ctx);
  if (!allowed) {
    throw AppError.forbidden('Only a firm admin or an accountant can submit 1099 e-filings', 'TAX1099_SUBMIT_FORBIDDEN');
  }
  if (!firmId) {
    throw AppError.badRequest('This company is not managed by a firm — Tax1099 e-filing settings live at the firm level.', 'TAX1099_NO_FIRM');
  }
  const creds = await firmIntegrations.getTax1099Credentials(firmId);

  // ── Payer block from the tenant's company profile ──
  const [company] = await db.select().from(companies)
    .where(eq(companies.tenantId, tenantId)).orderBy(companies.createdAt).limit(1);
  if (!company) throw AppError.badRequest('No company profile found for this tenant');
  const missingPayer: string[] = [];
  if (!company.ein) missingPayer.push('EIN');
  if (!company.addressLine1) missingPayer.push('address');
  if (!company.city) missingPayer.push('city');
  if (!company.state) missingPayer.push('state');
  if (!company.zip) missingPayer.push('ZIP');
  if (missingPayer.length > 0) {
    throw AppError.badRequest(`Company profile is missing payer fields required for e-filing: ${missingPayer.join(', ')}. Update it in Settings → Company.`, 'TAX1099_PAYER_INCOMPLETE');
  }
  const payer: tax1099Client.Tax1099Payer = {
    businessName: company.legalName || company.businessName,
    ein: company.ein!,
    addressLine1: company.addressLine1!,
    city: company.city!,
    state: company.state!,
    zip: company.zip!,
    phone: company.phone || undefined,
    email: company.email || undefined,
  };

  // ── Vendor set — identical filters to exportFiling ──
  const byBox = await ytdTotalsByBox(tenantId, input.taxYear);
  const formMatches = byBox.filter(
    (r) => formOf(r.formBox as FormBox) === input.formType && r.total >= BOX_THRESHOLDS[r.formBox as FormBox],
  );
  if (formMatches.length === 0) {
    throw AppError.badRequest(`No vendor activity above threshold for ${input.formType}. Check the 1099 Account Mapping panel.`);
  }
  const contactIds = [...new Set(formMatches.map((r) => r.contactId))];
  const [vendorRows, profileRows] = await Promise.all([
    db.select().from(contacts).where(and(eq(contacts.tenantId, tenantId), inArray(contacts.id, contactIds))),
    db.select().from(vendor1099Profile).where(and(eq(vendor1099Profile.tenantId, tenantId), inArray(vendor1099Profile.contactId, contactIds))),
  ]);
  const vendorById = new Map(vendorRows.map((v) => [v.id, v]));
  const profileById = new Map(profileRows.map((p) => [p.contactId, p]));

  // Group boxes per vendor.
  const boxesByVendor = new Map<string, Record<string, number>>();
  for (const r of formMatches) {
    const meta = FORM_1099_BOXES.find((b) => b.value === r.formBox);
    if (!meta) continue;
    const boxes = boxesByVendor.get(r.contactId) ?? {};
    boxes[String(meta.box)] = (boxes[String(meta.box)] ?? 0) + r.total;
    boxesByVendor.set(r.contactId, boxes);
  }

  const recipients: tax1099Client.Tax1099Recipient[] = [];
  const details: Array<Record<string, unknown>> = [];
  const problems: string[] = [];
  let totalAmount = 0;

  for (const [contactId, boxes] of boxesByVendor) {
    const v = vendorById.get(contactId);
    if (!v || !v.is1099Eligible) continue;
    const profile = profileById.get(contactId);
    if (profile?.exclusionReason) continue;

    const name = profile?.legalName || profile?.businessName || v.displayName;
    const tin = profile?.tinEncrypted ? decrypt(profile.tinEncrypted) : (v.taxId || '');
    const addressLine1 = profile?.addressLine1 || v.billingLine1 || '';
    const city = profile?.addressCity || v.billingCity || '';
    const state = profile?.addressState || v.billingState || '';
    const zip = profile?.addressZip || v.billingZip || '';

    const missing: string[] = [];
    if (!tin) missing.push('TIN');
    if (!addressLine1 || !city || !state || !zip) missing.push('address');
    if (missing.length > 0) {
      problems.push(`${v.displayName}: missing ${missing.join(' + ')}`);
      continue;
    }

    const amount = Object.values(boxes).reduce((s, n) => s + n, 0);
    totalAmount += amount;
    recipients.push({
      name, tin,
      tinType: (profile?.tinType as 'SSN' | 'EIN') ?? '',
      addressLine1, city, state, zip,
      email: v.email || undefined,
      boxes,
      backupWithholding: !!profile?.backupWithholding,
    });
    details.push({
      contactId, displayName: v.displayName, amount,
      boxes, tinMasked: maskTin(tin),
      tinType: profile?.tinType ?? null,
      backupWithholding: !!profile?.backupWithholding,
    });
  }

  if (recipients.length === 0) {
    throw AppError.badRequest(
      problems.length > 0
        ? `No submittable vendors — every candidate has gaps: ${problems.join('; ')}`
        : `No 1099-eligible vendors above threshold for ${input.formType}.`,
      'TAX1099_NO_RECIPIENTS',
    );
  }

  // ── Submit ──
  const session = await tax1099Client.createSession(creds);
  const result = await tax1099Client.submitForms(session, {
    taxYear: input.taxYear, formType: input.formType, payer, recipients,
  });

  // ── Record the filing (snapshot carries MASKED TINs only) ──
  const [filing] = await db.insert(annual1099Filings).values({
    tenantId,
    taxYear: input.taxYear,
    formType: input.formType,
    exportFormat: 'tax1099',
    vendorCount: recipients.length,
    totalAmount: totalAmount.toFixed(4),
    exportedBy: ctx.userId,
    detailsJson: details,
    submissionStatus: 'submitted',
    providerReference: result.referenceId,
    submittedAt: new Date(),
    statusMessage: problems.length > 0 ? `Skipped (incomplete): ${problems.join('; ')}` : null,
    firmId,
  }).returning();

  await auditLog(tenantId, 'create', 'tax1099_submission', filing!.id, null, {
    taxYear: input.taxYear, formType: input.formType,
    vendorCount: recipients.length, totalAmount: totalAmount.toFixed(2),
    providerReference: result.referenceId, environment: creds.environment,
    skipped: problems,
  }, ctx.userId);

  return {
    filingId: filing!.id,
    providerReference: result.referenceId,
    vendorCount: recipients.length,
    totalAmount,
    skipped: problems,
    environment: creds.environment,
  };
}

/** Re-poll the provider for a submission's current status. */
export async function refreshFilingStatus(tenantId: string, filingId: string) {
  const [filing] = await db.select().from(annual1099Filings)
    .where(and(eq(annual1099Filings.tenantId, tenantId), eq(annual1099Filings.id, filingId)))
    .limit(1);
  if (!filing) throw AppError.notFound('Filing not found');
  if (!filing.providerReference || !filing.firmId) {
    throw AppError.badRequest('This filing was not submitted via Tax1099');
  }
  const creds = await firmIntegrations.getTax1099Credentials(filing.firmId);
  const session = await tax1099Client.createSession(creds);
  const status = await tax1099Client.checkStatus(session, filing.providerReference);
  const mapped = ['accepted', 'rejected', 'submitted', 'processing', 'error'].includes(status.status)
    ? status.status : 'submitted';
  await db.update(annual1099Filings).set({
    submissionStatus: mapped,
    statusMessage: status.message,
  }).where(and(eq(annual1099Filings.tenantId, tenantId), eq(annual1099Filings.id, filingId)));
  return { status: mapped, message: status.message };
}

/** Test the firm's stored credentials by opening (and discarding) a session. */
export async function testConnection(firmId: string) {
  const creds = await firmIntegrations.getTax1099Credentials(firmId);
  await tax1099Client.createSession(creds);
  return { ok: true, environment: creds.environment };
}
