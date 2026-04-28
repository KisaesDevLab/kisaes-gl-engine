-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
--
-- Rollback for 0084: drop the seeded receipt-amount-mismatch
-- registry row and any findings/overrides/suppressions tied to it.
DELETE FROM findings WHERE check_key = 'receipt_amount_mismatch';
DELETE FROM check_suppressions WHERE check_key = 'receipt_amount_mismatch';
DELETE FROM check_params_overrides WHERE check_key = 'receipt_amount_mismatch';
DELETE FROM check_registry WHERE check_key = 'receipt_amount_mismatch';
