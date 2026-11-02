-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Bad-debt recoveries (U-154; bad-debt-recovery-v1, idempotency-recovery-v1).
-- write_off_recoveries: one row per write-off application a recovery
-- (txn_type 'bad_debt_recovery': Dr A/R, Cr the write-off account, Cr Sales
-- Tax Payable for the recovered SSUTA tax) takes back, with the amount. A
-- row counts while its recovery transaction is posted (a void keeps the row
-- and drops it from every sum). The recovered tax itself is stored as
-- transaction_tax_lines kind 'recovery' (0252) on the recovery.
--
-- The SSUTA switch (companies.sales_tax_ssuta) was added off by 0252
-- (Q-SPF6); this migration does not change it. transactions.sales_tax_ssuta
-- records the switch when a customer payment was first posted (NULL before
-- this migration, when no SSUTA rows were written: off), so an edit applies
-- the original posting's state (Q-P23w, forward only).
--
-- Additive. Ordering: after 0255 (exemption certificates).
-- Rollback: 0256_bad_debt_recovery.rollback.sql (refused while any exist).

CREATE TABLE IF NOT EXISTS write_off_recoveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  application_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  recovery_txn_id uuid NOT NULL,
  amount numeric(19,4) NOT NULL CHECK (amount > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_write_off_recoveries_app ON write_off_recoveries (application_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_write_off_recoveries_invoice ON write_off_recoveries (company_id, invoice_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_write_off_recoveries_txn ON write_off_recoveries (recovery_txn_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_write_off_recoveries_tenant ON write_off_recoveries (tenant_id);
--> statement-breakpoint
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS sales_tax_ssuta boolean;
