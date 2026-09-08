// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// "Invite my accountant" lifecycle: secrets stored hashed only, dedupe →
// resend, rotation, revoke, lazy expiry, and the accept path (assignment
// moves off the prior firm, acceptor gets accountant access, inviter is
// notified) with its authorization edges.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, firms, firmUsers, tenantFirmAssignments, userTenantAccess, auditLog, firmInvites,
} from '../db/schema/index.js';

const mail = vi.hoisted(() => ({ sendActionEmail: vi.fn(async () => {}) }));
vi.mock('./system-email.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./system-email.service.js')>();
  return { ...actual, sendActionEmail: (...args: unknown[]) => (mail.sendActionEmail as (...a: unknown[]) => Promise<void>)(...args) };
});

import * as inviteService from './firm-invite.service.js';

const suffix = () => `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const BASE_URL = 'https://books.example.com';
const sha = (v: string) => crypto.createHash('sha256').update(v).digest('hex');

let clientTenantId = '';
let ownerId = '';
let staffHomeId = '';
let staffId = '';
let firmAId = '';
let firmBId = '';
let priorFirmId = '';
const extraUserIds: string[] = [];
const extraFirmIds: string[] = [];

async function seedTenant(name: string): Promise<string> {
  const [t] = await db.insert(tenants).values({ name, slug: `${name.toLowerCase().replace(/\s+/g, '-')}-${suffix()}` }).returning();
  return t!.id;
}
async function seedUser(tenantId: string, email: string, opts: { role?: string; isSuperAdmin?: boolean; displayName?: string } = {}) {
  const [u] = await db.insert(users).values({
    tenantId, email, passwordHash: 'x'.repeat(60), role: opts.role ?? 'accountant',
    displayName: opts.displayName ?? email, isSuperAdmin: opts.isSuperAdmin ?? false,
  }).returning();
  return u!.id;
}
async function seedFirm(name: string, superAdminManaged = false): Promise<string> {
  const [f] = await db.insert(firms).values({ name, slug: `${name.toLowerCase().replace(/\s+/g, '-')}-${suffix()}`, superAdminManaged }).returning();
  return f!.id;
}

async function cleanDb() {
  const uids = [ownerId, staffId, ...extraUserIds].filter(Boolean);
  if (uids.length) await db.delete(userTenantAccess).where(inArray(userTenantAccess.userId, uids));
  const fids = [firmAId, firmBId, priorFirmId, ...extraFirmIds].filter(Boolean);
  if (clientTenantId) {
    await db.delete(firmInvites).where(eq(firmInvites.tenantId, clientTenantId));
    await db.delete(tenantFirmAssignments).where(eq(tenantFirmAssignments.tenantId, clientTenantId));
  }
  if (fids.length) {
    await db.delete(tenantFirmAssignments).where(inArray(tenantFirmAssignments.firmId, fids));
    await db.delete(firmUsers).where(inArray(firmUsers.firmId, fids));
    await db.delete(firms).where(inArray(firms.id, fids));
  }
  const tIds = [clientTenantId, staffHomeId].filter(Boolean);
  if (tIds.length) {
    await db.delete(auditLog).where(inArray(auditLog.tenantId, tIds));
    await db.delete(users).where(inArray(users.tenantId, tIds));
    await db.delete(tenants).where(inArray(tenants.id, tIds));
  }
  clientTenantId = ownerId = staffHomeId = staffId = firmAId = firmBId = priorFirmId = '';
  extraUserIds.length = 0;
  extraFirmIds.length = 0;
}

const STAFF_EMAIL = () => `cpa-${suffix()}@firm.example.com`;
let staffEmail = '';

beforeEach(async () => {
  await cleanDb();
  mail.sendActionEmail.mockClear();
  clientTenantId = await seedTenant('Invite Client Co');
  ownerId = await seedUser(clientTenantId, `owner-${suffix()}@client.example.com`, { role: 'owner', displayName: 'Olive Owner' });
  staffHomeId = await seedTenant('Invite Staff Home');
  staffEmail = STAFF_EMAIL();
  staffId = await seedUser(staffHomeId, staffEmail, { displayName: 'Sam Staff' });
  firmAId = await seedFirm('Firm A');
  await db.insert(firmUsers).values({ firmId: firmAId, userId: staffId, firmRole: 'firm_staff' });
  // The client is currently on an appliance-style prior firm (like every
  // self-signup tenant on Default Practice).
  priorFirmId = await seedFirm('Prior Practice', true);
  await db.insert(tenantFirmAssignments).values({ firmId: priorFirmId, tenantId: clientTenantId, isActive: true });
});
afterEach(cleanDb);

function secretsFromLastMail(): { token: string; code: string } {
  const call = mail.sendActionEmail.mock.calls.at(-1) as unknown as [{ bodyText: string; cta?: { url: string } }];
  const args = call[0];
  const token = /\/accept-firm-invite\/([a-f0-9]{64})/.exec(args.cta?.url ?? '')?.[1];
  const code = /\n {4}([A-Z2-9]{8})\n/.exec(args.bodyText)?.[1];
  expect(token, 'link token in CTA').toBeTruthy();
  expect(code, 'code in body').toBeTruthy();
  return { token: token!, code: code! };
}

async function invite(email = staffEmail) {
  return inviteService.createInvite({ tenantId: clientTenantId, createdBy: ownerId, email, baseUrl: BASE_URL });
}

describe('firm invites — owner side', () => {
  it('stores only hashes, 14-day expiry, and emails link + code', async () => {
    const res = await invite();
    expect(res.sent).toBe(true);
    expect(res.resent).toBe(false);
    const { token, code } = secretsFromLastMail();
    const row = await db.query.firmInvites.findFirst({ where: eq(firmInvites.id, res.inviteId) });
    expect(row!.tokenHash).toBe(sha(token));
    expect(row!.codeHash).toBe(sha(code));
    expect(row!.recipientEmail).toBe(staffEmail);
    const days = (row!.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThanOrEqual(14);
    const listed = await inviteService.listInvites(clientTenantId);
    expect(listed.invites).toHaveLength(1);
    expect(listed.invites[0]).not.toHaveProperty('tokenHash');
    expect(listed.managingFirm?.name).toBe('Prior Practice');
  });

  it('normalises the address and dedupes a live invite into a resend', async () => {
    const first = await invite(`  ${staffEmail.toUpperCase()} `);
    const second = await invite(staffEmail);
    expect(second.inviteId).toBe(first.inviteId);
    expect(second.resent).toBe(true);
    const rows = await db.query.firmInvites.findMany({ where: eq(firmInvites.tenantId, clientTenantId) });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.resendCount).toBe(1);
  });

  it('refuses a self-invite', async () => {
    const owner = await db.query.users.findFirst({ where: eq(users.id, ownerId) });
    await expect(invite(owner!.email)).rejects.toMatchObject({ code: 'CANNOT_INVITE_SELF' });
  });

  it('resend rotates both secrets and restarts the clock; revoke ends it', async () => {
    const res = await invite();
    const before = secretsFromLastMail();
    await db.update(firmInvites).set({ expiresAt: new Date(Date.now() + 1000) }).where(eq(firmInvites.id, res.inviteId));
    await inviteService.resendInvite(clientTenantId, res.inviteId, ownerId, BASE_URL);
    const after = secretsFromLastMail();
    expect(after.token).not.toBe(before.token);
    expect(after.code).not.toBe(before.code);
    const row = await db.query.firmInvites.findFirst({ where: eq(firmInvites.id, res.inviteId) });
    expect(row!.tokenHash).toBe(sha(after.token));
    expect(row!.expiresAt.getTime() - Date.now()).toBeGreaterThan(13 * 86_400_000);
    // Old link is dead.
    await expect(inviteService.preview({ token: before.token }, { userId: staffId })).rejects.toMatchObject({ statusCode: 404 });

    await inviteService.revokeInvite(clientTenantId, res.inviteId, ownerId);
    await expect(inviteService.preview({ token: after.token }, { userId: staffId })).rejects.toMatchObject({ code: 'REVOKED' });
    await expect(inviteService.resendInvite(clientTenantId, res.inviteId, ownerId, BASE_URL)).rejects.toMatchObject({ code: 'INVITE_NOT_RESENDABLE' });
  });

  it('flips to expired lazily', async () => {
    const res = await invite();
    const { token } = secretsFromLastMail();
    await db.update(firmInvites).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(firmInvites.id, res.inviteId));
    expect((await inviteService.listInvites(clientTenantId)).invites[0]!.status).toBe('expired');
    await expect(inviteService.preview({ token }, { userId: staffId })).rejects.toMatchObject({ code: 'EXPIRED' });
    expect((await db.query.firmInvites.findFirst({ where: eq(firmInvites.id, res.inviteId) }))!.status).toBe('expired');
  });
});

describe('firm invites — accept', () => {
  it('preview shows the client, inviter, current firm, and the acceptor\'s firm choices', async () => {
    await invite();
    const { code } = secretsFromLastMail();
    const p = await inviteService.preview({ code: code.toLowerCase() }, { userId: staffId });
    expect(p).toMatchObject({
      tenantName: 'Invite Client Co', inviterName: 'Olive Owner', currentFirmName: 'Prior Practice', status: 'viewed',
    });
    expect(p.firms.map((f) => f.name)).toEqual(['Firm A']);
  });

  it('happy path: moves the tenant off the prior firm, grants accountant access, marks accepted, notifies the inviter', async () => {
    const res = await invite();
    const { token } = secretsFromLastMail();
    const result = await inviteService.accept({ token }, undefined, { userId: staffId });
    expect(result).toMatchObject({ firmId: firmAId, firmName: 'Firm A', alreadyAssigned: false, accessGranted: true });

    const assignments = await db.select().from(tenantFirmAssignments).where(eq(tenantFirmAssignments.tenantId, clientTenantId));
    expect(assignments.find((a) => a.firmId === priorFirmId)!.isActive).toBe(false);
    expect(assignments.find((a) => a.firmId === firmAId)!.isActive).toBe(true);

    const access = await db.query.userTenantAccess.findFirst({
      where: and(eq(userTenantAccess.userId, staffId), eq(userTenantAccess.tenantId, clientTenantId)),
    });
    expect(access).toMatchObject({ role: 'accountant', isActive: true });

    const row = await db.query.firmInvites.findFirst({ where: eq(firmInvites.id, res.inviteId) });
    expect(row).toMatchObject({ status: 'accepted', acceptedByUserId: staffId, acceptedFirmId: firmAId });

    // Inviter notification went to the snapshot address.
    const notify = mail.sendActionEmail.mock.calls.at(-1) as unknown as [{ to: string; subject: string }];
    expect(notify[0].to).toBe((await db.query.users.findFirst({ where: eq(users.id, ownerId) }))!.email);
    expect(notify[0].subject).toMatch(/accepted your accountant invitation/);

    // Re-using the invite is refused.
    await expect(inviteService.accept({ token }, undefined, { userId: staffId })).rejects.toMatchObject({ code: 'ALREADY_ACCEPTED' });
  });

  it('is idempotent when the tenant is already on the acceptor\'s firm', async () => {
    await db.update(tenantFirmAssignments).set({ isActive: false }).where(eq(tenantFirmAssignments.tenantId, clientTenantId));
    await db.insert(tenantFirmAssignments).values({ firmId: firmAId, tenantId: clientTenantId, isActive: true });
    await invite();
    const { code } = secretsFromLastMail();
    const result = await inviteService.accept({ code }, undefined, { userId: staffId });
    expect(result.alreadyAssigned).toBe(true);
    const active = await db.select().from(tenantFirmAssignments)
      .where(and(eq(tenantFirmAssignments.tenantId, clientTenantId), eq(tenantFirmAssignments.isActive, true)));
    expect(active).toHaveLength(1);
  });

  it('never downgrades an existing active owner row; reactivates an inactive row', async () => {
    await db.insert(userTenantAccess).values({ userId: staffId, tenantId: clientTenantId, role: 'owner', isActive: true });
    await invite();
    let r = await inviteService.accept({ token: secretsFromLastMail().token }, undefined, { userId: staffId });
    expect(r.accessGranted).toBe(false);
    let access = await db.query.userTenantAccess.findFirst({ where: and(eq(userTenantAccess.userId, staffId), eq(userTenantAccess.tenantId, clientTenantId)) });
    expect(access).toMatchObject({ role: 'owner', isActive: true });

    await db.update(userTenantAccess).set({ isActive: false, role: 'readonly' }).where(eq(userTenantAccess.id, access!.id));
    await db.update(firmInvites).set({ status: 'sent', acceptedAt: null, acceptedByUserId: null, acceptedFirmId: null }).where(eq(firmInvites.tenantId, clientTenantId));
    await invite(); // dedupes into a resend of the (now live again) invite
    r = await inviteService.accept({ token: secretsFromLastMail().token }, undefined, { userId: staffId });
    expect(r.accessGranted).toBe(true);
    access = await db.query.userTenantAccess.findFirst({ where: eq(userTenantAccess.id, access!.id) });
    expect(access).toMatchObject({ role: 'accountant', isActive: true });
  });

  it('requires a firm choice when the acceptor belongs to several, and validates it', async () => {
    firmBId = await seedFirm('Firm B');
    await db.insert(firmUsers).values({ firmId: firmBId, userId: staffId, firmRole: 'firm_admin' });
    await invite();
    const { token } = secretsFromLastMail();
    await expect(inviteService.accept({ token }, undefined, { userId: staffId })).rejects.toMatchObject({ code: 'FIRM_CHOICE_REQUIRED' });
    await expect(inviteService.accept({ token }, priorFirmId, { userId: staffId })).rejects.toMatchObject({ code: 'FIRM_MEMBERSHIP_REQUIRED' });
    const r = await inviteService.accept({ token }, firmBId, { userId: staffId });
    expect(r.firmId).toBe(firmBId);
  });

  it('refuses acceptors with no write-tier firm membership (none / readonly-only / inactive firm)', async () => {
    await invite();
    const { token } = secretsFromLastMail();
    await db.update(firmUsers).set({ firmRole: 'firm_readonly' }).where(eq(firmUsers.userId, staffId));
    await expect(inviteService.accept({ token }, undefined, { userId: staffId })).rejects.toMatchObject({ code: 'FIRM_MEMBERSHIP_REQUIRED' });
    await db.update(firmUsers).set({ firmRole: 'firm_staff' }).where(eq(firmUsers.userId, staffId));
    await db.update(firms).set({ isActive: false }).where(eq(firms.id, firmAId));
    await expect(inviteService.accept({ token }, undefined, { userId: staffId })).rejects.toMatchObject({ code: 'FIRM_MEMBERSHIP_REQUIRED' });
    await db.delete(firmUsers).where(eq(firmUsers.userId, staffId));
    await expect(inviteService.preview({ token }, { userId: staffId })).rejects.toMatchObject({ code: 'FIRM_MEMBERSHIP_REQUIRED' });
  });

  it('binds acceptance to the recipient address', async () => {
    const other = await seedUser(staffHomeId, `other-${suffix()}@firm.example.com`);
    extraUserIds.push(other);
    await db.insert(firmUsers).values({ firmId: firmAId, userId: other, firmRole: 'firm_admin' });
    await invite();
    const { token } = secretsFromLastMail();
    await expect(inviteService.accept({ token }, undefined, { userId: other })).rejects.toMatchObject({ code: 'INVITE_EMAIL_MISMATCH' });
  });

  it('a super admin may accept into any active firm and gets no access row', async () => {
    const saEmail = `sa-${suffix()}@firm.example.com`;
    const sa = await seedUser(staffHomeId, saEmail, { isSuperAdmin: true, role: 'owner' });
    extraUserIds.push(sa);
    await invite(saEmail);
    const { token } = secretsFromLastMail();
    const p = await inviteService.preview({ token }, { userId: sa });
    expect(p.firms.some((f) => f.id === firmAId)).toBe(true);
    const r = await inviteService.accept({ token }, firmAId, { userId: sa });
    expect(r).toMatchObject({ firmId: firmAId, accessGranted: false });
    expect(await db.query.userTenantAccess.findFirst({ where: and(eq(userTenantAccess.userId, sa), eq(userTenantAccess.tenantId, clientTenantId)) })).toBeUndefined();
  });

  it('accepting into a firm grants its firm_admins auto-access too', async () => {
    const admin = await seedUser(staffHomeId, `admin-${suffix()}@firm.example.com`);
    extraUserIds.push(admin);
    await db.insert(firmUsers).values({ firmId: firmAId, userId: admin, firmRole: 'firm_admin' });
    await invite();
    await inviteService.accept({ token: secretsFromLastMail().token }, undefined, { userId: staffId });
    expect(await db.query.userTenantAccess.findFirst({ where: and(eq(userTenantAccess.userId, admin), eq(userTenantAccess.tenantId, clientTenantId)) }))
      .toMatchObject({ role: 'accountant', isActive: true });
  });
});
