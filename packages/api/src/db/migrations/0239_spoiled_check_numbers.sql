-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Spoiled check numbers (U-106; capability check-reprint-audit-v1).
--
-- When a numbered check goes back to the print queue (POST /checks/requeue,
-- POST /checks/reprint/:batchId, PUT /checks/:id sending it back to the
-- queue), the engine clears the check's number and records the old one here,
-- per bank account, so a register can show the spoiled paper check
-- (GET /checks/spoiled). A spoiled number may be used again: nothing here
-- blocks numbering. A number spoiled more than once has one row each time.
--
-- The company, bank account, check and user are soft references (no FK), so a
-- deleted check keeps its spoiled numbers.
--
-- Additive only: one new table and its indexes.
-- Rollback: 0239_spoiled_check_numbers.rollback.sql.

CREATE TABLE IF NOT EXISTS spoiled_check_numbers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid,
  bank_account_id uuid NOT NULL,
  check_number integer NOT NULL,
  transaction_id uuid NOT NULL,
  reason varchar(20) NOT NULL,
  spoiled_by uuid,
  spoiled_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_spoiled_check_numbers_bank
  ON spoiled_check_numbers (tenant_id, bank_account_id, check_number);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_spoiled_check_numbers_txn
  ON spoiled_check_numbers (transaction_id);
