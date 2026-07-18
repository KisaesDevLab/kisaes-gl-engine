// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import crypto from 'crypto';
import { eq, and, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { magicLinks, users } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import * as systemEmail from './system-email.service.js';
import * as tfaConfigService from './tfa-config.service.js';
import * as tfaService from './tfa.service.js';
import { env } from '../config/env.js';

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function sendMagicLink(email: string, ipAddress: string, userAgent: string) {
  const normalized = email.trim().toLowerCase();
  const user = await db.query.users.findFirst({ where: eq(users.email, normalized) });
  // Don't reveal whether user exists — always return success-like response
  if (!user || !user.isActive) {
    return { sent: true, expiresInMinutes: 15 };
  }

  const config = await tfaConfigService.getConfig();

  // Ineligible REAL accounts must get the same silent success as unknown
  // emails: throwing here turned this endpoint into an email-enumeration
  // oracle (200 for strangers, 400 with a reason for registered accounts).
  // The reason is logged for the operator, never surfaced to the caller.
  // This also enforces the system-wide magicLinkEnabled admin toggle,
  // which was previously read for expiry/attempts but never checked.
  const methods = (user.tfaMethods || '').split(',').filter(Boolean);
  const hasNonEmail2fa = methods.includes('totp') || methods.includes('sms');
  const ineligible = !config.magicLinkEnabled ? 'system magic-link toggle is off'
    : !user.magicLinkEnabled ? 'user has not enabled magic-link login'
    : !hasNonEmail2fa ? 'user has no TOTP/SMS second factor'
    : null;
  if (ineligible) {
    console.warn(`[magic-link] silently refusing send for ${user.id}: ${ineligible}`);
    return { sent: true, expiresInMinutes: config.magicLinkExpiryMinutes || 15 };
  }
  // Rate limit: max pending links. (Previously read off getRawConfig()
  // via `as any` — that object only carries SMS fields, so both values
  // silently fell back to their defaults; getConfig() has the real ones.)
  const maxAttempts = config.magicLinkMaxAttempts || 3;
  const expiryMinutes = config.magicLinkExpiryMinutes || 15;

  const pending = await db.select({ id: magicLinks.id, createdAt: magicLinks.createdAt }).from(magicLinks)
    .where(and(eq(magicLinks.userId, user.id), eq(magicLinks.used, false), sql`expires_at > NOW()`));

  if (pending.length >= maxAttempts) {
    throw AppError.tooManyRequests('Too many pending login links. Check your email for an existing link or wait for it to expire.');
  }

  // 60-second cooldown between sends
  const mostRecent = await db.query.magicLinks.findFirst({
    where: eq(magicLinks.userId, user.id),
    orderBy: (ml, { desc }) => [desc(ml.createdAt)],
  });
  if (mostRecent && mostRecent.createdAt && (Date.now() - new Date(mostRecent.createdAt).getTime()) < 60_000) {
    throw AppError.tooManyRequests('Please wait 60 seconds before requesting another login link.');
  }

  // Generate token
  const token = crypto.randomBytes(32).toString('base64url');
  const tokenH = hashToken(token);
  const expiresAt = new Date(Date.now() + expiryMinutes * 60 * 1000);

  await db.insert(magicLinks).values({
    userId: user.id,
    tokenHash: tokenH,
    expiresAt,
    ipAddress,
    userAgent,
  });

  // Send email. Use PUBLIC_URL (the canonical externally-visible URL)
  // rather than CORS_ORIGIN, which is comma-separated and would produce
  // broken links on multi-origin appliances. PUBLIC_URL and CORS_ORIGIN
  // share the same default (http://localhost:5173) for single-origin
  // standalone installs, so existing customers see no change.
  const link = `${env.PUBLIC_URL.replace(/\/$/, '')}/auth/magic?token=${token}`;
  const name = await (async () => {
    try { const { getBranding } = await import('./admin.service.js'); return (await getBranding()).appName; }
    catch { return 'Vibe MyBooks'; }
  })();

  try {
    await systemEmail.sendActionEmail({
      to: user.email,
      subject: `Log in to ${name}`,
      bodyText: `Click the button below to log in.\n\nThis link expires in ${expiryMinutes} minutes and can only be used once.\n\nIf you didn't request this, ignore this email.`,
      cta: { label: `Log In to ${name}`, url: link },
    });
  } catch (err) {
    // Don't reveal user existence on email failure, but do log so an
    // SMTP misconfiguration doesn't silently drop every magic-link.
    console.warn(`[magic-link] email send failed for user ${user.id}:`, err);
  }

  await auditLog(user.tenantId, 'create', 'magic_link_sent', user.id, null, { ip: ipAddress }, user.id);

  return { sent: true, expiresInMinutes: expiryMinutes };
}

export async function verifyMagicLink(token: string) {
  // System-wide admin toggle: no new logins via magic link while off.
  // Safe to give a real reason here — presenting a token already proves
  // control of the mailbox, so this is not an enumeration surface.
  const config = await tfaConfigService.getConfig();
  if (!config.magicLinkEnabled) {
    throw AppError.badRequest('Magic link login is disabled by your administrator.');
  }

  const tokenH = hashToken(token);

  const link = await db.query.magicLinks.findFirst({
    where: and(eq(magicLinks.tokenHash, tokenH), eq(magicLinks.used, false)),
  });

  if (!link) throw AppError.badRequest('Invalid or expired login link.');
  if (new Date() > link.expiresAt) throw AppError.badRequest('This login link has expired. Please request a new one.');

  // Mark as used
  await db.update(magicLinks).set({ used: true, usedAt: new Date() }).where(eq(magicLinks.id, link.id));

  // Invalidate all other pending links for this user
  await db.update(magicLinks).set({ used: true, usedAt: new Date() })
    .where(and(eq(magicLinks.userId, link.userId), eq(magicLinks.used, false)));

  const user = await db.query.users.findFirst({ where: eq(users.id, link.userId) });
  if (!user || !user.isActive) throw AppError.unauthorized('Account not found or deactivated.');

  await auditLog(user.tenantId, 'create', 'magic_link_verified', user.id, null, null, user.id);

  // Return a tfa_token — magic link only proves email ownership (factor 1)
  // Factor 2 (TOTP or SMS) is still required
  const tfaToken = tfaService.generateTfaToken(user.id);

  // Get available non-email 2FA methods
  const methods = (user.tfaMethods || '').split(',').filter(Boolean);
  const nonEmailMethods = methods.filter((m) => m !== 'email'); // exclude email — magic link already proves email

  const emailMasked = user.email.replace(/^(.{1,2})(.*)(@.*)$/, '$1***$3');
  const phoneMasked = user.tfaPhone ? user.tfaPhone.replace(/^(.*)(.{4})$/, '***$2') : undefined;

  return {
    valid: true,
    tfaToken,
    availableMethods: nonEmailMethods,
    preferredMethod: user.tfaPreferredMethod && nonEmailMethods.includes(user.tfaPreferredMethod)
      ? user.tfaPreferredMethod
      : nonEmailMethods[0],
    phoneMasked,
    emailMasked,
  };
}

export async function cleanupExpiredLinks() {
  const result = await db.delete(magicLinks).where(
    sql`(used = true AND used_at < NOW() - INTERVAL '1 day') OR (expires_at < NOW())`,
  ).returning({ id: magicLinks.id });
  return result.length;
}

export async function getActiveLinksCount(userId: string): Promise<number> {
  const rows = await db.select({ id: magicLinks.id }).from(magicLinks)
    .where(and(eq(magicLinks.userId, userId), eq(magicLinks.used, false), sql`expires_at > NOW()`));
  return rows.length;
}
