-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for 0203. Note: after rollback the code that reads this table
-- must also be rolled back (the notifier would otherwise fail and send nothing).
DROP TABLE IF EXISTS suggestion_notify_settings;
