-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Per-line tags on Journal Entry and Daily Sales templates. A line's
-- tag is stamped on the posted journal line; NULL falls back to the
-- entry/template default tag (existing behavior). Additive.

ALTER TABLE je_template_lines ADD COLUMN IF NOT EXISTS tag_id UUID;
ALTER TABLE daily_sales_template_lines ADD COLUMN IF NOT EXISTS tag_id UUID;
