// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

/**
 * Stale stamps required in LAN mode (U-292, stale-required-v1).
 *
 * With CL_LAN=1, a write the route table classifies as
 * `x-stale: stale(updatedAt|schedule|version)` or `bulk`
 * (desktop/route-classes.ts) must carry its stamp, or it is refused with
 * 428 STALE_REQUIRED before any handler runs:
 *   - stale(updatedAt), stale(schedule): `expectedUpdatedAt` (body, or the
 *     query string)
 *   - stale(version): `version` (body or query)
 *   - bulk: `stamps` (body only: a map)
 * Host and workstation requests alike: two people editing are two people
 * wherever they sit. Internal callers (the automatic reversal void, jobs)
 * call services directly and are never affected (S1).
 *
 * The check and the routes read one place (P33 review S3): in desktop mode
 * `stampLocations()` runs first and puts a stamp sent in either location in
 * both, so a route that reads only the body (or only the query) sees exactly
 * the stamp this check accepted. A stamp is never accepted here and then
 * ignored by the route.
 *
 * Mounted only in desktop LAN mode, after the JSON body parser. The server
 * appliance and desktop mode without LAN never mount it.
 */

import type { NextFunction, Request, Response } from 'express';
import { staleClassOf } from '../desktop/route-classes.js';

/**
 * The stamp a request carries for `field`: the body's when present and not
 * null, else the query string's when a non-empty string. `stamps` (bulk) is
 * read from the body only and must be an object.
 */
export function stampOf(req: Request, field: string): unknown {
  const body = req.body as Record<string, unknown> | undefined;
  const fromBody = body && typeof body === 'object' && !Array.isArray(body) ? body[field] : undefined;
  if (field === 'stamps') return fromBody !== null && typeof fromBody === 'object' && !Array.isArray(fromBody) ? fromBody : undefined;
  if (fromBody !== undefined && fromBody !== null) return fromBody;
  const q = req.query[field];
  return typeof q === 'string' && q.length > 0 ? q : undefined;
}

/** The stamp field a request to (method, path) must carry in LAN mode, or null. */
export function requiredStampField(method: string, path: string): string | null {
  const cls = staleClassOf(method, path);
  if (cls === 'stale(updatedAt)' || cls === 'stale(schedule)') return 'expectedUpdatedAt';
  if (cls === 'stale(version)') return 'version';
  if (cls === 'bulk') return 'stamps';
  return null;
}

/**
 * Desktop mode (LAN or not), after the JSON parser: a stale-checked route's
 * stamp, sent in the body or the query, is put in both (body first), so every
 * route reads the stamp the 428 check saw, wherever its code looks. A query
 * `version` of digits becomes a number in the body; a body value becomes a
 * string in the query.
 */
export function stampLocations() {
  return function clStampLocations(req: Request, _res: Response, next: NextFunction): void {
    const field = requiredStampField(req.method, req.path);
    if (field === null || field === 'stamps') {
      next();
      return;
    }
    const v = stampOf(req, field);
    if (v !== undefined) {
      if (req.body === undefined || req.body === null) req.body = {};
      const body = req.body as Record<string, unknown>;
      if (typeof body === 'object' && !Array.isArray(body) && (body[field] === undefined || body[field] === null)) {
        body[field] = field === 'version' && typeof v === 'string' && /^\d{1,9}$/.test(v) ? Number(v) : v;
      }
      if (typeof req.query[field] !== 'string' || (req.query[field] as string).length === 0) {
        if (typeof v === 'string' || typeof v === 'number') (req.query as Record<string, unknown>)[field] = String(v);
      }
    }
    next();
  };
}

export function staleRequired() {
  return function clStaleRequired(req: Request, res: Response, next: NextFunction): void {
    const field = requiredStampField(req.method, req.path);
    if (field === null || stampOf(req, field) !== undefined) {
      next();
      return;
    }
    res.status(428).json({
      error: {
        message: 'This change needs the record as you last read it. Reload it and try again.',
        code: 'STALE_REQUIRED',
        details: { field },
      },
    });
  };
}
