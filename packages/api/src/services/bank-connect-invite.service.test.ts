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
import { eq, and, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, sessions, companies, auditLog,
  bankConnectInvites, plaidItems, plaidAccounts, plaidItemActivity,
  portalSettingsPerPractice, tenantFeatureFlags,
} from '../db/schema/index.js';
import * as inviteService from './bank-connect-invite.service.js';

const plaidMocks = vi.hoisted(() => ({
  createLinkToken: vi.fn(),
  createUpdateLinkToken: vi.fn(),
  exchangePublicToken: vi.fn(),
  getAccounts: vi.fn(),
  removeItem: vi.fn(),
}));

vi.mock('./plaid-client.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./plaid-client.service.js')>();
  return {
    ...actual,
    createLinkToken: (...args: unknown[]) => plaidMocks.createLinkToken(...args),
    createUpdateLinkToken: (...args: unknown[]) => plaidMocks.createUpdateLinkToken(...args),
    exchangePublicToken: (...args: unknown[]) => plaidMocks.exchangePublicToken(...args),
    getAccounts: (...args: unknown[]) => plaidMocks.getAccounts(...args),
    removeItem: (...args: unknown[]) => plaidMocks.removeItem(...args),
  };
});

// completeInviteRepair kicks a sync to verify + self-heal the item; keep
// the real module otherwise (nothing else in this suite touches it).
const syncMocks = vi.hoisted(() => ({ syncItem: vi.fn() }));
vi.mock('./plaid-sync.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./plaid-sync.service.js')>();
  return { ...actual, syncItem: (...args: unknown[]) => syncMocks.syncItem(...args) };
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
    const repair = inviteService.buildRepairSmsBody(link);
    expect(repair).toContain(link);
    expect(repair.length).toBeLessThanOrEqual(160);
  });
});

// ─── Repair invites (Plaid Link update mode) ─────────────────────

