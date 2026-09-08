// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// "Invite my accountant" — a tenant OWNER invites a firm staff member by
// email. The email carries a one-click accept link (64-hex token, sent in
// a POST body — never a URL, because morgan logs request lines) and an
// 8-character code for Firm → Join a client. Only SHA-256 hashes are
// stored; resend rotates both secrets and restarts the 14-day clock.
//
// Authority model: the invite token/code is the TENANT-side authority
// ("the owner asked for this"); the acceptor's active firm membership is
// the FIRM-side authority. Acceptance therefore bypasses requireFirmAdmin
// (which refuses non-super-admins on the superAdminManaged appliance
// firm) on purpose — it is not firm administration, it is a client
// handing their books to the firm their accountant belongs to.
//
// Enumeration hygiene: sending performs NO user lookup. Every send inserts
// a row and emails the address, whether or not an account exists — an
// address that has no firm account simply can never accept. Super admins
// are refused at accept time only (never revealed at send time), and
// acceptance is bound to the recipient address, which is what makes a
// 40-bit code acceptable alongside the per-user/IP limiters.

import crypto from 'crypto';
import { and, desc, eq, inArray, or } from 'drizzle-orm';
import {
  FIRM_INVITE_CODE_LENGTH,
  FIRM_INVITE_TTL_DAYS,
  type AcceptFirmInviteResult,
  type FirmInvite,
  type FirmInvitePreview,
  type FirmInviteStatus,
} from '@kis-books/shared';
import { db } from '../db/index.js';
import { firmInvites, firms, firmUsers, tenants, users, userTenantAccess } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import * as systemEmail from './system-email.service.js';
import * as tenantFirmAssignmentService from './tenant-firm-assignment.service.js';
import { getBranding } from './admin.service.js';

