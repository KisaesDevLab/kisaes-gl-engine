// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Bank connection invites: staff email/SMS a client a tokenized public link
// (/connect/:token) that runs Plaid Link with no MyBooks login. Clones the
// W-9 request pattern (portal-1099.service.ts): 32-byte token, SHA-256-only
// storage, expiry auto-flip, console-stub mail/SMS for dev. The resulting
// Plaid connection is attributed to the INVITING staff user via
// plaidConnection.createConnection(invite.createdBy, …), which preserves the
// orphan guard (abandoned exchanges revoke the Item at Plaid) and makes the
// item visible to the inviter for mapping. One invite stays connectable for
// multiple institutions until it expires or is revoked.

import crypto from 'crypto';
import nodemailer from 'nodemailer';
import { eq, and, or, desc, count, gt } from 'drizzle-orm';
import { db } from '../db/index.js';
import { bankConnectInvites, users, tenants, companies, portalSettingsPerPractice, plaidItems } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import { getSmtpSettings } from './admin.service.js';
import { env } from '../config/env.js';
import { appBasePath } from '../utils/base-url.js';

export const INVITE_TTL_DAYS = 7;

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

interface MailerHandle {
  send: (to: string, subject: string, html: string, text: string) => Promise<void>;
  isStub: boolean;
}

// Same console-stub shape as the W-9 mailer so dev environments exercise
// the full flow without SMTP credentials.
async function getMailer(): Promise<MailerHandle> {
  const smtp = await getSmtpSettings();
  const from = smtp.smtpFrom || 'noreply@example.com';
  if (!smtp.smtpHost) {
    return {
      isStub: true,
      send: async (to, subject, _html, text) => {
        // eslint-disable-next-line no-console
        console.log(JSON.stringify({
          ts: new Date().toISOString(), level: 'info',
          component: 'bank-connect-mail-stub', event: 'send',
          to, subject, preview: text.slice(0, 400),
        }));
      },
    };
  }
  const transport = nodemailer.createTransport({
    host: smtp.smtpHost,
    port: smtp.smtpPort,
    secure: smtp.smtpPort === 465,
    auth: smtp.smtpUser ? { user: smtp.smtpUser, pass: smtp.smtpPass } : undefined,
  });
  return {
    isStub: false,
    send: async (to, subject, html, text) => {
      await transport.sendMail({ from, to, subject, html, text });
    },
  };
}

async function sendInviteSms(phone: string, body: string): Promise<{ success: boolean; error?: string; isStub?: boolean }> {
  try {
    const { getRawConfig } = await import('./tfa-config.service.js');
    const cfg = await getRawConfig();
    if (!cfg.smsProvider) {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify({
        ts: new Date().toISOString(), level: 'info',
        component: 'bank-connect-sms-stub', event: 'send',
        to: phone, preview: body.slice(0, 200),
      }));
      return { success: true, isStub: true };
    }
    const { getSmsProvider } = await import('./sms-providers/index.js');
    const provider = getSmsProvider(cfg);
    const result = await provider.sendText(phone, body);
    return { success: result.success, error: result.error };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'SMS dispatch failed' };
  }
}

/**
 * SMS body targets a single GSM-7 segment (160 chars) like the W-9 sender.
 * The link alone is ~100 chars (origin + /connect/ + 64-hex token), so the
 * fixed overhead must stay under ~60 — no firm name, no expiry note. The
 * firm's identity and the personal message ride the email channel; the SMS
 * is the link carrier.
 */
export function buildInviteSmsBody(link: string): string {
  return `Your accountant asked you to securely connect your bank: ${link}`;
}

/** Repair variant, same single-segment budget — no bank name, no expiry. */
export function buildRepairSmsBody(link: string): string {
  return `Your bank connection needs attention. Fix it securely here: ${link}`;
}

