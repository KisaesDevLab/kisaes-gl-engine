// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  portalContacts,
  portalContactCompanies,
  portalSettingsPerPractice,
  portalSettingsPerCompany,
  companies,
} from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';

// VIBE_MYBOOKS_PRACTICE_BUILD_PLAN Phase 8 — bookkeeper-side
// portal-contact CRUD + per-company portal settings. The portal
// itself (magic-link, sessions, dashboard) ships in Phase 9.

export interface PortalContactCompanyAssignment {
  companyId: string;
  role?: string;
  assignable?: boolean;
  financialsAccess?: boolean;
  filesAccess?: boolean;
  questionsForUsAccess?: boolean;
}

export interface CreatePortalContactInput {
  email: string;
  phone?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  companies: PortalContactCompanyAssignment[];
}

export interface UpdatePortalContactInput {
  email?: string;
  phone?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  status?: 'active' | 'paused';
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function ensureCompaniesBelongToTenant(tenantId: string, companyIds: string[]): Promise<void> {
  if (companyIds.length === 0) return;
  const rows = await db
    .select({ id: companies.id })
    .from(companies)
    .where(and(eq(companies.tenantId, tenantId), inArray(companies.id, companyIds)));
  if (rows.length !== companyIds.length) {
    throw AppError.badRequest('One or more companies do not belong to this tenant', 'COMPANY_SCOPE');
  }
}

export async function listContacts(
  tenantId: string,
  opts: { status?: 'active' | 'paused' | 'deleted' | 'all'; companyId?: string } = {},
): Promise<Array<{
  id: string;
  email: string;
  phone: string | null;
  firstName: string | null;
  lastName: string | null;
  status: string;
  lastSeenAt: Date | null;
  createdAt: Date;
  companyCount: number;
}>> {
  const status = opts.status ?? 'active';

  const filters: ReturnType<typeof eq>[] = [eq(portalContacts.tenantId, tenantId)];
  if (status !== 'all') filters.push(eq(portalContacts.status, status));

  // Optional filter to "contacts assigned to this company" — implemented
  // as an EXISTS on the join table. Done as inArray() of pre-fetched
  // contact ids to avoid a noisy join in the main projection.
  let allowedContactIds: string[] | null = null;
  if (opts.companyId) {
    const linkRows = await db
      .select({ contactId: portalContactCompanies.contactId })
      .from(portalContactCompanies)
      .where(eq(portalContactCompanies.companyId, opts.companyId));
    allowedContactIds = linkRows.map((r) => r.contactId);
    if (allowedContactIds.length === 0) return [];
    filters.push(inArray(portalContacts.id, allowedContactIds));
  }

  const rows = await db
    .select({
      id: portalContacts.id,
      email: portalContacts.email,
      phone: portalContacts.phone,
      firstName: portalContacts.firstName,
      lastName: portalContacts.lastName,
      status: portalContacts.status,
      lastSeenAt: portalContacts.lastSeenAt,
      createdAt: portalContacts.createdAt,
    })
    .from(portalContacts)
    .where(and(...filters))
    .orderBy(desc(portalContacts.createdAt));

  if (rows.length === 0) return [];

  const counts = await db
    .select({
      contactId: portalContactCompanies.contactId,
      n: sql<number>`COUNT(*)::int`,
    })
    .from(portalContactCompanies)
    .where(inArray(portalContactCompanies.contactId, rows.map((r) => r.id)))
    .groupBy(portalContactCompanies.contactId);

  const countMap = new Map(counts.map((c) => [c.contactId, Number(c.n)]));
  return rows.map((r) => ({ ...r, companyCount: countMap.get(r.id) ?? 0 }));
}

export async function getContact(
  tenantId: string,
  contactId: string,
): Promise<{
  id: string;
  email: string;
  phone: string | null;
  firstName: string | null;
  lastName: string | null;
  status: string;
  lastSeenAt: Date | null;
  createdAt: Date;
  companies: Array<{
    companyId: string;
    companyName: string;
    role: string;
    assignable: boolean;
    financialsAccess: boolean;
    filesAccess: boolean;
    questionsForUsAccess: boolean;
  }>;
}> {
  const contact = await db.query.portalContacts.findFirst({
    where: and(eq(portalContacts.tenantId, tenantId), eq(portalContacts.id, contactId)),
  });
  if (!contact) throw AppError.notFound('Portal contact not found');

  const links = await db
    .select({
      companyId: portalContactCompanies.companyId,
      companyName: companies.businessName,
      role: portalContactCompanies.role,
      assignable: portalContactCompanies.assignable,
      financialsAccess: portalContactCompanies.financialsAccess,
      filesAccess: portalContactCompanies.filesAccess,
      questionsForUsAccess: portalContactCompanies.questionsForUsAccess,
    })
    .from(portalContactCompanies)
    .innerJoin(companies, eq(portalContactCompanies.companyId, companies.id))
    .where(and(eq(portalContactCompanies.contactId, contactId), eq(companies.tenantId, tenantId)));

  return {
    id: contact.id,
    email: contact.email,
    phone: contact.phone,
    firstName: contact.firstName,
    lastName: contact.lastName,
    status: contact.status,
    lastSeenAt: contact.lastSeenAt,
    createdAt: contact.createdAt,
    companies: links,
  };
}

export async function createContact(
  tenantId: string,
  input: CreatePortalContactInput,
  actorUserId?: string,
): Promise<{ id: string }> {
  if (!input.email || !input.email.includes('@')) {
    throw AppError.badRequest('Email is required', 'EMAIL_REQUIRED');
  }
  if (!input.companies || input.companies.length === 0) {
    throw AppError.badRequest('Contact must be linked to at least one company', 'COMPANIES_REQUIRED');
  }

  const email = normalizeEmail(input.email);
  const companyIds = input.companies.map((c) => c.companyId);
  await ensureCompaniesBelongToTenant(tenantId, companyIds);

  // Duplicate-detection per 8.5: surface the existing contact id so the
  // UI can offer "link to existing" instead of erroring.
  const existing = await db.query.portalContacts.findFirst({
    where: and(eq(portalContacts.tenantId, tenantId), eq(portalContacts.email, email)),
  });
  if (existing) {
    throw AppError.conflict(
      'A portal contact with this email already exists',
      'DUPLICATE_EMAIL',
      { contactId: existing.id, status: existing.status },
    );
  }

  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(portalContacts)
      .values({
        tenantId,
        email,
        phone: input.phone ?? null,
        firstName: input.firstName ?? null,
        lastName: input.lastName ?? null,
        status: 'active',
      })
      .returning({ id: portalContacts.id });

    const row = inserted[0];
    if (!row) throw AppError.badRequest('Insert failed', 'INSERT_FAILED');

    await tx.insert(portalContactCompanies).values(
      input.companies.map((c) => ({
        contactId: row.id,
        companyId: c.companyId,
        role: c.role ?? 'staff',
        assignable: c.assignable ?? true,
        financialsAccess: c.financialsAccess ?? false,
        filesAccess: c.filesAccess ?? true,
        questionsForUsAccess: c.questionsForUsAccess ?? true,
      })),
    );

    await auditLog(tenantId, 'create', 'portal_contact', row.id, null, { email, companies: companyIds }, actorUserId);
    return { id: row.id };
  });
}

