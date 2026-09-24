// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Building blocks for list endpoints that sort and filter server-side:
// the web's column views send `sortBy`/`sortDir` and comma-joined IN-set
// params (`status=paid,partial`). Every list keeps its own whitelist of
// sort keys — these only shape the params.

import { z } from 'zod';

export const sortDirSchema = z.enum(['asc', 'desc']);

/** `sortBy` limited to a list's whitelist. */
export function sortBySchema<const T extends readonly [string, ...string[]]>(keys: T) {
  return z.enum(keys).optional();
}

/**
 * A comma-joined set of enum values (`a,b`), also accepting a real array
 * from JSON callers. Empty → undefined (no filter). An unknown value fails
 * validation rather than being dropped.
 */
export function csvEnumSet<const T extends readonly [string, ...string[]]>(allowed: T) {
  return z.preprocess(
    (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : v),
    z.array(z.enum(allowed)).min(1),
  ).optional();
}

/** A comma-joined set of uuids, same rules as csvEnumSet. */
export const csvUuidSet = z.preprocess(
  (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : v),
  z.array(z.string().uuid()).min(1),
).optional();
