-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Rollback for 0271 (percentage splits total exactly 100): a no-op for the
-- data. The old totals (99.99, 100.01, ...) were refused at posting and on
-- rule save before this migration ran, so putting them back would only
-- restore a rule that cannot post; the audit_log rows the migration wrote
-- (entity_type conditional_rule / bank_feed_item, reason
-- percent_splits_normalize) hold every previous value for anyone who needs
-- it. The functions are dropped; the older code does not call them.
DROP FUNCTION IF EXISTS percent_splits_normalize_tenant(uuid);
--> statement-breakpoint
DROP FUNCTION IF EXISTS percent_split_actions(jsonb);
--> statement-breakpoint
DROP FUNCTION IF EXISTS percent_splits_normalize(jsonb);
--> statement-breakpoint
DROP FUNCTION IF EXISTS percent_split_action_normalize(jsonb);
--> statement-breakpoint
DROP FUNCTION IF EXISTS percent_split_total(jsonb);
