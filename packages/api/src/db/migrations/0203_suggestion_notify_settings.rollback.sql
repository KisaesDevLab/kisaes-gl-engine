-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Rollback for 0203. Note: after rollback the code that reads this table
-- must also be rolled back (the notifier would otherwise fail and send nothing).
DROP TABLE IF EXISTS suggestion_notify_settings;
