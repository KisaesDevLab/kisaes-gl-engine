-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Document numbering, footers and the forms print queue (U-111, U-113;
-- capabilities document-numbers-v1 and forms-print-queue-v1).
--
-- 1. companies.document_numbers (jsonb, default {}): the prefix and next
--    number per document type other than invoices, keyed by type
--    (cash_sale, credit_memo, statement): {"cash_sale": {"prefix": "CS-",
--    "next": 1001}}. Invoices keep companies.invoice_prefix /
--    invoice_next_number. A missing key means prefix '' and next 1001.
-- 2. invoice_templates.footer_overrides (jsonb, default {}): per-type footer
--    text (invoice, cash_sale, credit_memo, statement); blank or absent
--    falls back to the template's footer_text.
-- 3. transactions.print_later (boolean, default false): an invoice, cash
--    sale or credit memo waiting to be printed (GET /forms/print-queue).
--    PostgreSQL 11+ adds a column with a constant default without a rewrite.
--
-- Additive only. Ordering: written after 0239 (clientledger/check-printing);
-- applies with or without it.
-- Rollback: 0240_document_numbers.rollback.sql.

ALTER TABLE companies ADD COLUMN IF NOT EXISTS document_numbers jsonb NOT NULL DEFAULT '{}'::jsonb;
--> statement-breakpoint
ALTER TABLE invoice_templates ADD COLUMN IF NOT EXISTS footer_overrides jsonb NOT NULL DEFAULT '{}'::jsonb;
--> statement-breakpoint
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS print_later boolean NOT NULL DEFAULT false;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_txn_print_later
  ON transactions (tenant_id, company_id) WHERE print_later;
