// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { seedEquityRolesBestEffort } from './equity-roles.service.js';
import { eq, and, notInArray, count } from 'drizzle-orm';
import type { UpdateCompanyInput } from '@kis-books/shared';
import DecimalLib from 'decimal.js';
import { db, type DbOrTx } from '../db/index.js';
import { accounts, companies, accountantCompanyExclusions, transactions, bankFeedItems, bankConnections } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import { authorizeLockDateChange, withoutClosingPasswordHash, type ClosingPasswordActor } from './closing-password.service.js';
import { isDesktop } from '../desktop/profile.js';
import { hasSessionSecret } from '../desktop/session-secrets.js';
import { assertBillDiscountAccount } from './bill-discount-account.js';
import { assertMarkupAccount } from './billable-links.js';
import { assertWriteOffAccount, assertSalesDiscountAccount } from './write-off-account.js';

const Decimal = DecimalLib.default || DecimalLib;

/**
 * A company row as it leaves the service layer (responses, audit images):
 * without the closing-date password hash (U-15) and without the intake
 * folders (U-93), whose paths are read only through
 * GET /company/intake-settings and never audited, and without the stored
 * SMTP password, which only the internal send path reads
 * (getSmtpTransportSettings).
 */
export function publicCompanyRow<T extends { closingPasswordHash?: unknown; intakeSettings?: unknown; smtpPass?: unknown }>(row: T): Omit<T, 'closingPasswordHash' | 'intakeSettings' | 'smtpPass'> {
  const { intakeSettings: _intake, smtpPass: _smtpPass, ...rest } = withoutClosingPasswordHash(row);
  return rest as Omit<T, 'closingPasswordHash' | 'intakeSettings' | 'smtpPass'>;
}

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
  // The closing-date password hash never leaves the service layer (U-15).
  return publicCompanyRow(company);
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
  // Pay Bills discount account (U-101); validated in updateCompany.
  'billDiscountAccountId',
  // Billable-cost markup account (U-128); validated in updateCompany.
  'billableMarkupAccountId',
  // Bounced-payment preferences (U-132); validated in updateCompany.
  'nsfBankFeeAccountId',
  'nsfFeeIncomeAccountId',
  'nsfCustomerFee',
  // Receive Payment write-offs and discounts (U-133, U-134); validated in updateCompany.
  'writeOffAccountId',
  'writeOffThreshold',
  'salesDiscountAccountId',
] as const;

