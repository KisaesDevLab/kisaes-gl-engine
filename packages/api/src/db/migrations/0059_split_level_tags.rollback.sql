-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
--
-- migration-policy: non-additive-exception
-- Reason: this is the ROLLBACK file for 0059_split_level_tags.sql. By
-- definition a rollback reverses the forward migration, so DROP COLUMN /
-- DROP INDEX are required. The file is NOT registered in _journal.json
-- and is never auto-applied; it exists as a manual-recovery script for
-- operators backing out the split-level tags rollout. Tag data on
-- journal_lines is lost on apply; transaction_tags remains authoritative.

DROP INDEX IF EXISTS idx_journal_lines_tenant_tag;
DROP INDEX IF EXISTS idx_journal_lines_tag_id;

ALTER TABLE journal_lines
  DROP CONSTRAINT IF EXISTS fk_journal_lines_tag_id;

ALTER TABLE journal_lines
  DROP COLUMN IF EXISTS tag_id;