export async function updateContact(
  tenantId: string,
  contactId: string,
  input: UpdatePortalContactInput,
  actorUserId?: string,
): Promise<void> {
  const before = await db.query.portalContacts.findFirst({
    where: and(eq(portalContacts.tenantId, tenantId), eq(portalContacts.id, contactId)),
  });
  if (!before) throw AppError.notFound('Portal contact not found');

  const patch: {
    email?: string;
    phone?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    status?: 'active' | 'paused';
    updatedAt: Date;
  } = { updatedAt: new Date() };
  if (input.email !== undefined) {
    const newEmail = normalizeEmail(input.email);
    if (newEmail !== before.email) {
      const dup = await db.query.portalContacts.findFirst({
        where: and(eq(portalContacts.tenantId, tenantId), eq(portalContacts.email, newEmail)),
      });
      if (dup) throw AppError.conflict('A portal contact with this email already exists', 'DUPLICATE_EMAIL');
      patch.email = newEmail;
    }
  }
  if (input.phone !== undefined) patch.phone = input.phone;
  if (input.firstName !== undefined) patch.firstName = input.firstName;
  if (input.lastName !== undefined) patch.lastName = input.lastName;
  if (input.status !== undefined) patch.status = input.status;

  await db
    .update(portalContacts)
    .set(patch)
    .where(and(eq(portalContacts.tenantId, tenantId), eq(portalContacts.id, contactId)));

  await auditLog(tenantId, 'update', 'portal_contact', contactId, before, { ...before, ...patch }, actorUserId);
}