export async function updateCompany(
  tenantId: string,
  companyId: string,
  input: UpdateCompanyInput,
  userId?: string,
  // Closing-date password from the request (U-15), and who is asking.
  closing?: { password?: string; actor?: ClosingPasswordActor },
) {
  const existing = await getCompany(tenantId, companyId);

  // Explicit allowlist: never trust `input` to be free of tenantId /
  // id keys that could move the company between tenants.
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  for (const key of COMPANY_UPDATABLE_FIELDS) {
    if ((input as Record<string, unknown>)[key] !== undefined) {
      updates[key] = (input as Record<string, unknown>)[key];
    }
  }

  // Closing date (TB rule TB5 / U-15): a change records who and when, as
  // PUT /tb/closing-date does, and needs the closing-date password when
  // the company has one. A password given while none is set becomes the
  // company's password ("set or confirm"; owner or super admin only).
  // Check and write run in one transaction with the company row locked,
  // so a concurrent password or closing-date change can't slip between.
  const requestedLock = (input as Record<string, unknown>)['lockDate'];
  const updated = await db.transaction(async (tx) => {
    const [locked] = await tx.select({ lockDate: companies.lockDate }).from(companies)
      .where(and(eq(companies.tenantId, tenantId), eq(companies.id, companyId)))
      .for('update')
      .limit(1);
    if (!locked) throw AppError.notFound('Company not found');
    const lockChanges = requestedLock !== undefined && ((requestedLock as string | null) || null) !== (locked.lockDate || null);
    let passwordSetNow = false;
    if (lockChanges || closing?.password !== undefined) {
      const { newHash } = await authorizeLockDateChange(tx, tenantId, companyId, closing?.password, {
        userId, ...closing?.actor,
      });
      if (newHash) {
        updates['closingPasswordHash'] = newHash;
        passwordSetNow = true;
      }
    }
    if (lockChanges) {
      updates['lockDateSetBy'] = userId ?? null;
      updates['lockDateSetAt'] = new Date();
    }
    // Pay Bills discount account (U-101): an account of this company, not A/P.
    const discountAccountId = updates['billDiscountAccountId'];
    if (typeof discountAccountId === 'string') {
      await assertBillDiscountAccount(tx, tenantId, companyId, discountAccountId);
    }
    // Bounced-payment accounts (U-132): accounts of this company, active,
    // not A/R, A/P, Payments Clearing or Customer Deposits.
    for (const field of ['nsfBankFeeAccountId', 'nsfFeeIncomeAccountId'] as const) {
      const id = updates[field];
      if (typeof id === 'string') await assertNsfAccount(tx, tenantId, companyId, id);
    }
    if (typeof updates['writeOffAccountId'] === 'string') {
      await assertWriteOffAccount(tx, tenantId, companyId, updates['writeOffAccountId'] as string);
    }
    if (typeof updates['salesDiscountAccountId'] === 'string') {
      await assertSalesDiscountAccount(tx, tenantId, companyId, updates['salesDiscountAccountId'] as string);
    }
    // Billable-cost markup account (U-128): an active income account of this company.
    const markupAccountId = updates['billableMarkupAccountId'];
    if (typeof markupAccountId === 'string') {
      await assertMarkupAccount(tx, tenantId, companyId, markupAccountId);
    }

    const [row] = await tx
      .update(companies)
      .set(updates as Partial<typeof companies.$inferInsert>)
      .where(and(eq(companies.tenantId, tenantId), eq(companies.id, companyId)))
      .returning();

    if (!row) throw AppError.internal('Failed to update company');
    const safe = publicCompanyRow(row);
    await auditLog(tenantId, 'update', 'company', safe.id, existing, safe, userId, tx);
    if (passwordSetNow) {
      await auditLog(tenantId, 'update', 'closing_password', companyId,
        { closingDateProtected: false }, { closingDateProtected: true }, userId, tx);
    }
    return safe;
  });
  // A new entity type may need other equity roles (U-55).
  if (updates['entityType'] !== undefined && updates['entityType'] !== existing.entityType) {
    await seedEquityRolesBestEffort(tenantId, userId);
  }
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
  // The full row goes back to POST /company/logo: never with the hash (U-15).
  return publicCompanyRow(updated);
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
    billDiscountAccountId: company.billDiscountAccountId ?? null,
    billableMarkupAccountId: company.billableMarkupAccountId ?? null,
    nsfBankFeeAccountId: company.nsfBankFeeAccountId ?? null,
    nsfFeeIncomeAccountId: company.nsfFeeIncomeAccountId ?? null,
    nsfCustomerFee: company.nsfCustomerFee == null ? null : new Decimal(company.nsfCustomerFee).toFixed(2),
    writeOffAccountId: company.writeOffAccountId ?? null,
    writeOffThreshold: company.writeOffThreshold == null ? null : new Decimal(company.writeOffThreshold).toFixed(2),
    salesDiscountAccountId: company.salesDiscountAccountId ?? null,
  };
}

/** A bounced-payment preference account (U-132): else 400 NSF_ACCOUNT_INVALID. */
async function assertNsfAccount(executor: DbOrTx, tenantId: string, companyId: string, accountId: string): Promise<void> {
  const [row] = await executor.select({
    companyId: accounts.companyId, systemTag: accounts.systemTag, isActive: accounts.isActive, detailType: accounts.detailType,
  }).from(accounts).where(and(eq(accounts.tenantId, tenantId), eq(accounts.id, accountId))).limit(1);
  if (!row || (row.companyId !== null && row.companyId !== companyId) || row.isActive === false
    || ['accounts_receivable', 'accounts_payable', 'payments_clearing', 'customer_deposits'].includes(row.systemTag ?? '')
    || row.detailType === 'accounts_receivable' || row.detailType === 'accounts_payable') {
    throw AppError.badRequest('Choose an active income or expense account of this company.', 'NSF_ACCOUNT_INVALID', { accountId });
  }
}

/**
 * Desktop (U-13): the SMTP password is supplied per session through
 * /api/v1/desktop/session-secrets and never stored. Setting or clearing it
 * through a settings write is 400 DESKTOP_KEYS_NOT_STORED; '' (no change)
 * passes. No-op on the server.
 */
export function assertSmtpPasswordNotStoredInDesktop(smtpPass: string | null | undefined): void {
  if (!isDesktop() || smtpPass === undefined || smtpPass === '') return;
  throw AppError.badRequest(
    'The email password is not stored by the desktop edition. Supply it for the session through /api/v1/desktop/session-secrets.',
    'DESKTOP_KEYS_NOT_STORED',
  );
}

