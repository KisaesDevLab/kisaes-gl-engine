// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

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
import { passkeys, users } from '../db/schema/index.js';
import { env } from '../config/env.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import {
  storeRegistrationChallenge,
  consumeRegistrationChallenge,
  storeAuthenticationChallenge,
  consumeAuthenticationChallenge,
} from './passkey-challenge-store.js';

// ─── RP Configuration ──────────────────────────────────────────
//
// Resolution order (vibe-distribution-plan D3):
//   1. WEBAUTHN_RP_ID env (explicit; multi-app installs set this so
//      the rpId stays stable across an HTTPS-terminating reverse proxy
//      whose PUBLIC_URL host matches but whose proxied origin doesn't).
//   2. URL(PUBLIC_URL).hostname — single source for the externally
//      visible origin in the new env contract. PUBLIC_URL has a Zod
//      default of http://localhost:5173, so this branch is the
//      effective default.
//   3. 'localhost' — final defensive fallback when PUBLIC_URL is set
//      to something unparseable (would have failed Zod validation
//      already, so this is belt-and-suspenders).
//
// rpOrigin (the WebAuthn origin string the browser must echo back at
// verification time) is just PUBLIC_URL — Zod's url() refinement
// guarantees it parses, and the schema default covers single-app dev.

// Exported for unit tests under refresh-cookie-style env-reload pattern.
export function getRpId(): string {
  if (env.WEBAUTHN_RP_ID && env.WEBAUTHN_RP_ID.length > 0) {
    return env.WEBAUTHN_RP_ID;
  }
  try {
    return new URL(env.PUBLIC_URL).hostname;
  } catch {
    return 'localhost';
  }
}

export function getRpOrigin(): string {
  // WebAuthn origins are scheme+host(+port) with NO path — the browser always
  // echoes a path-less origin (e.g. https://vibe.cpa2web.app). Returning
  // PUBLIC_URL verbatim breaks verification when PUBLIC_URL carries a sub-path
  // (e.g. https://host/mybooks): expectedOrigin would include /mybooks and never
  // match. Normalize to the origin so passkeys work whether or not PUBLIC_URL
  // has a path.
  try {
    return new URL(env.PUBLIC_URL).origin;
  } catch {
    return env.PUBLIC_URL;
  }
}

// ─── Challenge Storage ─────────────────────────────────────────
//
// Challenge persistence (store + single-use consume) lives in
// ./passkey-challenge-store, which is Redis-backed with an in-memory
// fallback so the single-use guarantee holds across replicas. The single-
// use semantics it provides are what WebAuthn depends on: a challenge
// issued for one pending sign-in can be consumed exactly once, closing the
// race where a concurrent verify could claim someone else's challenge.

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

  await storeRegistrationChallenge(userId, options.challenge);
  return options;
}

export async function verifyRegistration(userId: string, response: RegistrationResponseJSON, deviceName?: string) {
  const expectedChallenge = await consumeRegistrationChallenge(userId);
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

  await storeAuthenticationChallenge(options.challenge);
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
  if (!(await consumeAuthenticationChallenge(echoedChallenge))) {
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

  // Clone detection: the WebAuthn signature counter exists specifically to
  // catch a cloned authenticator, which replays a counter that hasn't
  // advanced past the stored value. @simplewebauthn does NOT enforce this —
  // it returns newCounter and leaves the policy to us. Fail closed on a
  // non-advancing counter. Authenticators that don't implement a counter
  // report 0 forever (newCounter === 0); that legitimate case stays allowed.
  const { newCounter } = verification.authenticationInfo;
  const storedCounter = pk.counter || 0;
  if (newCounter !== 0 && newCounter <= storedCounter) {
    throw AppError.unauthorized('Passkey verification failed.');
  }

  // Update counter and last used
  await db.update(passkeys).set({
    counter: newCounter,
    lastUsedAt: new Date(),
  }).where(eq(passkeys.id, pk.id));

  // Get user and generate tokens (skip 2FA — passkey is multi-factor)
  const user = await db.query.users.findFirst({ where: eq(users.id, pk.userId) });
  if (!user) throw AppError.notFound('User not found');
  if (!user.isActive) throw AppError.unauthorized('Account is deactivated');

  // Mint tokens via the shared helper so MAX_SESSIONS_PER_USER is enforced
  // and JWT_ACCESS_EXPIRY is honoured. The previous inline path bypassed
  // both and let passkey logins accumulate unbounded session rows.
  const { issueSession } = await import('./auth.service.js');
  const { accessToken, refreshToken } = await issueSession({
    userId: user.id,
    tenantId: user.tenantId,
    role: user.role,
    isSuperAdmin: user.isSuperAdmin || false,
  });

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