describe('Bank connection repair invites', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await cleanDb();
    await setup();
    Object.values(plaidMocks).forEach((m) => m.mockReset());
    syncMocks.syncItem.mockReset();
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(async () => {
    logSpy.mockRestore();
    await cleanDb();
  });

  /** Broken item + the connect invite that originally created it. */
  async function seedBrokenItem(): Promise<{ itemId: string; priorInviteId: string }> {
    const { encrypt } = await import('../utils/encryption.js');
    const [item] = await db.insert(plaidItems).values({
      plaidItemId: 'item-' + Math.random().toString(36).slice(2, 10),
      institutionName: 'U.S. Bank',
      accessTokenEncrypted: encrypt('access-token-123'),
      createdBy: userId,
      itemStatus: 'login_required',
      errorCode: 'ITEM_LOGIN_REQUIRED',
    }).returning();
    const { inviteId } = await mkInvite();
    await db.update(bankConnectInvites).set({
      connectedPlaidItemId: item!.id, status: 'connected', connectedAt: new Date(),
    }).where(eq(bankConnectInvites.id, inviteId));
    // The connect invite above logged its own mail-stub line; clear it so
    // captureTokenFromStub grabs the REPAIR link, not this one.
    logSpy.mockClear();
    return { itemId: item!.id, priorInviteId: inviteId };
  }

  it('createRepairInvite infers the recipient from the item invite trail and stamps kind/target', async () => {
    const { itemId } = await seedBrokenItem();
    const { inviteId, channels, recipientName } = await inviteService.createRepairInvite({
      plaidItemId: itemId, requestedBy: userId, baseUrl: BASE_URL,
    });
    expect(channels).toEqual(['email']);
    expect(recipientName).toBe('Cleo Client');

    const row = await db.query.bankConnectInvites.findFirst({ where: eq(bankConnectInvites.id, inviteId) });
    expect(row!.kind).toBe('repair');
    expect(row!.repairPlaidItemId).toBe(itemId);
    expect(row!.autoSent).toBe(false);
    expect(row!.recipientEmail).toBe('cleo@example.com');

    // Repair copy, not connect copy.
    const mail = logSpy.mock.calls.map((c) => String(c[0]))
      .filter((l) => l.includes('bank-connect-mail-stub'));
    expect(mail.some((l) => l.includes('update your U.S. Bank connection'))).toBe(true);
  });

  it('createRepairInvite refuses staff-connected items with no client on record', async () => {
    const { encrypt } = await import('../utils/encryption.js');
    const [item] = await db.insert(plaidItems).values({
      plaidItemId: 'item-' + Math.random().toString(36).slice(2, 10),
      institutionName: 'Staff Bank',
      accessTokenEncrypted: encrypt('tok'),
      createdBy: userId,
      itemStatus: 'login_required',
    }).returning();
    await expect(inviteService.createRepairInvite({
      plaidItemId: item!.id, requestedBy: userId, baseUrl: BASE_URL,
    })).rejects.toThrow(/No client on record/);
  });

  it('a repair link mints an UPDATE-mode token bound to the broken item', async () => {
    const { itemId } = await seedBrokenItem();
    await inviteService.createRepairInvite({ plaidItemId: itemId, requestedBy: userId, baseUrl: BASE_URL });
    const token = captureTokenFromStub(logSpy);

    plaidMocks.createUpdateLinkToken.mockResolvedValue('link-update-123');
    const res = await inviteService.createLinkTokenForInvite(token);
    expect(res.linkToken).toBe('link-update-123');
    expect(plaidMocks.createLinkToken).not.toHaveBeenCalled();
    const [, pseudoUser, accessToken] = plaidMocks.createUpdateLinkToken.mock.calls[0]!;
    expect(String(pseudoUser)).toMatch(/^bank-repair:/);
    expect(accessToken).toBe('access-token-123');
  });

  it('repair-complete syncs, stamps the invite, and rejects kind mismatches both ways', async () => {
    const { itemId, priorInviteId } = await seedBrokenItem();
    await inviteService.createRepairInvite({ plaidItemId: itemId, requestedBy: userId, baseUrl: BASE_URL });
    const repairToken = captureTokenFromStub(logSpy);

    // Exchange on a repair invite must not spend a public token.
    await expect(inviteService.completeInviteConnection(repairToken, 'public-tok', {}))
      .rejects.toThrow(/repairs an existing connection/);
    expect(plaidMocks.exchangePublicToken).not.toHaveBeenCalled();

    syncMocks.syncItem.mockResolvedValue({ added: 0, modified: 0, removed: 0 });
    const result = await inviteService.completeInviteRepair(repairToken);
    expect(result).toMatchObject({ ok: true, institutionName: 'U.S. Bank', healthy: true });
    expect(syncMocks.syncItem).toHaveBeenCalledWith(itemId);

    const row = await db.query.bankConnectInvites.findFirst({
      where: and(eq(bankConnectInvites.repairPlaidItemId, itemId), eq(bankConnectInvites.kind, 'repair')),
    });
    expect(row!.status).toBe('connected');
    expect(row!.connectionsCount).toBe(1);

    // repair-complete on the ORIGINAL connect invite is rejected. Its raw
    // token is gone (only the hash survives), so re-key the row with a
    // known token instead of re-sending.
    const knownToken = 'c'.repeat(64);
    await db.update(bankConnectInvites)
      .set({ tokenHash: crypto.createHash('sha256').update(knownToken).digest('hex') })
      .where(eq(bankConnectInvites.id, priorInviteId));
    await expect(inviteService.completeInviteRepair(knownToken)).rejects.toThrow(/not a repair link/);
  });

  it('a still-failing verify sync leaves the client flow green but reports healthy=false', async () => {
    const { itemId } = await seedBrokenItem();
    await inviteService.createRepairInvite({ plaidItemId: itemId, requestedBy: userId, baseUrl: BASE_URL });
    const repairToken = captureTokenFromStub(logSpy);

    syncMocks.syncItem.mockRejectedValue(new Error('still propagating'));
    const result = await inviteService.completeInviteRepair(repairToken);
    expect(result.healthy).toBe(false);
    expect(result.ok).toBe(true);
  });

  it('autoSendRepairInvite: sends to the client of record, then throttles (gap + cap) and skips no-trail items', async () => {
    const { env } = await import('../config/env.js');
    const prevPublicUrl = env.PUBLIC_URL;
    (env as { PUBLIC_URL?: string }).PUBLIC_URL = BASE_URL;
    try {
      const { itemId } = await seedBrokenItem();
      await db.insert(tenantFeatureFlags).values({ tenantId, flagKey: 'BANK_CONNECT_INVITES_V1', enabled: true });

      const first = await inviteService.autoSendRepairInvite(itemId);
      expect(first).toEqual({ sent: true });
      const row = await db.query.bankConnectInvites.findFirst({
        where: and(eq(bankConnectInvites.repairPlaidItemId, itemId), eq(bankConnectInvites.autoSent, true)),
      });
      expect(row!.kind).toBe('repair');

      // 72h gap: an immediate retry is silenced.
      const second = await inviteService.autoSendRepairInvite(itemId);
      expect(second).toMatchObject({ sent: false, reason: 'sent recently' });

      // Cap: 3 auto-sends inside 30 days exhaust the budget even when the
      // gap has passed. Backdate the existing send and add two more.
      const days = (n: number) => new Date(Date.now() - n * 86400000);
      await db.update(bankConnectInvites).set({ sentAt: days(10) }).where(eq(bankConnectInvites.id, row!.id));
      for (const d of [7, 4]) {
        await inviteService.createRepairInvite({ plaidItemId: itemId, baseUrl: BASE_URL, autoSent: true });
        const latest = await db.select().from(bankConnectInvites)
          .where(and(eq(bankConnectInvites.repairPlaidItemId, itemId), eq(bankConnectInvites.autoSent, true)))
          .then((rows) => rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]!);
        await db.update(bankConnectInvites).set({ sentAt: days(d) }).where(eq(bankConnectInvites.id, latest.id));
      }
      const capped = await inviteService.autoSendRepairInvite(itemId);
      expect(capped).toMatchObject({ sent: false, reason: 'auto-send cap reached' });

      // No invite trail → quiet skip, not an error.
      const { encrypt } = await import('../utils/encryption.js');
      const [staffItem] = await db.insert(plaidItems).values({
        plaidItemId: 'item-' + Math.random().toString(36).slice(2, 10),
        institutionName: 'Staff Bank', accessTokenEncrypted: encrypt('tok'),
        createdBy: userId, itemStatus: 'login_required',
      }).returning();
      const skipped = await inviteService.autoSendRepairInvite(staffItem!.id);
      expect(skipped.sent).toBe(false);
      expect(skipped.reason).toContain('no client on record');
    } finally {
      (env as { PUBLIC_URL?: string }).PUBLIC_URL = prevPublicUrl;
    }
  });
});
