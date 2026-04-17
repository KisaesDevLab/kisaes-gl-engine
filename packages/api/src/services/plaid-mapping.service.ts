// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { plaidAccounts, plaidAccountMappings, accounts } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';

// ─── Step 1: Assign Account to Company ─────────────────────────

export async function assignAccountToCompany(plaidAccountId: string, tenantId: string, coaAccountId: string, syncStartDate: string | null, userId: string) {
  const { users } = await import('../db/schema/index.js');
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });

  // Validate COA account
  const coaAccount = await db.query.accounts.findFirst({
    where: and(eq(accounts.id, coaAccountId), eq(accounts.tenantId, tenantId)),
  });
  if (!coaAccount) throw AppError.notFound('Chart of Accounts entry not found');

  const validTypes = ['bank', 'credit_card', 'other_current_asset', 'other_current_liability'];
  if (!validTypes.includes(coaAccount.detailType || '')) {
    throw AppError.badRequest('Only bank, credit card, and current asset/liability accounts can be linked to Plaid');
  }

  // Check no existing mapping on this Plaid account (one bank account → one company)
  const existingPlaidMapping = await db.query.plaidAccountMappings.findFirst({
    where: eq(plaidAccountMappings.plaidAccountId, plaidAccountId),
  });
  if (existingPlaidMapping) {
    throw AppError.conflict('This bank account is already assigned to a company. Unmap it first.');
  }

  // Check no existing mapping on this COA account (one COA → one feed)
  const existingCoaMapping = await db.query.plaidAccountMappings.findFirst({
    where: and(eq(plaidAccountMappings.tenantId, tenantId), eq(plaidAccountMappings.mappedAccountId, coaAccountId)),
  });
  if (existingCoaMapping) {
    throw AppError.conflict('This Chart of Accounts entry is already linked to another Plaid account.');
  }

  // Validate sync start date
  if (syncStartDate && new Date(syncStartDate) > new Date()) {
    throw AppError.badRequest('Sync start date cannot be in the future');
  }

  const [mapping] = await db.insert(plaidAccountMappings).values({
    plaidAccountId,
    tenantId,
    mappedAccountId: coaAccountId,
    syncStartDate: syncStartDate || null,
    mappedBy: userId,
    mappedByName: user?.displayName || null,
  }).returning();

  // Update COA balance from Plaid balance. The `accounts` table is
  // tenant-scoped, so we bind the UPDATE to the caller's tenant for
  // defense in depth (CLAUDE.md #17).
  const pa = await db.query.plaidAccounts.findFirst({ where: eq(plaidAccounts.id, plaidAccountId) });
  if (pa?.currentBalance) {
    await db.update(accounts).set({ balance: pa.currentBalance })
      .where(and(eq(accounts.tenantId, tenantId), eq(accounts.id, coaAccountId)));
  }

  return mapping;
}

// ─── Unmap Account ─────────────────────────────────────────────

export async function unmapAccount(plaidAccountId: string, tenantId: string) {
  const mapping = await db.query.plaidAccountMappings.findFirst({
    where: and(eq(plaidAccountMappings.plaidAccountId, plaidAccountId), eq(plaidAccountMappings.tenantId, tenantId)),
  });
  if (!mapping) throw AppError.notFound('Mapping not found');

  await db.delete(plaidAccountMappings)
    .where(and(eq(plaidAccountMappings.tenantId, tenantId), eq(plaidAccountMappings.id, mapping.id)));
  return { unmapped: true };
}

// ─── Remap Account ─────────────────────────────────────────────

export async function remapAccount(plaidAccountId: string, tenantId: string, newCoaAccountId: string, userId: string) {
  await unmapAccount(plaidAccountId, tenantId);
  return assignAccountToCompany(plaidAccountId, tenantId, newCoaAccountId, null, userId);
}

// ─── Update Sync Start Date ────────────────────────────────────

