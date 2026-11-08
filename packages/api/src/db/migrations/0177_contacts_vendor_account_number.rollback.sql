-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Drops the vendor-assigned account number. Checks already written keep
-- whatever memo they were given: the number is copied into
-- transactions.printed_memo when the check is created, never read at print.

ALTER TABLE contacts DROP COLUMN IF EXISTS vendor_account_number;
