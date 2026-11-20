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
 *     query string for DELETE)
 *   - stale(version): `version` (body or query)
 *   - bulk: `stamps` (body)
 * Host and workstation requests alike: two people editing are two people
 * wherever they sit. Internal callers (the automatic reversal void, jobs)
 * call services directly and are never affected (S1).
 *
 * Mounted only in desktop LAN mode, after the JSON body parser. The server
 * appliance and desktop mode without LAN never mount it.
 */

import type { NextFunction, Request, Response } from 'express';
import { staleClassOf } from '../desktop/route-classes.js';

function has(req: Request, field: string): boolean {
  const body = req.body as Record<string, unknown> | undefined;
  if (body && typeof body === 'object' && !Array.isArray(body) && body[field] !== undefined && body[field] !== null) return true;
  const q = req.query[field];
  return typeof q === 'string' && q.length > 0;
}

/** The stamp field a request to (method, path) must carry in LAN mode, or null. */
export function requiredStampField(method: string, path: string): string | null {
  const cls = staleClassOf(method, path);
  if (cls === 'stale(updatedAt)' || cls === 'stale(schedule)') return 'expectedUpdatedAt';
  if (cls === 'stale(version)') return 'version';
  if (cls === 'bulk') return 'stamps';
  return null;
}

export function staleRequired() {
  return function clStaleRequired(req: Request, res: Response, next: NextFunction): void {
    const field = requiredStampField(req.method, req.path);
    if (field === null || has(req, field)) {
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
