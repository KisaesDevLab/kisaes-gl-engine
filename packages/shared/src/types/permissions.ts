// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Per-member permission primitives. A user's access to each app
// resource is one of three levels; the level is derived (never stored
// raw on the wire) by `resolveEffectivePermissions` from the user's
// role plus, for bookkeepers, an assigned template + per-user overrides.
// See docs/plans plan file and `utils/permissions.ts`.

export const ACCESS_LEVELS = ['none', 'view', 'full'] as const;
export type AccessLevel = typeof ACCESS_LEVELS[number];

export function isAccessLevel(value: string): value is AccessLevel {
  return (ACCESS_LEVELS as readonly string[]).includes(value);
}

// CRUD verbs collapse onto the level ladder: `read` needs `view` or
// `full`; every mutating verb needs `full`.
export type PermissionAction = 'read' | 'create' | 'update' | 'delete';

// One row of the permission matrix. `writable: false` marks a
// read-only surface (Reports, Dashboard, Audit Log) where `full` is
// meaningless and is capped to `view` by the resolver.
export interface ResourceDef {
  key: string;
  label: string;
  group: string;
  writable: boolean;
}
