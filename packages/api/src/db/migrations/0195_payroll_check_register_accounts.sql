-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Standalone check-register payroll import: keep each check's cash and
-- offset account numbers from the file so a check can post to the
-- account the payroll provider assigned it. Additive.

ALTER TABLE payroll_check_register_rows ADD COLUMN IF NOT EXISTS cash_account_code VARCHAR(50);
ALTER TABLE payroll_check_register_rows ADD COLUMN IF NOT EXISTS offset_account_code VARCHAR(50);
