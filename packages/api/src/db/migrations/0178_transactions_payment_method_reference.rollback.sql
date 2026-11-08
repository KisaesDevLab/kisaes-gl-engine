-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Drops the stored payment method and reference number. Check numbers and
-- print status live in their own columns and are unaffected.

ALTER TABLE transactions DROP COLUMN IF EXISTS reference_number;
ALTER TABLE transactions DROP COLUMN IF EXISTS payment_method;
