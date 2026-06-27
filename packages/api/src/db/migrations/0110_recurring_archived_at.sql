-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.

-- Archive state for recurring schedules: a paused (is_active=false) plan can be
-- archived to hide it from the active list without deleting its history.
-- Null = not archived. Additive only (CLAUDE.md rule 13).
ALTER TABLE recurring_schedules ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
