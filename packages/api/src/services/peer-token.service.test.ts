// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { firms, firmPeers, auditLog as auditLogTable } from '../db/schema/index.js';
import {
  verifyPeerToken, validatePublicKeyPem, validateJwksUrl, PeerTokenError,
  setJwksFetcherForTests, clearJwksCacheForTests, resetPeerTouchThrottleForTests, fetchJwksKey,
  PEER_AUDIENCE, PEER_TOKEN_TYP,
} from './peer-token.service.js';
import { setPeerJtiClientForTests, closePeerJtiStore, type JtiRedisLike } from '../utils/peer-jti-store.js';

const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';

const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const ec384 = crypto.generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const rsa1024 = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
const ecPub = ec.publicKey.export({ type: 'spki', format: 'pem' }) as string;
const rsaPub = rsa.publicKey.export({ type: 'spki', format: 'pem' }) as string;

let firmId = '';
let issuer = '';
const firmIds: string[] = [];

function fakeRedis(): JtiRedisLike {
  const keys = new Set<string>();
  return { async set(key) { if (keys.has(key)) return null; keys.add(key); return 'OK'; } };
}

function mint(opts: {
  key?: crypto.KeyObject; alg?: string; iss?: string; aud?: string; typ?: string | null; kid?: string;
  ttl?: number; iat?: number; nbf?: number; jti?: string | null; extra?: Record<string, unknown>;
} = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const iat = opts.iat ?? now;
  const payload: Record<string, unknown> = {
    iss: opts.iss ?? issuer,
    aud: opts.aud ?? PEER_AUDIENCE,
    iat,
    exp: iat + (opts.ttl ?? 120),
    ...(opts.nbf !== undefined ? { nbf: opts.nbf } : {}),
    ...(opts.jti === null ? {} : { jti: opts.jti ?? crypto.randomUUID() }),
    ...(opts.extra ?? {}),
  };
  const header: Record<string, unknown> = { ...(opts.typ === null ? {} : { typ: opts.typ ?? PEER_TOKEN_TYP }), ...(opts.kid ? { kid: opts.kid } : {}) };
  return jwt.sign(payload, opts.key ?? ec.privateKey, { algorithm: (opts.alg ?? 'ES256') as jwt.Algorithm, header: header as unknown as jwt.JwtHeader });
}

async function seedPeer(v: Partial<typeof firmPeers.$inferInsert> = {}) {
  const [f] = await db.insert(firms).values({ name: 'Peer Firm', slug: `peer-firm-${Date.now()}-${Math.random().toString(36).slice(2, 6)}` }).returning();
  firmId = f!.id;
  firmIds.push(firmId);
  issuer = `https://pm-${crypto.randomUUID()}.example`;
  await db.insert(firmPeers).values({ firmId, issuer, publicKeyPem: ecPub, isEnabled: true, ...v });
}

async function reason(token: string, opts?: Parameters<typeof verifyPeerToken>[1]): Promise<string> {
  try { await verifyPeerToken(token, opts); return 'ok'; }
  catch (err) { if (err instanceof PeerTokenError) return err.reason; throw err; }
}

async function lastError(): Promise<string | null> {
  // recordPeerError is fire-and-forget on the verify path; let it land.
  await new Promise((r) => setTimeout(r, 60));
  const [row] = await db.select({ e: firmPeers.lastError }).from(firmPeers).where(eq(firmPeers.firmId, firmId));
  return row?.e ?? null;
}

beforeEach(async () => {
  setPeerJtiClientForTests(fakeRedis());
  setJwksFetcherForTests(null);
  clearJwksCacheForTests();
  resetPeerTouchThrottleForTests();
  await seedPeer();
});

afterEach(async () => {
  for (const id of firmIds.splice(0)) {
    await db.delete(firmPeers).where(eq(firmPeers.firmId, id));
    await db.delete(firms).where(eq(firms.id, id));
  }
  await db.delete(auditLogTable).where(eq(auditLogTable.tenantId, SYSTEM_TENANT_ID));
});

afterAll(async () => { await closePeerJtiStore(); });

