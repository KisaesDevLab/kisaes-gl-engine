// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { db } from '../db/index.js';
import {
  tenants, users, sessions, companies, accounts, plaidConfig, plaidItems, plaidAccounts,
  plaidAccountMappings, plaidItemActivity, plaidWebhookLog,
  bankFeedItems, bankConnections, bankStatementLines, bankStatements,
} from '../db/schema/index.js';
import { auditLog } from '../db/schema/index.js';
import * as authService from './auth.service.js';
import * as plaidClientService from './plaid-client.service.js';
import * as plaidConnectionService from './plaid-connection.service.js';
import * as plaidMappingService from './plaid-mapping.service.js';
import * as plaidWebhookService from './plaid-webhook.service.js';
import * as plaidSyncService from './plaid-sync.service.js';
import { encrypt, decrypt } from '../utils/encryption.js';
import { eq, and, asc, inArray } from 'drizzle-orm';

// syncItem's upstream calls are mocked (partial module mock — the config
// service functions stay real); the bank-feed pipelines are mocked so sync
// tests exercise routing/insert semantics without the full cleansing stack.
const syncMocks = vi.hoisted(() => ({
  syncTransactions: vi.fn(),
  getBalances: vi.fn(),
  refreshTransactions: vi.fn(),
  runCleansingPipeline: vi.fn(),
  runCategorizationPipeline: vi.fn(),
}));

vi.mock('./plaid-client.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./plaid-client.service.js')>();
  return {
    ...actual,
    syncTransactions: (...args: unknown[]) => syncMocks.syncTransactions(...args),
    getBalances: (...args: unknown[]) => syncMocks.getBalances(...args),
    refreshTransactions: (...args: unknown[]) => syncMocks.refreshTransactions(...args),
  };
});

vi.mock('./bank-feed.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./bank-feed.service.js')>();
  return {
    ...actual,
    runCleansingPipeline: (...args: unknown[]) => syncMocks.runCleansingPipeline(...args),
    runCategorizationPipeline: (...args: unknown[]) => syncMocks.runCategorizationPipeline(...args),
  };
});

// Plaid item_id strings this suite passes to handleWebhook — used to scope
// the webhook-log cleanup (other suites also write plaid_webhook_log rows).
const WEBHOOK_ITEM_IDS = ['nonexistent-item', 'webhook-test-item', 'revoked-item'];

// Scoped cleanup — this suite registers its user under a fixed email; the
// system-scoped Plaid rows are chased from that user (items.createdBy →
// accounts → mappings), and the mapping rows additionally reveal the extra
// tenants seeded by the cross-tenant tests. Unscoped deletes here used to
// nuke concurrently-running suites' data.
async function cleanDb() {
  const testUsers = await db
    .select({ id: users.id, tenantId: users.tenantId })
    .from(users)
    .where(eq(users.email, 'plaid-test@example.com'));
  const userIds = testUsers.map((u) => u.id);
  const itemIds = userIds.length
    ? (await db.select({ id: plaidItems.id }).from(plaidItems).where(inArray(plaidItems.createdBy, userIds))).map((r) => r.id)
    : [];
  const plaidAccountIds = itemIds.length
    ? (await db.select({ id: plaidAccounts.id }).from(plaidAccounts).where(inArray(plaidAccounts.plaidItemId, itemIds))).map((r) => r.id)
    : [];
  const mappingTenantIds = plaidAccountIds.length
    ? (await db.select({ tenantId: plaidAccountMappings.tenantId }).from(plaidAccountMappings).where(inArray(plaidAccountMappings.plaidAccountId, plaidAccountIds))).map((r) => r.tenantId)
    : [];
  const tenantIds = [...new Set([...testUsers.map((u) => u.tenantId), ...mappingTenantIds])];

  await db.delete(plaidWebhookLog).where(inArray(plaidWebhookLog.plaidItemId, WEBHOOK_ITEM_IDS));
  await db.delete(plaidItemActivity).where(inArray(plaidItemActivity.plaidItemId, itemIds));
  await db.delete(plaidAccountMappings).where(inArray(plaidAccountMappings.plaidAccountId, plaidAccountIds));
  await db.delete(plaidAccounts).where(inArray(plaidAccounts.id, plaidAccountIds));
  await db.delete(plaidItems).where(inArray(plaidItems.id, itemIds));
  await db.delete(plaidConfig); // global table — no tenant column; suites share it by design
  await db.delete(auditLog).where(inArray(auditLog.tenantId, tenantIds));
  // Known FK-pollution fix: bank_feed_items / bank_statement_lines /
  // bank_statements / bank_connections rows reference accounts, so they must
  // go before the accounts delete or it fails and leaks rows across files.
  await db.delete(bankFeedItems).where(inArray(bankFeedItems.tenantId, tenantIds));
  await db.delete(bankStatementLines).where(inArray(bankStatementLines.tenantId, tenantIds));
  await db.delete(bankStatements).where(inArray(bankStatements.tenantId, tenantIds));
  await db.delete(bankConnections).where(inArray(bankConnections.tenantId, tenantIds));
  await db.delete(accounts).where(inArray(accounts.tenantId, tenantIds));
  await db.delete(companies).where(inArray(companies.tenantId, tenantIds));
  await db.delete(sessions).where(inArray(sessions.userId, userIds));
  await db.delete(users).where(inArray(users.tenantId, tenantIds));
  await db.delete(tenants).where(inArray(tenants.id, tenantIds));
}

