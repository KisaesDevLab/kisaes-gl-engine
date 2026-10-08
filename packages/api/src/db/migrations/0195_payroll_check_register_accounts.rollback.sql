-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.

ALTER TABLE payroll_check_register_rows DROP COLUMN IF EXISTS offset_account_code;
ALTER TABLE payroll_check_register_rows DROP COLUMN IF EXISTS cash_account_code;
