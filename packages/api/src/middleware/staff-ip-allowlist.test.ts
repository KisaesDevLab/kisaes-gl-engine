// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';
import { staffIpAllowlist } from './staff-ip-allowlist.js';
import { db } from '../db/index.js';
import { staffIpAllowlist as staffIpAllowlistTable } from '../db/schema/index.js';
import { addEntry, invalidateCache } from '../services/staff-ip-allowlist.service.js';

function mockReq(opts: { ip?: string; auth?: string }): Request {
  return {
    ip: opts.ip,
    method: 'GET',
    originalUrl: '/api/v1/foo',
    headers: opts.auth ? { authorization: opts.auth } : {},
  } as unknown as Request;
}

function mockRes(): { res: Response; status?: number; body?: unknown } {
  const state: { status?: number; body?: unknown } = {};
  const res = {
    status(code: number) { state.status = code; return this; },
    json(payload: unknown) { state.body = payload; return this; },
  } as unknown as Response;
  return { res, ...state };
}

async function invoke(req: Request): Promise<{ status?: number; body?: unknown; nextCalled: boolean }> {
  let nextCalled = false;
  const next: NextFunction = () => { nextCalled = true; };
  const state = { status: undefined as number | undefined, body: undefined as unknown };
  const res = {
    status(code: number) { state.status = code; return this; },
    json(payload: unknown) { state.body = payload; return this; },
  } as unknown as Response;
  await staffIpAllowlist()(req, res, next);
  return { status: state.status, body: state.body, nextCalled };
}

describe('staffIpAllowlist middleware', () => {
  const originalEnv = process.env['STAFF_IP_ALLOWLIST_ENFORCED'];

  beforeEach(async () => {
    delete process.env['STAFF_IP_ALLOWLIST_ENFORCED'];
    await db.delete(staffIpAllowlistTable);
    invalidateCache();
  });

  afterEach(async () => {
    if (originalEnv === undefined) delete process.env['STAFF_IP_ALLOWLIST_ENFORCED'];
    else process.env['STAFF_IP_ALLOWLIST_ENFORCED'] = originalEnv;
    await db.delete(staffIpAllowlistTable);
    invalidateCache();
  });

  it('is a no-op when the env flag is unset', async () => {
    await addEntry({ cidr: '10.0.0.0/8' }); // entries exist, but enforcement is off
    const out = await invoke(mockReq({ ip: '203.0.113.99' }));
    expect(out.nextCalled).toBe(true);
    expect(out.status).toBeUndefined();
  });

  it('allows requests from an in-range IP when enforced', async () => {
    process.env['STAFF_IP_ALLOWLIST_ENFORCED'] = '1';
    await addEntry({ cidr: '203.0.113.0/24' });
    invalidateCache();
    const out = await invoke(mockReq({ ip: '203.0.113.99' }));
    expect(out.nextCalled).toBe(true);
  });

  it('denies requests from an out-of-range IP with 403', async () => {
    process.env['STAFF_IP_ALLOWLIST_ENFORCED'] = '1';
    await addEntry({ cidr: '203.0.113.0/24' });
    invalidateCache();
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const out = await invoke(mockReq({ ip: '198.51.100.1' }));
      expect(out.status).toBe(403);
      expect(out.nextCalled).toBe(false);
      expect((out.body as { error?: { code?: string } }).error?.code).toBe('STAFF_IP_BLOCKED');
    } finally {
      console.warn = originalWarn;
    }
  });

  it('super-admin token bypasses the check (break-glass)', async () => {
    process.env['STAFF_IP_ALLOWLIST_ENFORCED'] = '1';
    await addEntry({ cidr: '203.0.113.0/24' });
    invalidateCache();
    const token = jwt.sign(
      { userId: 'u1', tenantId: 't1', role: 'owner', isSuperAdmin: true },
      process.env['JWT_SECRET']!,
      { expiresIn: 60 },
    );
    const out = await invoke(mockReq({ ip: '198.51.100.1', auth: `Bearer ${token}` }));
    expect(out.nextCalled).toBe(true);
    expect(out.status).toBeUndefined();
  });

  it('non-super-admin token does not bypass the check', async () => {
    process.env['STAFF_IP_ALLOWLIST_ENFORCED'] = '1';
    await addEntry({ cidr: '203.0.113.0/24' });
    invalidateCache();
    const token = jwt.sign(
      { userId: 'u1', tenantId: 't1', role: 'owner', isSuperAdmin: false },
      process.env['JWT_SECRET']!,
      { expiresIn: 60 },
    );
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const out = await invoke(mockReq({ ip: '198.51.100.1', auth: `Bearer ${token}` }));
      expect(out.status).toBe(403);
    } finally {
      console.warn = originalWarn;
    }
  });

  it('allows everything when enforced but the allowlist is empty', async () => {
    process.env['STAFF_IP_ALLOWLIST_ENFORCED'] = '1';
    // No entries in DB — cold-start safety kicks in.
    invalidateCache();
    const out = await invoke(mockReq({ ip: '198.51.100.1' }));
    expect(out.nextCalled).toBe(true);
  });
});
