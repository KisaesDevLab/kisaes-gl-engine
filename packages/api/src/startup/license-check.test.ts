// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import jwt from 'jsonwebtoken';

// vibe-distribution-plan D6: RS256 license check.
// Uses the env-reload pattern so each test gets a fresh module import
// against its own process.env state.

const ORIGINAL_ENV = { ...process.env };

let publicKey: string;
let privateKey: string;
let otherPrivateKey: string;

beforeEach(() => {
  vi.resetModules();
  process.env = { ...ORIGINAL_ENV };
  process.env['DATABASE_URL'] = 'postgres://x:y@localhost:5432/test';
  process.env['REDIS_URL'] = 'redis://localhost:6379';
  process.env['JWT_SECRET'] = 'a'.repeat(32);
  process.env['ENCRYPTION_KEY'] = 'b'.repeat(64);
  process.env['PLAID_ENCRYPTION_KEY'] = 'c'.repeat(64);

  const kp = generateKeyPairSync('rsa', { modulusLength: 2048 });
  publicKey = kp.publicKey.export({ type: 'spki', format: 'pem' }) as string;
  privateKey = kp.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  const kp2 = generateKeyPairSync('rsa', { modulusLength: 2048 });
  otherPrivateKey = kp2.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function signToken(opts: {
  privateKey?: string;
  audience?: string;
  issuer?: string;
  subject?: string;
  expiresIn?: string | number;
  tier?: string;
} = {}): string {
  const payload: Record<string, unknown> = {};
  if (opts.tier) payload['tier'] = opts.tier;
  // jsonwebtoken's SignOptions narrows expiresIn to a string-literal
  // union ("1h" | "2d" | …) at the type level, but accepts any
  // ms-parsable string at runtime. Cast at the boundary so tests can
  // pass back-dated values like "-1h" without fighting the type.
  return jwt.sign(payload, opts.privateKey ?? privateKey, {
    algorithm: 'RS256',
    audience: opts.audience ?? 'vibe-mybooks',
    issuer: opts.issuer ?? 'licensing.kisaes.com',
    subject: opts.subject ?? 'host-abc123',
    expiresIn: (opts.expiresIn ?? '1h') as jwt.SignOptions['expiresIn'],
  });
}

describe('checkLicense', () => {
  it('returns "skipped" when DISABLE_LICENSE_CHECK=1 (CI default)', async () => {
    process.env['NODE_ENV'] = 'production';
    process.env['DISABLE_LICENSE_CHECK'] = '1';
    const { checkLicense } = await import('./license-check.js');
    expect(checkLicense().status).toBe('skipped');
  });

  it('returns "skipped" when NODE_ENV is development', async () => {
    process.env['NODE_ENV'] = 'development';
    delete process.env['DISABLE_LICENSE_CHECK'];
    const { checkLicense } = await import('./license-check.js');
    const r = checkLicense();
    expect(r.status).toBe('skipped');
    if (r.status === 'skipped') expect(r.reason).toMatch(/development/);
  });

  it('returns "missing" when LICENSE_TOKEN unset in production', async () => {
    process.env['NODE_ENV'] = 'production';
    process.env['DISABLE_LICENSE_CHECK'] = '0';
    process.env['LICENSE_PUBLIC_KEY'] = publicKey;
    delete process.env['LICENSE_TOKEN'];
    const { checkLicense } = await import('./license-check.js');
    const r = checkLicense();
    expect(r.status).toBe('missing');
    if (r.status === 'missing') expect(r.reason).toMatch(/LICENSE_TOKEN/);
  });

  it('returns "missing" when LICENSE_PUBLIC_KEY unset', async () => {
    process.env['NODE_ENV'] = 'production';
    process.env['DISABLE_LICENSE_CHECK'] = '0';
    process.env['LICENSE_TOKEN'] = signToken();
    delete process.env['LICENSE_PUBLIC_KEY'];
    const { checkLicense } = await import('./license-check.js');
    const r = checkLicense();
    expect(r.status).toBe('missing');
    if (r.status === 'missing') expect(r.reason).toMatch(/LICENSE_PUBLIC_KEY/);
  });

  it('returns "ok" with claims for a valid token', async () => {
    process.env['NODE_ENV'] = 'production';
    process.env['DISABLE_LICENSE_CHECK'] = '0';
    process.env['LICENSE_PUBLIC_KEY'] = publicKey;
    process.env['LICENSE_TOKEN'] = signToken({ tier: 'firm' });
    const { checkLicense } = await import('./license-check.js');
    const r = checkLicense();
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.claims.iss).toBe('licensing.kisaes.com');
      expect(r.claims.aud).toBe('vibe-mybooks');
      expect(r.claims.tier).toBe('firm');
    }
  });

  it('returns "invalid" when signed by the wrong key', async () => {
    process.env['NODE_ENV'] = 'production';
    process.env['DISABLE_LICENSE_CHECK'] = '0';
    process.env['LICENSE_PUBLIC_KEY'] = publicKey;
    process.env['LICENSE_TOKEN'] = signToken({ privateKey: otherPrivateKey });
    const { checkLicense } = await import('./license-check.js');
    expect(checkLicense().status).toBe('invalid');
  });

  it('returns "invalid" when audience does not match', async () => {
    process.env['NODE_ENV'] = 'production';
    process.env['DISABLE_LICENSE_CHECK'] = '0';
    process.env['LICENSE_PUBLIC_KEY'] = publicKey;
    process.env['LICENSE_TOKEN'] = signToken({ audience: 'wrong-aud' });
    const { checkLicense } = await import('./license-check.js');
    expect(checkLicense().status).toBe('invalid');
  });

  it('returns "invalid" when issuer does not match', async () => {
    process.env['NODE_ENV'] = 'production';
    process.env['DISABLE_LICENSE_CHECK'] = '0';
    process.env['LICENSE_PUBLIC_KEY'] = publicKey;
    process.env['LICENSE_TOKEN'] = signToken({ issuer: 'someone-else.example' });
    const { checkLicense } = await import('./license-check.js');
    expect(checkLicense().status).toBe('invalid');
  });

  it('returns "expired" when token exp is in the past', async () => {
    process.env['NODE_ENV'] = 'production';
    process.env['DISABLE_LICENSE_CHECK'] = '0';
    process.env['LICENSE_PUBLIC_KEY'] = publicKey;
    // jsonwebtoken accepts negative expiresIn for back-dated tokens.
    process.env['LICENSE_TOKEN'] = signToken({ expiresIn: '-1h' });
    const { checkLicense } = await import('./license-check.js');
    const r = checkLicense();
    expect(r.status).toBe('expired');
    if (r.status === 'expired') {
      expect(new Date(r.expiredAt).getTime()).toBeLessThan(Date.now());
    }
  });

  it('returns "not-yet-valid" when nbf is in the future (clock skew / pre-issued)', async () => {
    process.env['NODE_ENV'] = 'production';
    process.env['DISABLE_LICENSE_CHECK'] = '0';
    process.env['LICENSE_PUBLIC_KEY'] = publicKey;
    process.env['LICENSE_CLOCK_TOLERANCE_SECONDS'] = '0';
    // notBefore 1h in the future
    process.env['LICENSE_TOKEN'] = jwt.sign(
      { tier: 'firm' },
      privateKey,
      {
        algorithm: 'RS256',
        audience: 'vibe-mybooks',
        issuer: 'licensing.kisaes.com',
        subject: 'host-abc123',
        notBefore: '1h',
        expiresIn: '2h',
      },
    );
    const { checkLicense } = await import('./license-check.js');
    const r = checkLicense();
    expect(r.status).toBe('not-yet-valid');
    if (r.status === 'not-yet-valid') {
      expect(new Date(r.notBefore).getTime()).toBeGreaterThan(Date.now());
    }
  });

  it('clock-skew tolerance rescues a token that expired N seconds ago', async () => {
    process.env['NODE_ENV'] = 'production';
    process.env['DISABLE_LICENSE_CHECK'] = '0';
    process.env['LICENSE_PUBLIC_KEY'] = publicKey;
    process.env['LICENSE_CLOCK_TOLERANCE_SECONDS'] = '120';
    // Expired 30 seconds ago — would fail at clockTolerance=0,
    // accepted at clockTolerance=120.
    process.env['LICENSE_TOKEN'] = signToken({ expiresIn: '-30s' });
    const { checkLicense } = await import('./license-check.js');
    expect(checkLicense().status).toBe('ok');
  });

  it('returns "invalid" when LICENSE_PUBLIC_KEY is malformed PEM', async () => {
    process.env['NODE_ENV'] = 'production';
    process.env['DISABLE_LICENSE_CHECK'] = '0';
    process.env['LICENSE_TOKEN'] = signToken();
    process.env['LICENSE_PUBLIC_KEY'] = 'this is not a PEM-encoded RSA public key';
    const { checkLicense } = await import('./license-check.js');
    expect(checkLicense().status).toBe('invalid');
  });

  it('respects LICENSE_AUDIENCE / LICENSE_ISSUER env overrides for staging', async () => {
    process.env['NODE_ENV'] = 'production';
    process.env['DISABLE_LICENSE_CHECK'] = '0';
    process.env['LICENSE_PUBLIC_KEY'] = publicKey;
    process.env['LICENSE_AUDIENCE'] = 'vibe-mybooks-staging';
    process.env['LICENSE_ISSUER'] = 'licensing.staging.kisaes.com';
    process.env['LICENSE_TOKEN'] = signToken({
      audience: 'vibe-mybooks-staging',
      issuer: 'licensing.staging.kisaes.com',
    });
    const { checkLicense } = await import('./license-check.js');
    const r = checkLicense();
    expect(r.status).toBe('ok');
    if (r.status === 'ok') {
      expect(r.claims.iss).toBe('licensing.staging.kisaes.com');
      expect(r.claims.aud).toBe('vibe-mybooks-staging');
    }
  });

  it('accepts DISABLE_LICENSE_CHECK=true (boolean string) as opt-out', async () => {
    process.env['NODE_ENV'] = 'production';
    process.env['DISABLE_LICENSE_CHECK'] = 'true';
    const { checkLicense } = await import('./license-check.js');
    expect(checkLicense().status).toBe('skipped');
  });

  it('accepts DISABLE_LICENSE_CHECK=on (string) as opt-out', async () => {
    process.env['NODE_ENV'] = 'production';
    process.env['DISABLE_LICENSE_CHECK'] = 'on';
    const { checkLicense } = await import('./license-check.js');
    expect(checkLicense().status).toBe('skipped');
  });

  it('treats DISABLE_LICENSE_CHECK=false as opt-IN (must check)', async () => {
    process.env['NODE_ENV'] = 'production';
    process.env['DISABLE_LICENSE_CHECK'] = 'false';
    delete process.env['LICENSE_TOKEN'];
    delete process.env['LICENSE_PUBLIC_KEY'];
    const { checkLicense } = await import('./license-check.js');
    expect(checkLicense().status).toBe('missing');
  });
});

describe('formatLicenseResult', () => {
  it('formats ok with tier and exp', async () => {
    const { formatLicenseResult } = await import('./license-check.js');
    const out = formatLicenseResult({
      status: 'ok',
      claims: { tier: 'firm', exp: 1820000000 },
    });
    expect(out).toContain('ok');
    expect(out).toContain('firm');
    expect(out).toContain('20'); // ISO date prefix
  });

  it('formats expired with timestamp', async () => {
    const { formatLicenseResult } = await import('./license-check.js');
    const out = formatLicenseResult({
      status: 'expired',
      expiredAt: '2025-01-01T00:00:00.000Z',
    });
    expect(out).toContain('EXPIRED');
    expect(out).toContain('2025-01-01');
  });
});
