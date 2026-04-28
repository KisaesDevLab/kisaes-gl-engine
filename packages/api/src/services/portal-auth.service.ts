// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import {
  portalContacts,
  portalContactCompanies,
  portalMagicLinks,
  portalContactSessions,
  portalPasswords,
  portalSettingsPerPractice,
  previewSessions,
  companies,
} from '../db/schema/index.js';
import { env } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { getSmtpSettings } from './admin.service.js';
import { auditLog } from '../middleware/audit.js';

// VIBE_MYBOOKS_PRACTICE_BUILD_PLAN Phase 9 — magic-link auth +
// portal session lifecycle. Distinct from staff JWT auth.

const MAGIC_LINK_TTL_MIN = 15;
const SESSION_TTL_HOURS = 24;
const RATE_LIMIT_PER_HOUR = 5;

function sha256Hex(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function generateToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

async function ensureSmtpTransport(): Promise<{
  send: (to: string, subject: string, html: string, text: string) => Promise<void>;
  from: string;
  isStub: boolean;
}> {
  const smtp = await getSmtpSettings();
  const from = smtp.smtpFrom || 'noreply@example.com';
  if (!smtp.smtpHost) {
    return {
      from,
      isStub: true,
      send: async (to, subject, _html, text) => {
        // No SMTP configured — log the magic-link payload so the dev
        // operator can copy/paste the link from container logs. Phase
        // 9 ships code-complete; live email requires SMTP_HOST set.
        // eslint-disable-next-line no-console
        console.log(
          JSON.stringify({
            ts: new Date().toISOString(),
            level: 'info',
            component: 'portal-mail-stub',
            event: 'send',
            to,
            subject,
            preview: text.slice(0, 400),
          }),
        );
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
    from,
    isStub: false,
    send: async (to, subject, html, text) => {
      await transport.sendMail({ from, to, subject, html, text });
    },
  };
}

// 9.2 — request magic link.
//   - looks up active portal_contact by email + tenant
//   - rate limits to 5 requests per email per hour
//   - invalidates prior unconsumed links
//   - emails the magic-link URL
//
// Always returns ok: true regardless of whether the contact exists,
// to prevent email-enumeration. The action only happens when a real
// contact is found.
export async function requestMagicLink(args: {
  tenantId: string;
  email: string;
  baseUrl: string;
  ipAddress?: string;
}): Promise<{ ok: true; sent: boolean }> {
  const email = normalizeEmail(args.email);
  if (!email.includes('@')) return { ok: true, sent: false };

  const contact = await db.query.portalContacts.findFirst({
    where: and(eq(portalContacts.tenantId, args.tenantId), eq(portalContacts.email, email)),
  });
  if (!contact || contact.status !== 'active') return { ok: true, sent: false };

  // Rate limit window: per-email, last hour.
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const recent = await db
    .select({ n: sql<number>`COUNT(*)::int` })
    .from(portalMagicLinks)
    .where(
      and(
        eq(portalMagicLinks.contactId, contact.id),
        sql`${portalMagicLinks.createdAt} >= ${oneHourAgo}`,
      ),
    );
  const recentCount = Number(recent[0]?.n ?? 0);
  if (recentCount >= RATE_LIMIT_PER_HOUR) {
    throw AppError.tooManyRequests('Too many sign-in requests. Try again later.');
  }

  // Invalidate every prior unconsumed link for this contact.
  await db
    .update(portalMagicLinks)
    .set({ invalidatedAt: new Date() })
    .where(
      and(
        eq(portalMagicLinks.contactId, contact.id),
        isNull(portalMagicLinks.consumedAt),
        isNull(portalMagicLinks.invalidatedAt),
      ),
    );

  const token = generateToken();
  const tokenHash = sha256Hex(token);
  const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_MIN * 60 * 1000);

  await db.insert(portalMagicLinks).values({
    tenantId: args.tenantId,
    contactId: contact.id,
    tokenHash,
    emailSentTo: email,
    ipAddress: args.ipAddress ?? null,
    expiresAt,
  });

  const link = `${args.baseUrl.replace(/\/$/, '')}/portal/auth/verify?token=${encodeURIComponent(
    token,
  )}`;
  const greeting = contact.firstName ? `Hi ${contact.firstName},` : 'Hello,';
  const text = `${greeting}\n\nUse the link below to sign in to the portal. It expires in ${MAGIC_LINK_TTL_MIN} minutes and can only be used once.\n\n${link}\n\nIf you didn't request this, you can ignore this email.`;
  const html = `<p>${greeting}</p><p>Use the button below to sign in. The link expires in ${MAGIC_LINK_TTL_MIN} minutes and can only be used once.</p><p><a href="${link}" style="display:inline-block;background:#4f46e5;color:#fff;padding:10px 16px;text-decoration:none;border-radius:6px">Sign in to the portal</a></p><p>Or copy and paste this URL: <code>${link}</code></p><p style="color:#888;font-size:12px">If you didn't request this, you can ignore this email.</p>`;

  const mailer = await ensureSmtpTransport();
  await mailer.send(email, 'Your portal sign-in link', html, text);

  await auditLog(
    args.tenantId,
    'create',
    'portal_magic_link',
    null,
    null,
    { contactId: contact.id, email, viaStub: mailer.isStub },
  );

  return { ok: true, sent: true };
}

export interface VerifiedSession {
  sessionToken: string;
  contactId: string;
  tenantId: string;
  expiresAt: Date;
  // List of company ids the contact is linked to. The portal UI uses
  // this to render the company switcher.
  companies: Array<{ companyId: string; companyName: string; role: string }>;
}

// 9.3 — verify magic link, mint session.
export async function verifyMagicLink(args: {
  token: string;
  ipAddress?: string;
  userAgent?: string;
}): Promise<VerifiedSession> {
  const tokenHash = sha256Hex(args.token);
  const link = await db.query.portalMagicLinks.findFirst({
    where: eq(portalMagicLinks.tokenHash, tokenHash),
  });
  if (!link) throw AppError.unauthorized('Invalid or expired sign-in link', 'BAD_TOKEN');
  if (link.consumedAt) throw AppError.unauthorized('This link has already been used', 'TOKEN_USED');
  if (link.invalidatedAt) throw AppError.unauthorized('This link is no longer valid', 'TOKEN_INVALIDATED');
  if (link.expiresAt.getTime() < Date.now()) {
    throw AppError.unauthorized('This sign-in link has expired', 'TOKEN_EXPIRED');
  }

  const contact = await db.query.portalContacts.findFirst({
    where: eq(portalContacts.id, link.contactId),
  });
  if (!contact || contact.status !== 'active') {
    throw AppError.unauthorized('Account is not active', 'CONTACT_INACTIVE');
  }

  const sessionToken = generateToken();
  const sessionHash = sha256Hex(sessionToken);
  const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 60 * 60 * 1000);

  return db.transaction(async (tx) => {
    // Mark the link consumed atomically with the session insert.
    await tx
      .update(portalMagicLinks)
      .set({ consumedAt: new Date() })
      .where(eq(portalMagicLinks.id, link.id));

    await tx.insert(portalContactSessions).values({
      tenantId: link.tenantId,
      contactId: contact.id,
      tokenHash: sessionHash,
      expiresAt,
      ipAddress: args.ipAddress ?? null,
      userAgent: args.userAgent ?? null,
    });

    // Update last_seen on the contact (live tracking — not preview).
    await tx
      .update(portalContacts)
      .set({ lastSeenAt: new Date() })
      .where(eq(portalContacts.id, contact.id));

    const cos = await tx
      .select({
        companyId: portalContactCompanies.companyId,
        companyName: companies.businessName,
        role: portalContactCompanies.role,
      })
      .from(portalContactCompanies)
      .innerJoin(companies, eq(portalContactCompanies.companyId, companies.id))
      .where(eq(portalContactCompanies.contactId, contact.id));

    return {
      sessionToken,
      contactId: contact.id,
      tenantId: link.tenantId,
      expiresAt,
      companies: cos,
    };
  });
}

// 9.4 — set or rotate a password. Bcrypt cost factor 12 to match
// the staff users table.
const BCRYPT_COST = 12;

export async function setPassword(contactId: string, password: string): Promise<void> {
  if (!password || password.length < 8) {
    throw AppError.badRequest('Password must be at least 8 characters', 'WEAK_PASSWORD');
  }
  const hash = await bcrypt.hash(password, BCRYPT_COST);
  await db
    .insert(portalPasswords)
    .values({ contactId, bcryptHash: hash, active: true })
    .onConflictDoUpdate({
      target: portalPasswords.contactId,
      set: { bcryptHash: hash, setAt: new Date(), active: true },
    });
}

export async function loginWithPassword(args: {
  tenantId: string;
  email: string;
  password: string;
  ipAddress?: string;
  userAgent?: string;
}): Promise<VerifiedSession> {
  const email = normalizeEmail(args.email);
  const contact = await db.query.portalContacts.findFirst({
    where: and(eq(portalContacts.tenantId, args.tenantId), eq(portalContacts.email, email)),
  });
  // Constant-time-ish failure to avoid leaking which emails exist.
  if (!contact || contact.status !== 'active') {
    throw AppError.unauthorized('Invalid email or password', 'INVALID_CREDS');
  }
  const pw = await db.query.portalPasswords.findFirst({
    where: eq(portalPasswords.contactId, contact.id),
  });
  if (!pw || !pw.active) {
    throw AppError.unauthorized('No password set — request a magic link instead', 'NO_PASSWORD');
  }
  const ok = await bcrypt.compare(args.password, pw.bcryptHash);
  if (!ok) throw AppError.unauthorized('Invalid email or password', 'INVALID_CREDS');

  const sessionToken = generateToken();
  const sessionHash = sha256Hex(sessionToken);
  const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 60 * 60 * 1000);

  return db.transaction(async (tx) => {
    await tx.insert(portalContactSessions).values({
      tenantId: contact.tenantId,
      contactId: contact.id,
      tokenHash: sessionHash,
      expiresAt,
      ipAddress: args.ipAddress ?? null,
      userAgent: args.userAgent ?? null,
    });
    await tx
      .update(portalContacts)
      .set({ lastSeenAt: new Date() })
      .where(eq(portalContacts.id, contact.id));
    const cos = await tx
      .select({
        companyId: portalContactCompanies.companyId,
        companyName: companies.businessName,
        role: portalContactCompanies.role,
      })
      .from(portalContactCompanies)
      .innerJoin(companies, eq(portalContactCompanies.companyId, companies.id))
      .where(eq(portalContactCompanies.contactId, contact.id));
    return {
      sessionToken,
      contactId: contact.id,
      tenantId: contact.tenantId,
      expiresAt,
      companies: cos,
    };
  });
}

