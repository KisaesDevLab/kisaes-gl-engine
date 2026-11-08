-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Per-line tags on Journal Entry and Daily Sales templates. A line's
-- tag is stamped on the posted journal line; NULL falls back to the
-- entry/template default tag (existing behavior). Additive.

ALTER TABLE je_template_lines ADD COLUMN IF NOT EXISTS tag_id UUID;
ALTER TABLE daily_sales_template_lines ADD COLUMN IF NOT EXISTS tag_id UUID;
