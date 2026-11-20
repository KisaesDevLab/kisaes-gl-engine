-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Rollback for 0288 (U-293). LOST: a maintenance hold in progress (the engine
-- without 0288 has no maintenance mode).
DROP TABLE IF EXISTS desktop_maintenance;