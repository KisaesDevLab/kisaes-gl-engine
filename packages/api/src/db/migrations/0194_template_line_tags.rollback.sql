-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.

ALTER TABLE je_template_lines DROP COLUMN IF EXISTS tag_id;
ALTER TABLE daily_sales_template_lines DROP COLUMN IF EXISTS tag_id;
