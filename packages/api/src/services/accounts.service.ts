// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { eq, and, ilike, sql, count, inArray } from 'drizzle-orm';
import type { CreateAccountInput, UpdateAccountInput, AccountFilters, BulkUpdateAccountsInput } from '@kis-books/shared';
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

/**
 * Bulk inline edit from the COA Bulk Edit table. Applies the same
 * protections as the single-account update() (system accounts keep their
 * type; isSystem/balance are not editable — the schema only admits
 * number/name/type/detail), plus batch-level uniqueness checks on
 * account numbers.
 *
 * Number swaps (A↔B) are supported: inside the transaction, all edited
 * rows whose number changes are first set to NULL, then the new numbers
 * are applied — otherwise the (tenant_id, account_number) unique index
 * rejects the first UPDATE of a swap before the second frees the value.
 * Audit rows are written with the tx executor so they commit atomically
 * with the change (or roll back with it).
 */
export async function bulkUpdate(tenantId: string, input: BulkUpdateAccountsInput, userId?: string) {
  const { updates } = input;

  // Reject duplicate targets — two edits to the same account would make
  // the result order-dependent.
  const ids = updates.map((u) => u.id);
  if (new Set(ids).size !== ids.length) {
    throw AppError.badRequest('Duplicate account ids in bulk update');
  }

  const existing = await db.select().from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), inArray(accounts.id, ids)));
  const byId = new Map(existing.map((a) => [a.id, a]));
  const missing = ids.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw AppError.notFound(`Account(s) not found: ${missing.join(', ')}`);
  }

  // Per-account guards + compute each account's FINAL number for the
  // uniqueness checks below (undefined = unchanged).
  const finalNumbers = new Map<string, string | null>();
  for (const u of updates) {
    const acct = byId.get(u.id)!;
    if (acct.isSystem && u.accountType && u.accountType !== acct.accountType) {
      throw AppError.badRequest(`Cannot change the type of system account "${acct.name}"`);
    }
    const finalNumber = u.accountNumber !== undefined ? (u.accountNumber || null) : acct.accountNumber;
    finalNumbers.set(u.id, finalNumber);
  }

  // Uniqueness within the batch…
  const seen = new Map<string, string>();
  for (const [id, num] of finalNumbers) {
    if (!num) continue;
    const holder = seen.get(num);
    if (holder) {
      throw AppError.conflict(`Account number ${num} assigned to more than one account in this edit`, 'ACCOUNT_NUMBER_EXISTS');
    }
    seen.set(num, id);
  }
  // …and against tenant accounts NOT part of this batch.
  const claimed = [...seen.keys()];
  if (claimed.length > 0) {
    const outside = await db.select({ id: accounts.id, accountNumber: accounts.accountNumber })
      .from(accounts)
      .where(and(eq(accounts.tenantId, tenantId), inArray(accounts.accountNumber, claimed)));
    for (const o of outside) {
      if (!byId.has(o.id)) {
        throw AppError.conflict(`Account number ${o.accountNumber} already exists`, 'ACCOUNT_NUMBER_EXISTS');
      }
    }
  }

  const updated = await db.transaction(async (tx) => {
    // Phase 1: free the numbers of every edited row whose number changes,
    // so renumber shuffles/swaps can't trip the unique index mid-flight.
    const renumbered = updates.filter((u) => {
      const acct = byId.get(u.id)!;
      return u.accountNumber !== undefined && (u.accountNumber || null) !== acct.accountNumber;
    });
    if (renumbered.length > 0) {
      await tx.update(accounts)
        .set({ accountNumber: null })
        .where(and(eq(accounts.tenantId, tenantId), inArray(accounts.id, renumbered.map((u) => u.id))));
    }

    // Phase 2: apply each edit and audit it atomically.
    const results = [];
    for (const u of updates) {
      const before = byId.get(u.id)!;
      const [after] = await tx.update(accounts)
        .set({
          ...(u.name !== undefined ? { name: u.name } : {}),
          ...(u.accountType !== undefined ? { accountType: u.accountType } : {}),
          ...(u.detailType !== undefined ? { detailType: u.detailType || null } : {}),
          ...(u.accountNumber !== undefined ? { accountNumber: u.accountNumber || null } : {}),
          updatedAt: new Date(),
        })
        .where(and(eq(accounts.tenantId, tenantId), eq(accounts.id, u.id)))
        .returning();
      if (!after) throw AppError.internal(`Failed to update account ${u.id}`);
      await auditLog(tenantId, 'update', 'account', u.id, before, after, userId, tx);
      results.push(after);
    }
    return results;
  });

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

export async function seedFromTemplate(
  tenantId: string,
  templateName: string = 'default',
  companyId?: string,
  options: { systemOnly?: boolean } = {},
) {
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

  // `systemOnly` seeds just the required accounts (A/R, A/P, Payments
  // Clearing, Sales Tax Payable, Opening Balances, Retained Earnings,
  // Cash, …) — the ones services look up by systemTag — and skips the
  // rest of the business-type template. Used when a tenant is created
  // with "don't create the full chart of accounts".
  const source = options.systemOnly ? template.filter((t) => t.isSystem) : template;

  // Skip any template row whose account number already exists for this
  // tenant. On a fresh tenant this is a no-op (nothing exists yet); after a
  // COA delete+reapply it skips the preserved system accounts so we neither
  // collide on the (tenant_id, account_number) unique index nor create a
  // duplicate "Payments Clearing" / A/R / A/P. Account numbers are unique
  // per tenant regardless of company, so the check is tenant-scoped.
  const existingRows = await db
    .select({ accountNumber: accounts.accountNumber })
    .from(accounts)
    .where(eq(accounts.tenantId, tenantId));
  const existingNumbers = new Set(
    existingRows.map((r) => r.accountNumber).filter((n): n is string => !!n),
  );

  const values = source
    // Rows without an account number can't collide (NULLs are distinct in a
    // Postgres unique index), so they always seed.
    .filter((t) => !t.accountNumber || !existingNumbers.has(t.accountNumber))
    .map((t) => ({
      tenantId,
      companyId: companyId || null,
      accountNumber: t.accountNumber,
      name: t.name,
      accountType: t.accountType,
      detailType: t.detailType,
      isSystem: t.isSystem,
      systemTag: t.systemTag,
    }));

  if (values.length === 0) return;

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
