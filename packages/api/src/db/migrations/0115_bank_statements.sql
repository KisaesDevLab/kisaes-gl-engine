-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.

-- Statement-driven bank reconciliation: bank statements become first-class
-- records. A row is captured whenever a parsed statement is imported into
-- the bank feed (and backfilled from completed ocr_statement ai_jobs). The
-- statement seeds reconciliation.start (period_end -> statement date,
-- closing_balance -> ending balance), links to the reconciliation it
-- drove, and stamps every imported bank_feed_item so auto-clear can trace
-- statement rows to their posted journal lines. Additive only (rule 13).

CREATE TABLE IF NOT EXISTS bank_statements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid,
  account_id uuid NOT NULL REFERENCES accounts(id),
  attachment_id uuid REFERENCES attachments(id) ON DELETE SET NULL,
  ai_job_id uuid REFERENCES ai_jobs(id) ON DELETE SET NULL,
  period_start date,
  period_end date NOT NULL,
  opening_balance decimal(19,4),
  closing_balance decimal(19,4) NOT NULL,
  masked_account_number varchar(50),
  institution_name varchar(255),
  statement_type varchar(30),
  golden_rule_status varchar(20) DEFAULT 'unknown',
  golden_rule_delta decimal(19,4),
  reconciliation_id uuid REFERENCES reconciliations(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bank_statements_tenant_account
  ON bank_statements (tenant_id, account_id, period_end);
CREATE INDEX IF NOT EXISTS idx_bank_statements_ai_job
  ON bank_statements (ai_job_id);
CREATE INDEX IF NOT EXISTS idx_bank_statements_reconciliation
  ON bank_statements (reconciliation_id);

ALTER TABLE bank_feed_items
  ADD COLUMN IF NOT EXISTS statement_id uuid REFERENCES bank_statements(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_bfi_statement ON bank_feed_items (statement_id);