/** Firm display name shown on the public page: company > tenant. */
async function firmNameFor(tenantId: string, companyId?: string | null): Promise<string> {
  if (companyId) {
    const co = await db.query.companies.findFirst({
      where: and(eq(companies.tenantId, tenantId), eq(companies.id, companyId)),
    });
    if (co?.businessName) return co.businessName;
  }
  const t = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
  return t?.name ?? 'Your accountant';
}

/**
 * The dashboard-registered OAuth return URL. Built from PUBLIC_URL (never
 * from request headers — Plaid requires one stable registered URI, and the
 * appliance is reachable from several origins). Undefined when PUBLIC_URL
 * is unset: link tokens then omit redirect_uri and OAuth institutions
 * (Chase, Capital One) won't complete — non-OAuth banks still work.
 */
export function oauthRedirectUri(): string | undefined {
  if (!env.PUBLIC_URL) return undefined;
  const origin = env.PUBLIC_URL.replace(/\/+$/, '');
  const basePath = appBasePath().replace(/\/+$/, '');
  return `${origin}${basePath}/connect/oauth-return`;
}

async function composeAndSend(args: {
  invite: { id: string; recipientName: string; recipientEmail: string | null; recipientPhone: string | null; message: string | null };
  tenantId: string;
  companyId?: string | null;
  token: string;
  baseUrl: string;
  // Present on repair invites: switches copy from "connect your bank" to
  // "your existing connection needs its login updated".
  repair?: { institutionName: string | null };
}): Promise<{ channels: Array<'email' | 'sms'>; viaEmailStub: boolean; smsError?: string }> {
  const firmName = await firmNameFor(args.tenantId, args.companyId);
  const link = `${args.baseUrl.replace(/\/$/, '')}/connect/${encodeURIComponent(args.token)}`;
  const channels: Array<'email' | 'sms'> = [];
  let viaEmailStub = false;
  let smsError: string | undefined;

  if (args.invite.recipientEmail) {
    const greeting = `Hello ${args.invite.recipientName},`;
    let subject: string, text: string, html: string;
    if (args.repair) {
      const bank = args.repair.institutionName || 'your bank';
      subject = `${firmName} — action needed: update your ${bank} connection`;
      text = `${greeting}\n\n${bank} has stopped sharing transactions with ${firmName} — this usually happens after a password change or a security update at the bank. Open the link below to update your login; it takes about a minute and your credentials go directly to your bank, never to us.\n\n${link}\n\nThe link is valid for ${INVITE_TTL_DAYS} days.${args.invite.message ? `\n\n${args.invite.message}` : ''}`;
      html = `<p>${greeting}</p><p><strong>${bank}</strong> has stopped sharing transactions with <strong>${firmName}</strong> — this usually happens after a password change or a security update at the bank. Updating your login takes about a minute, and your credentials go directly to your bank — never to us.</p><p><a href="${link}" style="display:inline-block;background:#4f46e5;color:#fff;padding:10px 16px;text-decoration:none;border-radius:6px">Fix bank connection</a></p><p style="color:#888;font-size:12px">Link valid for ${INVITE_TTL_DAYS} days. If you didn't expect this, you can ignore this message.</p>${args.invite.message ? `<hr><p>${args.invite.message}</p>` : ''}`;
    } else {
      subject = `${firmName} — connect your bank account`;
      text = `${greeting}\n\n${firmName} has asked you to securely connect your bank account so your bookkeeping stays up to date. Open the link below to get started — it takes about two minutes and your banking credentials go directly to your bank, never to us.\n\n${link}\n\nThe link is valid for ${INVITE_TTL_DAYS} days.${args.invite.message ? `\n\n${args.invite.message}` : ''}`;
      html = `<p>${greeting}</p><p><strong>${firmName}</strong> has asked you to securely connect your bank account so your bookkeeping stays up to date. It takes about two minutes, and your banking credentials go directly to your bank — never to us.</p><p><a href="${link}" style="display:inline-block;background:#4f46e5;color:#fff;padding:10px 16px;text-decoration:none;border-radius:6px">Connect your bank</a></p><p style="color:#888;font-size:12px">Link valid for ${INVITE_TTL_DAYS} days. If you didn't expect this, you can ignore this message.</p>${args.invite.message ? `<hr><p>${args.invite.message}</p>` : ''}`;
    }
    const mailer = await getMailer();
    await mailer.send(args.invite.recipientEmail, subject, html, text);
    viaEmailStub = mailer.isStub;
    channels.push('email');
  }

  if (args.invite.recipientPhone) {
    const result = await sendInviteSms(args.invite.recipientPhone, args.repair ? buildRepairSmsBody(link) : buildInviteSmsBody(link));
    if (result.success) channels.push('sms');
    else {
      smsError = result.error ?? 'SMS delivery failed';
      // SMS-only invite with a failed send = nothing delivered — fail loud.
      if (!args.invite.recipientEmail) {
        throw AppError.badRequest(`SMS delivery failed: ${smsError}`);
      }
    }
  }

  return { channels, viaEmailStub, smsError };
}

