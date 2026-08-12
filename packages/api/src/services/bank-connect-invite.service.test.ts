// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Bank connection invites — token lifecycle, SMS gating, and the public
// exchange path. Plaid's API is mocked at the plaid-client seam (same
// partial-module-mock pattern as plaid.service.test.ts); the real
// plaid-connection.createConnection runs so attribution and the orphan
// guard are exercised for real.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, sessions, companies, auditLog,
  bankConnectInvites, plaidItems, plaidAccounts, plaidItemActivity,
  portalSettingsPerPractice, tenantFeatureFlags,
} from '../db/schema/index.js';
import * as inviteService from './bank-connect-invite.service.js';

const plaidMocks = vi.hoisted(() => ({
  createLinkToken: vi.fn(),
  exchangePublicToken: vi.fn(),
  getAccounts: vi.fn(),
  removeItem: vi.fn(),
}));

vi.mock('./plaid-client.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./plaid-client.service.js')>();
  return {
    ...actual,
    createLinkToken: (...args: unknown[]) => plaidMocks.createLinkToken(...args),
    exchangePublicToken: (...args: unknown[]) => plaidMocks.exchangePublicToken(...args),
    getAccounts: (...args: unknown[]) => plaidMocks.getAccounts(...args),
    removeItem: (...args: unknown[]) => plaidMocks.removeItem(...args),
  };
});

let tenantId: string;
let userId: string;

const BASE_URL = 'https://books.example.com';

