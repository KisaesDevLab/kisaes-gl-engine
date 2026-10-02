-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.

ALTER TABLE je_template_lines DROP COLUMN IF EXISTS tag_id;
ALTER TABLE daily_sales_template_lines DROP COLUMN IF EXISTS tag_id;
