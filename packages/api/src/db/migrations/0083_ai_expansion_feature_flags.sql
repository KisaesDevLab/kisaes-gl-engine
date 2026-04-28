-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
--
-- AI expansion in Close Review (vendor enrichment v1, vendor
-- enrichment v2, AI judgment checks). Each capability ships behind a
-- distinct feature flag so admins can stage the rollout per tenant.
-- All three flags backfill DISABLED for existing tenants — opt-in is
-- explicit. New tenants get explicit disabled rows via
-- feature-flags.service.seedDefaultsForNewTenant() on registration.
--
-- Additive only: adds rows to tenant_feature_flags. No schema change.

INSERT INTO tenant_feature_flags (tenant_id, flag_key, enabled)
SELECT t.id, f.flag_key, FALSE
FROM tenants t
CROSS JOIN (VALUES
  ('AI_VENDOR_ENRICHMENT_V1'),
  ('AI_VENDOR_ENRICHMENT_V2'),
  ('AI_JUDGMENT_CHECKS_V1')
) AS f(flag_key)
ON CONFLICT DO NOTHING;
