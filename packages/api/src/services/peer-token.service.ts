// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Vibe Practice Management peer tokens — verification (docs/vibe-pm-
// integration.md). PM signs a short-lived JWT with its private key; the
// firm has registered the matching public key (PEM) or a JWKS URL under
// Firm Settings. This module owns:
//
//   • key-material validation for the settings screen (PEM / JWKS URL)
//   • the JWKS fetch + cache (https only, SSRF-guarded, size/time capped)
//   • verifyPeerToken — the single entry point the peer middleware and
//     the "Test a token" endpoint call
//
// Every failure surfaces to the wire as ONE uniform 401 PEER_TOKEN_INVALID.
// The specific reason is kept on the thrown error (`reason`) for the
// test endpoint and is recorded on firm_peers.last_error as an enum —
// never token text, never the key.

import crypto from 'node:crypto';
import https from 'node:https';
import jwt from 'jsonwebtoken';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { firmPeers, firms } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { assertExternalUrlSafe, makeSafeAgents } from '../utils/url-safety.js';
import { consumeJti as consumeJtiInStore } from '../utils/peer-jti-store.js';
import { recordSecurityEvent } from '../utils/security-audit.js';

export const PEER_AUDIENCE = 'vibe-mybooks';
export const PEER_TOKEN_TYP = 'vibe-pm-peer';
export const PEER_MAX_LIFETIME_SEC = 300;
export const PEER_CLOCK_TOLERANCE_SEC = 30;
export const PEER_JTI_TTL_SEC = 360;
export const PEER_PROVIDER = 'vibe_pm';

export type PeerAlg = 'RS256' | 'ES256' | 'ES384';
export type PeerKeyKind = 'rsa' | 'ec';

/** Stored on firm_peers.last_error. Enum only. */
export type PeerErrorCode = 'sig_invalid' | 'unknown_kid' | 'expired' | 'replay' | 'jwks_fetch_failed' | 'no_link';

/** Internal reason set — superset of PeerErrorCode (extras are never persisted). */
export type PeerFailReason =
  | PeerErrorCode
  | 'malformed'
  | 'unknown_issuer'
  | 'disabled'
  | 'wrong_firm'
  | 'store_unavailable';

export interface PeerActor {
  email: string;
  name?: string;
}

export interface PeerClaims {
  iss: string;
  sub?: string;
  aud: string;
  jti: string;
  iat: number;
  exp: number;
  nbf?: number;
  pm_client_id?: string;
  actor?: PeerActor;
}

export interface PeerRow {
  id: string;
  firmId: string;
  provider: string;
  issuer: string;
  publicKeyPem: string | null;
  jwksUrl: string | null;
  isEnabled: boolean;
}

export interface VerifiedPeer {
  peer: PeerRow;
  claims: PeerClaims;
}

export class PeerTokenError extends AppError {
  constructor(public readonly reason: PeerFailReason) {
    super(401, 'Peer token invalid', 'PEER_TOKEN_INVALID');
    this.name = 'PeerTokenError';
  }
}

// ─── Key material ───────────────────────────────────────────────

export interface ValidatedKey {
  /** Re-exported SPKI PEM — what gets stored. */
  pem: string;
  kind: PeerKeyKind;
  alg: PeerAlg;
  /** sha256 of the DER SPKI, hex, for the settings screen. */
  fingerprint: string;
  detail: string;
}

function describeKey(key: crypto.KeyObject): { kind: PeerKeyKind; alg: PeerAlg; detail: string } {
  const details = key.asymmetricKeyDetails ?? {};
  if (key.asymmetricKeyType === 'rsa') {
    const bits = details.modulusLength ?? 0;
    if (bits < 2048) throw AppError.badRequest('RSA public keys must be at least 2048 bits', 'PEER_KEY_INVALID');
    return { kind: 'rsa', alg: 'RS256', detail: `RSA ${bits}` };
  }
  if (key.asymmetricKeyType === 'ec') {
    const curve = details.namedCurve ?? '';
    if (curve === 'prime256v1') return { kind: 'ec', alg: 'ES256', detail: 'EC P-256' };
    if (curve === 'secp384r1') return { kind: 'ec', alg: 'ES384', detail: 'EC P-384' };
    throw AppError.badRequest('EC public keys must use P-256 or P-384', 'PEER_KEY_INVALID');
  }
  throw AppError.badRequest('Only RSA and EC public keys are supported', 'PEER_KEY_INVALID');
}

