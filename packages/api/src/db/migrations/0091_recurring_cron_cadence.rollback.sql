-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.

ALTER TABLE recurring_document_requests
  DROP CONSTRAINT IF EXISTS chk_cadence_kind_cron_expr,
  DROP COLUMN IF EXISTS cron_timezone,
  DROP COLUMN IF EXISTS cron_expression,
  DROP COLUMN IF EXISTS cadence_kind;

DELETE FROM tenant_feature_flags WHERE flag_key = 'RECURRING_CRON_V1';
