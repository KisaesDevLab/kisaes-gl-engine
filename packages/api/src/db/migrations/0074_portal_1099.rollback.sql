-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.

DROP TABLE IF EXISTS annual_1099_filings;
DROP TABLE IF EXISTS w9_requests;
DROP TABLE IF EXISTS vendor_1099_profile;
ALTER TABLE contacts DROP COLUMN IF EXISTS exempt_payee_code;
ALTER TABLE contacts DROP COLUMN IF EXISTS form_1099_type;