export function fingerprintKey(key: crypto.KeyObject): string {
  const der = key.export({ type: 'spki', format: 'der' }) as Buffer;
  return crypto.createHash('sha256').update(der).digest('hex');
}

/**
 * Validate a pasted public key. Refuses private keys outright (the
 * admin pasted the wrong half — storing it would be worse than an
 * error), certificates, and anything but RSA ≥ 2048 / EC P-256|P-384.
 */
export function validatePublicKeyPem(raw: string): ValidatedKey {
  const text = (raw ?? '').trim();
  if (!text) throw AppError.badRequest('Public key is required', 'PEER_KEY_INVALID');
  if (text.length > 10_000) throw AppError.badRequest('Public key is too long', 'PEER_KEY_INVALID');
  if (/PRIVATE KEY/i.test(text)) {
    throw AppError.badRequest('That is a PRIVATE key. Paste the PUBLIC key only — the private key must never leave Vibe PM.', 'PEER_KEY_PRIVATE');
  }
  if (/CERTIFICATE/i.test(text)) {
    throw AppError.badRequest('Paste the public key (BEGIN PUBLIC KEY), not a certificate', 'PEER_KEY_INVALID');
  }
  let key: crypto.KeyObject;
  try {
    key = crypto.createPublicKey(text);
  } catch {
    throw AppError.badRequest('Public key could not be parsed. Expected a PEM block starting with BEGIN PUBLIC KEY.', 'PEER_KEY_INVALID');
  }
  if (key.type !== 'public') throw AppError.badRequest('Not a public key', 'PEER_KEY_INVALID');
  const desc = describeKey(key);
  return {
    pem: key.export({ type: 'spki', format: 'pem' }) as string,
    kind: desc.kind,
    alg: desc.alg,
    detail: desc.detail,
    fingerprint: fingerprintKey(key),
  };
}

/** https-only public URL; string-level SSRF checks at save time. */
export function validateJwksUrl(raw: string): string {
  const text = (raw ?? '').trim();
  if (!text) throw AppError.badRequest('JWKS URL is required', 'PEER_JWKS_URL_INVALID');
  if (text.length > 512) throw AppError.badRequest('JWKS URL is too long', 'PEER_JWKS_URL_INVALID');
  let u: URL;
  try { u = new URL(text); } catch { throw AppError.badRequest('JWKS URL is not a valid URL', 'PEER_JWKS_URL_INVALID'); }
  if (u.protocol !== 'https:') throw AppError.badRequest('JWKS URL must use https', 'PEER_JWKS_URL_INVALID');
  if (u.username || u.password) throw AppError.badRequest('JWKS URL must not carry credentials', 'PEER_JWKS_URL_INVALID');
  try { assertExternalUrlSafe(text, 'JWKS URL'); } catch (err) {
    throw AppError.badRequest((err as Error).message, 'PEER_JWKS_URL_INVALID');
  }
  return u.toString();
}

// ─── JWKS fetch + cache ─────────────────────────────────────────

const JWKS_TTL_MS = 10 * 60 * 1000;
const JWKS_NEGATIVE_MS = 30 * 1000;
const JWKS_REFETCH_MIN_MS = 60 * 1000;
const JWKS_MAX_BYTES = 64 * 1024;
const JWKS_TIMEOUT_MS = 5000;

interface JwksCacheEntry {
  keys: Map<string, crypto.KeyObject>;
  fetchedAt: number;
  lastAttemptAt: number;
  negativeUntil: number;
}

const jwksCache = new Map<string, JwksCacheEntry>();

let jwksFetcher: (url: string) => Promise<unknown> = defaultJwksFetch;

/** Test hook — replace the network fetch. Pass null to restore. */
export function setJwksFetcherForTests(fn: ((url: string) => Promise<unknown>) | null): void {
  jwksFetcher = fn ?? defaultJwksFetch;
  jwksCache.clear();
}

export function clearJwksCacheForTests(): void {
  jwksCache.clear();
}

function defaultJwksFetch(url: string): Promise<unknown> {
  // Re-validate at fetch time (the row may predate a stricter rule) and
  // dial through the DNS-pinning agent so a hostname that rebinds to an
  // internal address is refused at connect time.
  assertExternalUrlSafe(url, 'JWKS URL');
  const { httpsAgent } = makeSafeAgents();
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'GET',
      agent: httpsAgent,
      headers: { Accept: 'application/json', 'User-Agent': 'vibe-mybooks-peer/1' },
      timeout: JWKS_TIMEOUT_MS,
    }, (res) => {
      // No redirects: a 3xx is a failure, never followed.
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`JWKS HTTP ${res.statusCode}`));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > JWKS_MAX_BYTES) {
          req.destroy(new Error('JWKS response too large'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch (err) { reject(err); }
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('JWKS fetch timed out')));
    req.on('error', reject);
    req.end();
  });
}