async function createTestUser() {
  return authService.register({
    email: 'plaid-test@example.com',
    password: 'password123',
    displayName: 'Plaid Test User',
    companyName: 'Plaid Test Co',
  });
}

describe('Encryption Utility', () => {
  it('should encrypt and decrypt round-trip', () => {
    const plaintext = 'access-sandbox-12345678-abcd-efgh-ijkl';
    const encrypted = encrypt(plaintext);
    expect(encrypted).not.toBe(plaintext);
    expect(encrypted).toContain(':');
    expect(decrypt(encrypted)).toBe(plaintext);
  });

  it('should produce different ciphertext each time', () => {
    const plaintext = 'same-plaintext';
    const enc1 = encrypt(plaintext);
    const enc2 = encrypt(plaintext);
    expect(enc1).not.toBe(enc2);
    expect(decrypt(enc1)).toBe(plaintext);
    expect(decrypt(enc2)).toBe(plaintext);
  });
});

describe('Plaid Config Service', () => {
  beforeEach(async () => { await cleanDb(); });
  afterEach(async () => { await cleanDb(); });

  it('should create default config on first access', async () => {
    const config = await plaidClientService.getConfig();
    expect(config.environment).toBe('sandbox');
    expect(config.hasClientId).toBe(false);
    expect(config.isActive).toBe(true);
  });

  it('should update config with encrypted credentials', async () => {
    await plaidClientService.updateConfig({
      clientId: 'test-client-id',
      secretSandbox: 'test-sandbox-secret',
      environment: 'sandbox',
    });
    const config = await plaidClientService.getConfig();
    expect(config.hasClientId).toBe(true);
    expect(config.hasSandboxSecret).toBe(true);
    expect(config.environment).toBe('sandbox');
  });
});

