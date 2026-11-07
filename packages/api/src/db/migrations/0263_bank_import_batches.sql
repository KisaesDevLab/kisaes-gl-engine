-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Bank file import batches (U-06, bank-import-batch-v1). A client parses a
-- bank file (OFX, QFX, QIF, CSV) and sends one account section as a batch;
-- the engine computes each row's keys and status and, on commit, inserts the
-- new rows into the bank feed and records the batch.
--
--   bank_import_batches         one row per committed batch, also when it
--                               inserted nothing: the file, section, sign
--                               choice, CSV mapping, counts, the file's
--                               ending balance, the response (`result`, for
--                               an Idempotency-Key replay), post-processing
--                               state and undo.
--   bank_feed_items             import_batch_id, dedupe_key (the FITID key
--                               when the bank id was trusted, else the row
--                               key), row_key (every imported row),
--                               dedupe_version, source_line, possible_duplicate
--                               and possible_duplicate_of. A dedupe key is
--                               unique per bank connection, so a re-import
--                               adds nothing by construction.
--   bank_connection_identities  which bank connection a file's account
--                               identity (a keyed hash computed by the
--                               client, never the account number) belongs
--                               to, with the masked number for display.
--
-- Additive only: two new tables, nullable columns, new indexes.
CREATE TABLE IF NOT EXISTS bank_import_batches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
  bank_connection_id UUID NOT NULL REFERENCES bank_connections(id) ON DELETE CASCADE,
  account_id UUID NOT NULL,
  format VARCHAR(8) NOT NULL CHECK (format IN ('ofx', 'qfx', 'qif', 'csv')),
  file_name VARCHAR(255) NOT NULL,
  source_file_sha256 CHAR(64) NOT NULL,
  section_index INTEGER NOT NULL DEFAULT 0,
  section_start DATE,
  section_end DATE,
  amounts_flipped BOOLEAN NOT NULL DEFAULT false,
  csv_mapping JSONB,
  rows_in_file INTEGER NOT NULL DEFAULT 0,
  new_count INTEGER NOT NULL DEFAULT 0,
  duplicate_count INTEGER NOT NULL DEFAULT 0,
  possible_duplicate_count INTEGER NOT NULL DEFAULT 0,
  changed_count INTEGER NOT NULL DEFAULT 0,
  closed_period_count INTEGER NOT NULL DEFAULT 0,
  inserted_count INTEGER NOT NULL DEFAULT 0,
  inserted_total NUMERIC NOT NULL DEFAULT 0,
  file_ending_balance NUMERIC(19,4),
  file_ending_date DATE,
  result JSONB,
  post_processing VARCHAR(12) NOT NULL DEFAULT 'scheduled'
    CHECK (post_processing IN ('scheduled', 'done', 'failed')),
  undone_at TIMESTAMPTZ,
  undone_by UUID,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_bank_import_batches_account
  ON bank_import_batches (tenant_id, account_id, format, created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_bank_import_batches_scheduled
  ON bank_import_batches (created_at) WHERE post_processing = 'scheduled';
--> statement-breakpoint
ALTER TABLE bank_feed_items ADD COLUMN IF NOT EXISTS import_batch_id UUID REFERENCES bank_import_batches(id) ON DELETE SET NULL;
--> statement-breakpoint
ALTER TABLE bank_feed_items ADD COLUMN IF NOT EXISTS dedupe_key CHAR(64);
--> statement-breakpoint
ALTER TABLE bank_feed_items ADD COLUMN IF NOT EXISTS row_key CHAR(64);
--> statement-breakpoint
ALTER TABLE bank_feed_items ADD COLUMN IF NOT EXISTS dedupe_version SMALLINT;
--> statement-breakpoint
ALTER TABLE bank_feed_items ADD COLUMN IF NOT EXISTS source_line INTEGER;
--> statement-breakpoint
-- Q-P25c (owner 2026-11-07): a fuzzy look-alike is imported, flagged, with
-- the existing item it resembles (a soft reference; undo clears it).
ALTER TABLE bank_feed_items ADD COLUMN IF NOT EXISTS possible_duplicate BOOLEAN NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE bank_feed_items ADD COLUMN IF NOT EXISTS possible_duplicate_of UUID;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_bfi_connection_dedupe_key
  ON bank_feed_items (bank_connection_id, dedupe_key) WHERE dedupe_key IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_bfi_connection_row_key
  ON bank_feed_items (bank_connection_id, row_key) WHERE row_key IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_bfi_import_batch
  ON bank_feed_items (import_batch_id) WHERE import_batch_id IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS bank_connection_identities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  bank_connection_id UUID NOT NULL REFERENCES bank_connections(id) ON DELETE CASCADE,
  mask VARCHAR(10) NOT NULL,
  account_key_hash CHAR(64) NOT NULL,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_bank_connection_identities_hash
  ON bank_connection_identities (tenant_id, account_key_hash);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_bank_connection_identities_connection
  ON bank_connection_identities (bank_connection_id);
