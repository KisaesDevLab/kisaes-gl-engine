-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
-- migration-policy: non-additive-exception (DROP NOT NULL only relaxes file_path: a posted
-- import may now discard its stored upload, U-251; every existing row keeps its value).
--
-- U-251 (ClientLedger P30): POST /payroll-import/sessions/:id/post with discardEmployeeDetail
-- deletes the session's employee rows and its stored upload in the posting transaction.
-- file_path becomes NULL then, and detail_discarded_at records when.
ALTER TABLE payroll_import_sessions ALTER COLUMN file_path DROP NOT NULL;
ALTER TABLE payroll_import_sessions ADD COLUMN IF NOT EXISTS detail_discarded_at timestamptz;