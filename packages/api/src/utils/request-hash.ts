// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * The request hash of an Idempotency-Key record (U-18, idempotency-v1).
 *
 * Two requests are "the same request" when this hash matches: the same
 * method and route template, path parameters, query, company, If-Match
 * header and body. The body is compared as canonical JSON (object keys
 * sorted, array order kept, no whitespace), so key order and formatting
 * never matter, while every value (amount strings included) does.
 *
 * Secret-looking keys (`closingPassword` and everything SECRET_KEY_RE
 * matches) are removed before hashing: a stored hash over a body holding a
 * password could be guessed offline, and an owner who re-sends a refused
 * save with the closing-date password typed in keeps the same hash.
 */

import crypto from 'node:crypto';
import { canonicalize } from './canonical-json.js';
import { isSecretKey } from './secret-keys.js';

export interface RequestHashInput {
  method: string;
  /** Route template without the /api/vN prefix, e.g. `/transactions/:id/void`. */
  route: string;
  params?: Record<string, unknown>;
  query?: Record<string, unknown>;
  companyId?: string | null;
  ifMatch?: string | null;
  body?: unknown;
}

/**
 * `undefined` values are dropped (as JSON.stringify drops them), at every
 * depth; with `strip`, secret-looking keys too. Objects are rebuilt without
 * a prototype, so an own `__proto__` key (JSON.parse keeps one) is kept and
 * hashed like any other key instead of being swallowed by the setter.
 */
function jsonOnly(value: unknown, strip = false): unknown {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : jsonOnly(v, strip)));
  if (value !== null && typeof value === 'object') {
    if (value instanceof Date) return value.toISOString();
    const out = Object.create(null) as Record<string, unknown>;
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined || (strip && isSecretKey(k))) continue;
      out[k] = jsonOnly(v, strip);
    }
    return out;
  }
  return value;
}

/** The canonical JSON text that is hashed (exported for tests). */
export function requestHashInput(input: RequestHashInput): string {
  const method = input.method.toUpperCase();
  const body = input.body === undefined || input.body === null ? {} : input.body;
  return canonicalize({
    v: 1,
    method,
    route: `${method} ${input.route}`,
    params: jsonOnly(input.params ?? {}),
    query: jsonOnly(input.query ?? {}),
    companyId: input.companyId ?? null,
    ifMatch: input.ifMatch ?? null,
    body: jsonOnly(body, true),
  });
}

/** Hex SHA-256 of the canonical request (64 characters). */
export function requestHash(input: RequestHashInput): string {
  return crypto.createHash('sha256').update(requestHashInput(input), 'utf8').digest('hex');
}
