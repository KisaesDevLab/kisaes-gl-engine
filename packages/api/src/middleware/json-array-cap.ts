// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/errors.js';

/**
 * Caps the number of array elements a JSON body may carry, counted across
 * every array at every depth. Mounted right after express.json().
 *
 * Why: zod (GHSA-mrhx-c7xc-m3w5, every 3.x release) records one issue
 * object per failing element of an array schema without a length limit and
 * never stops early, so a body of a few million junk elements can exhaust
 * memory before any handler runs. The 10 MB body limit alone still admits
 * millions of one-byte elements. With this cap, validation of any body
 * allocates at most JSON_ARRAY_ELEMENT_CAP issues.
 *
 * The cap is 25x the largest array a schema accepts (payroll lineTags,
 * 10,000), so no documented payload comes near it. The walk is iterative
 * (an explicit stack): a deeply nested body must not overflow the call
 * stack here, which would be its own denial of service.
 */
export const JSON_ARRAY_ELEMENT_CAP = 250_000;

/** Total array elements in `value`, stopping early once `cap` is exceeded. */
export function countArrayElements(value: unknown, cap: number = JSON_ARRAY_ELEMENT_CAP): number {
  let total = 0;
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const v = stack.pop();
    if (v === null || typeof v !== 'object') continue;
    if (Array.isArray(v)) {
      total += v.length;
      if (total > cap) return total;
      for (const item of v) if (item !== null && typeof item === 'object') stack.push(item);
    } else {
      for (const item of Object.values(v as Record<string, unknown>)) {
        if (item !== null && typeof item === 'object') stack.push(item);
      }
    }
  }
  return total;
}

export function jsonArrayCap(cap: number = JSON_ARRAY_ELEMENT_CAP) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (req.body !== null && typeof req.body === 'object' && countArrayElements(req.body, cap) > cap) {
      throw new AppError(
        413,
        `Request body carries more than ${cap.toLocaleString('en-US')} array elements.`,
        'BODY_TOO_MANY_ELEMENTS',
      );
    }
    next();
  };
}
