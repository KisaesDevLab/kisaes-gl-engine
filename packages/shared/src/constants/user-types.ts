// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// `user_type` is orthogonal to `role`. Every firm user (owner,
// accountant, bookkeeper, readonly) is a `staff` user_type. A
// `client` user_type is reserved for the eventual non-staff
// commercial-gated app user introduced by the Practice build
// plan — they log in to the ledger UI but trigger the Commercial
// License requirement. Portal contacts (read-only Q&A surface
// under /portal) are not `users` at all; they live in a separate
// contacts table and authenticate via magic link.
export const USER_TYPES = ['staff', 'client'] as const;
export type UserType = typeof USER_TYPES[number];

export function isUserType(value: string): value is UserType {
  return (USER_TYPES as readonly string[]).includes(value);
}
