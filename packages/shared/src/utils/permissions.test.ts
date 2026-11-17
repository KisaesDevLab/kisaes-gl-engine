// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.
//
// Pure-function tests for the permission core. This is the single
// place the role→permission policy lives, so the matrix is pinned
// here: owner/accountant → full, readonly → view, a client with no
// permission row → resolves by role, bookkeeper with no row → full
// (legacy, no regression; sensitive accounts included since
// sensitive-accounts-grant-v1), and any customizable principal (bookkeeper
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

  it('readonly gets view everywhere except elevated resources', () => {
    const perms = resolveEffectivePermissions({ role: 'readonly' });
    for (const key of everyKey) expect(perms[key]).toBe(key === 'sensitive_accounts' ? 'none' : 'view');
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

describe('resolveEffectivePermissions — sensitive_accounts truth table (U-33)', () => {
  const level = (input: Parameters<typeof resolveEffectivePermissions>[0]) =>
    resolveEffectivePermissions(input).sensitive_accounts;

  it('super admin, owner and accountant see sensitive accounts', () => {
    expect(level({ role: 'bookkeeper', isSuperAdmin: true })).toBe('view');
    expect(level({ role: 'owner' })).toBe('view');
    expect(level({ role: 'accountant' })).toBe('view');
  });

  it('a bookkeeper with no permission row does too (sensitive-accounts-grant-v1: legacy full access includes it)', () => {
    const perms = resolveEffectivePermissions({ role: 'bookkeeper', hasPermissionRow: false });
    expect(perms.sensitive_accounts).toBe('view');
    expect(perms.accounts).toBe('full');
    expect(level({ role: 'bookkeeper' })).toBe('view');
    // A client-type user with the bookkeeper role and no row resolves by role, like every other key.
    expect(level({ role: 'bookkeeper', userType: 'client' })).toBe('view');
  });

  it('a restricted bookkeeper (any permission row) sees them only when the template or an override lists the key', () => {
    const bk = { role: 'bookkeeper', hasPermissionRow: true } as const;
    // The ClientLedger "Bookkeeper" template: lists the key.
    expect(level({ ...bk, templateMap: { accounts: 'full', sensitive_accounts: 'view' } })).toBe('view');
    // A/R, A/P or any other template that does not list it: none (no parent, no role default).
    expect(level({ ...bk, templateMap: { invoices: 'full', receive_payment: 'full', accounts: 'view' } })).toBe('none');
    expect(level({ ...bk, templateMap: { bills: 'full', pay_bills: 'full', accounts: 'view' } })).toBe('none');
    expect(level({ ...bk, templateMap: {} })).toBe('none');
    expect(level({ ...bk, templateMap: null, overrides: null })).toBe('none');
    // An override grants it on top of a template without it, or takes it away.
    expect(level({ ...bk, templateMap: { invoices: 'full' }, overrides: { sensitive_accounts: 'view' } })).toBe('view');
    expect(level({ ...bk, templateMap: { sensitive_accounts: 'view' }, overrides: { sensitive_accounts: 'none' } })).toBe('none');
  });

  it('a bookkeeper or client user with a row: override, else template, else none', () => {
    for (const userType of ['staff', 'client'] as const) {
      const role = userType === 'client' ? 'readonly' : 'bookkeeper';
      expect(level({ role, userType, hasPermissionRow: true })).toBe('none');
      expect(level({ role, userType, hasPermissionRow: true, templateMap: { sensitive_accounts: 'view' } })).toBe('view');
      expect(level({
        role, userType, hasPermissionRow: true,
        templateMap: { sensitive_accounts: 'view' }, overrides: { sensitive_accounts: 'none' },
      })).toBe('none');
      expect(level({ role, userType, hasPermissionRow: true, overrides: { sensitive_accounts: 'full' } })).toBe('view');
    }
  });

  it('readonly never sees them by default; unknown roles see nothing', () => {
    expect(level({ role: 'readonly' })).toBe('none');
    expect(level({ role: 'readonly', userType: 'client' })).toBe('none');
    expect(level({ role: '' })).toBe('none');
    expect(level({ role: null })).toBe('none');
    expect(level({ role: 'weird' })).toBe('none');
    expect(level({ role: undefined })).toBe('none');
  });

  it('is a read-only Manage row in the catalog', () => {
    const row = PERMISSION_RESOURCES.find((r) => r.key === 'sensitive_accounts');
    expect(row).toMatchObject({ label: 'Sensitive accounts', group: 'Manage', writable: false, elevated: true });
  });
});

describe('financial_reports inherits reports (U-227)', () => {
  const fin = (input: Parameters<typeof resolveEffectivePermissions>[0]) => resolveEffectivePermissions(input).financial_reports;
  const bk = { role: 'bookkeeper', hasPermissionRow: true } as const;

  it('a template without the key takes the reports level', () => {
    expect(fin({ ...bk, templateMap: { reports: 'view' } })).toBe('view');
    expect(fin({ ...bk, templateMap: { reports: 'full' } })).toBe('view'); // capped
    expect(fin({ ...bk, templateMap: {} })).toBe('none');
    expect(fin({ ...bk, templateMap: { reports: 'view' }, overrides: { reports: 'none' } })).toBe('none');
  });

  it('an explicit level, none included, wins over the parent', () => {
    expect(fin({ ...bk, templateMap: { reports: 'view', financial_reports: 'none' } })).toBe('none');
    expect(fin({ ...bk, templateMap: { reports: 'none', financial_reports: 'view' } })).toBe('view');
    expect(fin({ ...bk, templateMap: { financial_reports: 'none' }, overrides: { financial_reports: 'view' } })).toBe('view');
  });

  it('role defaults are unchanged: owner, readonly and a legacy bookkeeper see it', () => {
    expect(fin({ role: 'owner' })).toBe('view');
    expect(fin({ role: 'readonly' })).toBe('view');
    expect(fin({ role: 'bookkeeper' })).toBe('view');
    expect(fin({ role: 'weird' })).toBe('none');
  });

  it('is a read-only Reporting row that inherits reports', () => {
    expect(PERMISSION_RESOURCES.find((r) => r.key === 'financial_reports'))
      .toMatchObject({ group: 'Reporting', writable: false, inheritsFrom: 'reports' });
  });
});
