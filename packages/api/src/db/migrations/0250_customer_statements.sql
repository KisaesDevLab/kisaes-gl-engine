-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Customer statements (U-112, U-140; customer-statement-v1,
-- customer-statement-send-v1). Number provisional: renumbered at merge time
-- if another migration lands first.
--
-- 1. customer_statement_runs: one row per run (the Idempotency-Key entity).
-- 2. customer_statements: one numbered snapshot per client and run, from the
--    company's `statement` counter; unique (company_id, number). snapshot is
--    display data only (names, address, dates, numbers, amounts; no ids), so
--    a reprint or a later send is identical and archives need no remapping.
-- 3. customer_statement_send_events: send history of a statement (printed /
--    email / pdf), as document_send_events is for forms.
-- 4. customer_statement_email_queue: Outbox rows of statements, listed with
--    the forms Outbox (GET /forms/email-queue).
--
-- Separate tables keep document_send_events and form_email_queue unchanged
-- (no NOT NULL is dropped). Additive; idempotent. Ordering: after 0249.
-- Rollback: 0250_customer_statements.rollback.sql (loses statement history,
-- statement send history and statement Outbox rows).

CREATE TABLE IF NOT EXISTS customer_statement_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  as_of date NOT NULL,
  format varchar(20) NOT NULL,
  start_date date,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_cs_runs_company ON customer_statement_runs (tenant_id, company_id, created_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS customer_statements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  company_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  number varchar(50) NOT NULL,
  as_of date NOT NULL,
  amount_due numeric(19,4) NOT NULL,
  snapshot jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_statements_number ON customer_statements (company_id, number);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_customer_statements_contact ON customer_statements (tenant_id, contact_id, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_customer_statements_run ON customer_statements (run_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS customer_statement_send_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  customer_statement_id uuid NOT NULL,
  method varchar(10) NOT NULL,
  recipients jsonb NOT NULL DEFAULT '[]'::jsonb,
  sent_at timestamptz NOT NULL DEFAULT now(),
  user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_cs_send_events_statement ON customer_statement_send_events (tenant_id, customer_statement_id, sent_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS customer_statement_email_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  customer_statement_id uuid NOT NULL,
  to_addresses jsonb NOT NULL DEFAULT '[]'::jsonb,
  cc_addresses jsonb NOT NULL DEFAULT '[]'::jsonb,
  bcc_addresses jsonb NOT NULL DEFAULT '[]'::jsonb,
  subject varchar(500) NOT NULL DEFAULT '',
  body text NOT NULL DEFAULT '',
  user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_cs_email_queue_company ON customer_statement_email_queue (tenant_id, company_id, created_at);
