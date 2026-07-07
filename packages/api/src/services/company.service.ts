// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { eq, and, notInArray, count } from 'drizzle-orm';
import type { UpdateCompanyInput } from '@kis-books/shared';
import { db } from '../db/index.js';
import { companies, accountantCompanyExclusions, transactions, bankFeedItems, bankConnections } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';

// List all companies for a tenant, filtered by accountant exclusions if applicable
export async function listCompanies(tenantId: string, userId?: string) {
  // Include `currency` in the summary so the frontend can render money in
  // the correct locale without a second fetch. Previously the UI had no
  // access to currency at the company-summary level and hardcoded USD.
  const allCompanies = await db.select({
    id: companies.id,
    businessName: companies.businessName,
    setupComplete: companies.setupComplete,
    currency: companies.currency,
  }).from(companies).where(eq(companies.tenantId, tenantId));

  if (!userId) return allCompanies;

  // Check for exclusions
  const exclusions = await db.select({ companyId: accountantCompanyExclusions.companyId })
    .from(accountantCompanyExclusions).where(eq(accountantCompanyExclusions.userId, userId));

  if (exclusions.length === 0) return allCompanies;

  const excludedIds = new Set(exclusions.map((e) => e.companyId));
  return allCompanies.filter((c) => !excludedIds.has(c.id));
}

// Get a specific company (by companyId or fallback to first for tenant)
export async function getCompany(tenantId: string, companyId?: string) {
  const company = companyId
    ? await db.query.companies.findFirst({ where: and(eq(companies.tenantId, tenantId), eq(companies.id, companyId)) })
    : await db.query.companies.findFirst({ where: eq(companies.tenantId, tenantId) });

  if (!company) throw AppError.notFound('Company not found');
  return company;
}

// Fields the tenant's own users may edit via /companies/:id. Any
// field not in this list — notably `tenantId` and `id` — is
// silently dropped even if it appears in `input`. The Zod schema
// already strips unknown keys, but this allowlist is defense in
// depth against a future schema that uses .passthrough() or a
// direct call that bypasses the route layer.
const COMPANY_UPDATABLE_FIELDS = [
  'businessName',
  'legalName',
  'ein',
  'addressLine1',
  'addressLine2',
  'city',
  'state',
  'zip',
  'country',
  'phone',
  'email',
  'website',
  'industry',
  'entityType',
  'fiscalYearStartMonth',
  'accountingMethod',
  'defaultPaymentTerms',
  'invoicePrefix',
  'invoiceNextNumber',
  'defaultSalesTaxRate',
  'currency',
  'dateFormat',
  'categoryFilterMode',
  // These are edited on the Preferences page and returned by getSettings but
  // were missing from the allowlist, so updateCompany silently dropped them —
  // the toggles/fields appeared not to save.
  'defaultLineEntryMode',
  'lockDate',
  'chatSupportEnabled',
] as const;

export async function updateCompany(tenantId: string, companyId: string, input: UpdateCompanyInput, userId?: string) {
  const existing = await getCompany(tenantId, companyId);

  // Explicit allowlist: never trust `input` to be free of tenantId /
  // id keys that could move the company between tenants.
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  for (const key of COMPANY_UPDATABLE_FIELDS) {
    if ((input as Record<string, unknown>)[key] !== undefined) {
      updates[key] = (input as Record<string, unknown>)[key];
    }
  }

  const [updated] = await db
    .update(companies)
    .set(updates as Partial<typeof companies.$inferInsert>)
    .where(and(eq(companies.tenantId, tenantId), eq(companies.id, companyId)))
    .returning();

  if (!updated) throw AppError.internal('Failed to update company');
  await auditLog(tenantId, 'update', 'company', updated.id, existing, updated, userId);
  return updated;
}

export async function updateLogo(tenantId: string, companyId: string, logoUrl: string, userId?: string) {
  const existing = await getCompany(tenantId, companyId);

  const [updated] = await db
    .update(companies)
    .set({ logoUrl, updatedAt: new Date() })
    .where(and(eq(companies.tenantId, tenantId), eq(companies.id, companyId)))
    .returning();

  if (!updated) throw AppError.internal('Failed to update logo');
  await auditLog(tenantId, 'update', 'company', updated.id, { logoUrl: existing.logoUrl }, { logoUrl }, userId);
  return updated;
}

export async function markSetupComplete(tenantId: string, companyId: string) {
  await db
    .update(companies)
    .set({ setupComplete: true, updatedAt: new Date() })
    .where(and(eq(companies.tenantId, tenantId), eq(companies.id, companyId)));
}

export async function getSettings(tenantId: string, companyId?: string) {
  const company = await getCompany(tenantId, companyId);
  return {
    fiscalYearStartMonth: company.fiscalYearStartMonth,
    accountingMethod: company.accountingMethod,
    defaultPaymentTerms: company.defaultPaymentTerms,
    invoicePrefix: company.invoicePrefix,
    invoiceNextNumber: company.invoiceNextNumber,
    defaultSalesTaxRate: company.defaultSalesTaxRate,
    currency: company.currency,
    dateFormat: company.dateFormat,
    categoryFilterMode: company.categoryFilterMode || 'by_type',
    defaultLineEntryMode: company.defaultLineEntryMode || 'category',
    lockDate: company.lockDate || null,
    chatSupportEnabled: company.chatSupportEnabled ?? false,
  };
}

