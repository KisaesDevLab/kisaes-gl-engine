// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { eq, and, ilike, sql, count } from 'drizzle-orm';
import type { CreateAccountInput, UpdateAccountInput, AccountFilters } from '@kis-books/shared';
import { COA_TEMPLATES } from '@kis-books/shared';
import { db } from '../db/index.js';
import { accounts } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import * as coaTemplatesService from './coa-templates.service.js';

export async function list(tenantId: string, filters: AccountFilters) {
  const conditions = [eq(accounts.tenantId, tenantId)];

  if (filters.accountType) {
    conditions.push(eq(accounts.accountType, filters.accountType));
  }
  if (filters.isActive !== undefined) {
    conditions.push(eq(accounts.isActive, filters.isActive));
  }
  if (filters.search) {
    conditions.push(
      sql`(${accounts.name} ILIKE ${'%' + filters.search + '%'} OR ${accounts.accountNumber} ILIKE ${'%' + filters.search + '%'})`,
    );
  }

  const where = and(...conditions);

  const [data, total] = await Promise.all([
    db
      .select()
      .from(accounts)
      .where(where)
      .orderBy(accounts.accountNumber, accounts.name)
      .limit(filters.limit ?? 100)
      .offset(filters.offset ?? 0),
    db
      .select({ count: count() })
      .from(accounts)
      .where(where),
  ]);

  return { data, total: total[0]?.count ?? 0 };
}

export async function getById(tenantId: string, id: string) {
  const account = await db.query.accounts.findFirst({
    where: and(eq(accounts.tenantId, tenantId), eq(accounts.id, id)),
  });
  if (!account) {
    throw AppError.notFound('Account not found');
  }
  return account;
}

export async function create(tenantId: string, input: CreateAccountInput, userId?: string) {
  // Check unique account number
  if (input.accountNumber) {
    const existing = await db.query.accounts.findFirst({
      where: and(
        eq(accounts.tenantId, tenantId),
        eq(accounts.accountNumber, input.accountNumber),
      ),
    });
    if (existing) {
      throw AppError.conflict(`Account number ${input.accountNumber} already exists`, 'ACCOUNT_NUMBER_EXISTS');
    }
  }

  const [account] = await db.insert(accounts).values({
    tenantId,
    ...input,
  }).returning();

  if (!account) {
    throw AppError.internal('Failed to create account');
  }

  await auditLog(tenantId, 'create', 'account', account.id, null, account, userId);
  return account;
}

export async function update(tenantId: string, id: string, input: UpdateAccountInput, userId?: string) {
  const existing = await getById(tenantId, id);

  // Scrub fields that are never legitimately set by a caller. Previously
  // the spread-into-update below would let a client payload set
  // `isSystem: false` on a system account (neutralizing its protection and
  // unlocking deactivate), or write a `balance` directly, bypassing the
  // ledger. Keep the defense here even though the Zod schema should already
  // reject them, because schemas drift and this cost is one line.
  const sanitized: Record<string, unknown> = { ...(input as unknown as Record<string, unknown>) };
  delete sanitized['isSystem'];
  delete sanitized['is_system'];
  delete sanitized['balance'];
  delete sanitized['tenantId'];
  delete sanitized['companyId'];

  // Block type change on system accounts
  if (existing.isSystem && input.accountType && input.accountType !== existing.accountType) {
    throw AppError.badRequest('Cannot change the type of a system account');
  }

  // Check unique account number if changing
  if (input.accountNumber && input.accountNumber !== existing.accountNumber) {
    const duplicate = await db.query.accounts.findFirst({
      where: and(
        eq(accounts.tenantId, tenantId),
        eq(accounts.accountNumber, input.accountNumber),
      ),
    });
    if (duplicate) {
      throw AppError.conflict(`Account number ${input.accountNumber} already exists`, 'ACCOUNT_NUMBER_EXISTS');
    }
  }

  const [updated] = await db
    .update(accounts)
    .set({ ...sanitized, updatedAt: new Date() })
    .where(and(eq(accounts.tenantId, tenantId), eq(accounts.id, id)))
    .returning();

  if (!updated) {
    throw AppError.internal('Failed to update account');
  }

  await auditLog(tenantId, 'update', 'account', id, existing, updated, userId);
  return updated;
}

