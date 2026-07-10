-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.

-- Optional friendly name for a recurring schedule (e.g. "Monthly rent").
ALTER TABLE recurring_schedules
  ADD COLUMN IF NOT EXISTS name varchar(255);
