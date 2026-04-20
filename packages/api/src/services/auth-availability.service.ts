// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users, passkeys, tfaConfig } from '../db/schema/index.js';
import * as tfaConfigService from './tfa-config.service.js';
import { isSmtpConfigured } from './system-email.service.js';

// ─── Cached System Capabilities ────────────────────────────────

let cachedCapabilities: { smtpReady: boolean; smsReady: boolean; ts: number } | null = null;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export function invalidateCapabilitiesCache() {
  cachedCapabilities = null;
}

export async function getSystemCapabilities() {
  if (cachedCapabilities && Date.now() - cachedCapabilities.ts < CACHE_TTL) {
    return { ...cachedCapabilities, passkeysSupported: true, totpSupported: true };
  }

  const smtpReady = await isSmtpConfigured();
  const config = await tfaConfigService.getConfig();
  const smsReady = config.smsConfigured;

  cachedCapabilities = { smtpReady, smsReady, ts: Date.now() };
  return { smtpReady, smsReady, passkeysSupported: true, totpSupported: true };
}

// ─── Effective Methods (admin toggles × infrastructure) ────────

export async function getEffectiveLoginMethods() {
  const caps = await getSystemCapabilities();
  const config = await getPasswordlessConfig();

  return {
    password: true,
    magicLink: config.magicLinkEnabled && caps.smtpReady,
    passkey: config.passkeysEnabled,
  };
}

export async function getEffective2faMethods() {
  const caps = await getSystemCapabilities();
  const config = await tfaConfigService.getConfig();

  const methods: string[] = [];
  if (config.allowedMethods.includes('email') && caps.smtpReady) methods.push('email');
  if (config.allowedMethods.includes('sms') && caps.smsReady) methods.push('sms');
  if (config.allowedMethods.includes('totp')) methods.push('totp');
  return methods;
}

// ─── User-Specific Method Availability ─────────────────────────

export async function getUserAvailableMethods(userId: string) {
  const loginMethods = await getEffectiveLoginMethods();
  const tfaMethods = await getEffective2faMethods();

  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) return { loginMethods: { password: true, magicLink: false, passkey: false }, tfaMethods: [], preferredLogin: 'password' as const, preferredTfa: null };

  const userTfaMethods = (user.tfaMethods || '').split(',').filter(Boolean);
  const passkeyCount = (await db.select({ id: passkeys.id }).from(passkeys).where(eq(passkeys.userId, userId))).length;

  // Filter login methods by user state
  const userLoginMethods = {
    password: true,
    magicLink: loginMethods.magicLink && user.magicLinkEnabled && userTfaMethods.some((m) => m === 'totp' || m === 'sms'),
    passkey: loginMethods.passkey && passkeyCount > 0,
  };

  // Filter 2FA methods by user setup
  const userTfa = tfaMethods.filter((m) => {
    if (m === 'email') return userTfaMethods.includes('email');
    if (m === 'sms') return userTfaMethods.includes('sms') && user.tfaPhoneVerified;
    if (m === 'totp') return userTfaMethods.includes('totp') && user.tfaTotpVerified;
    return false;
  });

  return {
    loginMethods: userLoginMethods,
    tfaMethods: userTfa,
    preferredLogin: user.preferredLoginMethod || 'password',
    preferredTfa: user.tfaPreferredMethod || userTfa[0] || null,
  };
}

// ─── Public Auth Methods Endpoint Data ─────────────────────────

export async function getAuthMethods(email?: string) {
  const loginMethods = await getEffectiveLoginMethods();
  const caps = await getSystemCapabilities();
  const config = await tfaConfigService.getConfig();

  // The response shape is fixed regardless of whether the caller supplied
  // an email, whether that email is registered, and whether that account
  // has passkeys. Previously, registered emails got two extra fields
  // (`userHasPasskeys`, `userPreferredMethod`) appended — which turned the
  // endpoint into a reliable email-enumeration oracle. Always return the
  // same keys with safe defaults; only mutate the values we've decided are
  // safe to disclose (currently: none).
  // Turnstile site key is safe to expose to the browser — it's the
  // public half of the pair (the secret lives server-side in
  // TURNSTILE_SECRET_KEY). The literal string `disabled` or an empty
  // value means "no widget on the login page", which also aligns with
  // the server-side verifier's skip-on-disabled path so dev and
  // LAN-only installs stay silent.
  const rawSiteKey = process.env['TURNSTILE_SITE_KEY'];
  const turnstileSiteKey = rawSiteKey && rawSiteKey !== 'disabled' ? rawSiteKey : null;

  const base = {
    loginMethods: {
      password: true,
      magicLink: loginMethods.magicLink,
      passkey: loginMethods.passkey,
    },
    tfaAvailable: config.isEnabled,
    smtpReady: caps.smtpReady,
    smsReady: caps.smsReady,
    userHasPasskeys: false,
    userPreferredMethod: 'password' as string,
    turnstileSiteKey,
  };

  if (!email) return base;

  // Touch the DB either way so timing matches when the email is / isn't
  // registered. The result is intentionally discarded — see note above.
  await db.query.users.findFirst({ where: eq(users.email, email.trim().toLowerCase()) });
  return base;
}

// ─── Helper to get passwordless config ─────────────────────────

async function getPasswordlessConfig() {
  const config = await db.query.tfaConfig.findFirst();
  return {
    passkeysEnabled: config?.passkeysEnabled || false,
    magicLinkEnabled: config?.magicLinkEnabled || false,
    magicLinkExpiryMinutes: config?.magicLinkExpiryMinutes || 15,
    magicLinkMaxAttempts: config?.magicLinkMaxAttempts || 3,
  };
}

export { getPasswordlessConfig };
