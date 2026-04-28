-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
--
-- RECURRING_CRON_V1 — adds cron-style cadence to
-- recurring_document_requests so a firm can set up "every other
-- Tuesday" or "first Monday of month" without the simple
-- frequency+dayOfMonth model.
--
-- Three new columns + a CHECK constraint that ensures cron mode
-- carries an expression. cadence_kind defaults to 'frequency' so
-- existing rows are untouched and the existing computeNextIssueAt
-- branch keeps firing for them.

ALTER TABLE recurring_document_requests
  ADD COLUMN cadence_kind VARCHAR(20) NOT NULL DEFAULT 'frequency'
    CHECK (cadence_kind IN ('frequency', 'cron')),
  ADD COLUMN cron_expression VARCHAR(120),
  ADD COLUMN cron_timezone VARCHAR(64),
  ADD CONSTRAINT chk_cadence_kind_cron_expr
    CHECK (cadence_kind <> 'cron' OR cron_expression IS NOT NULL);

INSERT INTO tenant_feature_flags (tenant_id, flag_key, enabled)
SELECT t.id, 'RECURRING_CRON_V1', FALSE
FROM tenants t
ON CONFLICT DO NOTHING;
