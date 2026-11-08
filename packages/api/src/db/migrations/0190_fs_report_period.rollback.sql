-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Reports fall back to fiscal-year-to-date.

ALTER TABLE fs_reports DROP COLUMN IF EXISTS period_start;
ALTER TABLE fs_reports DROP COLUMN IF EXISTS period_type;
