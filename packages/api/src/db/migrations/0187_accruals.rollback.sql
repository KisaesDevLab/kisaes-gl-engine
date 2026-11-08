-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Drops accrual schedules and their entry records. Journal entries already
-- posted from them stay in the books as ordinary journal entries.

DROP TABLE IF EXISTS accrual_entries;
DROP TABLE IF EXISTS accrual_schedules;
DELETE FROM tenant_feature_flags WHERE flag_key = 'ACCRUALS_V1';
