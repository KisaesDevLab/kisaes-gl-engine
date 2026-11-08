-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for 0268 (U-170). The feed-accept code must be rolled back with
-- it. Nothing posted depends on the column.
-- LOST: which conditional rules allow "Accept all from this rule".
ALTER TABLE conditional_rules DROP COLUMN IF EXISTS auto_accept;
