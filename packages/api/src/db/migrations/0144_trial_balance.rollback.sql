-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback companion for 0144_trial_balance.sql. Never executed by
-- drizzle — manual escape hatch only.

DROP TRIGGER IF EXISTS trg_tb_stamp_txn_upd ON transactions;
DROP TRIGGER IF EXISTS trg_tb_stamp_lines_ins ON journal_lines;
DROP TRIGGER IF EXISTS trg_tb_stamp_lines_upd ON journal_lines;
DROP TRIGGER IF EXISTS trg_tb_stamp_lines_del ON journal_lines;
DROP FUNCTION IF EXISTS tb_bump_gl_stamp_txn();
DROP FUNCTION IF EXISTS tb_bump_gl_stamp_lines();

DELETE FROM tenant_feature_flags WHERE flag_key = 'TRIAL_BALANCE_V1';

ALTER TABLE transactions DROP COLUMN IF EXISTS aje_number;
ALTER TABLE companies DROP COLUMN IF EXISTS lock_date_set_at;
ALTER TABLE companies DROP COLUMN IF EXISTS lock_date_set_by;

DROP TABLE IF EXISTS gl_version_stamps;
DROP TABLE IF EXISTS tb_aje_sequences;
DROP TABLE IF EXISTS tb_status;
DROP TABLE IF EXISTS tb_tax_entry_lines;
DROP TABLE IF EXISTS tb_tax_entries;
DROP TABLE IF EXISTS tb_leadsheet_signoffs;
DROP TABLE IF EXISTS tb_notes;
DROP TABLE IF EXISTS tb_tickmark_applications;
DROP TABLE IF EXISTS tb_tickmarks;
DROP TABLE IF EXISTS tb_grouping_accounts;
DROP TABLE IF EXISTS tb_groupings;
DROP TABLE IF EXISTS account_tax_assignments;
DROP TABLE IF EXISTS tag_activity_map;
DROP TABLE IF EXISTS activity_units;
DROP TABLE IF EXISTS company_tax_profiles;
DROP TABLE IF EXISTS firm_tax_codes;
DROP TABLE IF EXISTS tax_codes;
DROP TABLE IF EXISTS tax_code_seed_versions;
