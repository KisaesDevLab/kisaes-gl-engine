-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
--
-- VIBE_MYBOOKS_PRACTICE_BUILD_PLAN Phase 15.8 — corrections workflow.
-- Adds a JSONB snapshot of the per-vendor amounts that went into each
-- 1099 filing so a later correction can reference the exact figures
-- that were filed (rather than re-deriving from a ledger that may have
-- moved). Additive — pre-0077 filings keep details_json NULL and the
-- correction UI surfaces them as "details unavailable, enter manually".

ALTER TABLE annual_1099_filings ADD COLUMN IF NOT EXISTS details_json JSONB;
