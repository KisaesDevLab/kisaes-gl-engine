// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../utils/errors.js';
import { emptyFirmCapabilities } from '@kis-books/shared';

const tenantCaps = vi.fn();
const adminCaps = vi.fn();
const adminScope = vi.fn();
vi.mock('../services/firm-capabilities.service.js', () => ({
  getTenantCapabilitiesForUser: (...a: unknown[]) => tenantCaps(...a),
  getAdminCapabilitiesForUser: (...a: unknown[]) => adminCaps(...a),
  getAdminScope: (...a: unknown[]) => adminScope(...a),
  hasAnyAdminCapability: (caps: Record<string, boolean>) => !!(caps['admin_tenant_ops'] || caps['admin_user_support']),
}));

const { requireTenantCapability, requireAdminPrincipal, requireAdminCapability, hasTenantOwnerPower } =
  await import('./firm-capabilities.js');

function mockReq(o: Partial<Request>): Request {
  return {
    userId: 'u1', tenantId: 't1', userRole: 'accountant', userType: 'staff', isSuperAdmin: false,
    authKind: 'session', tokenIssuedAt: Math.floor(Date.now() / 1000) - 10, ...o,
  } as unknown as Request;
}
async function run(mw: (req: Request, res: Response, next: NextFunction) => unknown, req: Request) {
  let nextCalled = false;
  try {
    await mw(req, {} as Response, () => { nextCalled = true; });
  } catch (err) {
    return { thrown: err as AppError, nextCalled };
  }
  return { thrown: undefined, nextCalled };
}

beforeEach(() => {
  tenantCaps.mockReset(); adminCaps.mockReset(); adminScope.mockReset();
  tenantCaps.mockResolvedValue(emptyFirmCapabilities());
  adminCaps.mockResolvedValue(emptyFirmCapabilities());
  adminScope.mockResolvedValue({ firmIds: [], tenantIds: [] });
});

describe('requireTenantCapability', () => {
  const gate = requireTenantCapability('team_management');
  it('owner and super admin pass without consulting the resolver', async () => {
    expect((await run(gate, mockReq({ userRole: 'owner' }))).nextCalled).toBe(true);
    expect((await run(gate, mockReq({ isSuperAdmin: true }))).nextCalled).toBe(true);
    expect(tenantCaps).not.toHaveBeenCalled();
  });
  it('a capable staff session passes; plain staff 403 OWNER_REQUIRED', async () => {
    tenantCaps.mockResolvedValue({ ...emptyFirmCapabilities(), team_management: true });
    expect((await run(gate, mockReq({}))).nextCalled).toBe(true);
    tenantCaps.mockResolvedValue(emptyFirmCapabilities());
    const out = await run(gate, mockReq({}));
    expect(out.thrown?.code).toBe('OWNER_REQUIRED');
    expect(out.thrown?.statusCode).toBe(403);
  });
  it('API keys and client users never elevate', async () => {
    tenantCaps.mockResolvedValue({ ...emptyFirmCapabilities(), team_management: true });
    expect((await run(gate, mockReq({ authKind: 'api_key' as never }))).thrown?.statusCode).toBe(403);
    expect((await run(gate, mockReq({ userType: 'client' }))).thrown?.statusCode).toBe(403);
    expect(tenantCaps).not.toHaveBeenCalled();
  });
  it('memoizes the resolver per request', async () => {
    const req = mockReq({});
    await hasTenantOwnerPower(req, 'team_management');
    await hasTenantOwnerPower(req, 'check_signatures');
    expect(tenantCaps).toHaveBeenCalledTimes(1);
  });
});

describe('requireAdminPrincipal', () => {
  it('super admin passes (fresh session) and is not marked delegated', async () => {
    const req = mockReq({ isSuperAdmin: true });
    expect((await run(requireAdminPrincipal, req)).nextCalled).toBe(true);
    expect(req.adminDelegated).toBeUndefined();
  });
  it('member with an admin capability passes and is marked delegated', async () => {
    adminCaps.mockResolvedValue({ ...emptyFirmCapabilities(), admin_user_support: true });
    const req = mockReq({});
    expect((await run(requireAdminPrincipal, req)).nextCalled).toBe(true);
    expect(req.adminDelegated).toBe(true);
  });
  it('member with only tenant-level capabilities is refused with the uniform message', async () => {
    adminCaps.mockResolvedValue({ ...emptyFirmCapabilities(), team_management: true });
    const out = await run(requireAdminPrincipal, mockReq({}));
    expect(out.thrown?.statusCode).toBe(403);
    expect(out.thrown?.message).toBe('Super admin access required');
  });
  it('applies the admin idle bound to delegated members (ADMIN_SESSION_EXPIRED)', async () => {
    adminCaps.mockResolvedValue({ ...emptyFirmCapabilities(), admin_tenant_ops: true });
    const out = await run(requireAdminPrincipal, mockReq({ tokenIssuedAt: Math.floor(Date.now() / 1000) - 31 * 60 }));
    expect(out.thrown?.code).toBe('ADMIN_SESSION_EXPIRED');
  });
  it('API keys and client users are refused before any lookup', async () => {
    adminCaps.mockResolvedValue({ ...emptyFirmCapabilities(), admin_tenant_ops: true });
    expect((await run(requireAdminPrincipal, mockReq({ authKind: 'api_key' as never }))).thrown?.statusCode).toBe(403);
    expect((await run(requireAdminPrincipal, mockReq({ userType: 'client' }))).thrown?.statusCode).toBe(403);
    expect(adminCaps).not.toHaveBeenCalled();
  });
});

describe('requireAdminCapability', () => {
  const gate = requireAdminCapability('admin_tenant_ops');
  it('carries the capability marker for the manifest test', () => {
    expect(gate.adminCapability).toBe('admin_tenant_ops');
  });
  it('super admin passes with no scope', async () => {
    const req = mockReq({ isSuperAdmin: true });
    expect((await run(gate, req)).nextCalled).toBe(true);
    expect(req.adminScope).toBeUndefined();
  });
  it('delegated member with scope passes and receives req.adminScope', async () => {
    adminScope.mockResolvedValue({ firmIds: ['f1'], tenantIds: ['t1', 't2'] });
    const req = mockReq({ adminDelegated: true });
    expect((await run(gate, req)).nextCalled).toBe(true);
    expect(req.adminScope).toEqual({ firmIds: ['f1'], tenantIds: ['t1', 't2'] });
  });
  it('delegated member lacking this capability is refused; non-delegated staff too', async () => {
    const out = await run(gate, mockReq({ adminDelegated: true }));
    expect(out.thrown?.code).toBe('ADMIN_CAPABILITY_REQUIRED');
    expect((await run(gate, mockReq({}))).thrown?.statusCode).toBe(403);
  });
});
