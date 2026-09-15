// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Default-deny pin for delegated admin. The admin router registers the
// delegable routes ABOVE a super-admin barrier layer; everything below is
// super-admin only. This test walks the Express stack and asserts:
//   1. every route above the barrier carries a requireAdminCapability guard
//   2. the set of delegable routes is EXACTLY the manifest below
//   3. the sensitive routes are below the barrier
// Adding a route above the barrier without a guard, or delegating a new
// route without updating this manifest, fails the build on purpose.

import { describe, it, expect } from 'vitest';
// express-async-errors (loaded by sibling test files in the single-process
// run) wraps every Layer handle, so identity checks on `layer.handle` are
// meaningless here. The router exports its barrier's stack index and the
// registry that the `delegable` helper fills — that helper is the ONLY way a
// route gets registered above the barrier WITH its capability guard.
import 'express-async-errors';
import { adminRouter, ADMIN_BARRIER_STACK_INDEX, DELEGABLE_ROUTES } from './admin.routes.js';

interface Layer {
  handle: unknown;
  route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> };
}

const DELEGABLE: Record<string, string> = {
  'GET /tenants': 'admin_tenant_ops',
  'GET /tenants/:id': 'admin_tenant_ops',
  'POST /tenants/:id/firm': 'admin_tenant_ops',
  'GET /firms': 'admin_tenant_ops',
  'GET /tenants/:id/retained-earnings': 'admin_tenant_ops',
  'POST /tenants/:id/retained-earnings': 'admin_tenant_ops',
  'GET /tenants/:id/system-accounts': 'admin_tenant_ops',
  'PUT /tenants/:id/system-accounts/:tag': 'admin_tenant_ops',
  'GET /tenants/:id/suspense-consolidation': 'admin_tenant_ops',
  'POST /tenants/:id/suspense-consolidation': 'admin_tenant_ops',
  'POST /tenants/:id/disable': 'admin_tenant_ops',
  'POST /tenants/:id/enable': 'admin_tenant_ops',
  'POST /tenants/:id/apply-coa-template': 'admin_tenant_ops',
  'POST /create-client': 'admin_tenant_ops',
  'GET /users': 'admin_user_support',
  'POST /users/create': 'admin_user_support',
  'POST /users/:id/send-password-reset': 'admin_user_support',
  'POST /users/:id/unlock': 'admin_user_support',
  'POST /users/:id/toggle-active': 'admin_user_support',
  'POST /users/:id/toggle-tenant-access': 'admin_user_support',
  'GET /users/:id/tenant-access': 'admin_user_support',
  'POST /users/:id/grant-tenant-access': 'admin_user_support',
  'GET /firm-users': 'admin_user_support',
  'POST /users/:id/set-role': 'admin_user_support',
  'GET /users/:id/company-access': 'admin_user_support',
  'POST /users/:id/exclude-company': 'admin_user_support',
  'POST /users/:id/include-company': 'admin_user_support',
};

const NEVER_DELEGABLE = [
  'POST /impersonate/:userId',
  'POST /users/:id/toggle-super-admin',
  'POST /users/:id/reset-password',
  'DELETE /tenants/:id',
  'DELETE /tenants/:id/chart-of-accounts',
  'DELETE /tenants/:id/transactions',
  'DELETE /tenants/:id/companies/:companyId',
  'DELETE /tenants/:id/payroll-import-history',
  'POST /tenants/:id/delete-transactions-range',
  'GET /settings',
  'PUT /settings/smtp',
  'PUT /settings/application',
  'GET /metrics',
  'GET /plaid/config',
  'GET /plaid/connections',
  'GET /coa-templates',
  'GET /report-letters',
  'GET /security/status',
  'GET /tunnel-config',
  'GET /ip-allowlist',
  'GET /tfa/config',
  'GET /mcp/config',
  'GET /backup/remote-config',
  'GET /storage/system-config',
];

function key(layer: Layer): string {
  const method = Object.keys(layer.route!.methods)[0]!.toUpperCase();
  return `${method} ${layer.route!.path}`;
}

describe('admin router delegation manifest', () => {
  const stack = (adminRouter as unknown as { stack: Layer[] }).stack;
  const barrierIdx = ADMIN_BARRIER_STACK_INDEX;

  it('has the super-admin barrier layer (a non-route use-layer)', () => {
    expect(barrierIdx).toBeGreaterThan(0);
    expect(stack[barrierIdx]!.route).toBeUndefined();
  });

  it('every route above the barrier came through the delegable registry and the set matches the manifest exactly', () => {
    const registry: Record<string, string> = {};
    for (const r of DELEGABLE_ROUTES) registry[`${r.method} ${r.path}`] = r.capability;
    const seen: Record<string, string> = {};
    for (const layer of stack.slice(0, barrierIdx)) {
      if (!layer.route) continue; // authenticate / requireAdminPrincipal use-layers
      const k = key(layer);
      expect(registry[k], `${k} is above the super-admin barrier but was not registered via delegable()`).toBeDefined();
      // The registry helper always prepends the capability guard, so the
      // route has at least guard + handler.
      expect(layer.route.stack.length).toBeGreaterThanOrEqual(2);
      seen[k] = registry[k]!;
    }
    expect(seen).toEqual(DELEGABLE);
    expect(registry).toEqual(DELEGABLE);
  });

  it('sensitive routes sit below the barrier (super-admin only)', () => {
    const above = new Set(stack.slice(0, barrierIdx).filter((l) => l.route).map(key));
    const all = new Set(stack.filter((l) => l.route).map(key));
    for (const k of NEVER_DELEGABLE) {
      expect(all.has(k), `${k} should exist on the admin router`).toBe(true);
      expect(above.has(k), `${k} must not be delegable`).toBe(false);
    }
  });
});