export async function softDeleteContact(
  tenantId: string,
  contactId: string,
  actorUserId?: string,
): Promise<void> {
  const before = await db.query.portalContacts.findFirst({
    where: and(eq(portalContacts.tenantId, tenantId), eq(portalContacts.id, contactId)),
  });
  if (!before) throw AppError.notFound('Portal contact not found');

  await db
    .update(portalContacts)
    .set({ status: 'deleted', updatedAt: new Date() })
    .where(and(eq(portalContacts.tenantId, tenantId), eq(portalContacts.id, contactId)));

  await auditLog(tenantId, 'delete', 'portal_contact', contactId, before, { ...before, status: 'deleted' }, actorUserId);
}

export async function setCompanyAssignments(
  tenantId: string,
  contactId: string,
  assignments: PortalContactCompanyAssignment[],
  actorUserId?: string,
): Promise<void> {
  const before = await db.query.portalContacts.findFirst({
    where: and(eq(portalContacts.tenantId, tenantId), eq(portalContacts.id, contactId)),
  });
  if (!before) throw AppError.notFound('Portal contact not found');

  const companyIds = assignments.map((a) => a.companyId);
  await ensureCompaniesBelongToTenant(tenantId, companyIds);

  await db.transaction(async (tx) => {
    await tx.delete(portalContactCompanies).where(eq(portalContactCompanies.contactId, contactId));
    if (assignments.length > 0) {
      await tx.insert(portalContactCompanies).values(
        assignments.map((a) => ({
          contactId,
          companyId: a.companyId,
          role: a.role ?? 'staff',
          assignable: a.assignable ?? true,
          financialsAccess: a.financialsAccess ?? false,
          filesAccess: a.filesAccess ?? true,
          questionsForUsAccess: a.questionsForUsAccess ?? true,
        })),
      );
    }
  });

  await auditLog(tenantId, 'update', 'portal_contact_companies', contactId, null, { companies: assignments }, actorUserId);
}

// Phase 8.2 — CSV bulk import. Each row: email,phone,first,last,companies(';' delimited UUIDs),role
export interface CsvImportRow {
  email: string;
  phone?: string;
  firstName?: string;
  lastName?: string;
  companyIds: string[];
  role?: string;
}

export interface CsvImportResult {
  inserted: number;
  skipped: Array<{ email: string; reason: string }>;
  linked: number;
}

export async function bulkImport(
  tenantId: string,
  rows: CsvImportRow[],
  actorUserId?: string,
): Promise<CsvImportResult> {
  let inserted = 0;
  let linked = 0;
  const skipped: CsvImportResult['skipped'] = [];

  // Validate every company up-front so a bad row doesn't half-finish.
  const allCompanyIds = Array.from(new Set(rows.flatMap((r) => r.companyIds)));
  await ensureCompaniesBelongToTenant(tenantId, allCompanyIds);

  for (const row of rows) {
    if (!row.email || !row.email.includes('@')) {
      skipped.push({ email: row.email ?? '', reason: 'invalid email' });
      continue;
    }
    const email = normalizeEmail(row.email);

    const existing = await db.query.portalContacts.findFirst({
      where: and(eq(portalContacts.tenantId, tenantId), eq(portalContacts.email, email)),
    });

    if (existing) {
      // Link to additional companies; do not overwrite existing fields.
      for (const companyId of row.companyIds) {
        await db
          .insert(portalContactCompanies)
          .values({
            contactId: existing.id,
            companyId,
            role: row.role ?? 'staff',
          })
          .onConflictDoNothing();
        linked++;
      }
      skipped.push({ email, reason: 'already exists; companies linked' });
      continue;
    }

    await db.transaction(async (tx) => {
      const insertedRows = await tx
        .insert(portalContacts)
        .values({
          tenantId,
          email,
          phone: row.phone ?? null,
          firstName: row.firstName ?? null,
          lastName: row.lastName ?? null,
          status: 'active',
        })
        .returning({ id: portalContacts.id });

      const created = insertedRows[0];
      if (!created) throw AppError.badRequest('Insert failed', 'INSERT_FAILED');

      if (row.companyIds.length > 0) {
        await tx.insert(portalContactCompanies).values(
          row.companyIds.map((companyId) => ({
            contactId: created.id,
            companyId,
            role: row.role ?? 'staff',
          })),
        );
      }
    });
    inserted++;
  }

  await auditLog(tenantId, 'create', 'portal_contact_bulk', 'bulk', null, { inserted, linked, skipped: skipped.length }, actorUserId);
  return { inserted, linked, skipped };
}

