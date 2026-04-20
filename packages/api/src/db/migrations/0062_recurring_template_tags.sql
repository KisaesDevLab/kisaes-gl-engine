-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
--
-- ADR 0XX §7.2 — lift recurring-template header tags down to each
-- template's journal_lines. Migration 0059 already did this for every
-- transaction, so for a tenant that migrated straight to split-level
-- tags this is a no-op. But for tenants that added header tags on a
-- template via the legacy transaction_tags junction AFTER 0059 ran
-- (e.g., during the dual-write window before TAGS_SPLIT_LEVEL_V2
-- flipped on), the template lines may still be NULL. Running this
-- migration is safe and idempotent.

UPDATE journal_lines jl
SET tag_id = primary_tag.tag_id
FROM (
  SELECT DISTINCT ON (tt.transaction_id)
    tt.transaction_id,
    tt.tag_id
  FROM transaction_tags tt
  JOIN recurring_schedules rs ON rs.template_transaction_id = tt.transaction_id
  ORDER BY tt.transaction_id, tt.created_at ASC, tt.tag_id
) AS primary_tag
WHERE jl.transaction_id = primary_tag.transaction_id
  AND jl.tag_id IS NULL;
