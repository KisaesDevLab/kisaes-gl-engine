-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
--
-- Rollback counterpart to 0062_recurring_template_tags.sql.
--
-- There's no "undo" for a tag lift-down because the header junction
-- remains authoritative and the lines-level write was additive. The
-- safe rollback is to null out tag_id on recurring-template lines that
-- still match exactly one header tag from transaction_tags — i.e.,
-- those we know we inserted. Lines whose tags diverge from the header
-- (user edits post-migration) are left alone.

UPDATE journal_lines jl
SET tag_id = NULL
FROM recurring_schedules rs
WHERE jl.transaction_id = rs.template_transaction_id
  AND jl.tag_id IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM transaction_tags tt
    WHERE tt.transaction_id = jl.transaction_id
      AND tt.tag_id = jl.tag_id
  );
