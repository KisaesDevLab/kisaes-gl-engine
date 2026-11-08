-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Rollback for 0239 (spoiled check numbers; U-106). The code that reads and
-- writes the table must be rolled back with it. Lost: the list of check
-- numbers spoiled by a reprint (the audit rows of each requeue / reprint
-- stay). Checks are untouched.

DROP TABLE IF EXISTS spoiled_check_numbers;
