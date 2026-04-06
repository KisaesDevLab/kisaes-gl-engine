import { eq, and, notInArray } from 'drizzle-orm';
import type { UpdateCompanyInput } from '@kis-books/shared';
import { db } from '../db/index.js';
import { companies, accountantCompanyExclusions } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import * as accountsService from './accounts.service.js';

// List all companies for a tenant, filtered by accountant exclusions if applicable
export async function listCompanies(tenantId: string, userId?: string) {
  const allCompanies = await db.select({
    id: companies.id,
    businessName: companies.businessName,
    setupComplete: companies.setupComplete,
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

export async function updateCompany(tenantId: string, companyId: string, input: UpdateCompanyInput, userId?: string) {
  const existing = await getCompany(tenantId, companyId);

  const [updated] = await db
    .update(companies)
    .set({ ...input, updatedAt: new Date() })
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
  };
}

export async function getSmtpSettings(tenantId: string, companyId?: string) {
  const company = await getCompany(tenantId, companyId);
  return {
    smtpHost: company.smtpHost || '',
    smtpPort: company.smtpPort || 587,
    smtpUser: company.smtpUser || '',
    smtpPass: company.smtpPass || '',
    smtpFrom: company.smtpFrom || company.email || '',
    configured: !!company.smtpHost,
  };
}

export async function updateSmtpSettings(
  tenantId: string,
  companyId: string,
  input: { smtpHost: string; smtpPort: number; smtpUser: string; smtpPass: string; smtpFrom: string },
  userId?: string,
) {
  const existing = await getCompany(tenantId, companyId);

  const [updated] = await db
    .update(companies)
    .set({
      smtpHost: input.smtpHost,
      smtpPort: input.smtpPort,
      smtpUser: input.smtpUser,
      smtpPass: input.smtpPass,
      smtpFrom: input.smtpFrom,
      updatedAt: new Date(),
    })
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

// Create an additional company under the same tenant (with COA seeding)
export async function createAdditionalCompany(tenantId: string, input: { businessName: string; entityType?: string; industry?: string; businessType?: string }) {
  const [company] = await db.insert(companies).values({
    tenantId,
    businessName: input.businessName,
    entityType: input.entityType || 'sole_prop',
    industry: input.industry || null,
    setupComplete: true,
  }).returning();

  if (!company) throw AppError.internal('Failed to create company');

  // Seed COA for the new company
  await accountsService.seedFromTemplate(tenantId, input.businessType || 'default', company.id);

  return company;
}