describe('Plaid Mapping Service (Cross-Company)', () => {
  beforeEach(async () => { await cleanDb(); });
  afterEach(async () => { await cleanDb(); });

  it('should suggest mappings based on account type', async () => {
    const { user } = await createTestUser();

    // Create a system-scoped Plaid item and account
    const [item] = await db.insert(plaidItems).values({
      plaidItemId: 'test-item-id',
      accessTokenEncrypted: encrypt('test-access-token'),
      createdBy: user.id,
    }).returning();

    const [pa] = await db.insert(plaidAccounts).values({
      plaidItemId: item!.id,
      plaidAccountId: 'test-account-id',
      name: 'My Checking',
      accountType: 'depository',
      accountSubtype: 'checking',
      mask: '1234',
    }).returning();

    const suggestions = await plaidMappingService.autoSuggestMapping(user.tenantId, pa!.id);
    expect(Array.isArray(suggestions)).toBe(true);
  });

  it('should prevent double-mapping to same COA account', async () => {
    const { user } = await createTestUser();

    const bankAccount = await db.query.accounts.findFirst({
      where: and(eq(accounts.tenantId, user.tenantId), eq(accounts.detailType, 'bank')),
    });
    if (!bankAccount) return;

    const [item] = await db.insert(plaidItems).values({
      plaidItemId: 'test-item',
      accessTokenEncrypted: encrypt('token'),
      createdBy: user.id,
    }).returning();

    const [pa1] = await db.insert(plaidAccounts).values({
      plaidItemId: item!.id, plaidAccountId: 'acct-1', accountType: 'depository', mask: '1111',
    }).returning();

    const [pa2] = await db.insert(plaidAccounts).values({
      plaidItemId: item!.id, plaidAccountId: 'acct-2', accountType: 'depository', mask: '2222',
    }).returning();

    // Map first account
    await plaidMappingService.assignAccountToCompany(pa1!.id, user.tenantId, bankAccount.id, null, user.id);

    // Second account mapping to same COA should fail
    await expect(plaidMappingService.assignAccountToCompany(pa2!.id, user.tenantId, bankAccount.id, null, user.id))
      .rejects.toThrow(/already linked/);
  });

  it('should enforce one bank account to one company', async () => {
    const { user } = await createTestUser();

    const bankAccount = await db.query.accounts.findFirst({
      where: and(eq(accounts.tenantId, user.tenantId), eq(accounts.detailType, 'bank')),
    });
    if (!bankAccount) return;

    const [item] = await db.insert(plaidItems).values({
      plaidItemId: 'single-map-test',
      accessTokenEncrypted: encrypt('token'),
      createdBy: user.id,
    }).returning();

    const [pa] = await db.insert(plaidAccounts).values({
      plaidItemId: item!.id, plaidAccountId: 'acct-single', accountType: 'depository', mask: '3333',
    }).returning();

    // Map to one company
    await plaidMappingService.assignAccountToCompany(pa!.id, user.tenantId, bankAccount.id, null, user.id);

    // Try to map same account to another company (even with different COA) — should fail (one bank account → one company)
    const otherBankAccount = (await db.select().from(accounts).where(and(eq(accounts.tenantId, user.tenantId), eq(accounts.detailType, 'bank'))))
      .find((a) => a.id !== bankAccount.id);
    if (otherBankAccount) {
      await expect(plaidMappingService.assignAccountToCompany(pa!.id, user.tenantId, otherBankAccount.id, null, user.id))
        .rejects.toThrow(/already assigned/);
    }
  });
});

describe('Plaid full re-import (resetAndResyncItem)', () => {
  beforeEach(async () => { await cleanDb(); syncMocks.syncTransactions.mockReset(); syncMocks.getBalances.mockReset(); });
  afterEach(async () => { await cleanDb(); });

  it('clears the sync cursor so Plaid replays full history, then syncs', async () => {
    const { user } = await createTestUser();
    const bankAccount = await db.query.accounts.findFirst({
      where: and(eq(accounts.tenantId, user.tenantId), eq(accounts.detailType, 'bank')),
    });
    if (!bankAccount) return;

    // Item with a NON-null cursor (as if it had already synced past the
    // now-deleted transactions) + a mapping owned by the tenant.
    const [item] = await db.insert(plaidItems).values({
      plaidItemId: 'resync-item', accessTokenEncrypted: encrypt('tok'),
      createdBy: user.id, syncCursor: 'CURSOR_PAST_DELETED_TXNS',
    }).returning();
    const [pa] = await db.insert(plaidAccounts).values({
      plaidItemId: item!.id, plaidAccountId: 'resync-acct', accountType: 'depository', mask: '4444',
    }).returning();
    await plaidMappingService.assignAccountToCompany(pa!.id, user.tenantId, bankAccount.id, null, user.id);

    // Plaid replays from a null cursor: assert the cursor passed to
    // syncTransactions is null/undefined (full replay), not the old value.
    syncMocks.syncTransactions.mockResolvedValue({ added: [], modified: [], removed: [], nextCursor: 'NEW' });
    syncMocks.getBalances.mockResolvedValue([]);

    await plaidSyncService.resetAndResyncItem(item!.id, user.tenantId);

    expect(syncMocks.syncTransactions).toHaveBeenCalled();
    const cursorArg = syncMocks.syncTransactions.mock.calls[0]![1];
    expect(cursorArg == null).toBe(true); // null/undefined → Plaid full replay
  });

  it('is tenant-scoped: another tenant cannot reset the cursor', async () => {
    const { user } = await createTestUser();
    const [item] = await db.insert(plaidItems).values({
      plaidItemId: 'resync-scoped', accessTokenEncrypted: encrypt('tok'), createdBy: user.id, syncCursor: 'C',
    }).returning();
    const [pa] = await db.insert(plaidAccounts).values({
      plaidItemId: item!.id, plaidAccountId: 'scoped-acct', accountType: 'depository', mask: '5555',
    }).returning();
    const bankAccount = await db.query.accounts.findFirst({
      where: and(eq(accounts.tenantId, user.tenantId), eq(accounts.detailType, 'bank')),
    });
    if (bankAccount) await plaidMappingService.assignAccountToCompany(pa!.id, user.tenantId, bankAccount.id, null, user.id);

    await expect(plaidSyncService.resetAndResyncItem(item!.id, '00000000-0000-0000-0000-000000000000'))
      .rejects.toThrow(/not found/i);
    // Cursor untouched for the wrong tenant.
    const after = await db.query.plaidItems.findFirst({ where: eq(plaidItems.id, item!.id) });
    expect(after!.syncCursor).toBe('C');
    expect(syncMocks.syncTransactions).not.toHaveBeenCalled();
  });
});