// No 0/O/1/I — the code is read off a phone screen and typed.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}
function generateCode(): string {
  let out = '';
  for (let i = 0; i < FIRM_INVITE_CODE_LENGTH; i += 1) {
    out += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  }
  return out;
}
function ttl(): Date {
  return new Date(Date.now() + FIRM_INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
}
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
async function appName(): Promise<string> {
  try { return (await getBranding()).appName; } catch { return 'Vibe MyBooks'; }
}

type InviteRow = typeof firmInvites.$inferSelect;

function isLive(row: InviteRow): boolean {
  return (row.status === 'sent' || row.status === 'viewed') && row.expiresAt.getTime() > Date.now();
}

async function firmNamesById(ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const rows = await db.select({ id: firms.id, name: firms.name }).from(firms).where(inArray(firms.id, unique));
  return new Map(rows.map((r) => [r.id, r.name]));
}

function toPublic(row: InviteRow, firmNames: Map<string, string>): FirmInvite {
  const status: FirmInviteStatus =
    (row.status === 'sent' || row.status === 'viewed') && row.expiresAt.getTime() < Date.now()
      ? 'expired'
      : (row.status as FirmInviteStatus);
  return {
    id: row.id,
    tenantId: row.tenantId,
    recipientEmail: row.recipientEmail,
    status,
    expiresAt: row.expiresAt.toISOString(),
    sentAt: row.sentAt.toISOString(),
    resendCount: row.resendCount,
    viewedAt: row.viewedAt?.toISOString() ?? null,
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
    acceptedFirmId: row.acceptedFirmId,
    acceptedFirmName: row.acceptedFirmId ? (firmNames.get(row.acceptedFirmId) ?? null) : null,
    createdByName: row.createdByName,
  };
}

async function sendInviteEmail(args: {
  to: string;
  inviterName: string | null;
  inviterEmail: string | null;
  tenantName: string;
  token: string;
  code: string;
  expiresAt: Date;
  baseUrl: string;
}): Promise<{ sent: boolean; error?: string }> {
  const app = await appName();
  const inviter = args.inviterName?.trim() || args.inviterEmail || 'A client';
  const inviterLine = args.inviterEmail ? `${inviter} (${args.inviterEmail})` : inviter;
  const link = `${args.baseUrl}/accept-firm-invite/${args.token}`;
  const expires = args.expiresAt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const bodyText =
    `${inviterLine} has invited you to be the accountant for ${args.tenantName} on ${app}.\n\n` +
    `Accepting links ${args.tenantName} to your accounting firm and gives you accountant access to its books.\n\n` +
    `Click the button below, or sign in and go to Firm → Join a client and enter this code:\n\n` +
    `    ${args.code}\n\n` +
    `This invitation expires on ${expires} (${FIRM_INVITE_TTL_DAYS} days). ` +
    `If you weren't expecting it, you can ignore this email.`;
  try {
    await systemEmail.sendActionEmail({
      to: args.to,
      subject: `${inviter} invited you to manage ${args.tenantName} on ${app}`,
      bodyText,
      cta: { label: 'Accept invitation', url: link },
    });
    return { sent: true };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[firm-invite.service] invite email failed:', (err as Error)?.message ?? err);
    return { sent: false, error: (err as Error)?.message ?? 'send failed' };
  }
}

// ─── Owner side ──────────────────────────────────────────────────

export async function createInvite(args: {
  tenantId: string;
  createdBy: string;
  email: string;
  baseUrl: string;
}): Promise<{ inviteId: string; expiresAt: string; sent: boolean; resent: boolean; error?: string }> {
  const email = normalizeEmail(args.email);
  const [inviter, tenant] = await Promise.all([
    db.query.users.findFirst({ where: eq(users.id, args.createdBy) }),
    db.query.tenants.findFirst({ where: eq(tenants.id, args.tenantId) }),
  ]);
  if (!tenant) throw AppError.notFound('Tenant not found');
  if (inviter && normalizeEmail(inviter.email) === email) {
    throw AppError.badRequest('You cannot invite yourself', 'CANNOT_INVITE_SELF');
  }

  // A live invite for the same address is treated as a resend so the
  // pending list never shows duplicates (and the old link/code dies).
  const live = (await db.query.firmInvites.findMany({
    where: and(
      eq(firmInvites.tenantId, args.tenantId),
      eq(firmInvites.recipientEmail, email),
      inArray(firmInvites.status, ['sent', 'viewed']),
    ),
  })).find(isLive);
  if (live) {
    const r = await resendInvite(args.tenantId, live.id, args.createdBy, args.baseUrl);
    return { inviteId: live.id, expiresAt: r.expiresAt, sent: r.sent, resent: true, ...(r.error ? { error: r.error } : {}) };
  }

  const token = generateToken();
  const code = generateCode();
  const expiresAt = ttl();
  const [row] = await db.insert(firmInvites).values({
    tenantId: args.tenantId,
    recipientEmail: email,
    tokenHash: sha256Hex(token),
    codeHash: sha256Hex(code),
    status: 'sent',
    expiresAt,
    createdBy: args.createdBy,
    createdByName: inviter?.displayName ?? null,
    createdByEmail: inviter?.email ?? null,
  }).returning();
  if (!row) throw AppError.internal('Invite insert failed');

  const mail = await sendInviteEmail({
    to: email,
    inviterName: inviter?.displayName ?? null,
    inviterEmail: inviter?.email ?? null,
    tenantName: tenant.name,
    token, code, expiresAt,
    baseUrl: args.baseUrl,
  });

  await auditLog(args.tenantId, 'create', 'firm_invite', row.id, null, {
    email, expiresAt: expiresAt.toISOString(), sent: mail.sent, error: mail.error,
  }, args.createdBy);

  return { inviteId: row.id, expiresAt: expiresAt.toISOString(), sent: mail.sent, resent: false, ...(mail.error ? { error: mail.error } : {}) };
}

export async function listInvites(tenantId: string): Promise<{
  invites: FirmInvite[];
  managingFirm: { id: string; name: string } | null;
}> {
  const rows = await db.query.firmInvites.findMany({
    where: eq(firmInvites.tenantId, tenantId),
    orderBy: desc(firmInvites.sentAt),
  });
  const active = await tenantFirmAssignmentService.getActiveForTenant(tenantId);
  const names = await firmNamesById([
    ...rows.map((r) => r.acceptedFirmId ?? ''),
    active?.firmId ?? '',
  ]);
  return {
    invites: rows.map((r) => toPublic(r, names)),
    managingFirm: active ? { id: active.firmId, name: names.get(active.firmId) ?? 'Unknown firm' } : null,
  };
}

export async function resendInvite(
  tenantId: string,
  inviteId: string,
  userId: string,
  baseUrl: string,
): Promise<{ expiresAt: string; sent: boolean; error?: string }> {
  const invite = await db.query.firmInvites.findFirst({
    where: and(eq(firmInvites.tenantId, tenantId), eq(firmInvites.id, inviteId)),
  });
  if (!invite) throw AppError.notFound('Invite not found');
  if (invite.status === 'revoked' || invite.status === 'accepted') {
    throw AppError.badRequest(
      invite.status === 'revoked'
        ? 'This invitation was revoked — send a new one instead'
        : 'This invitation was already accepted',
      'INVITE_NOT_RESENDABLE',
    );
  }
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
  const token = generateToken();
  const code = generateCode();
  const expiresAt = ttl();
  await db.update(firmInvites).set({
    tokenHash: sha256Hex(token),
    codeHash: sha256Hex(code),
    expiresAt,
    status: 'sent',
    resendCount: invite.resendCount + 1,
    updatedAt: new Date(),
  }).where(eq(firmInvites.id, invite.id));

  const mail = await sendInviteEmail({
    to: invite.recipientEmail,
    inviterName: invite.createdByName,
    inviterEmail: invite.createdByEmail,
    tenantName: tenant?.name ?? 'your client',
    token, code, expiresAt,
    baseUrl,
  });
  await auditLog(tenantId, 'update', 'firm_invite', invite.id, { status: invite.status }, {
    action: 'resend', expiresAt: expiresAt.toISOString(), sent: mail.sent, error: mail.error,
  }, userId);
  return { expiresAt: expiresAt.toISOString(), sent: mail.sent, ...(mail.error ? { error: mail.error } : {}) };
}

export async function revokeInvite(tenantId: string, inviteId: string, userId: string): Promise<void> {
  const invite = await db.query.firmInvites.findFirst({
    where: and(eq(firmInvites.tenantId, tenantId), eq(firmInvites.id, inviteId)),
  });
  if (!invite) throw AppError.notFound('Invite not found');
  if (invite.status === 'revoked') throw AppError.badRequest('Invitation is already revoked');
  if (invite.status === 'accepted') throw AppError.badRequest('This invitation was already accepted', 'ALREADY_ACCEPTED');
  await db.update(firmInvites).set({
    status: 'revoked', revokedAt: new Date(), revokedBy: userId, updatedAt: new Date(),
  }).where(eq(firmInvites.id, invite.id));
  await auditLog(tenantId, 'update', 'firm_invite', invite.id, { status: invite.status }, { status: 'revoked' }, userId);
}

// ─── Staff side ──────────────────────────────────────────────────

export interface Acceptor {
  userId: string;
}

async function loadLive(lookup: { token?: string; code?: string }): Promise<InviteRow> {
  const conds = [];
  if (lookup.token) conds.push(eq(firmInvites.tokenHash, sha256Hex(lookup.token)));
  if (lookup.code) conds.push(eq(firmInvites.codeHash, sha256Hex(lookup.code.trim().toUpperCase())));
  if (conds.length === 0) throw AppError.notFound('Invalid or expired invitation');
  const invite = await db.query.firmInvites.findFirst({ where: conds.length === 1 ? conds[0] : or(...conds) });
  if (!invite) throw AppError.notFound('Invalid or expired invitation');
  if (invite.status === 'revoked') {
    throw AppError.badRequest('This invitation was revoked. Ask the client to send a new one.', 'REVOKED');
  }
  if (invite.status === 'accepted') {
    throw AppError.badRequest('This invitation was already accepted.', 'ALREADY_ACCEPTED');
  }
  if (invite.expiresAt.getTime() < Date.now()) {
    if (invite.status !== 'expired') {
      await db.update(firmInvites).set({ status: 'expired', updatedAt: new Date() }).where(eq(firmInvites.id, invite.id));
    }
    throw AppError.badRequest('This invitation has expired. Ask the client to resend it.', 'EXPIRED');
  }
  return invite;
}

// The firms an acceptor may accept INTO. Active firms + active membership
// with a write-tier role: firm_readonly may not accept (accepting confers
// accountant access, which a readonly member has no standing to take).
// Super admins may accept into any active firm — the assignment is the
// point; they need no access row.
async function acceptableFirms(user: typeof users.$inferSelect): Promise<Array<{ id: string; name: string }>> {
  if (user.isSuperAdmin) {
    return db.select({ id: firms.id, name: firms.name }).from(firms).where(eq(firms.isActive, true)).orderBy(firms.name);
  }
  return db
    .select({ id: firms.id, name: firms.name })
    .from(firmUsers)
    .innerJoin(firms, eq(firms.id, firmUsers.firmId))
    .where(and(
      eq(firmUsers.userId, user.id),
      eq(firmUsers.isActive, true),
      eq(firms.isActive, true),
      inArray(firmUsers.firmRole, ['firm_admin', 'firm_staff']),
    ))
    .orderBy(firms.name);
}

async function resolveAcceptor(lookup: { token?: string; code?: string }, acceptor: Acceptor) {
  const invite = await loadLive(lookup);
  const user = await db.query.users.findFirst({ where: eq(users.id, acceptor.userId) });
  if (!user || user.isActive === false) throw AppError.forbidden('Account is not active');
  if (normalizeEmail(user.email) !== invite.recipientEmail) {
    throw AppError.forbidden(
      `This invitation was sent to ${invite.recipientEmail}. Sign in with that account to accept it.`,
      'INVITE_EMAIL_MISMATCH',
    );
  }
  const firmChoices = await acceptableFirms(user);
  if (firmChoices.length === 0) {
    throw AppError.forbidden(
      'You must be a member of an accounting firm to accept a client invitation. Ask your firm admin to add you.',
      'FIRM_MEMBERSHIP_REQUIRED',
    );
  }
  return { invite, user, firmChoices };
}

export async function preview(lookup: { token?: string; code?: string }, acceptor: Acceptor): Promise<FirmInvitePreview> {
  const { invite, firmChoices } = await resolveAcceptor(lookup, acceptor);
  if (!invite.viewedAt) {
    await db.update(firmInvites).set({
      viewedAt: new Date(),
      status: invite.status === 'sent' ? 'viewed' : invite.status,
      updatedAt: new Date(),
    }).where(eq(firmInvites.id, invite.id));
  }
  const [tenant, active] = await Promise.all([
    db.query.tenants.findFirst({ where: eq(tenants.id, invite.tenantId) }),
    tenantFirmAssignmentService.getActiveForTenant(invite.tenantId),
  ]);
  const names = await firmNamesById([active?.firmId ?? '']);
  return {
    tenantId: invite.tenantId,
    tenantName: tenant?.name ?? 'Unknown',
    inviterName: invite.createdByName,
    inviterEmail: invite.createdByEmail,
    expiresAt: invite.expiresAt.toISOString(),
    status: invite.status === 'sent' ? 'viewed' : (invite.status as FirmInviteStatus),
    currentFirmName: active ? (names.get(active.firmId) ?? null) : null,
    firms: firmChoices,
  };
}

// Acceptor access row: no row → accountant; inactive row → reactivate as
// accountant (an inactive OWNER keeps owner); active row → untouched
// (never downgrade). Super admins get no row (they bypass access checks).
async function grantAcceptorAccess(
  user: typeof users.$inferSelect,
  tenantId: string,
  firmId: string,
): Promise<boolean> {
  if (user.isSuperAdmin) return false;
  const existing = await db.query.userTenantAccess.findFirst({
    where: and(eq(userTenantAccess.userId, user.id), eq(userTenantAccess.tenantId, tenantId)),
  });
  if (existing?.isActive) return false;
  if (existing) {
    const role = existing.role === 'owner' ? 'owner' : 'accountant';
    await db.update(userTenantAccess).set({ isActive: true, role }).where(eq(userTenantAccess.id, existing.id));
    await auditLog(tenantId, 'update', 'user_access', user.id,
      { role: existing.role, isActive: false }, { role, isActive: true, source: 'firm_invite_accept', firmId }, user.id);
    return true;
  }
  const inserted = await db.insert(userTenantAccess)
    .values({ userId: user.id, tenantId, role: 'accountant', isActive: true })
    .onConflictDoNothing()
    .returning({ id: userTenantAccess.id });
  if (inserted.length === 0) return false;
  await auditLog(tenantId, 'create', 'user_access', user.id, null,
    { role: 'accountant', source: 'firm_invite_accept', firmId }, user.id);
  return true;
}

export async function accept(
  lookup: { token?: string; code?: string },
  firmId: string | undefined,
  acceptor: Acceptor,
): Promise<AcceptFirmInviteResult> {
  const { invite, user, firmChoices } = await resolveAcceptor(lookup, acceptor);

  const target = firmId
    ? firmChoices.find((f) => f.id === firmId)
    : firmChoices.length === 1 ? firmChoices[0] : undefined;
  if (!target) {
    if (firmId) throw AppError.forbidden('You are not a member of that firm', 'FIRM_MEMBERSHIP_REQUIRED');
    // 422 so the response can carry the candidate list for the chooser.
    throw AppError.unprocessableEntity(
      'You belong to more than one firm — choose which firm should manage this client.',
      'FIRM_CHOICE_REQUIRED',
      { firms: firmChoices },
    );
  }

  // Each step is idempotent so a retry after a partial failure converges.
  const before = await tenantFirmAssignmentService.getActiveForTenant(invite.tenantId);
  const alreadyAssigned = before?.firmId === target.id;
  const assignment = await tenantFirmAssignmentService.assignTenant(
    target.id,
    { tenantId: invite.tenantId, force: true },
    user.id,
  );
  const accessGranted = await grantAcceptorAccess(user, invite.tenantId, target.id);

  await db.update(firmInvites).set({
    status: 'accepted',
    acceptedAt: new Date(),
    acceptedByUserId: user.id,
    acceptedFirmId: target.id,
    updatedAt: new Date(),
  }).where(eq(firmInvites.id, invite.id));

  await auditLog(invite.tenantId, 'update', 'firm_invite', invite.id,
    { status: invite.status },
    { status: 'accepted', acceptedByUserId: user.id, firmId: target.id },
    user.id);
  if (!alreadyAssigned) {
    await auditLog(invite.tenantId, 'create', 'tenant_firm_assignment', assignment.id,
      before ? { firmId: before.firmId, assignmentId: before.id } : null,
      { firmId: target.id, source: 'firm_invite_accept', inviteId: invite.id },
      user.id);
  }

  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, invite.tenantId) });
  const tenantName = tenant?.name ?? 'your company';

  // Best-effort inviter notification.
  if (invite.createdByEmail) {
    const acceptorName = user.displayName?.trim() || user.email;
    void systemEmail.sendActionEmail({
      to: invite.createdByEmail,
      subject: `${acceptorName} accepted your accountant invitation`,
      bodyText:
        `${tenantName} is now managed by ${target.name}. ${acceptorName} (${user.email}) has accountant access to your books.\n\n` +
        `You can review who has access under Settings → Team.`,
    }).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn('[firm-invite.service] acceptance notification failed:', (err as Error)?.message ?? err);
    });
  }

  return {
    tenantId: invite.tenantId,
    tenantName,
    firmId: target.id,
    firmName: target.name,
    alreadyAssigned,
    accessGranted,
  };
}