export async function deactivate(tenantId: string, id: string, userId?: string) {
  const existing = await getById(tenantId, id);

  if (existing.isSystem) {
    throw AppError.badRequest('Cannot deactivate a system account');
  }

  if (existing.balance && parseFloat(existing.balance) !== 0) {
    throw AppError.badRequest('Cannot deactivate an account with a non-zero balance');
  }

  const [updated] = await db
    .update(accounts)
    .set({ isActive: false, updatedAt: new Date() })
    .where(and(eq(accounts.tenantId, tenantId), eq(accounts.id, id)))
    .returning();

  await auditLog(tenantId, 'update', 'account', id, existing, updated, userId);
  return updated;
}

export async function seedFromTemplate(tenantId: string, templateName: string = 'default', companyId?: string) {
  // DB-first: super admins can edit templates at runtime via /admin/coa-templates,
  // and those edits live in the coa_templates table. Fall back to the static
  // BUSINESS_TEMPLATES constant for legacy aliases (`default`/`service`/etc.)
  // and for the brief window before bootstrapBuiltins has populated the table.
  let template = await coaTemplatesService.getAccountsForSeed(templateName);
  if (!template) {
    const fallback = COA_TEMPLATES[templateName] || COA_TEMPLATES['default'];
    template = fallback ?? null;
  }
  if (!template) {
    throw AppError.badRequest(`Unknown template: ${templateName}`);
  }

  const values = template.map((t) => ({
    tenantId,
    companyId: companyId || null,
    accountNumber: t.accountNumber,
    name: t.name,
    accountType: t.accountType,
    detailType: t.detailType,
    isSystem: t.isSystem,
    systemTag: t.systemTag,
  }));

  // Wrap in a db.transaction so a partial failure (e.g., a unique
  // constraint collision on (tenant_id, account_number) caused by a
  // re-seed of an already-seeded tenant) rolls back cleanly instead of
  // leaving the tenant with a half-populated chart of accounts.
  await db.transaction(async (tx) => {
    await tx.insert(accounts).values(values);
  });
}

export async function importFromCsv(tenantId: string, csvData: Array<{ name: string; accountNumber?: string; accountType: string; detailType?: string }>, userId?: string) {
  const results: Array<typeof accounts.$inferSelect> = [];

  for (const row of csvData) {
    const [account] = await db.insert(accounts).values({
      tenantId,
      name: row.name,
      accountNumber: row.accountNumber || null,
      accountType: row.accountType,
      detailType: row.detailType || null,
    }).returning();

    if (account) {
      results.push(account);
    }
  }

  if (userId) {
    await auditLog(tenantId, 'create', 'account', null, null, { imported: results.length }, userId);
  }

  return results;
}

export async function exportToCsv(tenantId: string): Promise<string> {
  const data = await db
    .select()
    .from(accounts)
    .where(eq(accounts.tenantId, tenantId))
    .orderBy(accounts.accountNumber, accounts.name);

  const header = 'Account Number,Name,Type,Detail Type,Balance,Active,System\n';
  const rows = data.map((a) =>
    `"${a.accountNumber || ''}","${a.name}","${a.accountType}","${a.detailType || ''}","${a.balance}","${a.isActive}","${a.isSystem}"`,
  ).join('\n');

  return header + rows;
}

export async function merge(tenantId: string, sourceId: string, targetId: string, userId?: string) {
  const source = await getById(tenantId, sourceId);
  const target = await getById(tenantId, targetId);

  if (source.isSystem) {
    throw AppError.badRequest('Cannot merge a system account');
  }

  if (source.accountType !== target.accountType) {
    throw AppError.badRequest('Cannot merge accounts of different types');
  }

  // Re-point journal_lines will be done when journal_lines table exists (Phase 4)
  // For now, just deactivate the source
  await db
    .update(accounts)
    .set({ isActive: false, updatedAt: new Date() })
    .where(and(eq(accounts.tenantId, tenantId), eq(accounts.id, sourceId)));

  await auditLog(tenantId, 'update', 'account', sourceId, source, { merged_into: targetId }, userId);
  return target;
}

export async function getAccountLedger(tenantId: string, accountId: string, filters: { limit?: number; offset?: number }) {
  // Journal lines table doesn't exist yet (Phase 4), return empty for now
  await getById(tenantId, accountId); // validate account exists
  return { data: [], total: 0 };
}
