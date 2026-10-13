// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { FirmRole } from '../types/firms.js';
import {
  FIRM_CAPABILITY_KEYS,
  FIRM_DATA_CAPABILITY_KEYS,
  type FirmCapabilityMap,
  type EffectiveFirmCapabilities,
} from '../constants/firm-capabilities.js';

// Pure resolver for firm member access rights — no DB, no request. The
// API guards and the web UI both derive the effective set from the same
// function so they never disagree. Backend enforcement is authoritative.

function fill(value: boolean): EffectiveFirmCapabilities {
  const out = {} as EffectiveFirmCapabilities;
  for (const k of FIRM_CAPABILITY_KEYS) out[k] = value;
  return out;
}

export function emptyFirmCapabilities(): EffectiveFirmCapabilities {
  return fill(false);
}

// Which firm roles may hold owner / admin capabilities ('tenant' and
// 'admin' scopes). firm_readonly is deliberately ineligible: it is the
// "observe only" role and must never pick up owner-level or admin-level
// power through this matrix.
export function isCapabilityEligibleRole(role: FirmRole | string | null | undefined): boolean {
  return role === 'firm_admin' || role === 'firm_staff';
}

// Q54: may this role hold this particular key? 'firm_data' keys (view
// only) are open to firm_readonly as well; every other key follows
// isCapabilityEligibleRole.
export function isCapabilityKeyEligibleForRole(key: string, role: FirmRole | string | null | undefined): boolean {
  if ((FIRM_DATA_CAPABILITY_KEYS as readonly string[]).includes(key)) {
    return role === 'firm_admin' || role === 'firm_staff' || role === 'firm_readonly';
  }
  return isCapabilityEligibleRole(role);
}

// Role defaults, used when the membership row has no stored set (NULL):
//   firm_admin    → everything on
//   firm_staff    → nothing
//   firm_readonly → nothing (and ineligible)
export function defaultFirmCapabilities(role: FirmRole | string | null | undefined): EffectiveFirmCapabilities {
  return fill(role === 'firm_admin');
}

// Resolve the effective set for one membership row.
//   ineligible role      → all false, regardless of what is stored —
//                          except firm_readonly's stored 'firm_data' keys (Q54)
//   stored == null       → role defaults
//   stored is an object  → exactly the stored map; absent keys are false
export function resolveFirmCapabilities(
  role: FirmRole | string | null | undefined,
  stored: FirmCapabilityMap | null | undefined,
): EffectiveFirmCapabilities {
  if (stored == null) return defaultFirmCapabilities(role);
  const out = emptyFirmCapabilities();
  for (const k of FIRM_CAPABILITY_KEYS) out[k] = stored[k] === true && isCapabilityKeyEligibleForRole(k, role);
  return out;
}

// OR together the effective sets of several memberships (a user may
// belong to more than one firm that manages the same tenant).
export function unionFirmCapabilities(maps: readonly EffectiveFirmCapabilities[]): EffectiveFirmCapabilities {
  const out = emptyFirmCapabilities();
  for (const m of maps) {
    for (const k of FIRM_CAPABILITY_KEYS) if (m[k]) out[k] = true;
  }
  return out;
}

export function hasAnyFirmCapability(map: Partial<Record<string, boolean>> | null | undefined): boolean {
  if (!map) return false;
  return FIRM_CAPABILITY_KEYS.some((k) => map[k] === true);
}

// Strip a wire/storage map down to catalog keys with strict booleans.
export function normalizeFirmCapabilityMap(input: Partial<Record<string, unknown>>): FirmCapabilityMap {
  const out: FirmCapabilityMap = {};
  for (const k of FIRM_CAPABILITY_KEYS) {
    if (typeof input[k] === 'boolean') out[k] = input[k] as boolean;
  }
  return out;
}
