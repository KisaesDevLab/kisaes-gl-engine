// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { eq, and } from 'drizzle-orm';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from '@simplewebauthn/server';
import { db } from '../db/index.js';
import { passkeys, users, sessions } from '../db/schema/index.js';
import { env } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';

// ─── RP Configuration ──────────────────────────────────────────

function getRpId(): string {
  // Derive from CORS_ORIGIN or default to localhost
  try {
    const url = new URL(env.CORS_ORIGIN);
    return url.hostname;
  } catch {
    return 'localhost';
  }
}

function getRpOrigin(): string {
  return env.CORS_ORIGIN || 'http://localhost:5173';
}

// ─── Challenge Storage (in-memory with TTL) ────────────────────
//
// Registration challenges are keyed by userId because the caller is already
// authenticated — only the user who requested registration may complete it.
//
// Authentication challenges cannot be keyed by userId (passkey sign-in is
// optionally usernameless/discoverable). Instead, we key them by the
// challenge bytes themselves and require the client to echo that exact
// challenge back inside the signed clientDataJSON. Previously, the verify
// path iterated the map and accepted the first unexpired auth challenge it
// found, which meant a challenge issued for one pending sign-in could be
// consumed by a concurrent attacker's verify call — breaking the single-use
// guarantee WebAuthn depends on.

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const challengeStore = new Map<string, { challenge: string; expires: number }>();

function storeRegistrationChallenge(userId: string, challenge: string): void {
  challengeStore.set(`reg:${userId}`, { challenge, expires: Date.now() + CHALLENGE_TTL_MS });
}

function consumeRegistrationChallenge(userId: string): string | null {
  const key = `reg:${userId}`;
  const entry = challengeStore.get(key);
  challengeStore.delete(key);
  if (!entry || Date.now() > entry.expires) return null;
  return entry.challenge;
}

function storeAuthenticationChallenge(challenge: string): void {
  challengeStore.set(`auth:${challenge}`, { challenge, expires: Date.now() + CHALLENGE_TTL_MS });
}

function consumeAuthenticationChallenge(challenge: string): boolean {
  const key = `auth:${challenge}`;
  const entry = challengeStore.get(key);
  challengeStore.delete(key);
  if (!entry || Date.now() > entry.expires) return false;
  return entry.challenge === challenge;
}

// Opportunistic sweep so the in-memory map doesn't grow unbounded if some
// challenges are never consumed (e.g., user abandons the flow).
function sweepExpiredChallenges(): void {
  const now = Date.now();
  for (const [key, val] of challengeStore.entries()) {
    if (now > val.expires) challengeStore.delete(key);
  }
}

function extractChallengeFromResponse(clientDataJSONBase64Url: string): string | null {
  try {
    const json = Buffer.from(clientDataJSONBase64Url, 'base64url').toString('utf-8');
    const parsed = JSON.parse(json) as { challenge?: string };
    if (typeof parsed.challenge !== 'string') return null;
    // The echoed challenge must be a plausible base64url token; reject
    // anything with unexpected characters so we don't feed garbage into
    // the library or use it as a map-probe primitive.
    if (!/^[A-Za-z0-9_-]+$/.test(parsed.challenge)) return null;
    return parsed.challenge;
  } catch {
    return null;
  }
}

// ─── Registration ──────────────────────────────────────────────

export async function getRegistrationOptions(userId: string) {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw AppError.notFound('User not found');

  // Exclude existing credentials
  const existing = await db.select({ credentialId: passkeys.credentialId, transports: passkeys.transports })
    .from(passkeys).where(eq(passkeys.userId, userId));

  const excludeCredentials = existing.map((p) => ({
    id: p.credentialId,
    transports: (p.transports?.split(',') || []) as any[],
  }));

  const options = await generateRegistrationOptions({
    rpName: 'Vibe MyBooks',
    rpID: getRpId(),
    userID: new TextEncoder().encode(userId),
    userName: user.email,
    userDisplayName: user.displayName || user.email,
    excludeCredentials,
    authenticatorSelection: {
      userVerification: 'required',
      residentKey: 'preferred',
    },
    attestationType: 'none',
  });

  storeRegistrationChallenge(userId, options.challenge);
  return options;
}

export async function verifyRegistration(userId: string, response: RegistrationResponseJSON, deviceName?: string) {
  const expectedChallenge = consumeRegistrationChallenge(userId);
  if (!expectedChallenge) throw AppError.badRequest('Challenge expired or not found. Please try again.');

  const verification = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: getRpOrigin(),
    expectedRPID: getRpId(),
  });

  if (!verification.verified || !verification.registrationInfo) {
    throw AppError.badRequest('Passkey registration failed. Please try again.');
  }

  const { credential, credentialBackedUp } = verification.registrationInfo;

  const [pk] = await db.insert(passkeys).values({
    userId,
    credentialId: credential.id,
    publicKey: Buffer.from(credential.publicKey).toString('base64url'),
    counter: credential.counter,
    deviceName: deviceName || 'Passkey',
    transports: (credential.transports || []).join(','),
    backedUp: credentialBackedUp,
  }).returning();

  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (user) await auditLog(user.tenantId, 'create', 'passkey_registered', pk!.id, null, { deviceName }, userId);

  return { id: pk!.id, deviceName: pk!.deviceName, credentialId: credential.id };
}

// ─── Authentication ────────────────────────────────────────────

