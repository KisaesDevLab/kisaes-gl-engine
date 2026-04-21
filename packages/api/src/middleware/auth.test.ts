// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { requireSuperAdmin } from './auth.js';
import { AppError } from '../utils/errors.js';

function mockReq(overrides: Partial<Request>): Request {
  return { isSuperAdmin: false, ...overrides } as unknown as Request;
}

function run(req: Request): { thrown?: unknown; nextCalled: boolean } {
  let nextCalled = false;
  const next: NextFunction = () => { nextCalled = true; };
  const res = {} as Response;
  try {
    requireSuperAdmin(req, res, next);
  } catch (err) {
    return { thrown: err, nextCalled };
  }
  return { nextCalled };
}

describe('requireSuperAdmin', () => {
  it('rejects non-admin requests', () => {
    const out = run(mockReq({ isSuperAdmin: false }));
    expect(out.thrown).toBeInstanceOf(AppError);
    expect(out.nextCalled).toBe(false);
  });

  it('allows a fresh admin token', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const out = run(mockReq({ isSuperAdmin: true, tokenIssuedAt: nowSec - 60 }));
    expect(out.nextCalled).toBe(true);
    expect(out.thrown).toBeUndefined();
  });

  it('rejects an admin token older than JWT_ADMIN_MAX_AGE (default 30m)', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const out = run(mockReq({
      isSuperAdmin: true,
      // 31 minutes old — past the 30-minute default.
      tokenIssuedAt: nowSec - (31 * 60),
    }));
    expect(out.thrown).toBeInstanceOf(AppError);
    const err = out.thrown as AppError;
    expect(err.code).toBe('ADMIN_SESSION_EXPIRED');
  });

  it('allows admin when tokenIssuedAt is missing (API-key callers)', () => {
    const out = run(mockReq({ isSuperAdmin: true }));
    expect(out.nextCalled).toBe(true);
  });
});