function jwkToKey(jwk: Record<string, unknown>): crypto.KeyObject | null {
  const kty = jwk['kty'];
  if (kty === 'RSA') {
    if (typeof jwk['n'] !== 'string' || typeof jwk['e'] !== 'string') return null;
    return crypto.createPublicKey({ key: { kty: 'RSA', n: jwk['n'], e: jwk['e'] }, format: 'jwk' });
  }
  if (kty === 'EC') {
    const crv = jwk['crv'];
    if (crv !== 'P-256' && crv !== 'P-384') return null;
    if (typeof jwk['x'] !== 'string' || typeof jwk['y'] !== 'string') return null;
    return crypto.createPublicKey({ key: { kty: 'EC', crv, x: jwk['x'], y: jwk['y'] }, format: 'jwk' });
  }
  return null;
}

async function loadJwks(issuer: string, url: string): Promise<JwksCacheEntry> {
  const now = Date.now();
  const entry: JwksCacheEntry = jwksCache.get(issuer) ?? { keys: new Map(), fetchedAt: 0, lastAttemptAt: 0, negativeUntil: 0 };
  entry.lastAttemptAt = now;
  jwksCache.set(issuer, entry);
  let doc: unknown;
  try {
    doc = await jwksFetcher(url);
  } catch (err) {
    entry.negativeUntil = now + JWKS_NEGATIVE_MS;
    throw err;
  }
  const keys = new Map<string, crypto.KeyObject>();
  const list = (doc as { keys?: unknown })?.keys;
  if (Array.isArray(list)) {
    for (const k of list) {
      if (!k || typeof k !== 'object') continue;
      const jwk = k as Record<string, unknown>;
      const kid = jwk['kid'];
      if (typeof kid !== 'string' || !kid || kid.length > 128) continue;
      try {
        const key = jwkToKey(jwk);
        if (key) keys.set(kid, key);
      } catch {
        // Skip a malformed entry; the rest of the set is still usable.
      }
    }
  }
  entry.keys = keys;
  entry.fetchedAt = now;
  entry.negativeUntil = 0;
  return entry;
}

/**
 * Resolve `kid` against the issuer's JWKS. Cached 10 min; an unknown
 * kid triggers at most one refetch per minute (key rotation), and a
 * failed fetch is remembered for 30 s so a flapping endpoint cannot be
 * used to hammer it through us.
 */
export async function fetchJwksKey(peer: PeerRow, kid: string): Promise<{ key: crypto.KeyObject } | { error: PeerErrorCode }> {
  if (!peer.jwksUrl) return { error: 'unknown_kid' };
  const now = Date.now();
  let entry = jwksCache.get(peer.issuer);
  const fresh = entry && now - entry.fetchedAt < JWKS_TTL_MS;
  if (!fresh) {
    if (entry && entry.negativeUntil > now) return { error: 'jwks_fetch_failed' };
    try { entry = await loadJwks(peer.issuer, peer.jwksUrl); }
    catch { return { error: 'jwks_fetch_failed' }; }
  }
  let key = entry!.keys.get(kid);
  if (!key && now - entry!.lastAttemptAt >= JWKS_REFETCH_MIN_MS) {
    try { entry = await loadJwks(peer.issuer, peer.jwksUrl); }
    catch { return { error: 'jwks_fetch_failed' }; }
    key = entry.keys.get(kid);
  }
  return key ? { key } : { error: 'unknown_kid' };
}

// ─── last_seen / last_error bookkeeping (throttled) ─────────────

const seenTouchedAt = new Map<string, number>();
const errorTouchedAt = new Map<string, number>();
const TOUCH_MIN_MS = 60_000;

export async function touchPeerSeen(peerId: string): Promise<void> {
  const now = Date.now();
  if ((seenTouchedAt.get(peerId) ?? 0) > now - TOUCH_MIN_MS) return;
  seenTouchedAt.set(peerId, now);
  try {
    await db.update(firmPeers).set({ lastSeenAt: new Date() }).where(eq(firmPeers.id, peerId));
  } catch { /* bookkeeping only */ }
}

