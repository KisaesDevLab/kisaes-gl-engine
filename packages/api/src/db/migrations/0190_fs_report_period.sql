-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Financial statements: reporting periods (annual / quarter / month / YTD /
-- custom range). NULL on existing reports = fiscal-year-to-date through
-- period_end (normalized at read). Additive.

ALTER TABLE fs_reports ADD COLUMN IF NOT EXISTS period_type VARCHAR(10);
ALTER TABLE fs_reports ADD COLUMN IF NOT EXISTS period_start DATE;
