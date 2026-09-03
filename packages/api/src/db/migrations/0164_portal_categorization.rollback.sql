-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Drops the client suggestion queue. Suggestions never posted on their own,
-- so nothing here moves money: approved ones already became ordinary ledger
-- transactions and are untouched.

DROP TABLE IF EXISTS client_category_suggestions;
--> statement-breakpoint
ALTER TABLE portal_contact_companies DROP COLUMN IF EXISTS categorize_access;
--> statement-breakpoint
DELETE FROM tenant_feature_flags
 WHERE flag_key IN ('PORTAL_CATEGORIZE_V1', 'UNCATEGORIZED_REVIEW_V1');
