-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Tax Estimator (TAX_ESTIMATOR_V1). ONE consolidated, additive migration for
-- the whole module (features/tax-estimator/MODULE.md D6): each phase appends
-- its tables below; the file is renumbered to the next free journal idx on
-- the day the feature branch merges to main. Flag seeded OFF for every tenant.

-- ── Phase 0: flag ───────────────────────────────────────────────────────
INSERT INTO tenant_feature_flags (tenant_id, flag_key, enabled)
SELECT t.id, 'TAX_ESTIMATOR_V1', FALSE FROM tenants t
ON CONFLICT DO NOTHING;