export async function recordPeerError(peerId: string, code: PeerErrorCode): Promise<void> {
  const now = Date.now();
  const key = `${peerId}:${code}`;
  if ((errorTouchedAt.get(key) ?? 0) > now - TOUCH_MIN_MS) return;
  errorTouchedAt.set(key, now);
  try {
    await db.update(firmPeers).set({ lastError: code, lastErrorAt: new Date() }).where(eq(firmPeers.id, peerId));
  } catch { /* bookkeeping only */ }
}

/** Test hook — forget throttle state. */
export function resetPeerTouchThrottleForTests(): void {
  seenTouchedAt.clear();
  errorTouchedAt.clear();
}

// ─── Verification ───────────────────────────────────────────────

const ALLOWED_ALGS: ReadonlySet<string> = new Set<PeerAlg>(['RS256', 'ES256', 'ES384']);
const JTI_RE = /^[A-Za-z0-9._~-]{8,128}$/;
const PM_CLIENT_ID_RE = /^[A-Za-z0-9._:@~-]{1,120}$/;

function isPersistable(reason: PeerFailReason): reason is PeerErrorCode {
  return reason === 'sig_invalid' || reason === 'unknown_kid' || reason === 'expired'
    || reason === 'replay' || reason === 'jwks_fetch_failed' || reason === 'no_link';
}

export interface VerifyPeerTokenOptions {
  /** Default true. The "Test a token" endpoint passes false so a probe
   *  does not burn the jti PM will present for real. */
  consumeJti?: boolean;
  /** When set, the resolved issuer must belong to this firm. */
  expectFirmId?: string;
}

async function findPeerByIssuer(issuer: string): Promise<PeerRow | null> {
  const [row] = await db
    .select({
      id: firmPeers.id,
      firmId: firmPeers.firmId,
      provider: firmPeers.provider,
      issuer: firmPeers.issuer,
      publicKeyPem: firmPeers.publicKeyPem,
      jwksUrl: firmPeers.jwksUrl,
      isEnabled: firmPeers.isEnabled,
      firmActive: firms.isActive,
    })
    .from(firmPeers)
    .innerJoin(firms, eq(firms.id, firmPeers.firmId))
    .where(and(eq(firmPeers.issuer, issuer), eq(firmPeers.provider, PEER_PROVIDER)))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    firmId: row.firmId,
    provider: row.provider,
    issuer: row.issuer,
    publicKeyPem: row.publicKeyPem,
    jwksUrl: row.jwksUrl,
    // A deactivated firm authorizes nobody (same rule as firm_users).
    isEnabled: row.isEnabled && row.firmActive,
  };
}

function fail(peer: PeerRow | null, reason: PeerFailReason): never {
  if (peer && isPersistable(reason)) void recordPeerError(peer.id, reason);
  if (reason === 'sig_invalid' || reason === 'replay' || reason === 'store_unavailable') {
    recordSecurityEvent({
      component: 'peer_auth',
      reason,
      details: peer ? { firmId: peer.firmId, issuer: peer.issuer } : {},
    });
  }
  throw new PeerTokenError(reason);
}

function parseActor(raw: unknown): PeerActor | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object') throw new Error('actor');
  const a = raw as Record<string, unknown>;
  if (typeof a['email'] !== 'string' || !a['email'] || a['email'].length > 320) throw new Error('actor');
  const actor: PeerActor = { email: a['email'].trim().toLowerCase() };
  if (a['name'] !== undefined && a['name'] !== null) {
    if (typeof a['name'] !== 'string' || a['name'].length > 200) throw new Error('actor');
    actor.name = a['name'];
  }
  return actor;
}

/**
 * Verify a Vibe PM peer bearer token end to end. Resolves the issuer to
 * its firm_peers row, checks the signature against the registered key
 * material, enforces audience / typ / lifetime / jti single-use, and
 * returns the row + normalized claims. Throws PeerTokenError (401
 * PEER_TOKEN_INVALID) for every failure.
 */
