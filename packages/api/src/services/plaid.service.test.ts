// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

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
import * as plaidMappingService from './plaid-mapping.service.js';
import * as plaidWebhookService from './plaid-webhook.service.js';
import * as plaidSyncService from './plaid-sync.service.js';
import { encrypt, decrypt } from '../utils/encryption.js';
import { eq, and, asc } from 'drizzle-orm';

// syncItem's upstream calls are mocked (partial module mock — the config
// service functions stay real); the bank-feed pipelines are mocked so sync
// tests exercise routing/insert semantics without the full cleansing stack.
const syncMocks = vi.hoisted(() => ({
  syncTransactions: vi.fn(),
  getBalances: vi.fn(),
  runCleansingPipeline: vi.fn(),
  runCategorizationPipeline: vi.fn(),
}));

vi.mock('./plaid-client.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./plaid-client.service.js')>();
  return {
    ...actual,
    syncTransactions: (...args: unknown[]) => syncMocks.syncTransactions(...args),
    getBalances: (...args: unknown[]) => syncMocks.getBalances(...args),
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

async function cleanDb() {
  await db.delete(plaidWebhookLog);
  await db.delete(plaidItemActivity);
  await db.delete(plaidAccountMappings);
  await db.delete(plaidAccounts);
  await db.delete(plaidItems);
  await db.delete(plaidConfig);
  await db.delete(auditLog);
  // Known FK-pollution fix: bank_feed_items / bank_statement_lines /
  // bank_statements / bank_connections rows reference accounts, so they must
  // go before the accounts delete or it fails and leaks rows across files.
  await db.delete(bankFeedItems);
  await db.delete(bankStatementLines);
  await db.delete(bankStatements);
  await db.delete(bankConnections);
  await db.delete(accounts);
  await db.delete(companies);
  await db.delete(sessions);
  await db.delete(users);
  await db.delete(tenants);
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
