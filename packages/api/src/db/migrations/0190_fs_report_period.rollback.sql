-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Reports fall back to fiscal-year-to-date.

ALTER TABLE fs_reports DROP COLUMN IF EXISTS period_start;
ALTER TABLE fs_reports DROP COLUMN IF EXISTS period_type;
