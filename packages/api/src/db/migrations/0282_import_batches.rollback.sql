-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Rollback for 0282 (U-261, U-263). Rows a batch created stay; they only lose
-- the pointer to the batch. Parsed rows kept in import_rows are dropped with
-- the table (a session that still needs them must be uploaded again).
DROP INDEX IF EXISTS idx_tag_groups_import_batch;
DROP INDEX IF EXISTS idx_tags_import_batch;
DROP INDEX IF EXISTS idx_items_import_batch;
DROP INDEX IF EXISTS idx_contacts_import_batch;
DROP INDEX IF EXISTS idx_accounts_import_batch;
DROP INDEX IF EXISTS idx_transactions_import_batch;
ALTER TABLE tag_groups DROP COLUMN IF EXISTS import_batch_id;
ALTER TABLE tags DROP COLUMN IF EXISTS import_batch_id;
ALTER TABLE items DROP COLUMN IF EXISTS import_batch_id;
ALTER TABLE contacts DROP COLUMN IF EXISTS import_batch_id;
ALTER TABLE accounts DROP COLUMN IF EXISTS import_batch_id;
ALTER TABLE transactions DROP COLUMN IF EXISTS import_batch_id;
DROP TABLE IF EXISTS import_rows;
DROP INDEX IF EXISTS idx_imp_sess_row_hash_active;
DROP INDEX IF EXISTS idx_imp_sess_batch;
ALTER TABLE import_sessions DROP COLUMN IF EXISTS date_to;
ALTER TABLE import_sessions DROP COLUMN IF EXISTS date_from;
ALTER TABLE import_sessions DROP COLUMN IF EXISTS active_commit;
ALTER TABLE import_sessions DROP COLUMN IF EXISTS row_hash;
ALTER TABLE import_sessions DROP COLUMN IF EXISTS role;
ALTER TABLE import_sessions DROP COLUMN IF EXISTS batch_id;
DROP INDEX IF EXISTS idx_imp_batches_running;
DROP INDEX IF EXISTS idx_imp_batches_company;
DROP TABLE IF EXISTS import_batches;
