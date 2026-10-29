-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for 0241 (transactions.is_check, U-117). The code that reads the
-- column must be rolled back with it. Lost: the check mark on checks voided
-- while waiting to print (all other checks keep their print status).

ALTER TABLE transactions DROP COLUMN IF EXISTS is_check;
