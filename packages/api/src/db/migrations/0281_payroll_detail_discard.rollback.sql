-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Rollback for 0281 (U-251). A session whose upload was discarded keeps an empty
-- file_path (the file is gone either way) so NOT NULL can be restored.
UPDATE payroll_import_sessions SET file_path = '' WHERE file_path IS NULL;
ALTER TABLE payroll_import_sessions ALTER COLUMN file_path SET NOT NULL;
ALTER TABLE payroll_import_sessions DROP COLUMN IF EXISTS detail_discarded_at;