export async function verifyPeerToken(token: string, opts: VerifyPeerTokenOptions = {}): Promise<VerifiedPeer> {
  const consume = opts.consumeJti !== false;
  if (typeof token !== 'string' || token.length < 20 || token.length > 8192) fail(null, 'malformed');

  // 1. Header-only pre-parse: alg allow-list before any key lookup so
  //    `none` / HS256 never reach jwt.verify.
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded || typeof decoded !== 'object' || typeof decoded.header !== 'object') fail(null, 'malformed');
  const header = decoded.header as { alg?: string; kid?: string; typ?: string };
  const payload = decoded.payload;
  if (!payload || typeof payload !== 'object') fail(null, 'malformed');
  if (!header.alg || !ALLOWED_ALGS.has(header.alg)) fail(null, 'malformed');
  const alg = header.alg as PeerAlg;
  if (header.typ !== PEER_TOKEN_TYP) fail(null, 'malformed');

  // 2. Exact issuer → single firm_peers row.
  const iss = (payload as { iss?: unknown }).iss;
  if (typeof iss !== 'string' || !iss || iss.length > 255) fail(null, 'malformed');
  const peer = await findPeerByIssuer(iss);
  if (!peer) fail(null, 'unknown_issuer');
  if (!peer.isEnabled) fail(peer, 'disabled');
  if (opts.expectFirmId && peer.firmId !== opts.expectFirmId) fail(peer, 'wrong_firm');

  // 3. Key material; the alg must match the registered key's kind.
  let key: crypto.KeyObject;
  if (peer.publicKeyPem) {
    try { key = crypto.createPublicKey(peer.publicKeyPem); } catch { fail(peer, 'sig_invalid'); }
  } else if (peer.jwksUrl) {
    if (!header.kid || typeof header.kid !== 'string' || header.kid.length > 128) fail(peer, 'unknown_kid');
    const res = await fetchJwksKey(peer, header.kid);
    if ('error' in res) fail(peer, res.error);
    key = res.key;
  } else {
    fail(peer, 'sig_invalid');
  }
  let expected: PeerAlg;
  try { expected = describeKey(key!).alg; } catch { fail(peer, 'sig_invalid'); }
  if (expected !== alg) fail(peer, 'sig_invalid');

  // 4. Signature + standard claims.
  let verified: jwt.JwtPayload;
  try {
    verified = jwt.verify(token, key!, {
      algorithms: [alg],
      audience: PEER_AUDIENCE,
      issuer: peer.issuer,
      clockTolerance: PEER_CLOCK_TOLERANCE_SEC,
    }) as jwt.JwtPayload;
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) fail(peer, 'expired');
    fail(peer, 'sig_invalid');
  }

  // 5. Lifetime + jti shape.
  const iat = verified!.iat;
  const exp = verified!.exp;
  if (typeof iat !== 'number' || typeof exp !== 'number') fail(peer, 'sig_invalid');
  if (exp! - iat! > PEER_MAX_LIFETIME_SEC || exp! <= iat!) fail(peer, 'sig_invalid');
  const nbf = verified!.nbf;
  if (nbf !== undefined && (typeof nbf !== 'number' || nbf > exp!)) fail(peer, 'sig_invalid');
  const jti = verified!.jti;
  if (typeof jti !== 'string' || !JTI_RE.test(jti)) fail(peer, 'sig_invalid');

  // 6. Optional app claims.
  const rawClient = (verified as Record<string, unknown>)['pm_client_id'];
  let pmClientId: string | undefined;
  if (rawClient !== undefined && rawClient !== null) {
    if (typeof rawClient !== 'string' || !PM_CLIENT_ID_RE.test(rawClient)) fail(peer, 'sig_invalid');
    pmClientId = rawClient;
  }
  let actor: PeerActor | undefined;
  try { actor = parseActor((verified as Record<string, unknown>)['actor']); } catch { fail(peer, 'sig_invalid'); }
  const sub = typeof verified!.sub === 'string' && verified!.sub.length <= 255 ? verified!.sub : undefined;

  // 7. Single use — fail closed when the store cannot answer.
  if (consume) {
    let first: boolean;
    try { first = await consumeJtiInStore(peer.issuer, jti!, PEER_JTI_TTL_SEC); }
    catch { fail(peer, 'store_unavailable'); }
    if (!first!) fail(peer, 'replay');
  }

  void touchPeerSeen(peer.id);
  return {
    peer,
    claims: {
      iss: peer.issuer,
      ...(sub ? { sub } : {}),
      aud: PEER_AUDIENCE,
      jti: jti!,
      iat: iat!,
      exp: exp!,
      ...(typeof nbf === 'number' ? { nbf } : {}),
      ...(pmClientId ? { pm_client_id: pmClientId } : {}),
      ...(actor ? { actor } : {}),
    },
  };
}
