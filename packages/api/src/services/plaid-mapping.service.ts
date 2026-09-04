// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { plaidAccounts, plaidAccountMappings, accounts } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { BANK_FEED_SYSTEM_TAG } from './system-accounts.service.js';

// ─── Step 1: Assign Account to Company ─────────────────────────

export async function assignAccountToCompany(plaidAccountId: string, tenantId: string, coaAccountId: string, syncStartDate: string | null, userId: string) {
  const { users } = await import('../db/schema/index.js');
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });

  // SECURITY: the caller must be allowed to operate on the Plaid ITEM this
  // account belongs to (creator, mapped-tenant member, or super-admin).
  // Without this, any authenticated user who learned an unmapped Plaid
  // account's UUID could map another client's bank account into their own
  // tenant and pull its transactions through sync (IDOR).
  const plaidAccount = await db.query.plaidAccounts.findFirst({
    where: eq(plaidAccounts.id, plaidAccountId),
  });
  if (!plaidAccount) throw AppError.notFound('Bank account not found');
  const { assertCanAccessItem, getUserAdminTenants } = await import('./plaid-connection.service.js');
  await assertCanAccessItem(userId, plaidAccount.plaidItemId);

  // SECURITY: when the item is shared with a tenant OUTSIDE the caller's
  // orbit (a super-admin mapped one of its accounts to this tenant), the
  // caller must not self-extend the share to the item's other unassigned
  // accounts — only a super-admin may map accounts on a cross-tenant item
  // (via the Plaid monitor).
  if (!user?.isSuperAdmin) {
    const siblingAccounts = await db.select({ id: plaidAccounts.id }).from(plaidAccounts)
      .where(eq(plaidAccounts.plaidItemId, plaidAccount.plaidItemId));
    const siblingIds = siblingAccounts.map((a) => a.id);
    const itemMappings = siblingIds.length > 0
      ? await db.query.plaidAccountMappings.findMany({
          where: (pam, { inArray: inArr }) => inArr(pam.plaidAccountId, siblingIds),
        })
      : [];
    const userTenants = await getUserAdminTenants(userId);
    const hasForeignMapping = itemMappings.some((m) => !userTenants.includes(m.tenantId));
    if (hasForeignMapping) {
      throw AppError.forbidden('This connection is shared with another client — only a super-admin can map its remaining accounts (Admin → Plaid monitor).');
    }
  }

  // Validate COA account
  const coaAccount = await db.query.accounts.findFirst({
    where: and(eq(accounts.id, coaAccountId), eq(accounts.tenantId, tenantId)),
  });
  if (!coaAccount) throw AppError.notFound('Chart of Accounts entry not found');

  const validTypes = ['bank', 'credit_card', 'other_current_asset', 'other_current_liability'];
  if (!validTypes.includes(coaAccount.detailType || '')) {
    throw AppError.badRequest('Only bank, credit card, and current asset/liability accounts can be linked to Plaid');
  }

  // A SYSTEM account is never a bank feed's destination, with one exception:
  // cash_on_hand is the role the real bank account carries.
  //
  // The detailType check above is not enough on its own. Payments Clearing is
  // seeded as other_current_asset, but on two tenants it had drifted to
  // 'bank', which put it in the picker looking like any other bank account —
  // and a client's live Plaid feed was wired to it. Holding and control
  // accounts corrupt both themselves and the real bank balance when fed.
  if (coaAccount.systemTag && coaAccount.systemTag !== BANK_FEED_SYSTEM_TAG) {
    throw AppError.badRequest(
      `"${coaAccount.name}" is a system account (${coaAccount.systemTag}) and cannot receive a bank feed. ` +
      'Choose the bank or credit card account this feed belongs to.',
      'SYSTEM_ACCOUNT_NOT_FEEDABLE',
    );
  }

  // Check no existing mapping on this Plaid account (one bank account → one
  // company). Stays deliberately NOT tenant-scoped: idx_pam_plaid_account_uniq
  // is unique on plaid_account_id alone, so scoping this would just move the
  // failure to a raw unique violation.
  //
  // The message used to be "already assigned to a company. Unmap it first."
  // and said nothing else, which read as nonsense to anyone looking at a
  // chart-of-accounts account with nothing on it — the thing already assigned
  // is the BANK account, not the ledger account. Worse, when the mapping
  // belongs to another tenant there is nothing the caller can unmap, so the
  // instruction was impossible to follow. Say which, and what to do.
  const existingPlaidMapping = await db.query.plaidAccountMappings.findFirst({
    where: eq(plaidAccountMappings.plaidAccountId, plaidAccountId),
  });
  if (existingPlaidMapping) {
    if (existingPlaidMapping.tenantId !== tenantId) {
      throw AppError.conflict(
        'This bank account is already connected under a different client. ' +
        'It cannot be mapped here while that connection exists.',
        'PLAID_ACCOUNT_MAPPED_ELSEWHERE',
      );
    }
    const current = await db.query.accounts.findFirst({
      where: and(
        eq(accounts.id, existingPlaidMapping.mappedAccountId),
        eq(accounts.tenantId, tenantId),
      ),
    });
    const named = current
      ? `"${current.accountNumber ? `${current.accountNumber} — ` : ''}${current.name}"`
      : 'another account';
    throw AppError.conflict(
      `This bank account already feeds ${named}. ` +
      'Use Change account on that connection to point it somewhere else — ' +
      'mapping it a second time would create a duplicate feed.',
      'PLAID_ACCOUNT_ALREADY_MAPPED',
    );
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

  // NOTE: we deliberately do NOT copy the bank's reported balance onto
  // accounts.balance. That column is the GL running balance —
  // SUM(debit−credit) over posted journal lines (CLAUDE.md rule 24) —
  // and overwriting it with the bank's number permanently desynced it
  // from the ledger (outstanding checks alone make the two differ).
  // The bank balance lives on plaid_accounts.current_balance; anything
  // that wants "what the bank says" should read it from there.

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

export async function autoSuggestMapping(tenantId: string, plaidAccountId: string, userId?: string) {
  // Gate on item access when the caller is known, so this endpoint can't be
  // used to existence-probe foreign plaid-account UUIDs.
  if (userId) {
    const pa = await db.query.plaidAccounts.findFirst({ where: eq(plaidAccounts.id, plaidAccountId) });
    if (!pa) throw AppError.notFound('Bank account not found');
    const { assertCanAccessItem } = await import('./plaid-connection.service.js');
    await assertCanAccessItem(userId, pa.plaidItemId);
  }
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
