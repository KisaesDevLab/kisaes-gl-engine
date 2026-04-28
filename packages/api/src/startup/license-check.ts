// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';

// vibe-distribution-plan §Vibe MyBooks license enforcement (Phase D6).
//
// Production appliances boot with two env values supplied by the
// installer at `vibe install` time:
//
//   LICENSE_PUBLIC_KEY  PEM-encoded RSA public key fetched from
//                       licensing.kisaes.com. Embedded in the env
//                       rather than baked into the image so a key
//                       rotation doesn't require an image rebuild.
//   LICENSE_TOKEN       RS256-signed JWT with claims:
//                         iss = licensing.kisaes.com
//                         aud = vibe-mybooks
//                         sub = host id (matches sentinel/installation)
//                         iat, exp
//                         tier (string — 'firm' / 'enterprise' / etc.)
//
// Failure modes get distinct shapes so bootstrap can render a useful
// diagnostic message rather than just "license invalid":
//
//   skipped        — DISABLE_LICENSE_CHECK=1 or NODE_ENV in {development,
//                    test}. CI runs here. The skip itself is logged so
//                    it's never silent.
//   missing        — LICENSE_TOKEN or LICENSE_PUBLIC_KEY unset. Tells
//                    operators which env they forgot.
//   invalid        — signature failed / wrong issuer / wrong audience.
//                    Distinct from `expired` because the operator's
//                    fix path is different (re-issue vs renew).
//   expired        — `exp` claim in the past. Body includes the exp
//                    so the operator can confirm at a glance.
//   ok             — all checks passed.

export interface LicenseClaims {
  iss?: string;
  // Narrowed to single string at decode time — multi-audience tokens
  // never reach the ok branch because jwt.verify({audience}) requires
  // at least one match against our single expected value.
  aud?: string;
  sub?: string;
  iat?: number;
  exp?: number;
  tier?: string;
}

export type LicenseCheckResult =
  | { status: 'ok'; claims: LicenseClaims }
  | { status: 'skipped'; reason: string }
  | { status: 'missing'; reason: string }
  | { status: 'invalid'; reason: string }
  | { status: 'expired'; expiredAt: string }
  | { status: 'not-yet-valid'; notBefore: string };

export function checkLicense(): LicenseCheckResult {
  // Dev / test / explicit opt-out paths. Tested apps in CI run with
  // DISABLE_LICENSE_CHECK=1 so they don't need a real signing key.
  if (env.DISABLE_LICENSE_CHECK === '1') {
    return { status: 'skipped', reason: 'DISABLE_LICENSE_CHECK=1' };
  }
  if (env.NODE_ENV !== 'production') {
    return { status: 'skipped', reason: `NODE_ENV=${env.NODE_ENV}` };
  }

  if (!env.LICENSE_TOKEN) {
    return {
      status: 'missing',
      reason: 'LICENSE_TOKEN env is unset (set it via the installer or .env)',
    };
  }
  if (!env.LICENSE_PUBLIC_KEY) {
    return {
      status: 'missing',
      reason: `LICENSE_PUBLIC_KEY env is unset (installer fetches this from ${env.LICENSE_ISSUER})`,
    };
  }

  let decoded: jwt.JwtPayload;
  try {
    const result = jwt.verify(env.LICENSE_TOKEN, env.LICENSE_PUBLIC_KEY, {
      algorithms: ['RS256'],
      // jsonwebtoken throws TokenExpiredError when exp is in the past
      // — we let that bubble so we can report it distinctly.
      audience: env.LICENSE_AUDIENCE,
      issuer: env.LICENSE_ISSUER,
      // Clock-skew tolerance — operators on islanded networks see
      // multi-second NTP drift between the licensing server and their
      // host, which without tolerance produces spurious "expired"
      // outcomes a few seconds before the wall-clock exp. 60s default
      // is per env.LICENSE_CLOCK_TOLERANCE_SECONDS.
      clockTolerance: env.LICENSE_CLOCK_TOLERANCE_SECONDS,
    });
    if (typeof result === 'string') {
      return { status: 'invalid', reason: 'token payload is a string, expected JSON object' };
    }
    decoded = result;
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      return {
        status: 'expired',
        expiredAt: new Date(err.expiredAt).toISOString(),
      };
    }
    if (err instanceof jwt.NotBeforeError) {
      // Distinct from `invalid` because the operator's fix is to
      // wait or correct host clock — not to re-issue the token.
      return {
        status: 'not-yet-valid',
        notBefore: new Date(err.date).toISOString(),
      };
    }
    if (err instanceof jwt.JsonWebTokenError) {
      return { status: 'invalid', reason: err.message };
    }
    return {
      status: 'invalid',
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  // Narrow `aud` to a single string. jsonwebtoken returns string[] when
  // the token was signed with multiple audiences; the verify-time
  // audience match guarantees the expected value is in the array, but
  // the LicenseClaims type narrows downstream consumer ergonomics.
  let aud: string | undefined;
  if (typeof decoded.aud === 'string') {
    aud = decoded.aud;
  } else if (Array.isArray(decoded.aud) && decoded.aud.includes(env.LICENSE_AUDIENCE)) {
    aud = env.LICENSE_AUDIENCE;
  }

  return {
    status: 'ok',
    claims: {
      iss: decoded.iss,
      aud,
      sub: typeof decoded.sub === 'string' ? decoded.sub : undefined,
      iat: decoded.iat,
      exp: decoded.exp,
      tier: typeof decoded['tier'] === 'string' ? decoded['tier'] : undefined,
    },
  };
}

/**
 * Convenience formatter so bootstrap can log a single line that an
 * operator running `docker compose logs api` can act on.
 */
export function formatLicenseResult(r: LicenseCheckResult): string {
  switch (r.status) {
    case 'ok':
      return `[license] ok (tier=${r.claims.tier ?? '<unset>'}, exp=${
        r.claims.exp ? new Date(r.claims.exp * 1000).toISOString() : '<no exp>'
      })`;
    case 'skipped':
      return `[license] skipped (${r.reason})`;
    case 'missing':
      return `[license] MISSING — ${r.reason}`;
    case 'invalid':
      return `[license] INVALID — ${r.reason}`;
    case 'expired':
      return `[license] EXPIRED — token's exp claim was ${r.expiredAt}`;
    case 'not-yet-valid':
      return `[license] NOT YET VALID — token's nbf claim is ${r.notBefore} (check host clock vs NTP)`;
  }
}
