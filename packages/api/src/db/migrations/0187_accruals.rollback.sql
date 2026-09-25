-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Drops accrual schedules and their entry records. Journal entries already
-- posted from them stay in the books as ordinary journal entries.

DROP TABLE IF EXISTS accrual_entries;
DROP TABLE IF EXISTS accrual_schedules;
DELETE FROM tenant_feature_flags WHERE flag_key = 'ACCRUALS_V1';