/**
 * INTERNAL — the company's SMTP settings for building a transport,
 * including the stored password. Only the send path (email.service) calls
 * this; no route returns it and its result is never logged. In desktop mode
 * the stored column is always empty and createMailTransport substitutes the
 * session password (U-13).
 */
export async function getSmtpTransportSettings(tenantId: string, companyId?: string) {
  const [company] = await db.select({
    smtpHost: companies.smtpHost,
    smtpPort: companies.smtpPort,
    smtpUser: companies.smtpUser,
    smtpPass: companies.smtpPass,
    smtpFrom: companies.smtpFrom,
    smtpFromName: companies.smtpFromName,
    email: companies.email,
  }).from(companies)
    .where(companyId ? and(eq(companies.tenantId, tenantId), eq(companies.id, companyId)) : eq(companies.tenantId, tenantId))
    .limit(1);
  if (!company) throw AppError.notFound('Company not found');
  return {
    smtpHost: company.smtpHost || '',
    smtpPort: company.smtpPort || 587,
    smtpUser: company.smtpUser || '',
    smtpPass: company.smtpPass || '',
    smtpFrom: company.smtpFrom || company.email || '',
    smtpFromName: company.smtpFromName || '',
    configured: !!company.smtpHost,
  };
}

/** The company's SMTP settings as the settings screen reads them: the password is never returned. */
export async function getSmtpSettings(tenantId: string, companyId?: string) {
  const { smtpPass, ...smtp } = await getSmtpTransportSettings(tenantId, companyId);
  return {
    smtpHost: smtp.smtpHost,
    smtpPort: smtp.smtpPort,
    smtpUser: smtp.smtpUser,
    // Never return the stored password. The frontend treats an empty value
    // as "leave alone" on save. A `passwordConfigured` boolean lets the UI
    // render a placeholder.
    smtpPass: '',
    // Desktop (U-13): the password is a per-session secret, never a column.
    passwordConfigured: isDesktop() ? hasSessionSecret('smtp.password') : !!smtpPass,
    smtpFrom: smtp.smtpFrom,
    smtpFromName: smtp.smtpFromName,
    configured: smtp.configured,
  };
}

export async function updateSmtpSettings(
  tenantId: string,
  companyId: string,
  input: { smtpHost: string; smtpPort: number; smtpUser: string; smtpPass?: string | null; smtpFrom: string; smtpFromName?: string },
  userId?: string,
) {
  const existing = await getCompany(tenantId, companyId);
  assertSmtpPasswordNotStoredInDesktop(input.smtpPass);

  // The same host guard the "test connection" path applies (loopback,
  // link-local / cloud-metadata refused; LAN relays allowed): otherwise a
  // tenant could SAVE 127.0.0.1 here and have every outbound mail dial it.
  if (input.smtpHost && input.smtpHost.trim()) {
    const { assertHostSafe } = await import('../utils/url-safety.js');
    try {
      await assertHostSafe(input.smtpHost, 'SMTP host', { allowPrivate: true });
    } catch (err) {
      throw AppError.badRequest(err instanceof Error ? err.message : 'SMTP host is not allowed', 'SMTP_HOST_BLOCKED');
    }
  }

  // smtpPass uses 3-state sentinel: null = explicit clear, '' or
  // undefined = no change, non-empty = set. The GET endpoint scrubs the
  // password so an empty form value must never overwrite the stored one.
  const updates: Record<string, unknown> = {
    smtpHost: input.smtpHost,
    smtpPort: input.smtpPort,
    smtpUser: input.smtpUser,
    smtpFrom: input.smtpFrom,
    smtpFromName: input.smtpFromName ?? '',
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

  if (!updated) throw AppError.internal('Failed to update email settings');
  if (userId) {
    await auditLog(tenantId, 'update', 'company', companyId, { smtpHost: existing.smtpHost }, { smtpHost: input.smtpHost }, userId);
  }

  // No secret leaves the service layer: neither the closing-date password
  // hash (U-15) nor the stored SMTP password.
  return publicCompanyRow(updated);
}

export async function createCompanyForTenant(tenantId: string, businessName: string, entityType?: string) {
  const [company] = await db.insert(companies).values({
    tenantId,
    businessName,
    // Optional so existing callers keep the column default ('sole_prop').
    ...(entityType ? { entityType } : {}),
  }).returning();
  return company ? publicCompanyRow(company) : company;
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

  // Equity roles for the new company's entity type (U-55).
  await seedEquityRolesBestEffort(tenantId);

  return publicCompanyRow(company);
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