describe('manual sync freshness + sync-start-date visibility', () => {
  beforeEach(async () => {
    await cleanDb();
    syncMocks.syncTransactions.mockReset();
    syncMocks.getBalances.mockReset();
    syncMocks.refreshTransactions.mockReset();
    syncMocks.runCleansingPipeline.mockResolvedValue({ processed: 0, aiCleansed: 0, aiFailed: 0, disabled: 0 });
    syncMocks.runCategorizationPipeline.mockResolvedValue(undefined);
  });
  afterEach(async () => { await cleanDb(); });

  async function seedMappedItem(syncStartDate: string | null = null) {
    const { user } = await createTestUser();
    const bankAccount = await db.query.accounts.findFirst({
      where: and(eq(accounts.tenantId, user.tenantId), eq(accounts.detailType, 'bank')),
    });
    const [item] = await db.insert(plaidItems).values({
      plaidItemId: 'fresh-item-' + Date.now(), accessTokenEncrypted: encrypt('tok'), createdBy: user.id,
    }).returning();
    const [pa] = await db.insert(plaidAccounts).values({
      plaidItemId: item!.id, plaidAccountId: 'fresh-acct', accountType: 'depository', mask: '9999',
    }).returning();
    await plaidMappingService.assignAccountToCompany(pa!.id, user.tenantId, bankAccount!.id, syncStartDate, user.id);
    return { item: item!, user };
  }

  it('refresh option asks Plaid to poll the institution BEFORE syncing', async () => {
    const { item } = await seedMappedItem();
    syncMocks.refreshTransactions.mockResolvedValue(undefined);
    syncMocks.syncTransactions.mockResolvedValue({ added: [], modified: [], removed: [], nextCursor: 'N1' });
    syncMocks.getBalances.mockResolvedValue([]);

    const result = await plaidSyncService.syncItem(item.id, { refresh: true, refreshWaitMs: 0 });

    expect(syncMocks.refreshTransactions).toHaveBeenCalledTimes(1);
    expect(result.refreshRequested).toBe(true);
    const refreshOrder = syncMocks.refreshTransactions.mock.invocationCallOrder[0]!;
    const syncOrder = syncMocks.syncTransactions.mock.invocationCallOrder[0]!;
    expect(refreshOrder).toBeLessThan(syncOrder);
  });

  it('a failed refresh never blocks the normal cursor sync', async () => {
    const { item } = await seedMappedItem();
    syncMocks.refreshTransactions.mockRejectedValue(new Error('PRODUCT_NOT_ENABLED'));
    syncMocks.syncTransactions.mockResolvedValue({ added: [], modified: [], removed: [], nextCursor: 'N2' });
    syncMocks.getBalances.mockResolvedValue([]);

    const result = await plaidSyncService.syncItem(item.id, { refresh: true, refreshWaitMs: 0 });
    expect(result.refreshRequested).toBe(false);
    expect(syncMocks.syncTransactions).toHaveBeenCalledTimes(1);
  });

  it('counts transactions skipped by the sync start date instead of dropping them silently', async () => {
    const { item } = await seedMappedItem('2026-07-01');
    syncMocks.syncTransactions.mockResolvedValue({
      added: [
        { transaction_id: 'old-1', account_id: 'fresh-acct', date: '2026-06-15', name: 'OLD CHARGE', amount: 10 },
        { transaction_id: 'new-1', account_id: 'fresh-acct', date: '2026-07-10', name: 'NEW CHARGE', amount: 20 },
      ],
      modified: [], removed: [], nextCursor: 'N3',
    });
    syncMocks.getBalances.mockResolvedValue([]);

    const result = await plaidSyncService.syncItem(item.id);
    expect(result.added).toBe(1);
    expect(result.skippedByStartDate).toBe(1);
  });
});