// ── Per-practice & per-company portal settings (8.3) ──────────────

export interface PracticePortalSettings {
  remindersEnabled: boolean;
  reminderCadenceDays: number[];
  openTrackingEnabled: boolean;
  assignableQuestionsEnabled: boolean;
  customDomain: string | null;
  brandingLogoUrl: string | null;
  brandingPrimaryColor: string | null;
  announcementText: string | null;
  announcementEnabled: boolean;
  previewEnabled: boolean;
  previewAllowedRoles: string[];
}

const PRACTICE_DEFAULTS: PracticePortalSettings = {
  remindersEnabled: true,
  reminderCadenceDays: [3, 7, 14],
  openTrackingEnabled: true,
  assignableQuestionsEnabled: true,
  customDomain: null,
  brandingLogoUrl: null,
  brandingPrimaryColor: null,
  announcementText: null,
  announcementEnabled: false,
  previewEnabled: true,
  previewAllowedRoles: ['owner', 'bookkeeper', 'accountant'],
};

export async function getPracticeSettings(tenantId: string): Promise<PracticePortalSettings> {
  const row = await db.query.portalSettingsPerPractice.findFirst({
    where: eq(portalSettingsPerPractice.tenantId, tenantId),
  });
  if (!row) return PRACTICE_DEFAULTS;
  return {
    remindersEnabled: row.remindersEnabled,
    reminderCadenceDays: Array.isArray(row.reminderCadenceDays)
      ? (row.reminderCadenceDays as number[])
      : PRACTICE_DEFAULTS.reminderCadenceDays,
    openTrackingEnabled: row.openTrackingEnabled,
    assignableQuestionsEnabled: row.assignableQuestionsEnabled,
    customDomain: row.customDomain,
    brandingLogoUrl: row.brandingLogoUrl,
    brandingPrimaryColor: row.brandingPrimaryColor,
    announcementText: row.announcementText,
    announcementEnabled: row.announcementEnabled,
    previewEnabled: row.previewEnabled,
    previewAllowedRoles: row.previewAllowedRoles
      ? row.previewAllowedRoles.split(',').map((s) => s.trim()).filter(Boolean)
      : PRACTICE_DEFAULTS.previewAllowedRoles,
  };
}

export async function updatePracticeSettings(
  tenantId: string,
  patch: Partial<PracticePortalSettings>,
  actorUserId?: string,
): Promise<PracticePortalSettings> {
  const before = await getPracticeSettings(tenantId);
  const next: PracticePortalSettings = { ...before, ...patch };

  await db
    .insert(portalSettingsPerPractice)
    .values({
      tenantId,
      remindersEnabled: next.remindersEnabled,
      reminderCadenceDays: next.reminderCadenceDays,
      openTrackingEnabled: next.openTrackingEnabled,
      assignableQuestionsEnabled: next.assignableQuestionsEnabled,
      customDomain: next.customDomain,
      brandingLogoUrl: next.brandingLogoUrl,
      brandingPrimaryColor: next.brandingPrimaryColor,
      announcementText: next.announcementText,
      announcementEnabled: next.announcementEnabled,
      previewEnabled: next.previewEnabled,
      previewAllowedRoles: next.previewAllowedRoles.join(','),
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: portalSettingsPerPractice.tenantId,
      set: {
        remindersEnabled: next.remindersEnabled,
        reminderCadenceDays: next.reminderCadenceDays,
        openTrackingEnabled: next.openTrackingEnabled,
        assignableQuestionsEnabled: next.assignableQuestionsEnabled,
        customDomain: next.customDomain,
        brandingLogoUrl: next.brandingLogoUrl,
        brandingPrimaryColor: next.brandingPrimaryColor,
        announcementText: next.announcementText,
        announcementEnabled: next.announcementEnabled,
        previewEnabled: next.previewEnabled,
        previewAllowedRoles: next.previewAllowedRoles.join(','),
        updatedAt: new Date(),
      },
    });

  await auditLog(tenantId, 'update', 'portal_settings_per_practice', tenantId, before, next, actorUserId);
  return next;
}

