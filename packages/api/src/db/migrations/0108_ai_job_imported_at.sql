-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.

-- Statement Imports history: mark when a parsed statement's transactions were
-- imported into the bank feed, so the "Statement Imports" list can separate
-- pending-review statements from already-imported ones and let a user resume an
-- overnight batch the next morning. Null = parsed but not yet imported.
-- Additive only (CLAUDE.md rule 13).
ALTER TABLE ai_jobs ADD COLUMN IF NOT EXISTS imported_at TIMESTAMPTZ;
