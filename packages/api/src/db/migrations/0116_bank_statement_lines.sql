-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.

-- Statement Match Engine (wave 1): persist each parsed bank-statement
-- transaction as a first-class line so the match engine can score it against
-- reconciliation worksheet journal lines and record the outcome
-- (auto-cleared / suggested / confirmed / rejected). Populated at statement
-- capture time from the ocr_statement parse result, and backfilled for
-- already-captured statements. Additive only (rule 13).
--
-- amount is SIGNED in normalized statement orientation: money INTO the GL
-- account (deposit / card payment) = positive, money OUT (spend / charge) =
-- negative — i.e. it equals journal_lines.debit - journal_lines.credit of the
-- matching line on the reconciliation account.

CREATE TABLE IF NOT EXISTS bank_statement_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  statement_id uuid NOT NULL REFERENCES bank_statements(id) ON DELETE CASCADE,
  line_date date NOT NULL,
  description text,
  amount decimal(19,4) NOT NULL,
  check_number varchar(40),
  payee varchar(255),
  running_balance decimal(19,4),
  match_status varchar(20) NOT NULL DEFAULT 'unmatched',
  matched_journal_line_id uuid REFERENCES journal_lines(id) ON DELETE SET NULL,
  match_score decimal(6,4),
  score_breakdown jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bsl_tenant_statement
  ON bank_statement_lines (tenant_id, statement_id);
CREATE INDEX IF NOT EXISTS idx_bsl_tenant_matched_jl
  ON bank_statement_lines (tenant_id, matched_journal_line_id);
