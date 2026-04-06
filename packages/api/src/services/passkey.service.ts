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

const challengeStore = new Map<string, { challenge: string; expires: number }>();

function storeChallenge(userId: string, challenge: string): void {
  challengeStore.set(`webauthn:${userId}`, { challenge, expires: Date.now() + 5 * 60 * 1000 });
}

function getChallenge(userId: string): string | null {
  const key = `webauthn:${userId}`;
  const entry = challengeStore.get(key);
  if (!entry || Date.now() > entry.expires) {
    challengeStore.delete(key);
    return null;
  }
  challengeStore.delete(key);
  return entry.challenge;
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

  storeChallenge(userId, options.challenge);
  return options;
}

export async function verifyRegistration(userId: string, response: RegistrationResponseJSON, deviceName?: string) {
  const expectedChallenge = getChallenge(userId);
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
    const user = await db.query.users.findFirst({ where: eq(users.email, email) });
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

  // Store challenge keyed by challenge itself (since we may not know the user yet)
  storeChallenge(`auth:${options.challenge}`, options.challenge);
  return options;
}

export async function verifyAuthentication(response: AuthenticationResponseJSON, expectedChallenge?: string) {
  // Look up the credential
  const pk = await db.query.passkeys.findFirst({
    where: eq(passkeys.credentialId, response.id),
  });
  if (!pk) throw AppError.unauthorized('Passkey not recognized.');

  // Retrieve challenge
  const challenge = expectedChallenge || getChallenge(`auth:${response.response.clientDataJSON}`);
  // Try the challenge stored by the options call
  let storedChallenge: string | null = null;
  // We stored it as auth:<challenge>, so iterate to find it
  for (const [key, val] of challengeStore.entries()) {
    if (key.startsWith('auth:') && Date.now() < val.expires) {
      storedChallenge = val.challenge;
      challengeStore.delete(key);
      break;
    }
  }

  if (!storedChallenge) throw AppError.badRequest('Challenge expired. Please try again.');

  const verification = await verifyAuthenticationResponse({
    response,
    expectedChallenge: storedChallenge,
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