export async function getSmtpSettings(tenantId: string, companyId?: string) {
  const company = await getCompany(tenantId, companyId);
  return {
    smtpHost: company.smtpHost || '',
    smtpPort: company.smtpPort || 587,
    smtpUser: company.smtpUser || '',
    // Never return the stored password — it's encryption-at-rest only.
    // The frontend treats an empty value as "leave alone" on save. A
    // `passwordConfigured` boolean lets the UI render a placeholder.
    smtpPass: '',
    passwordConfigured: !!company.smtpPass,
    smtpFrom: company.smtpFrom || company.email || '',
    configured: !!company.smtpHost,
  };
}

export async function updateSmtpSettings(
  tenantId: string,
  companyId: string,
  input: { smtpHost: string; smtpPort: number; smtpUser: string; smtpPass?: string | null; smtpFrom: string },
  userId?: string,
) {
  const existing = await getCompany(tenantId, companyId);

  // smtpPass uses 3-state sentinel: null = explicit clear, '' or
  // undefined = no change, non-empty = set. The GET endpoint scrubs the
  // password so an empty form value must never overwrite the stored one.
  const updates: Record<string, unknown> = {
    smtpHost: input.smtpHost,
    smtpPort: input.smtpPort,
    smtpUser: input.smtpUser,
    smtpFrom: input.smtpFrom,
    updatedAt: new Date(),
  };
  if (input.smtpPass === null) {
    updates['smtpPass'] = null;
  } else if (input.smtpPass) {
    updates['smtpPass'] = input.smtpPass;
  }

  const [updated] = await db
    .update(companies)
    .set(updates)
    .where(and(eq(companies.tenantId, tenantId), eq(companies.id, companyId)))
    .returning();

  if (userId) {
    await auditLog(tenantId, 'update', 'company', companyId, { smtpHost: existing.smtpHost }, { smtpHost: input.smtpHost }, userId);
  }

  return updated;
}

export async function createCompanyForTenant(tenantId: string, businessName: string) {
  const [company] = await db.insert(companies).values({
    tenantId,
    businessName,
  }).returning();
  return company;
}

// Create an additional company under the same tenant.
//
// NOTE: companies within a single tenant SHARE one chart of accounts.
// The unique index on accounts is `(tenant_id, account_number)` — there
// is no `company_id` in that index — so only one COA can exist per
// tenant. The previous version of this function called
// `seedFromTemplate(tenantId, businessType, company.id)` which crashed
// with a unique-constraint violation as soon as the tenant already had
// any accounts (which is always true after first-run setup).
//
// The `businessType` parameter is intentionally accepted but unused.
// It's part of the public API surface and removing it would break the
// existing UI form that posts it. Documented as a no-op so a future
// reviewer doesn't try to "fix" it.
//
// If a user genuinely needs a separate chart of accounts, they should
// create a separate TENANT instead of a separate company. The admin
// tenant-management UI under /admin/tenants supports this.
export async function createAdditionalCompany(tenantId: string, input: { businessName: string; entityType?: string; industry?: string; businessType?: string }) {
  // `businessType` is accepted but intentionally not used — see header comment.
  void input.businessType;

  const [company] = await db.insert(companies).values({
    tenantId,
    businessName: input.businessName,
    entityType: input.entityType || 'sole_prop',
    industry: input.industry || null,
    setupComplete: true,
  }).returning();

  if (!company) throw AppError.internal('Failed to create company');

  return company;
}

// Delete an additional company from a tenant. Safe because companies within a
// tenant SHARE one tenant-scoped chart of accounts (see createAdditionalCompany
// note), so an unused company owns nothing to cascade. Refuses when the company
// has any real activity (transactions, bank feed items, or bank connections) so
// deleting it can never orphan ledger/banking history — the operator is told to
// clear that first. A tenant must always keep at least one company.
export async function deleteCompany(tenantId: string, companyId: string, userId?: string) {
  const company = await db.query.companies.findFirst({
    where: and(eq(companies.tenantId, tenantId), eq(companies.id, companyId)),
  });
  if (!company) throw AppError.notFound('Company not found');

  const [companyCountRow] = await db.select({ c: count() }).from(companies)
    .where(eq(companies.tenantId, tenantId));
  if (Number(companyCountRow?.c ?? 0) <= 1) {
    throw AppError.badRequest(
      'A tenant must keep at least one company. Create another company before deleting this one.',
      'LAST_COMPANY',
    );
  }

  const [txnRow] = await db.select({ c: count() }).from(transactions)
    .where(and(eq(transactions.tenantId, tenantId), eq(transactions.companyId, companyId)));
  if (Number(txnRow?.c ?? 0) > 0) {
    throw AppError.badRequest(
      `This company has ${txnRow!.c} transaction(s). Void or reassign them before deleting the company.`,
      'COMPANY_HAS_TRANSACTIONS',
    );
  }

  const [feedRow] = await db.select({ c: count() }).from(bankFeedItems)
    .where(and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.companyId, companyId)));
  if (Number(feedRow?.c ?? 0) > 0) {
    throw AppError.badRequest(
      'This company has bank feed items. Clear them before deleting the company.',
      'COMPANY_HAS_DATA',
    );
  }

  const [connRow] = await db.select({ c: count() }).from(bankConnections)
    .where(and(eq(bankConnections.tenantId, tenantId), eq(bankConnections.companyId, companyId)));
  if (Number(connRow?.c ?? 0) > 0) {
    throw AppError.badRequest(
      'This company has bank connections. Disconnect them before deleting the company.',
      'COMPANY_HAS_DATA',
    );
  }

  await db.delete(companies).where(and(eq(companies.tenantId, tenantId), eq(companies.id, companyId)));
  await auditLog(tenantId, 'delete', 'company', companyId, { businessName: company.businessName }, null, userId);

  return { deleted: true, companyId };
}
