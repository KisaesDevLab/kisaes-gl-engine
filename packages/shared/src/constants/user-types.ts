// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// `user_type` is orthogonal to `role`. Every firm user (owner,
// accountant, bookkeeper, readonly) is a `staff` user_type. A
// `client` user_type is an external, non-staff user — an outside
// collaborator who logs into the ledger UI. They are invited from a
// tenant's Team page and their access is tailored via permission
// templates/overrides (see isCustomizablePrincipal); external users
// are a fully-supported feature and are NOT gated behind a commercial
// license. Client user_type is architecturally kept off the firm-side
// Practice/portal-admin surfaces (those route by `user_type === 'client'`)
// — that separation is a product boundary, not a licensing one.
// Portal contacts (read-only Q&A surface under /portal) are not `users`
// at all; they live in a separate contacts table and authenticate via
// magic link.
export const USER_TYPES = ['staff', 'client'] as const;
export type UserType = typeof USER_TYPES[number];

export function isUserType(value: string): value is UserType {
  return (USER_TYPES as readonly string[]).includes(value);
}