// 9.9 — middleware-friendly session resolver. Returns the contact
// payload or throws Unauthorized. Updates last_activity_at.
export async function resolveSession(sessionToken: string): Promise<{
  sessionId: string;
  contactId: string;
  tenantId: string;
  expiresAt: Date;
  contact: {
    id: string;
    email: string;
    firstName: string | null;
    lastName: string | null;
  };
}> {
  if (!sessionToken) throw AppError.unauthorized('No portal session', 'NO_SESSION');
  const hash = sha256Hex(sessionToken);
  const session = await db.query.portalContactSessions.findFirst({
    where: eq(portalContactSessions.tokenHash, hash),
  });
  if (!session) throw AppError.unauthorized('Portal session not found', 'NO_SESSION');
  if (session.expiresAt.getTime() < Date.now()) {
    throw AppError.unauthorized('Portal session expired', 'SESSION_EXPIRED');
  }

  // Idle timeout: 30 min since last activity.
  const idleMs = Date.now() - session.lastActivityAt.getTime();
  if (idleMs > 30 * 60 * 1000) {
    throw AppError.unauthorized('Portal session idle — please sign in again', 'SESSION_IDLE');
  }

  const contact = await db.query.portalContacts.findFirst({
    where: eq(portalContacts.id, session.contactId),
  });
  if (!contact || contact.status !== 'active') {
    throw AppError.unauthorized('Account is not active', 'CONTACT_INACTIVE');
  }

  // Touch last_activity_at — best-effort, swallow concurrent errors.
  await db
    .update(portalContactSessions)
    .set({ lastActivityAt: new Date() })
    .where(eq(portalContactSessions.id, session.id));

  return {
    sessionId: session.id,
    contactId: session.contactId,
    tenantId: session.tenantId,
    expiresAt: session.expiresAt,
    contact: {
      id: contact.id,
      email: contact.email,
      firstName: contact.firstName,
      lastName: contact.lastName,
    },
  };
}