export async function getAuthenticationOptions(email?: string) {
  let allowCredentials: { id: string; transports?: any[] }[] = [];

  if (email) {
    const user = await db.query.users.findFirst({ where: eq(users.email, email.trim().toLowerCase()) });
    if (user) {
      const creds = await db.select({ credentialId: passkeys.credentialId, transports: passkeys.transports })
        .from(passkeys).where(eq(passkeys.userId, user.id));
      allowCredentials = creds.map((c) => ({
        id: c.credentialId,
        transports: (c.transports?.split(',') || []) as any[],
      }));
    }
  }

  const options = await generateAuthenticationOptions({
    rpID: getRpId(),
    allowCredentials,
    userVerification: 'required',
  });

  sweepExpiredChallenges();
  storeAuthenticationChallenge(options.challenge);
  return options;
}

export async function verifyAuthentication(response: AuthenticationResponseJSON) {
  // Look up the credential first so a nonexistent credentialId fails fast
  // without touching the challenge store.
  const pk = await db.query.passkeys.findFirst({
    where: eq(passkeys.credentialId, response.id),
  });
  if (!pk) throw AppError.unauthorized('Passkey not recognized.');

  // The challenge is whatever the authenticator signed over. We must use the
  // value echoed in clientDataJSON and then verify it matches a challenge we
  // actually issued. Consuming by exact-match + single-use prevents the
  // "first unexpired auth challenge wins" race that used to let a challenge
  // issued for one sign-in be claimed by a concurrent attacker's request.
  const echoedChallenge = extractChallengeFromResponse(response.response.clientDataJSON);
  if (!echoedChallenge) throw AppError.badRequest('Malformed passkey response.');
  if (!consumeAuthenticationChallenge(echoedChallenge)) {
    throw AppError.badRequest('Challenge expired or already used. Please try again.');
  }

  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge: echoedChallenge,
    expectedOrigin: getRpOrigin(),
    expectedRPID: getRpId(),
    credential: {
      id: pk.credentialId,
      publicKey: new Uint8Array(Buffer.from(pk.publicKey, 'base64url')),
      counter: pk.counter || 0,
      transports: (pk.transports?.split(',') || []) as any[],
    },
  });

  if (!verification.verified) {
    throw AppError.unauthorized('Passkey verification failed.');
  }

  // Update counter and last used
  await db.update(passkeys).set({
    counter: verification.authenticationInfo.newCounter,
    lastUsedAt: new Date(),
  }).where(eq(passkeys.id, pk.id));

  // Get user and generate tokens (skip 2FA — passkey is multi-factor)
  const user = await db.query.users.findFirst({ where: eq(users.id, pk.userId) });
  if (!user) throw AppError.notFound('User not found');
  if (!user.isActive) throw AppError.unauthorized('Account is deactivated');

  const accessToken = jwt.sign(
    { userId: user.id, tenantId: user.tenantId, role: user.role, isSuperAdmin: user.isSuperAdmin || false },
    env.JWT_SECRET, { expiresIn: 900 },
  );
  const refreshToken = crypto.randomBytes(48).toString('hex');
  const refreshHash = crypto.createHash('sha256').update(refreshToken).digest('hex');
  const expiresAt = new Date(); expiresAt.setDate(expiresAt.getDate() + 7);
  await db.insert(sessions).values({ userId: user.id, refreshTokenHash: refreshHash, expiresAt });

  // Update last login
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));

  await auditLog(user.tenantId, 'create', 'passkey_login', pk.id, null, { deviceName: pk.deviceName }, user.id);

  // Get accessible tenants
  const { getAccessibleTenants } = await import('./auth.service.js');
  const accessibleTenants = await getAccessibleTenants(user.id);

  return {
    user: {
      id: user.id, tenantId: user.tenantId, email: user.email,
      displayName: user.displayName, role: user.role, isActive: user.isActive,
      isSuperAdmin: user.isSuperAdmin || false, lastLoginAt: user.lastLoginAt,
      displayPreferences: user.displayPreferences,
      createdAt: user.createdAt, updatedAt: user.updatedAt,
    },
    tokens: { accessToken, refreshToken },
    accessibleTenants,
  };
}

// ─── Management ────────────────────────────────────────────────

export async function listPasskeys(userId: string) {
  return db.select({
    id: passkeys.id,
    deviceName: passkeys.deviceName,
    aaguid: passkeys.aaguid,
    transports: passkeys.transports,
    backedUp: passkeys.backedUp,
    lastUsedAt: passkeys.lastUsedAt,
    createdAt: passkeys.createdAt,
  }).from(passkeys).where(eq(passkeys.userId, userId));
}

export async function renamePasskey(userId: string, passkeyId: string, name: string) {
  const [updated] = await db.update(passkeys).set({ deviceName: name })
    .where(and(eq(passkeys.id, passkeyId), eq(passkeys.userId, userId))).returning();
  if (!updated) throw AppError.notFound('Passkey not found');
  return updated;
}

export async function removePasskey(userId: string, passkeyId: string) {
  const [deleted] = await db.delete(passkeys)
    .where(and(eq(passkeys.id, passkeyId), eq(passkeys.userId, userId))).returning();
  if (!deleted) throw AppError.notFound('Passkey not found');

  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (user) await auditLog(user.tenantId, 'delete', 'passkey_removed', passkeyId, null, { deviceName: deleted.deviceName }, userId);
}

export async function getPasskeyCount(userId: string): Promise<number> {
  const rows = await db.select({ id: passkeys.id }).from(passkeys).where(eq(passkeys.userId, userId));
  return rows.length;
}
