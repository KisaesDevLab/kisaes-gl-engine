-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Pay Sales Tax (U-150; sales-tax-pay-v1, idempotency-sales-tax-pay-v1).
-- sales_tax_payments: one row per Pay Sales Tax transaction (txn_type
-- 'sales_tax_payment'): the agency, the date it pays through and the method
-- (check | electronic). Its paid and adjustment lines live in
-- sales_tax_payment_lines (0252); a payment made outside Pay Sales Tax (a
-- check or journal entry debiting Sales Tax Payable) is linked by paid lines
-- on that transaction, with no row here. sales_tax_mark_paid_runs: one row per
-- "mark paid through" (opening lines of an agency, no GL) with the 201 body
-- it answered; sales_tax_payment_lines.run_id ties its opening lines to it so
-- the run can be undone (its lines deleted, undone_at set).
--
-- Additive. Ordering: after 0253 (sales tax liability).
-- Rollback: 0254_sales_tax_pay.rollback.sql (refused while any exist).

CREATE TABLE IF NOT EXISTS sales_tax_payments (
  transaction_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  agency_id uuid NOT NULL,
  through_date date NOT NULL,
  method varchar(12) NOT NULL CHECK (method IN ('check', 'electronic')),
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_st_payments_company ON sales_tax_payments (company_id, agency_id, through_date);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_st_payments_tenant ON sales_tax_payments (tenant_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS sales_tax_mark_paid_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  agency_id uuid NOT NULL,
  through_date date NOT NULL,
  reason varchar(255) NOT NULL,
  total numeric(19,4) NOT NULL,
  lines jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  undone_by uuid,
  undone_at timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_st_mark_paid_runs_company ON sales_tax_mark_paid_runs (company_id, agency_id, through_date);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_st_mark_paid_runs_tenant ON sales_tax_mark_paid_runs (tenant_id);
--> statement-breakpoint
ALTER TABLE sales_tax_payment_lines ADD COLUMN IF NOT EXISTS run_id uuid;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_st_payment_lines_run ON sales_tax_payment_lines (run_id) WHERE run_id IS NOT NULL;
