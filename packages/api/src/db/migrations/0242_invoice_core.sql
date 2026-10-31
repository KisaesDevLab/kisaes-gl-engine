-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Invoice core (U-123 invoice-fields-v1, U-126 invoice-sent-history-v1).
--
-- U-123: journal_lines.service_date (the day a line's work was done, shown
-- on the form), and on transactions po_number (the customer's PO),
-- customer_message (printed on the invoice; memo stays internal) and
-- hide_zero_lines (leave $0 lines off the printed form). Nullable or with a
-- default, so existing rows read as before.
--
-- U-126: document_send_events, one row each time a form is sent: method
-- printed | email | pdf, the recipients (email only; never logged or
-- audited), when and by whom. Kept across edits of the form. Soft
-- references (no FK), like spoiled_check_numbers.
--
-- Additive only; PostgreSQL 11+ adds the columns without a rewrite.
-- Ordering: after 0241. Rollback: 0242_invoice_core.rollback.sql.

ALTER TABLE journal_lines ADD COLUMN IF NOT EXISTS service_date date;
--> statement-breakpoint
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS po_number varchar(50);
--> statement-breakpoint
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS customer_message text;
--> statement-breakpoint
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS hide_zero_lines boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS document_send_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid,
  transaction_id uuid NOT NULL,
  method varchar(10) NOT NULL CONSTRAINT document_send_events_method_ck CHECK (method IN ('printed', 'email', 'pdf')),
  recipients jsonb NOT NULL DEFAULT '[]'::jsonb,
  sent_at timestamptz NOT NULL DEFAULT now(),
  user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_document_send_events_txn
  ON document_send_events (tenant_id, transaction_id, sent_at);
