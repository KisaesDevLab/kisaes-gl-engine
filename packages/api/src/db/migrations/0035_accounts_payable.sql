-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
-- Accounts Payable: bills, vendor credits, bill payments
-- Adds bill-specific columns to transactions, vendor-default columns to contacts,
-- and the two application/junction tables that link payments to bills and credits.

-- 1. Bill-specific columns on transactions
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "bill_status" varchar(20);
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "terms_days" integer;
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "credits_applied" numeric(19,4) DEFAULT 0;
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "vendor_invoice_number" varchar(100);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "idx_txn_bill_status" ON "transactions" USING btree ("tenant_id", "bill_status");
CREATE INDEX IF NOT EXISTS "idx_txn_vendor_inv" ON "transactions" USING btree ("tenant_id", "vendor_invoice_number");
--> statement-breakpoint

-- 2. Vendor default terms on contacts
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "default_terms_days" integer;
--> statement-breakpoint

-- 3. Bill payment applications (junction: which bills are covered by a payment)
CREATE TABLE IF NOT EXISTS "bill_payment_applications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "company_id" uuid,
  "payment_id" uuid NOT NULL,
  "bill_id" uuid NOT NULL,
  "amount" numeric(19,4) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now(),
  CONSTRAINT "chk_bpa_amount_positive" CHECK (amount > 0)
);
CREATE INDEX IF NOT EXISTS "idx_bpa_payment" ON "bill_payment_applications" USING btree ("payment_id");
CREATE INDEX IF NOT EXISTS "idx_bpa_bill" ON "bill_payment_applications" USING btree ("bill_id");
CREATE INDEX IF NOT EXISTS "idx_bpa_tenant" ON "bill_payment_applications" USING btree ("tenant_id");
--> statement-breakpoint

-- 4. Vendor credit applications (junction: which credits are applied to which bills in a payment)
CREATE TABLE IF NOT EXISTS "vendor_credit_applications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "company_id" uuid,
  "payment_id" uuid NOT NULL,
  "credit_id" uuid NOT NULL,
  "bill_id" uuid NOT NULL,
  "amount" numeric(19,4) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now(),
  CONSTRAINT "chk_vca_amount_positive" CHECK (amount > 0)
);
CREATE INDEX IF NOT EXISTS "idx_vca_payment" ON "vendor_credit_applications" USING btree ("payment_id");
CREATE INDEX IF NOT EXISTS "idx_vca_credit" ON "vendor_credit_applications" USING btree ("credit_id");
CREATE INDEX IF NOT EXISTS "idx_vca_bill" ON "vendor_credit_applications" USING btree ("bill_id");
CREATE INDEX IF NOT EXISTS "idx_vca_tenant" ON "vendor_credit_applications" USING btree ("tenant_id");