describe('detectAccountsConnectedElsewhere (cross-tenant duplicate warning)', () => {
  beforeEach(async () => { await cleanDb(); });
  afterEach(async () => { await cleanDb(); });

  // Seed a plaid item + account mapped to a DIFFERENT tenant than the caller.
  async function seedOtherTenantAccount(callerUserId: string, opts: {
    persistentAccountId?: string | null; mask: string; subtype: string; institutionId: string;
  }) {
    const [tenantA] = await db.insert(tenants).values({
      name: 'Other Tenant', slug: 'other-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6),
    }).returning();
    const [acctA] = await db.insert(accounts).values({
      tenantId: tenantA!.id, name: 'A Checking', accountType: 'asset', detailType: 'bank',
    }).returning();
    const [itemA] = await db.insert(plaidItems).values({
      plaidItemId: 'other-item-' + Math.random().toString(36).slice(2, 8),
      accessTokenEncrypted: encrypt('tok'),
      plaidInstitutionId: opts.institutionId,
      createdBy: callerUserId,
    }).returning();
    const [paA] = await db.insert(plaidAccounts).values({
      plaidItemId: itemA!.id,
      plaidAccountId: 'other-acct-' + Math.random().toString(36).slice(2, 8),
      persistentAccountId: opts.persistentAccountId ?? null,
      accountType: 'depository', accountSubtype: opts.subtype, mask: opts.mask,
    }).returning();
    await db.insert(plaidAccountMappings).values({
      plaidAccountId: paA!.id, tenantId: tenantA!.id, mappedAccountId: acctA!.id,
      isSyncEnabled: true, mappedBy: callerUserId,
    });
    return { tenantA: tenantA!, paA: paA! };
  }

  it('detects a match in another tenant by persistent_account_id', async () => {
    const { user } = await createTestUser();
    await seedOtherTenantAccount(user.id, { persistentAccountId: 'PERSIST-1', mask: '9999', subtype: 'checking', institutionId: 'ins_1' });

    const hit = await plaidConnectionService.detectAccountsConnectedElsewhere(user.id, 'ins_1', [
      { persistent_account_id: 'PERSIST-1', mask: '9999', subtype: 'checking' },
    ]);
    expect(hit).toBe(true);
  });

  it('falls back to institution + mask + subtype when persistent id is absent', async () => {
    const { user } = await createTestUser();
    await seedOtherTenantAccount(user.id, { persistentAccountId: null, mask: '9999', subtype: 'checking', institutionId: 'ins_1' });

    const hit = await plaidConnectionService.detectAccountsConnectedElsewhere(user.id, 'ins_1', [
      { persistent_account_id: null, mask: '9999', subtype: 'checking' },
    ]);
    expect(hit).toBe(true);
  });

  it('returns false when the only match is in the caller\'s OWN tenant', async () => {
    const { user } = await createTestUser();
    const bankAccount = await db.query.accounts.findFirst({
      where: and(eq(accounts.tenantId, user.tenantId), eq(accounts.detailType, 'bank')),
    });
    if (!bankAccount) return;
    const [item] = await db.insert(plaidItems).values({
      plaidItemId: 'self-item', accessTokenEncrypted: encrypt('tok'), plaidInstitutionId: 'ins_1', createdBy: user.id,
    }).returning();
    const [pa] = await db.insert(plaidAccounts).values({
      plaidItemId: item!.id, plaidAccountId: 'self-acct', persistentAccountId: 'PERSIST-SELF',
      accountType: 'depository', accountSubtype: 'checking', mask: '9999',
    }).returning();
    await db.insert(plaidAccountMappings).values({
      plaidAccountId: pa!.id, tenantId: user.tenantId, mappedAccountId: bankAccount.id, isSyncEnabled: true, mappedBy: user.id,
    });

    const self = await plaidConnectionService.detectAccountsConnectedElsewhere(user.id, 'ins_1', [
      { persistent_account_id: 'PERSIST-SELF', mask: '9999', subtype: 'checking' },
    ]);
    expect(self).toBe(false);
  });

  it('returns false for an account not connected anywhere', async () => {
    const { user } = await createTestUser();
    await seedOtherTenantAccount(user.id, { persistentAccountId: 'PERSIST-1', mask: '9999', subtype: 'checking', institutionId: 'ins_1' });

    const miss = await plaidConnectionService.detectAccountsConnectedElsewhere(user.id, 'ins_2', [
      { persistent_account_id: 'PERSIST-UNKNOWN', mask: '0000', subtype: 'savings' },
    ]);
    expect(miss).toBe(false);
  });
});