/** SMS channel gate: per-tenant outbound switch + STOP-list check. */
async function assertSmsAllowed(tenantId: string, phone: string): Promise<void> {
  const settings = await db.query.portalSettingsPerPractice.findFirst({
    where: eq(portalSettingsPerPractice.tenantId, tenantId),
  });
  if (!settings?.smsOutboundEnabled) {
    throw AppError.badRequest(
      'Outbound SMS is disabled for this practice — enable it under Client Portal → Settings → Text messaging, or send the invite by email.',
    );
  }
  const { isPhoneSuppressed } = await import('./sms-suppression.service.js');
  if (await isPhoneSuppressed(phone)) {
    throw AppError.badRequest('This phone number has opted out of text messages (STOP). Send the invite by email instead.');
  }
}

export async function createInvite(args: {
  tenantId: string;
  companyId?: string | null;
  createdBy: string;
  recipientName: string;
  email?: string;
  phone?: string;
  message?: string;
  baseUrl: string;
}): Promise<{ inviteId: string; channels: Array<'email' | 'sms'> }> {
  const email = args.email?.trim().toLowerCase() || null;
  const phone = args.phone?.trim() || null;
  const recipientName = args.recipientName.trim();
  if (!recipientName) throw AppError.badRequest('Recipient name is required');
  if (!email && !phone) throw AppError.badRequest('Provide an email address, a phone number, or both');
  if (phone) await assertSmsAllowed(args.tenantId, phone);

  const inviter = await db.query.users.findFirst({ where: eq(users.id, args.createdBy) });

  const token = generateToken();
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
  const [row] = await db.insert(bankConnectInvites).values({
    tenantId: args.tenantId,
    companyId: args.companyId ?? null,
    recipientName,
    recipientEmail: email,
    recipientPhone: phone,
    message: args.message?.trim() || null,
    tokenHash: sha256Hex(token),
    status: 'sent',
    sentVia: email && phone ? 'both' : email ? 'email' : 'sms',
    expiresAt,
    createdBy: args.createdBy,
    createdByName: inviter?.displayName ?? null,
    createdByEmail: inviter?.email ?? null,
  }).returning();
  if (!row) throw AppError.internal('Invite insert failed');

  const sent = await composeAndSend({
    invite: { id: row.id, recipientName, recipientEmail: email, recipientPhone: phone, message: row.message },
    tenantId: args.tenantId,
    companyId: args.companyId,
    token,
    baseUrl: args.baseUrl,
  });

  await auditLog(args.tenantId, 'create', 'bank_connect_invite', row.id, null, {
    recipientName, email, phone, channels: sent.channels,
    viaEmailStub: sent.viaEmailStub, smsError: sent.smsError,
  }, args.createdBy);

  return { inviteId: row.id, channels: sent.channels };
}

/** The most recent invite that touched this plaid item — the connection's
 * client of record. Used to infer the repair recipient. */
