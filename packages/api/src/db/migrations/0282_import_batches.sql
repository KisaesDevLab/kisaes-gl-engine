-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- U-261, U-263 (ClientLedger P31 E1): Bulk Import batches. A batch groups
-- upload sessions and commits them in ONE database transaction; it records
-- what it created (import_batch_id on the created rows) and the prior values
-- of what it changed, so an undo can remove all of it. Additive only: new
-- tables, nullable or defaulted columns, partial indexes. Legacy sessions keep
-- NULL row_hash and active_commit false, so the unique index never clashes
-- with history (no backfill).

CREATE TABLE IF NOT EXISTS import_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  source_system varchar(30) NOT NULL,
  kind varchar(20) NOT NULL DEFAULT 'single',
  status varchar(20) NOT NULL DEFAULT 'draft',
  options jsonb,
  prior_values jsonb,
  tieout jsonb,
  spot_check jsonb,
  result jsonb,
  error jsonb,
  backup_ref varchar(500),
  company_was_empty boolean,
  conversion_date date,
  history_from date,
  verified_at timestamptz,
  verified_by uuid,
  created_by uuid,
  committed_by uuid,
  committed_at timestamptz,
  undone_by uuid,
  undone_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT import_batches_kind_chk CHECK (kind IN ('conversion', 'single', 'transactions')),
  CONSTRAINT import_batches_status_chk CHECK (status IN ('draft', 'committing', 'committed', 'failed', 'undoing', 'undone'))
);
CREATE INDEX IF NOT EXISTS idx_imp_batches_company ON import_batches (tenant_id, company_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_imp_batches_running ON import_batches (status) WHERE status IN ('committing', 'undoing');

ALTER TABLE import_sessions ADD COLUMN IF NOT EXISTS batch_id uuid;
ALTER TABLE import_sessions ADD COLUMN IF NOT EXISTS role varchar(10) NOT NULL DEFAULT 'post';
ALTER TABLE import_sessions ADD COLUMN IF NOT EXISTS row_hash varchar(64);
ALTER TABLE import_sessions ADD COLUMN IF NOT EXISTS active_commit boolean NOT NULL DEFAULT false;
ALTER TABLE import_sessions ADD COLUMN IF NOT EXISTS date_from date;
ALTER TABLE import_sessions ADD COLUMN IF NOT EXISTS date_to date;
CREATE INDEX IF NOT EXISTS idx_imp_sess_batch ON import_sessions (batch_id) WHERE batch_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_imp_sess_row_hash_active ON import_sessions (company_id, row_hash) WHERE active_commit;

-- Parsed rows, one per canonical row, instead of one large jsonb on the
-- session (review S8). Deleted at verify and at undo; the session row stays.
CREATE TABLE IF NOT EXISTS import_rows (
  session_id uuid NOT NULL,
  row_no integer NOT NULL,
  data jsonb NOT NULL,
  PRIMARY KEY (session_id, row_no)
);

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS import_batch_id uuid;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS import_batch_id uuid;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS import_batch_id uuid;
ALTER TABLE items ADD COLUMN IF NOT EXISTS import_batch_id uuid;
ALTER TABLE tags ADD COLUMN IF NOT EXISTS import_batch_id uuid;
ALTER TABLE tag_groups ADD COLUMN IF NOT EXISTS import_batch_id uuid;
CREATE INDEX IF NOT EXISTS idx_transactions_import_batch ON transactions (import_batch_id) WHERE import_batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_accounts_import_batch ON accounts (import_batch_id) WHERE import_batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_import_batch ON contacts (import_batch_id) WHERE import_batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_items_import_batch ON items (import_batch_id) WHERE import_batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tags_import_batch ON tags (import_batch_id) WHERE import_batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tag_groups_import_batch ON tag_groups (import_batch_id) WHERE import_batch_id IS NOT NULL;
