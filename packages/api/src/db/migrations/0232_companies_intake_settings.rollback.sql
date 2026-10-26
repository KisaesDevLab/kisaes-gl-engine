-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for 0232 (company intake settings, U-93): drops the column and
-- with it every company's intake folder list. Clients without
-- intake-settings-v1 fall back to their local settings.
ALTER TABLE companies DROP COLUMN IF EXISTS intake_settings;