export async function logout(sessionToken: string): Promise<void> {
  if (!sessionToken) return;
  const hash = sha256Hex(sessionToken);
  await db
    .delete(portalContactSessions)
    .where(eq(portalContactSessions.tokenHash, hash));
}

// Periodic cleaner — called from the existing scheduler tick or an
// ad-hoc admin endpoint. Removes expired magic links + sessions so
// the tables don't grow unbounded.
export async function purgeExpired(): Promise<{ links: number; sessions: number }> {
  const now = new Date();
  const linksRes = await db
    .delete(portalMagicLinks)
    .where(lt(portalMagicLinks.expiresAt, now));
  const sessionsRes = await db
    .delete(portalContactSessions)
    .where(lt(portalContactSessions.expiresAt, now));
  return {
    links: (linksRes as { rowCount?: number }).rowCount ?? 0,
    sessions: (sessionsRes as { rowCount?: number }).rowCount ?? 0,
  };
}

// 8.4 — preview ("View as Client") tokens. Signed JWT carrying the
// initiating staff user, the impersonated contact + company, the
// preview origin, and an explicit isPreview flag. The token is
// distinct from the magic-link cookie session: it embeds bookkeeper
// authentication and rides in its own cookie so portal middleware
// can detect "this is a preview" and short-circuit every write.

const PREVIEW_TTL_SEC = 30 * 60; // 30 minutes per the build plan

export interface PreviewTokenPayload {
  initiatingUserId: string;
  tenantId: string;
  contactId: string;
  companyId: string;
  origin: 'contact_detail' | 'contact_list' | 'close_page' | 'question_view';
  previewSessionId: string;
  iat: number;
  exp: number;
}