async function cleanDb() {
  if (!tenantId) return;
  // plaid_items are appliance-global — chase them via createdBy.
  const itemIds = (await db.select({ id: plaidItems.id }).from(plaidItems)
    .where(eq(plaidItems.createdBy, userId))).map((r) => r.id);
  if (itemIds.length > 0) {
    await db.delete(plaidItemActivity).where(inArray(plaidItemActivity.plaidItemId, itemIds));
    await db.delete(plaidAccounts).where(inArray(plaidAccounts.plaidItemId, itemIds));
    await db.delete(plaidItems).where(inArray(plaidItems.id, itemIds));
  }
  await db.delete(bankConnectInvites).where(eq(bankConnectInvites.tenantId, tenantId));
  await db.delete(tenantFeatureFlags).where(eq(tenantFeatureFlags.tenantId, tenantId));
  await db.delete(portalSettingsPerPractice).where(eq(portalSettingsPerPractice.tenantId, tenantId));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(sessions).where(
    inArray(sessions.userId, db.select({ id: users.id }).from(users).where(eq(users.tenantId, tenantId))),
  );
  await db.delete(users).where(eq(users.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  tenantId = '';
}

async function setup() {
  const [tenant] = await db.insert(tenants).values({
    name: 'Invite Test Firm',
    slug: 'bci-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
  }).returning();
  tenantId = tenant!.id;
  const [user] = await db.insert(users).values({
    tenantId,
    email: `inviter-${Date.now()}@example.com`,
    passwordHash: 'x',
    displayName: 'Ivy Inviter',
  }).returning();
  userId = user!.id;
}

async function mkInvite(overrides: Partial<Parameters<typeof inviteService.createInvite>[0]> = {}) {
  return inviteService.createInvite({
    tenantId,
    createdBy: userId,
    recipientName: 'Cleo Client',
    email: 'cleo@example.com',
    baseUrl: BASE_URL,
    ...overrides,
  });
}

/** Pull the raw token out of the emailed link via the mail stub. */
function captureTokenFromStub(spy: ReturnType<typeof vi.spyOn>): string {
  const call = spy.mock.calls.map((c) => String(c[0]))
    .find((line) => line.includes('bank-connect-mail-stub') && line.includes('/connect/'));
  expect(call, 'expected a mail-stub log line with the invite link').toBeTruthy();
  const m = /\/connect\/([a-f0-9]{64})/.exec(call!);
  expect(m).toBeTruthy();
  return m![1]!;
}

describe('Bank connection invites', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await cleanDb();
    await setup();
    Object.values(plaidMocks).forEach((m) => m.mockReset());
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(async () => {
    logSpy.mockRestore();
    await cleanDb();
  });

  it('mints an invite storing only the token hash, with a 7-day expiry', async () => {
    const { inviteId, channels } = await mkInvite();
    expect(channels).toEqual(['email']);
    const token = captureTokenFromStub(logSpy);

    const row = await db.query.bankConnectInvites.findFirst({ where: eq(bankConnectInvites.id, inviteId) });
    expect(row!.tokenHash).toBe(crypto.createHash('sha256').update(token).digest('hex'));
    expect(row!.tokenHash).not.toBe(token);
    expect(row!.status).toBe('sent');
    expect(row!.createdByName).toBe('Ivy Inviter');
    const ttlDays = (row!.expiresAt.getTime() - Date.now()) / 86400000;
    expect(ttlDays).toBeGreaterThan(6.9);
    expect(ttlDays).toBeLessThanOrEqual(7.01);
  });

  it('rejects SMS when the practice outbound switch is off, and requires some channel', async () => {
    await expect(mkInvite({ email: undefined, phone: undefined }))
      .rejects.toThrow(/email address, a phone number/i);
    // No portal settings row → smsOutboundEnabled defaults false.
    await expect(mkInvite({ email: undefined, phone: '5551234567' }))
      .rejects.toThrow(/Outbound SMS is disabled/i);
  });

  it('loadInviteByToken stamps viewed, auto-expires, and blocks revoked', async () => {
    const { inviteId } = await mkInvite();
    const token = captureTokenFromStub(logSpy);

    const first = await inviteService.loadInviteByToken(token);
    expect(first.status).toBe('viewed');
    expect(first.recipientName).toBe('Cleo Client');
    expect(first.firmName).toBe('Invite Test Firm');

    // Force-expire, then load → EXPIRED + status flip.
    await db.update(bankConnectInvites).set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(bankConnectInvites.id, inviteId));
    await expect(inviteService.loadInviteByToken(token)).rejects.toThrow(/expired/i);
    const row = await db.query.bankConnectInvites.findFirst({ where: eq(bankConnectInvites.id, inviteId) });
    expect(row!.status).toBe('expired');

    // Revive via resend, then revoke → REVOKED.
    await inviteService.resendInvite(tenantId, inviteId, userId, BASE_URL);
    await inviteService.revokeInvite(tenantId, inviteId, userId);
    const token2 = logSpy.mock.calls.map((c) => String(c[0]))
      .filter((l) => l.includes('/connect/')).map((l) => /\/connect\/([a-f0-9]{64})/.exec(l)![1]!).pop()!;
    await expect(inviteService.loadInviteByToken(token2)).rejects.toThrow(/deactivated/i);
    // Unknown token is a plain 404.
    await expect(inviteService.loadInviteByToken('0'.repeat(64))).rejects.toThrow(/Invalid or expired/i);
  });

  it('resend rotates the token: the old link dies, the new one works', async () => {
    const { inviteId } = await mkInvite();
    const oldToken = captureTokenFromStub(logSpy);
    logSpy.mockClear();

    await inviteService.resendInvite(tenantId, inviteId, userId, BASE_URL);
    const newToken = captureTokenFromStub(logSpy);
    expect(newToken).not.toBe(oldToken);

    await expect(inviteService.loadInviteByToken(oldToken)).rejects.toThrow(/Invalid or expired/i);
    const loaded = await inviteService.loadInviteByToken(newToken);
    expect(loaded.recipientName).toBe('Cleo Client');
  });

  it('createLinkTokenForInvite derives the pseudo user id from the invite', async () => {
    const { inviteId } = await mkInvite();
    const token = captureTokenFromStub(logSpy);
    plaidMocks.createLinkToken.mockResolvedValue('link-sandbox-abc');

    const { linkToken } = await inviteService.createLinkTokenForInvite(token);
    expect(linkToken).toBe('link-sandbox-abc');
    expect(plaidMocks.createLinkToken).toHaveBeenCalledWith('system', `bank-invite:${inviteId}`, expect.anything());
  });

  it('exchange attributes the connection to the INVITER and stamps the invite; second bank increments', async () => {
    const { inviteId } = await mkInvite();
    const token = captureTokenFromStub(logSpy);
    const mkAccount = (id: string) => ({
      account_id: id, persistent_account_id: null, name: 'Checking',
      official_name: null, type: 'depository', subtype: 'checking', mask: '1234',
      balances: { current: 100, available: 90, iso_currency_code: 'USD' },
    });
    const itemId1 = `plaid-item-1-${tenantId}`;
    plaidMocks.exchangePublicToken.mockResolvedValueOnce({ accessToken: 'at-1', itemId: itemId1 });
    plaidMocks.getAccounts.mockResolvedValueOnce([mkAccount(`acc-1-${tenantId}`)]);

    const result = await inviteService.completeInviteConnection(token, 'public-1', {
      institutionName: 'First Bank', accounts: [{}, {}],
    });
    expect(result).toMatchObject({ ok: true, institutionName: 'First Bank', accountCount: 2 });

    const item = await db.query.plaidItems.findFirst({ where: eq(plaidItems.plaidItemId, itemId1) });
    expect(item!.createdBy).toBe(userId);
    expect(item!.createdByName).toBe('Ivy Inviter');

    let invite = await db.query.bankConnectInvites.findFirst({ where: eq(bankConnectInvites.id, inviteId) });
    expect(invite!.status).toBe('connected');
    expect(invite!.connectionsCount).toBe(1);
    expect(invite!.connectedPlaidItemId).toBe(item!.id);
    const firstConnectedAt = invite!.connectedAt;

    // Invite remains live: a SECOND institution connects on the same link.
    plaidMocks.exchangePublicToken.mockResolvedValueOnce({ accessToken: 'at-2', itemId: `plaid-item-2-${tenantId}` });
    plaidMocks.getAccounts.mockResolvedValueOnce([mkAccount(`acc-2-${tenantId}`)]);
    await inviteService.completeInviteConnection(token, 'public-2', { institutionName: 'Second Bank' });
    invite = await db.query.bankConnectInvites.findFirst({ where: eq(bankConnectInvites.id, inviteId) });
    expect(invite!.connectionsCount).toBe(2);
    // First-connection stamps are preserved.
    expect(invite!.connectedAt?.getTime()).toBe(firstConnectedAt?.getTime());
    expect(invite!.connectedPlaidItemId).toBe(item!.id);
  });

  it('orphan guard: a failure after the exchange removes the Item at Plaid', async () => {
    await mkInvite();
    const token = captureTokenFromStub(logSpy);
    plaidMocks.exchangePublicToken.mockResolvedValue({ accessToken: 'at-orphan', itemId: 'plaid-item-x' });
    plaidMocks.getAccounts.mockRejectedValue(new Error('ITEM_LOGIN_REQUIRED'));
    plaidMocks.removeItem.mockResolvedValue(undefined);

    await expect(inviteService.completeInviteConnection(token, 'public-x', {}))
      .rejects.toThrow('ITEM_LOGIN_REQUIRED');
    expect(plaidMocks.removeItem).toHaveBeenCalledWith('at-orphan');
  });

  it('a revoked invite rejects the exchange BEFORE spending the public token', async () => {
    const { inviteId } = await mkInvite();
    const token = captureTokenFromStub(logSpy);
    await inviteService.revokeInvite(tenantId, inviteId, userId);

    await expect(inviteService.completeInviteConnection(token, 'public-y', {}))
      .rejects.toThrow(/deactivated/i);
    expect(plaidMocks.exchangePublicToken).not.toHaveBeenCalled();
  });

  it('SMS body stays a single GSM-7 segment for realistic links', () => {
    const link = `${BASE_URL}/connect/${'a'.repeat(64)}`;
    const body = inviteService.buildInviteSmsBody(link);
    expect(body).toContain(link);
    expect(body.length).toBeLessThanOrEqual(160);
  });
});
