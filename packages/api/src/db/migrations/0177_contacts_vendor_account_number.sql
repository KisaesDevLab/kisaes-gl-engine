-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- The account number a VENDOR has assigned to us (utility account, customer
-- number on their statements). Printed on the memo line of checks written to
-- that vendor so they can apply the payment.
--
-- Text, not numeric: real ones carry dashes, spaces, letters and leading
-- zeros ("00-4471-A"). Not to be confused with accounts.account_number (our
-- chart of accounts) or the bank account number in check settings.

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS vendor_account_number varchar(50);
