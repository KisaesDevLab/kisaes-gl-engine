// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Pure-function tests for the permission core. This is the single
// place the role→permission policy lives, so the matrix is pinned
// here: owner/accountant → full, readonly → view, a client with no
// permission row → resolves by role, bookkeeper with no row → full
// (legacy, no regression), and any customizable principal (bookkeeper
// or client) with a row → template ?? none, then overrides. Read-only
// resources are capped at view. can() maps CRUD verbs onto the level ladder.

import { describe, it, expect } from 'vitest';
import { can, resolveEffectivePermissions, isCustomizablePrincipal } from './permissions.js';
import { PERMISSION_RESOURCES } from '../constants/permissions.js';

const everyKey = PERMISSION_RESOURCES.map((r) => r.key);

describe('resolveEffectivePermissions — role defaults', () => {
  it('owner and accountant get full on every writable resource', () => {
    for (const role of ['owner', 'accountant']) {
      const perms = resolveEffectivePermissions({ role });
      for (const r of PERMISSION_RESOURCES) {
        expect(perms[r.key]).toBe(r.writable ? 'full' : 'view');
      }
    }
  });

  it('readonly gets view everywhere', () => {
    const perms = resolveEffectivePermissions({ role: 'readonly' });
    for (const key of everyKey) expect(perms[key]).toBe('view');
  });

  it('super-admin overrides role and gets full', () => {
    const perms = resolveEffectivePermissions({ role: 'readonly', isSuperAdmin: true });
    expect(perms.invoices).toBe('full');
  });

  it('client userType resolves by role when it has no permission row (a client owner keeps full ledger access)', () => {
    const perms = resolveEffectivePermissions({ role: 'owner', userType: 'client' });
    expect(perms.invoices).toBe('full');
  });

  it('a readonly-baseline client with no row is view-only', () => {
    const perms = resolveEffectivePermissions({ role: 'readonly', userType: 'client' });
    expect(perms.invoices).toBe('view');
  });

  it('unknown/missing role denies by default', () => {
    expect(resolveEffectivePermissions({ role: undefined }).invoices).toBe('none');
    expect(resolveEffectivePermissions({ role: 'weird' }).invoices).toBe('none');
  });
});

describe('resolveEffectivePermissions — external (client) users', () => {
  it('applies template + overrides once a permission row exists, regardless of role', () => {
    const perms = resolveEffectivePermissions({
      role: 'readonly',
      userType: 'client',
      hasPermissionRow: true,
      templateMap: { invoices: 'view', receive_payment: 'full' },
    });
    expect(can(perms, 'invoices', 'read')).toBe(true);
    expect(can(perms, 'invoices', 'create')).toBe(false);
    expect(can(perms, 'receive_payment', 'create')).toBe(true);
    // Anything not named by the template/overrides is denied.
    expect(perms.bills).toBe('none');
  });

  it('overrides beat the template for a client', () => {
    const perms = resolveEffectivePermissions({
      role: 'accountant',
      userType: 'client',
      hasPermissionRow: true,
      templateMap: { bills: 'full' },
      overrides: { bills: 'view' },
    });
    expect(perms.bills).toBe('view');
  });

  it('isCustomizablePrincipal covers bookkeepers and every client', () => {
    expect(isCustomizablePrincipal('bookkeeper')).toBe(true);
    expect(isCustomizablePrincipal('owner', 'client')).toBe(true);
    expect(isCustomizablePrincipal('readonly', 'client')).toBe(true);
    expect(isCustomizablePrincipal('accountant', 'staff')).toBe(false);
    expect(isCustomizablePrincipal('owner')).toBe(false);
  });
});

describe('resolveEffectivePermissions — bookkeeper', () => {
  it('keeps legacy full access when no permission row exists', () => {
    const perms = resolveEffectivePermissions({ role: 'bookkeeper', hasPermissionRow: false });
    expect(perms.invoices).toBe('full');
    expect(perms.receive_payment).toBe('full');
  });

  it('denies unset resources once a row exists (deny-by-default)', () => {
    const perms = resolveEffectivePermissions({
      role: 'bookkeeper',
      hasPermissionRow: true,
      templateMap: { invoices: 'view' },
    });
    expect(perms.invoices).toBe('view');
    expect(perms.bills).toBe('none');
  });

  it('applies the user example: view invoices, full receive-payment', () => {
    const perms = resolveEffectivePermissions({
      role: 'bookkeeper',
      hasPermissionRow: true,
      templateMap: { invoices: 'view', receive_payment: 'full' },
    });
    expect(can(perms, 'invoices', 'read')).toBe(true);
    expect(can(perms, 'invoices', 'create')).toBe(false);
    expect(can(perms, 'receive_payment', 'create')).toBe(true);
  });

  it('overrides take precedence over the template', () => {
    const perms = resolveEffectivePermissions({
      role: 'bookkeeper',
      hasPermissionRow: true,
      templateMap: { bills: 'full' },
      overrides: { bills: 'view' },
    });
    expect(perms.bills).toBe('view');
  });

  it('caps full to view on read-only resources', () => {
    const perms = resolveEffectivePermissions({
      role: 'bookkeeper',
      hasPermissionRow: true,
      templateMap: { reports: 'full' },
    });
    expect(perms.reports).toBe('view');
  });
});

describe('can', () => {
  it('read needs view or full; writes need full', () => {
    expect(can({ invoices: 'view' }, 'invoices', 'read')).toBe(true);
    expect(can({ invoices: 'view' }, 'invoices', 'update')).toBe(false);
    expect(can({ invoices: 'full' }, 'invoices', 'delete')).toBe(true);
    expect(can({ invoices: 'none' }, 'invoices', 'read')).toBe(false);
    expect(can(undefined, 'invoices', 'read')).toBe(false);
  });
});
