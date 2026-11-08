-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Rollback for 0267 (U-170). The feed-accept code must be rolled back with
-- it. Nothing posted depends on the column.
-- LOST: which conditional rules allow "Accept all from this rule".
ALTER TABLE conditional_rules DROP COLUMN IF EXISTS auto_accept;
