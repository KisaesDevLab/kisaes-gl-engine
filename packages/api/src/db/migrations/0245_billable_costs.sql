-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Billable costs (U-128 billable-costs-v1).
--
-- billable_cost_links: one row per cost line (journal_lines with
-- is_billable) billed on an invoice. The source line id is kept stable
-- across source edits (ledger.updateTransaction re-inserts a billed line
-- with its old id), so the link never dangles. A link is active while
-- released_at IS NULL; the partial unique index allows one active link per
-- cost line, so a cost is billed at most once. Soft references (no FK):
-- journal lines are deleted and re-inserted on every edit, as
-- reconciliation_lines.journal_line_id.
--
-- cost_amount is round2(source cost); markup_amount round2(cost x
-- markup_percent / 100), half away from zero (0 on a negative cost, Q-P20z);
-- markup_account_id is the account the markup posted to, kept on every edit.
--
-- journal_lines.billable_source_line_id: on an invoice's cost line
-- (line_role 'billable_cost') and markup line (line_role 'billable_markup'),
-- the cost line it bills. contacts.default_markup_percent: the client's
-- suggested markup (a percent, 10 = 10 %). companies.billable_markup_account_id:
-- the income account markups post to.
--
-- Additive only; no backfill ('billed' was reserved and never written,
-- U-50). Ordering: after 0244. Rollback: 0245_billable_costs.rollback.sql.

CREATE TABLE IF NOT EXISTS billable_cost_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid,
  source_transaction_id uuid NOT NULL,
  source_line_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  cost_amount numeric(19,4) NOT NULL,
  markup_percent numeric(9,4) NOT NULL DEFAULT 0,
  markup_amount numeric(19,4) NOT NULL DEFAULT 0,
  markup_account_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  released_at timestamptz,
  released_by uuid,
  release_reason varchar(20),
  CONSTRAINT billable_cost_links_release_chk CHECK (
    (released_at IS NULL AND release_reason IS NULL)
    OR (released_at IS NOT NULL AND release_reason IN ('removed', 'invoice_void', 'invoice_delete'))
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_bcl_active_source
  ON billable_cost_links (tenant_id, source_line_id) WHERE released_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_bcl_invoice
  ON billable_cost_links (tenant_id, invoice_id) WHERE released_at IS NULL;
--> statement-breakpoint
ALTER TABLE "journal_lines" ADD COLUMN IF NOT EXISTS "billable_source_line_id" uuid;
--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "default_markup_percent" numeric(9,4);
--> statement-breakpoint
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contacts_default_markup_percent_chk') THEN
    ALTER TABLE "contacts" ADD CONSTRAINT "contacts_default_markup_percent_chk"
      CHECK ("default_markup_percent" IS NULL OR ("default_markup_percent" >= 0 AND "default_markup_percent" <= 1000));
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "billable_markup_account_id" uuid;
