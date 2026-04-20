-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
--
-- ADR 0XX + repo-alignment addendum §B: move tag scoping from the
-- transaction header (transaction_tags junction) to individual journal
-- lines. Additive: adds tag_id + supporting indexes on journal_lines,
-- then backfills from transaction_tags. The transaction_tags junction
-- itself remains in place during the dual-write window and is dropped
-- in a later migration per the ADR 0XX §4 cutover state machine.

ALTER TABLE journal_lines
  ADD COLUMN tag_id uuid;

ALTER TABLE journal_lines
  ADD CONSTRAINT fk_journal_lines_tag_id
  FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE RESTRICT;

-- Partial index: the vast majority of historical lines will have no tag,
-- so indexing only the tagged subset keeps the index small and lookups
-- fast. Re-evaluate if tag coverage climbs above ~50% after rollout.
CREATE INDEX IF NOT EXISTS idx_journal_lines_tag_id
  ON journal_lines(tag_id)
  WHERE tag_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_journal_lines_tenant_tag
  ON journal_lines(tenant_id, tag_id)
  WHERE tag_id IS NOT NULL;

-- Backfill: for every transaction with one or more header tags, stamp
-- the earliest-assigned tag onto every journal_line of that transaction
-- whose tag_id is still NULL. Idempotent: the IS NULL guard prevents
-- overwriting anything a subsequent write has stored. Transactions with
-- multiple header tags retain every tag in transaction_tags (unchanged),
-- but the line-level column carries only the primary tag for V1. A
-- follow-up reconciliation pass can resolve multi-tag transactions once
-- the multi-tag-per-line design is written.
UPDATE journal_lines jl
SET tag_id = primary_tag.tag_id
FROM (
  SELECT DISTINCT ON (tt.transaction_id)
    tt.transaction_id,
    tt.tag_id
  FROM transaction_tags tt
  ORDER BY tt.transaction_id, tt.created_at ASC, tt.tag_id
) AS primary_tag
WHERE jl.transaction_id = primary_tag.transaction_id
  AND jl.tag_id IS NULL;