export async function updateSyncStartDate(plaidAccountId: string, tenantId: string, newDate: string | null) {
  const mapping = await db.query.plaidAccountMappings.findFirst({
    where: and(eq(plaidAccountMappings.plaidAccountId, plaidAccountId), eq(plaidAccountMappings.tenantId, tenantId)),
  });
  if (!mapping) throw AppError.notFound('Mapping not found');

  if (newDate && new Date(newDate) > new Date()) {
    throw AppError.badRequest('Sync start date cannot be in the future');
  }

  const oldDate = mapping.syncStartDate;
  const movedBackward = oldDate && newDate && newDate < oldDate;

  await db.update(plaidAccountMappings).set({ syncStartDate: newDate || null, updatedAt: new Date() })
    .where(eq(plaidAccountMappings.id, mapping.id));

  // If date moved backward, trigger historical backfill — reset cursor and re-sync
  if (movedBackward || (!newDate && oldDate)) {
    const pa = await db.query.plaidAccounts.findFirst({ where: eq(plaidAccounts.id, plaidAccountId) });
    if (pa) {
      const { plaidItems } = await import('../db/schema/index.js');
      await db.update(plaidItems).set({ syncCursor: null, updatedAt: new Date() }).where(eq(plaidItems.id, pa.plaidItemId));
      // Trigger re-sync (dedup will prevent duplicate feed items)
      try {
        const { syncItem } = await import('./plaid-sync.service.js');
        await syncItem(pa.plaidItemId);
      } catch { /* sync is best-effort */ }
    }
  }

  return { updated: true, backfillTriggered: !!(movedBackward || (!newDate && oldDate)) };
}

// ─── Pause/Resume Sync ─────────────────────────────────────────

export async function toggleSync(plaidAccountId: string, tenantId: string, enabled: boolean) {
  const mapping = await db.query.plaidAccountMappings.findFirst({
    where: and(eq(plaidAccountMappings.plaidAccountId, plaidAccountId), eq(plaidAccountMappings.tenantId, tenantId)),
  });
  if (!mapping) throw AppError.notFound('Mapping not found');

  await db.update(plaidAccountMappings).set({ isSyncEnabled: enabled, updatedAt: new Date() })
    .where(eq(plaidAccountMappings.id, mapping.id));
}

// ─── Auto-Suggest COA Account ──────────────────────────────────

export async function autoSuggestMapping(tenantId: string, plaidAccountId: string) {
  const pa = await db.query.plaidAccounts.findFirst({ where: eq(plaidAccounts.id, plaidAccountId) });
  if (!pa) throw AppError.notFound('Plaid account not found');

  const typeMap: Record<string, string[]> = {
    'depository': ['bank'],
    'credit': ['credit_card'],
    'loan': ['other_current_liability'],
    'investment': ['other_current_asset'],
  };
  const matchTypes = typeMap[pa.accountType || ''] || ['bank'];

  const coaAccounts = await db.select().from(accounts).where(
    and(eq(accounts.tenantId, tenantId), eq(accounts.isActive, true)),
  );

  return coaAccounts
    .filter((a) => matchTypes.includes(a.detailType || ''))
    .map((a) => {
      const plaidName = (pa.name || '').toLowerCase();
      const coaName = (a.name || '').toLowerCase();
      let confidence: 'high' | 'medium' | 'low' = 'low';
      let reason = 'Account type matches';
      if (coaName.includes(plaidName) || plaidName.includes(coaName)) { confidence = 'high'; reason = 'Name and type match'; }
      else if (matchTypes.includes(a.detailType || '')) { confidence = 'medium'; }
      return { coaAccountId: a.id, coaAccountName: a.name, coaAccountNumber: a.accountNumber, confidence, reason };
    })
    .sort((a, b) => ({ high: 0, medium: 1, low: 2 }[a.confidence] - { high: 0, medium: 1, low: 2 }[b.confidence]));
}

// ─── Create and Map COA Account ────────────────────────────────

export async function createAndMapAccount(tenantId: string, plaidAccountId: string, input: {
  accountName: string; accountNumber?: string; accountType: string; detailType: string;
}, syncStartDate: string | null, userId: string) {
  const [newAccount] = await db.insert(accounts).values({
    tenantId,
    name: input.accountName,
    accountNumber: input.accountNumber || null,
    accountType: input.accountType as any,
    detailType: input.detailType,
    isActive: true, isSystem: false,
  }).returning();

  await assignAccountToCompany(plaidAccountId, tenantId, newAccount!.id, syncStartDate, userId);
  return newAccount;
}
