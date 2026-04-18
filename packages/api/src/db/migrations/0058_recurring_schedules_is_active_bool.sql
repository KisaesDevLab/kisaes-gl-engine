-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
--
-- migration-policy: non-additive-exception
-- Reason: recurring_schedules.is_active was inadvertently declared as
-- varchar(5) with string values 'true' / 'false' instead of the proper
-- boolean column pattern used by every other is_active column in the
-- schema. This migration converts it to boolean in place. Safe because:
--   1. The only writers set the literal strings 'true' / 'false', so the
--      cast is lossless.
--   2. The rewrite is atomic inside this migration's implicit transaction.

ALTER TABLE recurring_schedules
  ALTER COLUMN is_active DROP DEFAULT,
  ALTER COLUMN is_active TYPE boolean USING (
    CASE
      WHEN is_active ILIKE 'true' THEN true
      WHEN is_active ILIKE 'false' THEN false
      ELSE true
    END
  ),
  ALTER COLUMN is_active SET DEFAULT true;