describe('validatePublicKeyPem', () => {
  it('accepts EC P-256, P-384 and RSA 2048', () => {
    expect(validatePublicKeyPem(ecPub)).toMatchObject({ kind: 'ec', alg: 'ES256' });
    expect(validatePublicKeyPem(ec384.publicKey.export({ type: 'spki', format: 'pem' }) as string)).toMatchObject({ kind: 'ec', alg: 'ES384' });
    expect(validatePublicKeyPem(rsaPub)).toMatchObject({ kind: 'rsa', alg: 'RS256' });
    expect(validatePublicKeyPem(ecPub).fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });
  it('refuses a private key outright', () => {
    const priv = ec.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    expect(() => validatePublicKeyPem(priv)).toThrow(/PRIVATE/);
  });
  it('refuses RSA < 2048 and garbage', () => {
    expect(() => validatePublicKeyPem(rsa1024.publicKey.export({ type: 'spki', format: 'pem' }) as string)).toThrow(/2048/);
    expect(() => validatePublicKeyPem('not a key')).toThrow(/parsed/);
  });
});

describe('validateJwksUrl', () => {
  it('requires https and a public host', () => {
    expect(validateJwksUrl('https://pm.example/.well-known/jwks.json')).toBe('https://pm.example/.well-known/jwks.json');
    expect(() => validateJwksUrl('http://pm.example/jwks')).toThrow(/https/);
    expect(() => validateJwksUrl('https://127.0.0.1/jwks')).toThrow();
    expect(() => validateJwksUrl('https://169.254.169.254/jwks')).toThrow();
    expect(() => validateJwksUrl('https://user:pw@pm.example/jwks')).toThrow(/credentials/);
  });
});

describe('verifyPeerToken', () => {
  it('accepts a valid ES256 token and returns normalized claims', async () => {
    const r = await verifyPeerToken(mint({ extra: { pm_client_id: 'cl_1', actor: { email: 'Bob@Example.com', name: 'Bob' } } }));
    expect(r.peer.firmId).toBe(firmId);
    expect(r.claims.iss).toBe(issuer);
    expect(r.claims.pm_client_id).toBe('cl_1');
    expect(r.claims.actor).toEqual({ email: 'bob@example.com', name: 'Bob' });
  });

  it('accepts RS256 against an RSA key', async () => {
    await db.update(firmPeers).set({ publicKeyPem: rsaPub }).where(eq(firmPeers.firmId, firmId));
    expect(await reason(mint({ key: rsa.privateKey, alg: 'RS256' }))).toBe('ok');
  });

  it('rejects alg/key mismatch (RS256 token against an EC key)', async () => {
    expect(await reason(mint({ key: rsa.privateKey, alg: 'RS256' }))).toBe('sig_invalid');
    expect(await lastError()).toBe('sig_invalid');
  });

  it('rejects a bad signature', async () => {
    const other = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    expect(await reason(mint({ key: other.privateKey }))).toBe('sig_invalid');
  });

  it('rejects wrong audience, wrong typ, missing typ', async () => {
    expect(await reason(mint({ aud: 'someone-else' }))).toBe('sig_invalid');
    expect(await reason(mint({ typ: 'JWT' }))).toBe('malformed');
    expect(await reason(mint({ typ: null }))).toBe('malformed');
  });

  it('rejects unknown and disabled issuers', async () => {
    expect(await reason(mint({ iss: 'https://nobody.example' }))).toBe('unknown_issuer');
    await db.update(firmPeers).set({ isEnabled: false }).where(eq(firmPeers.firmId, firmId));
    expect(await reason(mint())).toBe('disabled');
  });

  it('a deactivated firm authorizes nobody', async () => {
    await db.update(firms).set({ isActive: false }).where(eq(firms.id, firmId));
    expect(await reason(mint())).toBe('disabled');
  });

  it('rejects expired, over-long lifetime and future nbf', async () => {
    const now = Math.floor(Date.now() / 1000);
    expect(await reason(mint({ iat: now - 600, ttl: 120 }))).toBe('expired');
    expect(await lastError()).toBe('expired');
    expect(await reason(mint({ ttl: 900 }))).toBe('sig_invalid');
    expect(await reason(mint({ nbf: now + 600, ttl: 900 }))).toBe('sig_invalid');
    expect(await reason(mint({ nbf: now + 120 }))).toBe('sig_invalid');
  });

  it('rejects a missing or malformed jti', async () => {
    expect(await reason(mint({ jti: null }))).toBe('sig_invalid');
    expect(await reason(mint({ jti: 'x' }))).toBe('sig_invalid');
    expect(await reason(mint({ jti: 'has spaces in it' }))).toBe('sig_invalid');
  });

  it('rejects a replayed jti and records it', async () => {
    const t = mint();
    expect(await reason(t)).toBe('ok');
    expect(await reason(t)).toBe('replay');
    expect(await lastError()).toBe('replay');
  });

  it('consumeJti:false does not burn the jti', async () => {
    const t = mint();
    expect(await reason(t, { consumeJti: false })).toBe('ok');
    expect(await reason(t)).toBe('ok');
  });

  it('expectFirmId refuses another firm\'s issuer', async () => {
    expect(await reason(mint(), { expectFirmId: crypto.randomUUID() })).toBe('wrong_firm');
  });

  it('fails closed when the jti store is unavailable', async () => {
    setPeerJtiClientForTests({ async set() { throw new Error('down'); } });
    expect(await reason(mint())).toBe('store_unavailable');
  });

  it('rejects alg:none and HS256 before any key lookup', async () => {
    const now = Math.floor(Date.now() / 1000);
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const none = `${b64({ alg: 'none', typ: PEER_TOKEN_TYP })}.${b64({ iss: issuer, aud: PEER_AUDIENCE, iat: now, exp: now + 60, jti: crypto.randomUUID() })}.`;
    expect(await reason(none)).toBe('malformed');
    const hs = jwt.sign({ iss: issuer, aud: PEER_AUDIENCE, jti: crypto.randomUUID() }, ecPub, { algorithm: 'HS256', expiresIn: 60, header: { typ: PEER_TOKEN_TYP } as jwt.JwtHeader });
    expect(await reason(hs)).toBe('malformed');
    expect(await reason('garbage')).toBe('malformed');
  });

  it('rejects a malformed pm_client_id or actor', async () => {
    expect(await reason(mint({ extra: { pm_client_id: 'has space' } }))).toBe('sig_invalid');
    expect(await reason(mint({ extra: { actor: { name: 'no email' } } }))).toBe('sig_invalid');
  });

  it('touches last_seen_at on success', async () => {
    await verifyPeerToken(mint());
    await new Promise((r) => setTimeout(r, 50));
    const [row] = await db.select({ s: firmPeers.lastSeenAt }).from(firmPeers).where(eq(firmPeers.firmId, firmId));
    expect(row?.s).toBeTruthy();
  });
});

describe('verifyPeerToken with JWKS', () => {
  const jwk = ec.publicKey.export({ format: 'jwk' }) as Record<string, string>;
  let fetches = 0;

  beforeEach(async () => {
    fetches = 0;
    await db.update(firmPeers).set({ publicKeyPem: null, jwksUrl: 'https://pm.example/.well-known/jwks.json' }).where(eq(firmPeers.firmId, firmId));
    setJwksFetcherForTests(async () => { fetches += 1; return { keys: [{ ...jwk, kid: 'k1' }, { kty: 'oct', kid: 'bad' }] }; });
  });

  it('resolves kid, caches the document, and refuses an unknown kid', async () => {
    expect(await reason(mint({ kid: 'k1' }))).toBe('ok');
    expect(await reason(mint({ kid: 'k1' }))).toBe('ok');
    expect(fetches).toBe(1);
    expect(await reason(mint({ kid: 'nope' }))).toBe('unknown_kid');
    expect(await lastError()).toBe('unknown_kid');
    expect(await reason(mint())).toBe('unknown_kid'); // no kid at all
  });

  it('records jwks_fetch_failed and negative-caches a failing endpoint', async () => {
    setJwksFetcherForTests(async () => { fetches += 1; throw new Error('boom'); });
    expect(await reason(mint({ kid: 'k1' }))).toBe('jwks_fetch_failed');
    expect(await reason(mint({ kid: 'k1' }))).toBe('jwks_fetch_failed');
    expect(fetches).toBe(1);
    expect(await lastError()).toBe('jwks_fetch_failed');
  });

  it('the real fetcher refuses http and private hosts before dialing', async () => {
    setJwksFetcherForTests(null);
    const peer = { id: 'x', firmId, provider: 'vibe_pm', issuer, publicKeyPem: null, jwksUrl: 'https://127.0.0.1/jwks', isEnabled: true };
    expect(await fetchJwksKey(peer, 'k1')).toEqual({ error: 'jwks_fetch_failed' });
  });
});
