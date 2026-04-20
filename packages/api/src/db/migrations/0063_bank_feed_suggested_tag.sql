-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
--
-- ADR 0XX §7.3 / ADR 0XY §3.4 — persist the AI-suggested per-line tag
-- on the bank feed item so the UI can pre-fill it in the categorize
-- drawer without having to re-run the LLM on every render.

ALTER TABLE bank_feed_items
  ADD COLUMN suggested_tag_id uuid;

ALTER TABLE bank_feed_items
  ADD CONSTRAINT fk_bank_feed_items_suggested_tag_id
  FOREIGN KEY (suggested_tag_id) REFERENCES tags(id) ON DELETE SET NULL;

-- Partial index so the column costs ~nothing until AI actively suggests
-- tags on a tenant's feed. Sparse by construction (most rows are NULL).
CREATE INDEX IF NOT EXISTS idx_bank_feed_items_suggested_tag_id
  ON bank_feed_items(suggested_tag_id)
  WHERE suggested_tag_id IS NOT NULL;
