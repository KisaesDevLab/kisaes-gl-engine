// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Firm member access rights — the per-member capability catalog.
//
// A firm member (firm_users row) may hold any subset of these boolean
// capabilities. They are stored firm-wide on the membership row and
// resolved by `resolveFirmCapabilities` (utils/firm-capabilities.ts).
//
// Two scopes:
//   'tenant' — elevates the member to owner parity for one settings area
//              on a tenant the firm manages AND the member already has
//              active user_tenant_access on. Never grants access by itself.
//   'admin'  — unlocks a delegated slice of the super-admin area, scoped
//              to the tenants of the firms where the member holds it.
//
// Keep in sync with:
//   - requireTenantCapability(...) / requireAdminCapability(...) guards
//     (packages/api/src/middleware/firm-capabilities.ts)
//   - the delegation manifest test on admin.routes.ts
//   - FirmMemberCapabilitiesDrawer (packages/web)
export const FIRM_CAPABILITY_GROUPS = ['Client settings', 'Administration'] as const;
export type FirmCapabilityGroup = typeof FIRM_CAPABILITY_GROUPS[number];

export type FirmCapabilityScope = 'tenant' | 'admin';

export interface FirmCapabilityDef {
  key: string;
  label: string;
  group: FirmCapabilityGroup;
  scope: FirmCapabilityScope;
  description: string;
}

export const FIRM_CAPABILITIES = [
  // ── Client settings (owner parity on managed tenants) ──
  {
    key: 'team_management',
    label: 'Team management',
    group: 'Client settings',
    scope: 'tenant',
    description:
      'Invite, edit, deactivate, unlock and send password resets for users on the client\'s Team page; manage permission templates and per-user permissions. Full owner parity, including owner role changes.',
  },
  {
    key: 'integrations_payments',
    label: 'Integrations & payments',
    group: 'Client settings',
    scope: 'tenant',
    description:
      'Configure or remove Stripe online payments, accept or revoke AI processing consent, and manage "Invite my accountant" invitations.',
  },
  {
    key: 'check_signatures',
    label: 'Check signatures',
    group: 'Client settings',
    scope: 'tenant',
    description:
      'Manage the check signature library and which users may print with each signature. Printing still requires the usual step-up re-authentication.',
  },
  {
    key: 'screen_share_admin',
    label: 'Screen share admin',
    group: 'Client settings',
    scope: 'tenant',
    description:
      'View and end peer screen-share sessions and edit screen-share settings and per-user overrides.',
  },
  // ── Administration (delegated, firm-scoped slice of Admin) ──
  {
    key: 'admin_tenant_ops',
    label: 'Tenant operations',
    group: 'Administration',
    scope: 'admin',
    description:
      'Admin → Tenants for the firm\'s clients only: tenant detail, enable/disable, managing firm, feature flags, chart-of-accounts template, retained earnings, system accounts, suspense consolidation, and creating client companies. Never deletes.',
  },
  {
    key: 'admin_user_support',
    label: 'User support',
    group: 'Administration',
    scope: 'admin',
    description:
      'Admin → Users for users of the firm\'s clients only: create, unlock, send password reset, activate/deactivate, change role, and manage tenant and company access. Never impersonation, typed password resets, or super-admin changes.',
  },
] as const satisfies readonly FirmCapabilityDef[];

export type FirmCapabilityKey = typeof FIRM_CAPABILITIES[number]['key'];

export const FIRM_CAPABILITY_KEYS: readonly FirmCapabilityKey[] = FIRM_CAPABILITIES.map((c) => c.key);

export const TENANT_CAPABILITY_KEYS: readonly FirmCapabilityKey[] = FIRM_CAPABILITIES
  .filter((c) => c.scope === 'tenant')
  .map((c) => c.key);

export const ADMIN_CAPABILITY_KEYS: readonly FirmCapabilityKey[] = FIRM_CAPABILITIES
  .filter((c) => c.scope === 'admin')
  .map((c) => c.key);

export function isFirmCapabilityKey(key: string): key is FirmCapabilityKey {
  return (FIRM_CAPABILITY_KEYS as readonly string[]).includes(key);
}

export function getFirmCapabilityDef(key: FirmCapabilityKey): FirmCapabilityDef {
  // Safe: key is a catalog member by construction.
  return FIRM_CAPABILITIES.find((c) => c.key === key) as FirmCapabilityDef;
}

// Partial map is the wire/storage shape. Absent keys resolve to `false`
// (deny-by-default) so a future catalog addition never silently grants
// to a member whose set was customized before it existed.
export type FirmCapabilityMap = Partial<Record<FirmCapabilityKey, boolean>>;

// Fully-resolved map — every capability has a concrete boolean. This is
// what the resolver returns and what `/auth/me` ships.
export type EffectiveFirmCapabilities = Record<FirmCapabilityKey, boolean>;
