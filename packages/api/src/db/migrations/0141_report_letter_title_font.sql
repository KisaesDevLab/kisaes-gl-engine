-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Make the CPA report letter's printed heading and font editable.
--
-- `title`       — the heading (<h1>) printed above the letter body. NULL (or
--                 blank) falls back to the standard SSARS title for the
--                 letter's type (REPORT_LETTER_TITLES), preserving today's
--                 behavior; a non-blank value overrides it so the super-admin
--                 can set any printed title.
-- `font_family` — a font-stack KEY (see LETTER_FONT_OPTIONS) applied to the
--                 whole rendered letter. NULL = the default stack, unchanged
--                 from before this migration.

ALTER TABLE report_letters
  ADD COLUMN IF NOT EXISTS title TEXT,
  ADD COLUMN IF NOT EXISTS font_family VARCHAR(40);