async function latestInviteForItem(plaidItemId: string) {
  return db.query.bankConnectInvites.findFirst({
    where: or(
      eq(bankConnectInvites.connectedPlaidItemId, plaidItemId),
      eq(bankConnectInvites.repairPlaidItemId, plaidItemId),
    ),
    orderBy: desc(bankConnectInvites.sentAt),
  });
}

/**
 * Send a "fix your bank login" link for an existing plaid item. The link
 * opens Plaid Link in UPDATE MODE against the item — no new Item, no
 * token exchange, mappings and history untouched.
 *
 * Recipient defaults to the client of record (the most recent invite that
 * connected or repaired this item); staff may override via args.recipient.
 * Items connected by staff in-app have no invite trail — those throw, and
 * staff repairs them with the in-app Fix Now button instead.
 */
export async function createRepairInvite(args: {
  plaidItemId: string;
  requestedBy?: string; // absent on worker auto-sends
  recipient?: { name: string; email?: string; phone?: string };
  message?: string;
  baseUrl: string;
  autoSent?: boolean;
}): Promise<{ inviteId: string; channels: Array<'email' | 'sms'>; recipientName: string }> {
  const item = await db.query.plaidItems.findFirst({ where: eq(plaidItems.id, args.plaidItemId) });
  if (!item || item.itemStatus === 'removed') throw AppError.notFound('Bank connection not found');

  const prior = await latestInviteForItem(args.plaidItemId);
  if (!prior && !args.recipient?.email && !args.recipient?.phone) {
    throw AppError.badRequest(
      'No client on record for this connection — it was connected in-app. Use Fix Now, or provide a recipient email/phone.',
    );
  }

  const tenantId = prior?.tenantId;
  if (!tenantId) throw AppError.badRequest('No inviting practice on record for this connection');
  const recipientName = (args.recipient?.name || prior?.recipientName || '').trim();
  let email = (args.recipient ? args.recipient.email : prior?.recipientEmail)?.trim().toLowerCase() || null;
  let phone = (args.recipient ? args.recipient.phone : prior?.recipientPhone)?.trim() || null;
  if (!recipientName) throw AppError.badRequest('Recipient name is required');
  if (!email && !phone) throw AppError.badRequest('Provide an email address, a phone number, or both');
  if (phone) {
    if (args.autoSent) {
      // Worker context: a closed SMS gate (practice switch off, STOP list)
      // downgrades to email-only instead of failing the whole send.
      try { await assertSmsAllowed(tenantId, phone); } catch { phone = email ? null : phone; }
      if (!email && !phone) throw AppError.badRequest('SMS is the only channel on record and it is unavailable');
    } else {
      await assertSmsAllowed(tenantId, phone);
    }
  }

  const createdBy = args.requestedBy ?? prior?.createdBy;
  if (!createdBy) throw AppError.badRequest('No inviting user on record for this connection');
  const inviter = await db.query.users.findFirst({ where: eq(users.id, createdBy) });

  const token = generateToken();
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
  const [row] = await db.insert(bankConnectInvites).values({
    tenantId,
    companyId: prior?.companyId ?? null,
    recipientName,
    recipientEmail: email,
    recipientPhone: phone,
    message: args.message?.trim() || null,
    kind: 'repair',
    repairPlaidItemId: args.plaidItemId,
    autoSent: args.autoSent ?? false,
    tokenHash: sha256Hex(token),
    status: 'sent',
    sentVia: email && phone ? 'both' : email ? 'email' : 'sms',
    expiresAt,
    createdBy,
    createdByName: inviter?.displayName ?? prior?.createdByName ?? null,
    createdByEmail: inviter?.email ?? prior?.createdByEmail ?? null,
  }).returning();
  if (!row) throw AppError.internal('Invite insert failed');

  const sent = await composeAndSend({
    invite: { id: row.id, recipientName, recipientEmail: email, recipientPhone: phone, message: row.message },
    tenantId,
    companyId: row.companyId,
    token,
    baseUrl: args.baseUrl,
    repair: { institutionName: item.institutionName },
  });

  await auditLog(tenantId, 'create', 'bank_connect_invite', row.id, null, {
    kind: 'repair', plaidItemId: args.plaidItemId, institutionName: item.institutionName,
    recipientName, email, phone, channels: sent.channels, autoSent: args.autoSent ?? false,
    viaEmailStub: sent.viaEmailStub, smsError: sent.smsError,
  }, createdBy);

  return { inviteId: row.id, channels: sent.channels, recipientName };
}

