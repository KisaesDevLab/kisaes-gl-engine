// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { db } from '../db/index.js';
import { tenants, users, sessions, companies, accounts, plaidConfig, plaidItems, plaidAccounts, plaidAccountMappings, plaidItemActivity, plaidWebhookLog } from '../db/schema/index.js';
import { auditLog } from '../db/schema/index.js';
import * as authService from './auth.service.js';
import * as plaidClientService from './plaid-client.service.js';
import * as plaidMappingService from './plaid-mapping.service.js';
import * as plaidWebhookService from './plaid-webhook.service.js';
import { encrypt, decrypt } from '../utils/encryption.js';
import { eq, and } from 'drizzle-orm';

async function cleanDb() {
  await db.delete(plaidWebhookLog);
  await db.delete(plaidItemActivity);
  await db.delete(plaidAccountMappings);
  await db.delete(plaidAccounts);
  await db.delete(plaidItems);
  await db.delete(plaidConfig);
  await db.delete(auditLog);
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
