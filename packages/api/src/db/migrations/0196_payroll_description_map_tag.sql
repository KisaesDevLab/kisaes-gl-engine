-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Pre-built JE payroll imports: a tag per source description, saved with
-- its account mapping (e.g. "Wages and Salary - Bentonville" -> the
-- Bentonville tag) and stamped on every line with that description.
-- NULL = untagged. Additive.

ALTER TABLE payroll_description_account_map ADD COLUMN IF NOT EXISTS tag_id UUID;