// Auto-send throttle: at most one worker-dispatched repair invite per item
// per 72h, and at most 3 per 30 days. Manual sends are never throttled and
// don't count against the caps.
const AUTO_REPAIR_MIN_GAP_MS = 72 * 60 * 60 * 1000;
const AUTO_REPAIR_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const AUTO_REPAIR_MAX_PER_WINDOW = 3;

/**
 * Worker entry point: on a credential failure, email/SMS the client of
 * record a repair link — best-effort and throttled. Every skip reason
 * returns quietly (this runs inside the sync error path; it must never
 * mask the original sync failure).
 */
export async function autoSendRepairInvite(plaidItemId: string): Promise<{ sent: boolean; reason?: string }> {
  if (!env.PUBLIC_URL) return { sent: false, reason: 'PUBLIC_URL not configured' };

  const { getConfig } = await import('./plaid-client.service.js');
  if (!(await getConfig()).autoRepairInvites) return { sent: false, reason: 'auto-repair invites disabled' };

  const prior = await latestInviteForItem(plaidItemId);
  if (!prior) return { sent: false, reason: 'no client on record (staff-connected item)' };

  const { isEnabled } = await import('./feature-flags.service.js');
  if (!(await isEnabled(prior.tenantId, 'BANK_CONNECT_INVITES_V1'))) {
    return { sent: false, reason: 'invites feature disabled for tenant' };
  }

  // Gap check counts EVERY repair invite for the item (a staff manual send
  // an hour ago should also silence the worker); the 30-day cap counts only
  // auto-sends so manual activity never exhausts the worker's budget.
  const recent = await db.select().from(bankConnectInvites).where(and(
    eq(bankConnectInvites.repairPlaidItemId, plaidItemId),
    eq(bankConnectInvites.kind, 'repair'),
    gt(bankConnectInvites.sentAt, new Date(Date.now() - AUTO_REPAIR_WINDOW_MS)),
  )).orderBy(desc(bankConnectInvites.sentAt));
  if (recent.filter((r) => r.autoSent).length >= AUTO_REPAIR_MAX_PER_WINDOW) return { sent: false, reason: 'auto-send cap reached' };
  if (recent[0] && recent[0].sentAt.getTime() > Date.now() - AUTO_REPAIR_MIN_GAP_MS) {
    return { sent: false, reason: 'sent recently' };
  }

  const origin = env.PUBLIC_URL.replace(/\/+$/, '');
  const basePath = appBasePath().replace(/\/+$/, '');
  const result = await createRepairInvite({ plaidItemId, baseUrl: `${origin}${basePath}`, autoSent: true });
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    ts: new Date().toISOString(), level: 'info', component: 'bank-connect-invite',
    event: 'auto_repair_invite_sent', plaidItemId, inviteId: result.inviteId, channels: result.channels,
  }));
  return { sent: true };
}

export async function listInvites(tenantId: string, opts: { limit: number; offset: number }) {
  const [rows, [totalRow]] = await Promise.all([
    db.select().from(bankConnectInvites)
      .where(eq(bankConnectInvites.tenantId, tenantId))
      .orderBy(desc(bankConnectInvites.sentAt))
      .limit(opts.limit).offset(opts.offset),
    db.select({ total: count() }).from(bankConnectInvites)
      .where(eq(bankConnectInvites.tenantId, tenantId)),
  ]);
  // Lazily reflect expiry in the listing without waiting for a public hit.
  const now = Date.now();
  const invites = rows.map((r) => ({
    ...r,
    status: (r.status === 'sent' || r.status === 'viewed') && r.expiresAt.getTime() < now ? 'expired' : r.status,
    tokenHash: undefined,
  }));
  return { invites, total: totalRow?.total ?? 0, limit: opts.limit, offset: opts.offset };
}

