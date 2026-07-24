// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { AccessLevel, PermissionAction } from '../types/permissions.js';
import {
  PERMISSION_RESOURCES,
  getResourceDef,
  type ResourceKey,
  type PermissionMap,
  type EffectivePermissions,
} from '../constants/permissions.js';

// Pure authorization core — no DB, no request. Copied in spirit from
// `filterPracticeNav` so both the API guards and the web UI derive
// access identically and the whole thing is unit-testable without a
// server. Backend enforcement is authoritative; the UI uses the same
// functions only to hide what the server would reject.

// Cap a level to what a resource actually supports: read-only
// resources (writable=false) can never be `full`.
function cap(level: AccessLevel, writable: boolean): AccessLevel {
  if (!writable && level === 'full') return 'view';
  return level;
}

// Does `perms` permit `action` on `resource`?
//   read            → view | full
//   create/update/delete → full
export function can(
  perms: Partial<Record<ResourceKey, AccessLevel>> | undefined | null,
  resource: ResourceKey,
  action: PermissionAction,
): boolean {
  const level = perms?.[resource] ?? 'none';
  if (action === 'read') return level === 'view' || level === 'full';
  return level === 'full';
}

export interface ResolvePermissionsInput {
  role: string | undefined | null;
  userType?: 'staff' | 'client' | undefined;
  isSuperAdmin?: boolean;
  // Whether a `user_permissions` row exists for this (tenant, user).
  // Absence is what keeps a legacy bookkeeper at full access.
  hasPermissionRow?: boolean;
  // The assigned template's permission map (bookkeeper only).
  templateMap?: PermissionMap | null;
  // Per-user overrides layered on top of the template (bookkeeper only).
  overrides?: PermissionMap | null;
}

function fillAll(level: AccessLevel): EffectivePermissions {
  const out = {} as EffectivePermissions;
  for (const r of PERMISSION_RESOURCES) {
    out[r.key] = cap(level, r.writable);
  }
  return out;
}

// Resolve a concrete access level for every resource. This is the one
// place the role→permission policy lives.
//
//   super-admin / owner / accountant → full (capped per resource)
//   readonly                         → view
//   bookkeeper, no permission row     → full (legacy, no regression)
//   customizable + permission row     → template ?? none, then overrides
//   unknown / missing role            → none (deny-by-default)
//
// "Customizable" principals are bookkeepers AND every external (client)
// user — both resolve from an assigned template + overrides once a
// `user_permissions` row exists (see isCustomizablePrincipal). Absent a
// row they fall through to their role defaults, which preserves both the
// legacy bookkeeper full-access behavior and a client owner's full ledger.
export function resolveEffectivePermissions(input: ResolvePermissionsInput): EffectivePermissions {
  const { role, userType, isSuperAdmin, hasPermissionRow, templateMap, overrides } = input;

  if (isSuperAdmin) return fillAll('full');

  // Template-driven path: a bookkeeper or external client user who has been
  // given a permission row resolves entirely from template + overrides.
  // For a client this is how an owner tailors an external user's access;
  // the client's nominal role only supplies the pre-permission baseline
  // (the switch below) until that row exists.
  if (isCustomizablePrincipal(role, userType) && hasPermissionRow) {
    const out = {} as EffectivePermissions;
    for (const r of PERMISSION_RESOURCES) {
      const fromTemplate = templateMap?.[r.key];
      const fromOverride = overrides?.[r.key];
      const level: AccessLevel = fromOverride ?? fromTemplate ?? 'none';
      out[r.key] = cap(level, r.writable);
    }
    return out;
  }

  // Role defaults (no permission row, or a non-customizable principal).
  // Note: `userType === 'client'` is intentionally NOT forced to `none`
  // here — a client with no row resolves by role like anyone else, so a
  // client owner keeps full ledger access.
  switch (role) {
    case 'owner':
    case 'accountant':
      return fillAll('full');
    case 'readonly':
      return fillAll('view');
    case 'bookkeeper':
      // Legacy compatibility: a bookkeeper who has never been given a
      // permission row behaves exactly as today (full access).
      return fillAll('full');
    default:
      return fillAll('none');
  }
}

// Convenience: is this role one whose access can be tailored via
// templates/overrides? Only bookkeeper, per the locked decision.
export function isCustomizableRole(role: string | undefined | null): boolean {
  return role === 'bookkeeper';
}

// A principal whose effective access is tailored via templates/overrides
// rather than derived purely from role: bookkeepers, and every external
// (client) user. Both consult the `user_permissions` table at enforcement
// time. This is what lets an owner apply granular permissions to an
// invited external user regardless of the nominal tenant role.
export function isCustomizablePrincipal(
  role: string | undefined | null,
  userType?: 'staff' | 'client' | undefined | null,
): boolean {
  return role === 'bookkeeper' || userType === 'client';
}

export { getResourceDef };
