-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Finance charges (U-141; finance-charges-v1, idempotency-finance-charges-v1).
-- Number provisional: renumbered at merge time if another migration (for
-- example 0250 customer statements) lands first.
--
-- 1. companies: finance-charge settings. finance_charge_annual_rate NULL =
--    finance charges off (Q-P22a); minimum, grace days, compounding,
--    income account, print later.
-- 2. transactions.is_finance_charge: an invoice posted by an assessment.
-- 3. finance_charge_runs (the Idempotency-Key entity), finance_charge_
--    assessments (one per client and run; a partial unique index allows one
--    live assessment per client and month) and finance_charge_sources (the
--    invoices charged, with the days charged through).
--
-- Additive; idempotent. Ordering: after 0249 (renumbered after 0250 customer statements when both merge).
-- Rollback: 0250_finance_charges.rollback.sql. After a rollback and a
-- re-upgrade, periods already charged can be charged again (the guard
-- rows are gone); the posted finance-charge invoices stay.

ALTER TABLE companies ADD COLUMN IF NOT EXISTS finance_charge_annual_rate numeric(7,4);
--> statement-breakpoint
ALTER TABLE companies ADD COLUMN IF NOT EXISTS finance_charge_minimum numeric(19,4) NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE companies ADD COLUMN IF NOT EXISTS finance_charge_grace_days integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE companies ADD COLUMN IF NOT EXISTS finance_charge_on_finance_charges boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE companies ADD COLUMN IF NOT EXISTS finance_charge_income_account_id uuid;
--> statement-breakpoint
ALTER TABLE companies ADD COLUMN IF NOT EXISTS finance_charge_print_later boolean NOT NULL DEFAULT true;
--> statement-breakpoint
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS is_finance_charge boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS finance_charge_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  assessment_date date NOT NULL,
  period char(7) NOT NULL,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS finance_charge_assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  company_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  period char(7) NOT NULL,
  assessment_date date NOT NULL,
  invoice_id uuid NOT NULL,
  voided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_fc_assessment_live
  ON finance_charge_assessments (company_id, contact_id, period) WHERE voided_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_fc_assessment_invoice ON finance_charge_assessments (tenant_id, invoice_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_fc_assessment_run ON finance_charge_assessments (run_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS finance_charge_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  assessment_id uuid NOT NULL,
  company_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  open numeric(19,4) NOT NULL,
  from_date date NOT NULL,
  through_date date NOT NULL,
  days integer NOT NULL,
  amount numeric(19,4) NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_fc_sources_invoice ON finance_charge_sources (company_id, invoice_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_fc_sources_assessment ON finance_charge_sources (assessment_id);