/**
 * Resend mints a NEW token and resets the expiry — the plaintext is never
 * stored, so the old link necessarily dies. This doubles as rotation for a
 * possibly-leaked link. Allowed for sent/viewed/expired (revives expired);
 * revoked stays revoked, connected invites are still live so resending them
 * is also allowed (client may have lost the email mid-way through banks).
 */
export async function resendInvite(tenantId: string, inviteId: string, userId: string, baseUrl: string): Promise<{ channels: Array<'email' | 'sms'> }> {
  const invite = await db.query.bankConnectInvites.findFirst({
    where: and(eq(bankConnectInvites.tenantId, tenantId), eq(bankConnectInvites.id, inviteId)),
  });
  if (!invite) throw AppError.notFound('Invite not found');
  if (invite.status === 'revoked') throw AppError.badRequest('This invite was revoked — create a new one instead');
  if (invite.recipientPhone) await assertSmsAllowed(tenantId, invite.recipientPhone);

  const token = generateToken();
  const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
  await db.update(bankConnectInvites).set({
    tokenHash: sha256Hex(token),
    expiresAt,
    status: invite.status === 'expired' ? 'sent' : invite.status,
    updatedAt: new Date(),
  }).where(eq(bankConnectInvites.id, invite.id));

  const repairItem = invite.kind === 'repair' && invite.repairPlaidItemId
    ? await db.query.plaidItems.findFirst({ where: eq(plaidItems.id, invite.repairPlaidItemId) })
    : null;
  const sent = await composeAndSend({
    invite: {
      id: invite.id, recipientName: invite.recipientName,
      recipientEmail: invite.recipientEmail, recipientPhone: invite.recipientPhone,
      message: invite.message,
    },
    tenantId, companyId: invite.companyId, token, baseUrl,
    ...(invite.kind === 'repair' ? { repair: { institutionName: repairItem?.institutionName ?? null } } : {}),
  });

  await auditLog(tenantId, 'update', 'bank_connect_invite', invite.id, { status: invite.status }, {
    action: 'resend', channels: sent.channels,
  }, userId);
  return { channels: sent.channels };
}

export async function revokeInvite(tenantId: string, inviteId: string, userId: string): Promise<void> {
  const invite = await db.query.bankConnectInvites.findFirst({
    where: and(eq(bankConnectInvites.tenantId, tenantId), eq(bankConnectInvites.id, inviteId)),
  });
  if (!invite) throw AppError.notFound('Invite not found');
  if (invite.status === 'revoked') throw AppError.badRequest('Invite is already revoked');
  await db.update(bankConnectInvites).set({
    status: 'revoked', revokedAt: new Date(), revokedBy: userId, updatedAt: new Date(),
  }).where(eq(bankConnectInvites.id, invite.id));
  await auditLog(tenantId, 'update', 'bank_connect_invite', invite.id, { status: invite.status }, { status: 'revoked' }, userId);
}

/**
 * Resolve a live invite from its raw token. Expiry auto-flips like the W-9
 * loader; UNLIKE W-9, `connected` invites stay loadable and connectable —
 * one link commonly serves several institutions until it expires.
 */
async function loadLiveInvite(token: string) {
  const invite = await db.query.bankConnectInvites.findFirst({
    where: eq(bankConnectInvites.tokenHash, sha256Hex(token)),
  });
  if (!invite) throw AppError.notFound('Invalid or expired link');
  if (invite.status === 'revoked') throw AppError.badRequest('This link has been deactivated. Contact your accountant for a new one.', 'REVOKED');
  if (invite.expiresAt.getTime() < Date.now()) {
    if (invite.status !== 'expired') {
      await db.update(bankConnectInvites).set({ status: 'expired', updatedAt: new Date() })
        .where(eq(bankConnectInvites.id, invite.id));
    }
    throw AppError.badRequest('This link has expired. Contact your accountant for a new one.', 'EXPIRED');
  }
  return invite;
}

