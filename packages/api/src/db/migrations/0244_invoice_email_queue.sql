-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Invoice email Outbox (U-127 invoice-email-v1).
--
-- form_email_queue: an email of a form waiting to be sent ("send later").
-- It holds the message only: recipients (to / cc / bcc; owner data, never
-- logged or audited), subject and body text. The PDF is not stored: the
-- client makes it when the message is sent (Q-P20q), so the row stays small
-- and always attaches the form as it is then. Rows are removed when sent
-- (POST /invoices/:id/email with outboxId) or deleted by the owner. Soft
-- references (no FK), like document_send_events.
--
-- Additive only. Ordering: after 0243. Rollback:
-- 0244_invoice_email_queue.rollback.sql.

CREATE TABLE IF NOT EXISTS form_email_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid,
  transaction_id uuid NOT NULL,
  to_addresses jsonb NOT NULL DEFAULT '[]'::jsonb,
  cc_addresses jsonb NOT NULL DEFAULT '[]'::jsonb,
  bcc_addresses jsonb NOT NULL DEFAULT '[]'::jsonb,
  subject varchar(500) NOT NULL DEFAULT '',
  body text NOT NULL DEFAULT '',
  user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_form_email_queue_company
  ON form_email_queue (tenant_id, company_id, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_form_email_queue_txn
  ON form_email_queue (tenant_id, transaction_id);
