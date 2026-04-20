// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import type { Request } from 'express';
import { env } from '../config/env.js';

/**
 * Derive the request's absolute origin (`https://mb.kisaes.local`,
 * `http://192.168.68.100:3081`, etc.) from the incoming headers so
 * links in responses match the URL the user is actually on.
 *
 * Why request-scoped rather than a fixed env var: the appliance is
 * typically reached via multiple origins (mDNS hostname + IP:port
 * fallback for clients that can't resolve `.local`). Password-reset
 * emails, public invoice links, and Stripe/Plaid return URLs built
 * from a fixed `CORS_ORIGIN` point at the wrong origin for half the
 * user population. Reading from the request resolves that.
 *
 * `trust proxy` is set in app.ts so `req.protocol` respects the
 * reverse proxy's `X-Forwarded-Proto` header; we also read
 * `X-Forwarded-Host` directly because express's `req.host` can strip
 * the port that's part of the appliance fallback URL.
 */
export function baseUrlFor(req: Request): string {
  const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim() ?? req.protocol;
  const host = (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host;
  if (host) return `${proto}://${host}`.replace(/\/$/, '');
  return firstConfiguredOrigin();
}

/**
 * Fallback base URL for contexts that don't have a request — scheduled
 * jobs emitting email, webhook return URLs registered at app startup,
 * Stripe/Plaid callbacks that kick off from a cron. Returns the first
 * entry of the comma-separated `CORS_ORIGIN`.
 */
export function firstConfiguredOrigin(): string {
  const first = env.CORS_ORIGIN.split(',')[0]?.trim().replace(/\/$/, '');
  return first || 'http://localhost:5173';
}