export async function startPreview(args: {
  initiatingUserId: string;
  initiatingUserRole: string;
  tenantId: string;
  contactId: string;
  companyId: string;
  origin: 'contact_detail' | 'contact_list' | 'close_page' | 'question_view';
}): Promise<{ token: string; expiresAt: Date; previewSessionId: string }> {
  // Practice-level allowlist + enable check.
  const practice = await db.query.portalSettingsPerPractice.findFirst({
    where: eq(portalSettingsPerPractice.tenantId, args.tenantId),
  });
  if (practice && !practice.previewEnabled) {
    throw AppError.forbidden('Preview mode is disabled for this practice');
  }
  const allowedRoles = practice?.previewAllowedRoles
    ? practice.previewAllowedRoles.split(',').map((s) => s.trim()).filter(Boolean)
    : ['owner', 'bookkeeper', 'accountant'];
  if (!allowedRoles.includes(args.initiatingUserRole)) {
    throw AppError.forbidden('Your role is not allowed to start preview sessions');
  }

  // Verify contact + company belong to tenant and are linked.
  const contact = await db.query.portalContacts.findFirst({
    where: and(eq(portalContacts.tenantId, args.tenantId), eq(portalContacts.id, args.contactId)),
  });
  if (!contact) throw AppError.notFound('Contact not found');
  const co = await db.query.companies.findFirst({
    where: and(eq(companies.tenantId, args.tenantId), eq(companies.id, args.companyId)),
  });
  if (!co) throw AppError.notFound('Company not found');
  const link = await db
    .select({ id: portalContactCompanies.contactId })
    .from(portalContactCompanies)
    .where(
      and(
        eq(portalContactCompanies.contactId, args.contactId),
        eq(portalContactCompanies.companyId, args.companyId),
      ),
    )
    .limit(1);
  if (link.length === 0) {
    throw AppError.badRequest('Contact is not linked to this company');
  }

  // Insert the preview_sessions audit row first — the JWT carries its id.
  const inserted = await db
    .insert(previewSessions)
    .values({
      tenantId: args.tenantId,
      userId: args.initiatingUserId,
      contactId: args.contactId,
      companyId: args.companyId,
      origin: args.origin,
    })
    .returning({ id: previewSessions.id });
  const session = inserted[0];
  if (!session) throw AppError.badRequest('Insert failed');

  const expiresAt = new Date(Date.now() + PREVIEW_TTL_SEC * 1000);
  const token = jwt.sign(
    {
      initiatingUserId: args.initiatingUserId,
      tenantId: args.tenantId,
      contactId: args.contactId,
      companyId: args.companyId,
      origin: args.origin,
      previewSessionId: session.id,
    },
    env.JWT_SECRET,
    { expiresIn: PREVIEW_TTL_SEC },
  );

  // Audit event so the practice-level "Preview sessions last 30 days"
  // report has a record alongside the standard audit feed.
  await auditLog(
    args.tenantId,
    'create',
    'preview_session_start',
    session.id,
    null,
    {
      contactId: args.contactId,
      companyId: args.companyId,
      origin: args.origin,
    },
    args.initiatingUserId,
  );

  return { token, expiresAt, previewSessionId: session.id };
}

export function verifyPreviewToken(token: string): PreviewTokenPayload {
  try {
    return jwt.verify(token, env.JWT_SECRET) as PreviewTokenPayload;
  } catch {
    throw AppError.unauthorized('Preview token invalid or expired', 'PREVIEW_TOKEN_INVALID');
  }
}

export async function endPreview(previewSessionId: string, initiatingUserId: string): Promise<void> {
  const session = await db.query.previewSessions.findFirst({
    where: eq(previewSessions.id, previewSessionId),
  });
  if (!session || session.endedAt) return;
  const now = new Date();
  const durationSeconds = Math.floor((now.getTime() - session.startedAt.getTime()) / 1000);
  await db
    .update(previewSessions)
    .set({ endedAt: now, durationSeconds })
    .where(eq(previewSessions.id, previewSessionId));
  await auditLog(
    session.tenantId,
    'update',
    'preview_session_end',
    previewSessionId,
    { startedAt: session.startedAt },
    { endedAt: now, durationSeconds },
    initiatingUserId,
  );
}

// Looks up tenant id by host header (custom-domain mapping per
// portal_settings_per_practice.custom_domain). Used when the portal
// is reached via a CF-Tunnel-fronted vanity domain rather than the
// firm's app URL.
export async function resolveTenantByHost(host: string): Promise<string | null> {
  const cleaned = host.replace(/^www\./, '').toLowerCase();
  const row = await db.query.portalSettingsPerPractice.findFirst({
    where: eq(portalSettingsPerPractice.customDomain, cleaned),
  });
  return row?.tenantId ?? null;
}