export async function loadInviteByToken(token: string): Promise<{
  status: string;
  kind: string;
  recipientName: string;
  firmName: string;
  institutionName: string | null;
  expiresAt: Date;
  connectionsCount: number;
}> {
  const invite = await loadLiveInvite(token);
  if (!invite.viewedAt) {
    await db.update(bankConnectInvites).set({
      viewedAt: new Date(),
      status: invite.status === 'sent' ? 'viewed' : invite.status,
      updatedAt: new Date(),
    }).where(eq(bankConnectInvites.id, invite.id));
  }
  const repairItem = invite.kind === 'repair' && invite.repairPlaidItemId
    ? await db.query.plaidItems.findFirst({ where: eq(plaidItems.id, invite.repairPlaidItemId) })
    : null;
  return {
    status: invite.status === 'sent' ? 'viewed' : invite.status,
    kind: invite.kind,
    recipientName: invite.recipientName,
    firmName: await firmNameFor(invite.tenantId, invite.companyId),
    institutionName: repairItem?.institutionName ?? null,
    expiresAt: invite.expiresAt,
    connectionsCount: invite.connectionsCount,
  };
}

export async function createLinkTokenForInvite(token: string): Promise<{ linkToken: string }> {
  const invite = await loadLiveInvite(token);
  const plaidClient = await import('./plaid-client.service.js');

  if (invite.kind === 'repair') {
    // Update mode: the link token is bound to the broken item's access
    // token — Link re-authenticates the EXISTING Item instead of creating
    // a new one, so no public-token exchange happens on success.
    if (!invite.repairPlaidItemId) throw AppError.badRequest('This repair link is missing its bank connection');
    const item = await db.query.plaidItems.findFirst({ where: eq(plaidItems.id, invite.repairPlaidItemId) });
    if (!item || item.itemStatus === 'removed') {
      throw AppError.badRequest('This bank connection no longer exists. Ask your accountant for a new connect link.');
    }
    const { decrypt } = await import('../utils/encryption.js');
    const linkToken = await plaidClient.createUpdateLinkToken('system', `bank-repair:${invite.id}`, decrypt(item.accessTokenEncrypted), {
      redirectUri: oauthRedirectUri(),
    });
    return { linkToken };
  }

  const linkToken = await plaidClient.createLinkToken('system', `bank-invite:${invite.id}`, {
    redirectUri: oauthRedirectUri(),
  });
  return { linkToken };
}

