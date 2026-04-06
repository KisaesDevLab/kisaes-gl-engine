import crypto from 'crypto';
import { eq, and, sql, lt } from 'drizzle-orm';
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
  const user = await db.query.users.findFirst({ where: eq(users.email, email) });
  // Don't reveal whether user exists — always return success-like response
  if (!user || !user.isActive) {
    return { sent: true, expiresInMinutes: 15 };
  }

  if (!user.magicLinkEnabled) {
    throw AppError.badRequest('Magic link login is not enabled for this account. Enable it in your security settings.');
  }

  // Verify user has non-email 2FA (TOTP or SMS)
  const methods = (user.tfaMethods || '').split(',').filter(Boolean);
  const hasNonEmail2fa = methods.includes('totp') || methods.includes('sms');
  if (!hasNonEmail2fa) {
    throw AppError.badRequest('Magic link login requires an authenticator app or SMS verification to be set up.');
  }

  // Rate limit: max pending links
  const config = await tfaConfigService.getConfig();
  const rawConfig = await tfaConfigService.getRawConfig();
  const maxAttempts = (rawConfig as any).magicLinkMaxAttempts || 3;
  const expiryMinutes = (rawConfig as any).magicLinkExpiryMinutes || 15;

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

  // Send email
  const appUrl = env.CORS_ORIGIN || 'http://localhost:5173';
  const link = `${appUrl}/auth/magic?token=${token}`;

  try {
    await systemEmail.sendCustomEmail(
      user.email,
      'Log in to Vibe MyBooks',
      `<p>Click the link below to log in:</p>
       <p><a href="${link}" style="display:inline-block;padding:12px 24px;background:#4F46E5;color:#fff;border-radius:8px;text-decoration:none;font-weight:600;">Log In to Vibe MyBooks</a></p>
       <p style="color:#6B7280;font-size:14px;">This link expires in ${expiryMinutes} minutes and can only be used once.</p>
       <p style="color:#6B7280;font-size:14px;">If you didn't request this, ignore this email.</p>`,
    );
  } catch {
    // If email fails, still don't reveal user existence
  }

  await auditLog(user.tenantId, 'create', 'magic_link_sent', user.id, null, { ip: ipAddress }, user.id);

  return { sent: true, expiresInMinutes: expiryMinutes };
}

export async function verifyMagicLink(token: string) {
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
