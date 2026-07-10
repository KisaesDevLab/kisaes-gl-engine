-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.

-- Marks journal lines inserted as the reversing half of a void
-- (CLAUDE.md rule 23). Lets document views / invoice PDFs exclude the
-- reversal rows exactly instead of matching on a description prefix.
-- Additive only (rule 13).
ALTER TABLE journal_lines ADD COLUMN IF NOT EXISTS is_void_reversal boolean NOT NULL DEFAULT false;
