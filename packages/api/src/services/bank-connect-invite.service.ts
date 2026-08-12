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
import { eq, and, desc, count } from 'drizzle-orm';
import { db } from '../db/index.js';
import { bankConnectInvites, users, tenants, companies, portalSettingsPerPractice } from '../db/schema/index.js';
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
}): Promise<{ channels: Array<'email' | 'sms'>; viaEmailStub: boolean; smsError?: string }> {
  const firmName = await firmNameFor(args.tenantId, args.companyId);
  const link = `${args.baseUrl.replace(/\/$/, '')}/connect/${encodeURIComponent(args.token)}`;
  const channels: Array<'email' | 'sms'> = [];
  let viaEmailStub = false;
  let smsError: string | undefined;

  if (args.invite.recipientEmail) {
    const greeting = `Hello ${args.invite.recipientName},`;
    const text = `${greeting}\n\n${firmName} has asked you to securely connect your bank account so your bookkeeping stays up to date. Open the link below to get started — it takes about two minutes and your banking credentials go directly to your bank, never to us.\n\n${link}\n\nThe link is valid for ${INVITE_TTL_DAYS} days.${args.invite.message ? `\n\n${args.invite.message}` : ''}`;
    const html = `<p>${greeting}</p><p><strong>${firmName}</strong> has asked you to securely connect your bank account so your bookkeeping stays up to date. It takes about two minutes, and your banking credentials go directly to your bank — never to us.</p><p><a href="${link}" style="display:inline-block;background:#4f46e5;color:#fff;padding:10px 16px;text-decoration:none;border-radius:6px">Connect your bank</a></p><p style="color:#888;font-size:12px">Link valid for ${INVITE_TTL_DAYS} days. If you didn't expect this, you can ignore this message.</p>${args.invite.message ? `<hr><p>${args.invite.message}</p>` : ''}`;
    const mailer = await getMailer();
    await mailer.send(args.invite.recipientEmail, `${firmName} — connect your bank account`, html, text);
    viaEmailStub = mailer.isStub;
    channels.push('email');
  }

  if (args.invite.recipientPhone) {
    const result = await sendInviteSms(args.invite.recipientPhone, buildInviteSmsBody(link));
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
      'Outbound SMS is disabled for this practice — enable it under Practice settings, or send the invite by email.',
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

  const sent = await composeAndSend({
    invite: {
      id: invite.id, recipientName: invite.recipientName,
      recipientEmail: invite.recipientEmail, recipientPhone: invite.recipientPhone,
      message: invite.message,
    },
    tenantId, companyId: invite.companyId, token, baseUrl,
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
  recipientName: string;
  firmName: string;
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
  return {
    status: invite.status === 'sent' ? 'viewed' : invite.status,
    recipientName: invite.recipientName,
    firmName: await firmNameFor(invite.tenantId, invite.companyId),
    expiresAt: invite.expiresAt,
    connectionsCount: invite.connectionsCount,
  };
}

export async function createLinkTokenForInvite(token: string): Promise<{ linkToken: string }> {
  const invite = await loadLiveInvite(token);
  const plaidClient = await import('./plaid-client.service.js');
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
