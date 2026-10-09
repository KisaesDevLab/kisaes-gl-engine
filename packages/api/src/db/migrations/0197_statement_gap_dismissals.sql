-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Bank Rec "no statement on file for YYYY-MM" warnings can be dismissed per
-- account + month (account opened mid-year, no activity, statement never
-- issued). Shared by the whole tenant; a new gap month still warns.
-- Additive.

CREATE TABLE IF NOT EXISTS statement_gap_dismissals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  month VARCHAR(7) NOT NULL,
  dismissed_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_statement_gap_dismissals
  ON statement_gap_dismissals (tenant_id, account_id, month);