describe('Plaid Webhook Service (System-Scoped)', () => {
  beforeEach(async () => { await cleanDb(); });
  afterEach(async () => { await cleanDb(); });

  it('should log webhooks', async () => {
    await plaidWebhookService.handleWebhook({
      webhook_type: 'TRANSACTIONS',
      webhook_code: 'SYNC_UPDATES_AVAILABLE',
      item_id: 'nonexistent-item',
    });

    const logs = await db.select().from(plaidWebhookLog);
    expect(logs.length).toBeGreaterThanOrEqual(1);
    expect(logs[0]!.webhookType).toBe('TRANSACTIONS');
  });

  it('should update item status on LOGIN_REPAIRED', async () => {
    const { user } = await createTestUser();
    const [item] = await db.insert(plaidItems).values({
      plaidItemId: 'webhook-test-item',
      accessTokenEncrypted: encrypt('token'),
      itemStatus: 'login_required',
      errorCode: 'ITEM_LOGIN_REQUIRED',
      createdBy: user.id,
    }).returning();

    await plaidWebhookService.handleWebhook({
      webhook_type: 'ITEM',
      webhook_code: 'LOGIN_REPAIRED',
      item_id: 'webhook-test-item',
    });

    const updated = await db.query.plaidItems.findFirst({ where: eq(plaidItems.id, item!.id) });
    expect(updated!.itemStatus).toBe('active');
    expect(updated!.errorCode).toBeNull();
  });

  it('should handle USER_PERMISSION_REVOKED', async () => {
    const { user } = await createTestUser();
    await db.insert(plaidItems).values({
      plaidItemId: 'revoked-item',
      accessTokenEncrypted: encrypt('token'),
      createdBy: user.id,
    });

    await plaidWebhookService.handleWebhook({
      webhook_type: 'ITEM',
      webhook_code: 'USER_PERMISSION_REVOKED',
      item_id: 'revoked-item',
    });

    const item = await db.query.plaidItems.findFirst({
      where: eq(plaidItems.plaidItemId, 'revoked-item'),
    });
    expect(item!.itemStatus).toBe('revoked');
  });
});

