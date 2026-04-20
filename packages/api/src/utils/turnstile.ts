// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// Cloudflare Turnstile server-side verification — see
// Build Plans/CLOUDFLARE_TUNNEL_PLAN.md Phase 4 and
// https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
//
// Frontend gets a token from the Turnstile widget on sign-in / sign-up /
// password-reset forms; backend POSTs the token + secret to Cloudflare's
// siteverify endpoint. We reject on explicit failure but fail OPEN on
// network / CF-outage paths — Cloudflare itself has had hour-long
// siteverify outages (2024-02-21 incident), and locking every user out
// of login during a CF degradation is worse than the baseline login rate
// limit doing its job.

import type { Request, Response, NextFunction } from 'express';

const SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const SITEVERIFY_TIMEOUT_MS = 3000;

// Cached Turnstile secret — refreshed on admin-panel writes via
// invalidateTurnstileSecretCache(). Without a cache we'd hit the DB
// on every single auth request; with one we pay the DB cost only
// when the secret is rotated. `loaded` distinguishes "never loaded"
// from "loaded as null" (unconfigured).
let secretCache: { loaded: boolean; value: string | null } = { loaded: false, value: null };

async function resolveSecret(): Promise<string | null> {
  if (secretCache.loaded) return secretCache.value;
  try {
    const { getSetting } = await import('../services/admin.service.js');
    const { SystemSettingsKeys } = await import('../constants/system-settings-keys.js');
    const dbValue = await getSetting(SystemSettingsKeys.TURNSTILE_SECRET_KEY);
    if (dbValue) {
      secretCache = { loaded: true, value: dbValue };
      return dbValue;
    }
  } catch {
    // DB unreachable on early boot — fall through to env.
  }
  const envValue = process.env['TURNSTILE_SECRET_KEY'];
  secretCache = { loaded: true, value: envValue || null };
  return secretCache.value;
}

/** Called by the admin save path so the next verify sees the new key. */
export function invalidateTurnstileSecretCache(): void {
  secretCache = { loaded: false, value: null };
}

export interface TurnstileResult {
  /** Whether to let the request through. `true` on verify-success AND on fail-open paths. */
  allow: boolean;
  /** Present when CF explicitly rejected the token. */
  errorCodes?: string[];
  /** Set on soft-failure paths (timeout, disabled, outage). */
  skipped?: 'disabled' | 'missing_secret' | 'timeout' | 'network_error';
  /** Full CF response, exposed for audit/logging. */
  raw?: unknown;
}

/**
 * Verify a Turnstile token against Cloudflare's siteverify endpoint.
 *
 * Dev/test path: when `TURNSTILE_SECRET_KEY` is unset OR equals the
 * literal string `disabled`, every call returns
 * `{ allow: true, skipped: 'disabled' }` without a network round-trip.
 * This matches the build-plan's dev-env flag, keeps the Vitest suite
 * airgapped, and lets LAN-only installs skip Turnstile without extra
 * code paths in callers.
 */
export async function verifyTurnstile(token: string | null | undefined, remoteIp?: string): Promise<TurnstileResult> {
  const secret = await resolveSecret();
  if (!secret || secret === 'disabled') {
    return { allow: true, skipped: 'disabled' };
  }
  if (!token) {
    return { allow: false, errorCodes: ['missing-input-response'], skipped: 'missing_secret' };
  }

  const body = new URLSearchParams();
  body.set('secret', secret);
  body.set('response', token);
  if (remoteIp) body.set('remoteip', remoteIp);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SITEVERIFY_TIMEOUT_MS);
  try {
    const res = await fetch(SITEVERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      // CF siteverify is degraded — fail open (see file header).
      return { allow: true, skipped: 'network_error' };
    }
    const data = (await res.json()) as {
      success: boolean;
      'error-codes'?: string[];
      [key: string]: unknown;
    };
    if (data.success) return { allow: true, raw: data };
    return { allow: false, errorCodes: data['error-codes'] || ['unknown'], raw: data };
  } catch (err) {
    const reason = err instanceof Error && err.name === 'AbortError' ? 'timeout' : 'network_error';
    // Fail open on timeout/network: global rate limits + per-account
    // lockout still bound the damage if Turnstile is actually down.
    return { allow: true, skipped: reason };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Express middleware that enforces Turnstile on the route it protects.
 * Reads the token from `req.body.turnstileToken` (POST JSON) and the
 * client IP from req.ip. On explicit CF rejection → 400. On any
 * fail-open path (disabled, network error, timeout) → next().
 *
 * Pairs well with the existing login rate limiter so the fail-open path
 * still has a cost ceiling.
 */
export function requireTurnstile() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const token = (req.body && typeof req.body === 'object' && 'turnstileToken' in req.body
      ? (req.body as { turnstileToken?: string }).turnstileToken
      : undefined);
    const result = await verifyTurnstile(token, req.ip);
    if (!result.allow) {
      res.status(400).json({
        error: {
          message: 'Verification failed. Please reload the page and try again.',
          code: 'TURNSTILE_FAILED',
          errorCodes: result.errorCodes,
        },
      });
      return;
    }
    next();
  };
}
