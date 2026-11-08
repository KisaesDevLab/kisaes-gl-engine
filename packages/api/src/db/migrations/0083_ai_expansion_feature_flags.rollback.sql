-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Rollback for 0083: remove the three AI expansion flag rows.
DELETE FROM tenant_feature_flags
WHERE flag_key IN (
  'AI_VENDOR_ENRICHMENT_V1',
  'AI_VENDOR_ENRICHMENT_V2',
  'AI_JUDGMENT_CHECKS_V1'
);