describe('Plaid Sync — sign convention + originalDescription (F5)', () => {
  beforeEach(async () => {
    await cleanDb();
    syncMocks.syncTransactions.mockReset();
    syncMocks.getBalances.mockReset().mockResolvedValue([]);
    syncMocks.runCleansingPipeline.mockReset().mockResolvedValue({
      processed: 0, aiCleansed: 0, aiFailed: 0, disabled: 0,
    });
    syncMocks.runCategorizationPipeline.mockReset().mockResolvedValue(undefined);
  });
  afterEach(async () => { await cleanDb(); });

  async function setupMappedItem() {
    const { user } = await createTestUser();
    const bankAccount = await db.query.accounts.findFirst({
      where: and(eq(accounts.tenantId, user.tenantId), eq(accounts.detailType, 'bank')),
    });
    expect(bankAccount).toBeDefined();

    const [item] = await db.insert(plaidItems).values({
      plaidItemId: 'sync-sign-item',
      accessTokenEncrypted: encrypt('access-token'),
      institutionName: 'Sign Test Bank',
      createdBy: user.id,
    }).returning();

    const [pa] = await db.insert(plaidAccounts).values({
      plaidItemId: item!.id,
      plaidAccountId: 'acct-sign',
      name: 'Sign Checking',
      accountType: 'depository',
      mask: '4242',
    }).returning();

    await db.insert(plaidAccountMappings).values({
      plaidAccountId: pa!.id,
      tenantId: user.tenantId,
      mappedAccountId: bankAccount!.id,
      isSyncEnabled: true,
      mappedBy: user.id,
    });

    return { user, item: item!, pa: pa! };
  }

  it('preserves the Plaid sign in both directions and sets originalDescription', async () => {
    const { user, item } = await setupMappedItem();

    // Plaid convention: positive = money OUT (spend), negative = money IN.
    syncMocks.syncTransactions.mockResolvedValue({
      added: [
        {
          transaction_id: 'txn-out', account_id: 'acct-sign', date: '2026-06-01',
          name: 'COFFEE SHOP #42', merchant_name: 'Coffee Shop', amount: 25.5,
          personal_finance_category: { primary: 'FOOD_AND_DRINK' },
        },
        {
          transaction_id: 'txn-in', account_id: 'acct-sign', date: '2026-06-02',
          name: 'PAYROLL DEPOSIT ACME', amount: -1500,
        },
      ],
      modified: [], removed: [], nextCursor: 'cursor-1',
    });

    const result = await plaidSyncService.syncItem(item.id);
    expect(result.added).toBe(2);

    const rows = await db.select().from(bankFeedItems)
      .where(eq(bankFeedItems.tenantId, user.tenantId))
      .orderBy(asc(bankFeedItems.feedDate));
    expect(rows).toHaveLength(2);

    const spend = rows.find((r) => r.providerTransactionId === 'txn-out')!;
    const deposit = rows.find((r) => r.providerTransactionId === 'txn-in')!;
    // Money out stays positive (app convention: positive = spend)…
    expect(parseFloat(spend.amount)).toBeCloseTo(25.5, 4);
    // …and money in stays NEGATIVE — Math.abs() here was the sign bug.
    expect(parseFloat(deposit.amount)).toBeCloseTo(-1500, 4);
    // originalDescription is populated (dedup + learning key off it).
    expect(spend.originalDescription).toBe('COFFEE SHOP #42');
    expect(deposit.originalDescription).toBe('PAYROLL DEPOSIT ACME');
  });

  it('carries the cleansing aggregate on the sync result', async () => {
    const { item } = await setupMappedItem();
    syncMocks.syncTransactions.mockResolvedValue({
      added: [
        { transaction_id: 'txn-1', account_id: 'acct-sign', date: '2026-06-01', name: 'VENDOR X', amount: 10 },
      ],
      modified: [], removed: [], nextCursor: 'cursor-1',
    });
    syncMocks.runCleansingPipeline.mockResolvedValue({
      processed: 1, aiCleansed: 0, aiFailed: 1, disabled: 0, firstError: 'llm down',
    });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await plaidSyncService.syncItem(item.id);

    expect(result.cleansing).toMatchObject({ processed: 1, aiFailed: 1, firstError: 'llm down' });
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('[plaid-sync] AI cleanup unavailable'))).toBe(true);
    warnSpy.mockRestore();
  });

  it('modified transactions keep the signed amount too (no Math.abs)', async () => {
    const { user, item } = await setupMappedItem();

    syncMocks.syncTransactions.mockResolvedValue({
      added: [
        { transaction_id: 'txn-mod', account_id: 'acct-sign', date: '2026-06-01', name: 'REFUND PENDING', amount: -20 },
      ],
      modified: [], removed: [], nextCursor: 'cursor-1',
    });
    await plaidSyncService.syncItem(item.id);

    // Second sync run delivers the same transaction as `modified` with an
    // updated (still negative) amount. Clear the 30s claim debounce first.
    await db.update(plaidItems).set({ lastSyncAt: new Date(Date.now() - 60_000) })
      .where(eq(plaidItems.id, item.id));
    syncMocks.syncTransactions.mockResolvedValue({
      added: [],
      modified: [
        { transaction_id: 'txn-mod', account_id: 'acct-sign', date: '2026-06-03', name: 'REFUND POSTED', amount: -22.75 },
      ],
      removed: [], nextCursor: 'cursor-2',
    });
    const result = await plaidSyncService.syncItem(item.id);
    expect(result.modified).toBe(1);

    const row = await db.query.bankFeedItems.findFirst({
      where: and(eq(bankFeedItems.tenantId, user.tenantId), eq(bankFeedItems.providerTransactionId, 'txn-mod')),
    });
    expect(parseFloat(row!.amount)).toBeCloseTo(-22.75, 4);
    expect(row!.originalDescription).toBe('REFUND POSTED');
  });
});
