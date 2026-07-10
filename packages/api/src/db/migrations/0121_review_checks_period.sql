-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.

-- Period-scope the Close Review / review-checks subsystem. Until now a
-- check run scanned all-time data and its findings carried no period, so
-- the Findings tab could not be filtered to the month the bookkeeper is
-- closing (the Buckets / Manual Queue tabs already scope by period).
--
-- We add nullable period bounds to both the run row and each finding:
--   - check_runs.period_start / period_end record the window a run targeted.
--   - findings.period_start / period_end are stamped from the run so the
--     Findings list can filter to a selected month.
-- Both are nullable: a null period means "all-time" (backward compatible
-- with the nightly scheduler and any pre-migration rows). Bounds follow
-- ClosePeriodSelector semantics — period_start inclusive, period_end
-- exclusive (first day of the next month). Additive only.

ALTER TABLE check_runs ADD COLUMN IF NOT EXISTS period_start date;
ALTER TABLE check_runs ADD COLUMN IF NOT EXISTS period_end date;

ALTER TABLE findings ADD COLUMN IF NOT EXISTS period_start date;
ALTER TABLE findings ADD COLUMN IF NOT EXISTS period_end date;

-- Findings are filtered by period_start when the Findings list is scoped
-- to a month; index it alongside the tenant so that filter stays cheap.
CREATE INDEX IF NOT EXISTS idx_findings_tenant_period
  ON findings (tenant_id, period_start);