export async function completeInviteConnection(
  token: string,
  publicToken: string,
  metadata: { institutionId?: string; institutionName?: string; accounts?: unknown[]; linkSessionId?: string },
): Promise<{ ok: true; institutionName: string | null; accountCount: number }> {
  // Status re-check happens BEFORE the exchange: a revoked/expired invite
  // never spends the public token, so no Plaid Item is created (nothing to
  // orphan-clean).
  const invite = await loadLiveInvite(token);
  if (invite.kind === 'repair') throw AppError.badRequest('This link repairs an existing connection — nothing to exchange');

  const plaidConnection = await import('./plaid-connection.service.js');
  // Attribute the connection to the INVITING staff user: createConnection's
  // dedup, orphan guard, and visibility math all work unchanged, and the
  // item shows up in the inviter's Bank Connections for mapping.
  const result = await plaidConnection.createConnection(invite.createdBy, publicToken, {
    ...metadata,
    source: 'client_invite',
  });

  const accountCount = Array.isArray(metadata.accounts) ? metadata.accounts.length : 0;
  await db.update(bankConnectInvites).set({
    status: 'connected',
    connectedAt: invite.connectedAt ?? new Date(),
    connectedPlaidItemId: invite.connectedPlaidItemId ?? (result.item?.id ?? null),
    connectionsCount: invite.connectionsCount + 1,
    updatedAt: new Date(),
  }).where(eq(bankConnectInvites.id, invite.id));

  await auditLog(invite.tenantId, 'update', 'bank_connect_invite', invite.id, null, {
    action: 'connected',
    institutionName: metadata.institutionName ?? null,
    plaidItemId: result.item?.id ?? null,
    isExisting: result.isExisting ?? false,
  }, invite.createdBy);

  // Best-effort inviter notification — the connection is already saved, so
  // a mail failure must never surface to the client.
  if (invite.createdByEmail) {
    try {
      const firmName = await firmNameFor(invite.tenantId, invite.companyId);
      const mailer = await getMailer();
      const subject = `${invite.recipientName} connected a bank account`;
      const body = `${invite.recipientName} connected ${accountCount || 'their'} account${accountCount === 1 ? '' : 's'}` +
        `${metadata.institutionName ? ` at ${metadata.institutionName}` : ''} using your invite (${firmName}).\n\n` +
        `Open Banking → Bank Connections in MyBooks to map the new accounts to the books.`;
      await mailer.send(invite.createdByEmail, subject, `<p>${body.replace(/\n\n/g, '</p><p>')}</p>`, body);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[bank-connect] inviter notification failed:', err instanceof Error ? err.message : err);
    }
  }

  return { ok: true, institutionName: metadata.institutionName ?? null, accountCount };
}

/**
 * Public completion for a repair invite. Link update mode already fixed the
 * credentials at Plaid — there is no token to exchange. We kick a sync,
 * whose success self-heals the item's error status (same path as the staff
 * Fix Now button); if Plaid is still settling, the scheduler's next pass
 * finishes the healing.
 */
export async function completeInviteRepair(token: string): Promise<{ ok: true; institutionName: string | null; healthy: boolean }> {
  const invite = await loadLiveInvite(token);
  if (invite.kind !== 'repair' || !invite.repairPlaidItemId) {
    throw AppError.badRequest('This link is not a repair link');
  }
  const item = await db.query.plaidItems.findFirst({ where: eq(plaidItems.id, invite.repairPlaidItemId) });
  if (!item || item.itemStatus === 'removed') {
    throw AppError.badRequest('This bank connection no longer exists. Ask your accountant for a new connect link.');
  }

  let healthy = false;
  try {
    const { syncItem } = await import('./plaid-sync.service.js');
    await syncItem(invite.repairPlaidItemId);
    healthy = true;
  } catch {
    // Sync still failing right after repair — leave the error state for the
    // scheduler; the client's part is done either way.
  }

  await db.update(bankConnectInvites).set({
    status: 'connected',
    connectedAt: invite.connectedAt ?? new Date(),
    connectionsCount: invite.connectionsCount + 1,
    updatedAt: new Date(),
  }).where(eq(bankConnectInvites.id, invite.id));

  await auditLog(invite.tenantId, 'update', 'bank_connect_invite', invite.id, null, {
    action: 'repaired', plaidItemId: invite.repairPlaidItemId,
    institutionName: item.institutionName, syncHealthy: healthy,
  }, invite.createdBy);

  // Best-effort inviter notification, same contract as the connect path.
  if (invite.createdByEmail) {
    try {
      const firmName = await firmNameFor(invite.tenantId, invite.companyId);
      const mailer = await getMailer();
      const bank = item.institutionName || 'their bank';
      const subject = `${invite.recipientName} fixed the ${bank} connection`;
      const body = `${invite.recipientName} updated their bank login for ${bank} (${firmName}).` +
        (healthy ? ' The connection is syncing again.' : ' The next scheduled sync will confirm the repair.');
      await mailer.send(invite.createdByEmail, subject, `<p>${body}</p>`, body);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[bank-connect] repair notification failed:', err instanceof Error ? err.message : err);
    }
  }

  return { ok: true, institutionName: item.institutionName, healthy };
}
