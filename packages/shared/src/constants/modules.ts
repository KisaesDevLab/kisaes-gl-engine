// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Module → license-tier manifest. Visibility-only today: no runtime gate
// reads this (the TB build plan registers `tb: base` here so the future
// licensing work from BUILD_PLAN_MYBOOKS_LICENSING.md has one place to
// look). `base` = PolyForm Internal Use, no commercial gate.
export const MODULE_LICENSE_TIERS = {
  // Trial Balance module (docs/tb/BUILD_PLAN.md) — firm-side feature.
  tb: 'base',
} as const;

export type ModuleKey = keyof typeof MODULE_LICENSE_TIERS;
export type ModuleLicenseTier = typeof MODULE_LICENSE_TIERS[ModuleKey];