export interface CompanyPortalSettings {
  remindersEnabled: boolean | null;
  reminderCadenceDays: number[] | null;
  assignableQuestionsEnabled: boolean | null;
  financialsAccessDefault: boolean | null;
  filesAccessDefault: boolean | null;
  previewRequireReauth: boolean;
  paused: boolean;
}

const COMPANY_DEFAULTS: CompanyPortalSettings = {
  remindersEnabled: null,
  reminderCadenceDays: null,
  assignableQuestionsEnabled: null,
  financialsAccessDefault: null,
  filesAccessDefault: null,
  previewRequireReauth: false,
  paused: false,
};

export async function getCompanySettings(tenantId: string, companyId: string): Promise<CompanyPortalSettings> {
  // Verify company belongs to tenant.
  const co = await db.query.companies.findFirst({
    where: and(eq(companies.tenantId, tenantId), eq(companies.id, companyId)),
  });
  if (!co) throw AppError.notFound('Company not found');

  const row = await db.query.portalSettingsPerCompany.findFirst({
    where: eq(portalSettingsPerCompany.companyId, companyId),
  });
  if (!row) return COMPANY_DEFAULTS;
  return {
    remindersEnabled: row.remindersEnabled,
    reminderCadenceDays: Array.isArray(row.reminderCadenceDays) ? (row.reminderCadenceDays as number[]) : null,
    assignableQuestionsEnabled: row.assignableQuestionsEnabled,
    financialsAccessDefault: row.financialsAccessDefault,
    filesAccessDefault: row.filesAccessDefault,
    previewRequireReauth: row.previewRequireReauth,
    paused: row.paused,
  };
}

export async function updateCompanySettings(
  tenantId: string,
  companyId: string,
  patch: Partial<CompanyPortalSettings>,
  actorUserId?: string,
): Promise<CompanyPortalSettings> {
  const before = await getCompanySettings(tenantId, companyId);
  const next: CompanyPortalSettings = { ...before, ...patch };

  await db
    .insert(portalSettingsPerCompany)
    .values({
      companyId,
      remindersEnabled: next.remindersEnabled,
      reminderCadenceDays: next.reminderCadenceDays,
      assignableQuestionsEnabled: next.assignableQuestionsEnabled,
      financialsAccessDefault: next.financialsAccessDefault,
      filesAccessDefault: next.filesAccessDefault,
      previewRequireReauth: next.previewRequireReauth,
      paused: next.paused,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: portalSettingsPerCompany.companyId,
      set: {
        remindersEnabled: next.remindersEnabled,
        reminderCadenceDays: next.reminderCadenceDays,
        assignableQuestionsEnabled: next.assignableQuestionsEnabled,
        financialsAccessDefault: next.financialsAccessDefault,
        filesAccessDefault: next.filesAccessDefault,
        previewRequireReauth: next.previewRequireReauth,
        paused: next.paused,
        updatedAt: new Date(),
      },
    });

  await auditLog(tenantId, 'update', 'portal_settings_per_company', companyId, before, next, actorUserId);
  return next;
}

// Effective merge: company override wins, falling back to practice.
export interface EffectivePortalSettings {
  remindersEnabled: boolean;
  reminderCadenceDays: number[];
  assignableQuestionsEnabled: boolean;
  paused: boolean;
}

export async function getEffectiveCompanySettings(
  tenantId: string,
  companyId: string,
): Promise<EffectivePortalSettings> {
  const [practice, company] = await Promise.all([
    getPracticeSettings(tenantId),
    getCompanySettings(tenantId, companyId),
  ]);
  return {
    remindersEnabled: company.remindersEnabled ?? practice.remindersEnabled,
    reminderCadenceDays: company.reminderCadenceDays ?? practice.reminderCadenceDays,
    assignableQuestionsEnabled:
      company.assignableQuestionsEnabled ?? practice.assignableQuestionsEnabled,
    paused: company.paused,
  };
}
