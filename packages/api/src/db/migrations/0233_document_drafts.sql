-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Document drafts, vendor layout templates and card last 4 (U-92, U-92a,
-- U-92b; capabilities document-drafts-v1 and idempotency-docs-v1).
--
-- document_drafts: what a client read from one vendor document (a bill, a
-- card charge, a check or a cash expense), waiting for the owner to accept
-- it. A draft never posts by itself and never touches transactions or
-- journal_lines; POST /document-drafts/:id/convert posts it through the
-- existing bill / expense / check service in one database transaction.
--   - The file stays an ordinary draft attachment (attachable_type 'draft',
--     attachable_id the client's draft key); attachment_id points at it and
--     is nulled when the file is deleted after the draft is closed.
--   - content_sha256 is the SHA-256 of the stored file, computed by the
--     engine. It is the claim: one live or converted draft per file and
--     company (uq_document_drafts_claim); discarding a draft frees it. It is
--     kept when attachment_id is nulled, so a converted file stays claimed.
--   - fields / lines / checks are the client's reading (decimal-string
--     amounts, basis points, integer page boxes); the engine stores them and
--     never computes with them. suggested_contact_id, doc_reference,
--     doc_total and doc_date are the typed copy the duplicate check reads.
--
-- vendor_layout_templates: where a vendor's documents print each field, one
-- row per company, vendor and layout fingerprint.
--
-- accounts.card_last4: the last four digits of a credit card account, so a
-- client can pick the card account a receipt was paid with.
--
-- Additive only: two new tables, one nullable column and its check.

CREATE TABLE IF NOT EXISTS document_drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  attachment_id uuid REFERENCES attachments(id) ON DELETE SET NULL,
  content_sha256 char(64) NOT NULL,
  kind varchar(20) NOT NULL DEFAULT 'unknown',
  status varchar(20) NOT NULL DEFAULT 'new',
  reader varchar(20),
  fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  lines jsonb NOT NULL DEFAULT '[]'::jsonb,
  checks jsonb NOT NULL DEFAULT '[]'::jsonb,
  failure_reason varchar(40),
  suggested_contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  doc_reference varchar(100),
  doc_total numeric(19,4),
  doc_date date,
  converted_transaction_id uuid REFERENCES transactions(id) ON DELETE SET NULL,
  converted_type varchar(30),
  converted_at timestamptz,
  converted_by uuid,
  discarded_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT document_drafts_sha_ck CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT document_drafts_kind_ck CHECK (kind IN ('bill', 'card_charge', 'check', 'cash_expense', 'unknown')),
  CONSTRAINT document_drafts_status_ck CHECK (status IN ('new', 'ready', 'failed', 'converted', 'discarded')),
  CONSTRAINT document_drafts_reader_ck CHECK (reader IS NULL OR reader IN ('text_pdf', 'ocr', 'template', 'ollama', 'cloud', 'manual')),
  CONSTRAINT document_drafts_total_ck CHECK (doc_total IS NULL OR doc_total >= 0),
  CONSTRAINT document_drafts_converted_ck CHECK (status <> 'converted' OR converted_at IS NOT NULL)
);
--> statement-breakpoint
-- The claim (U-92b): one draft per file and company until it is discarded.
CREATE UNIQUE INDEX IF NOT EXISTS uq_document_drafts_claim
  ON document_drafts (tenant_id, company_id, content_sha256)
  WHERE status <> 'discarded';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_document_drafts_queue
  ON document_drafts (tenant_id, company_id, status, created_at DESC);
--> statement-breakpoint
-- attachment.service remove(): is the file a live draft's?
CREATE INDEX IF NOT EXISTS idx_document_drafts_attachment
  ON document_drafts (attachment_id)
  WHERE attachment_id IS NOT NULL;
--> statement-breakpoint
-- Duplicate check across live drafts of one vendor.
CREATE INDEX IF NOT EXISTS idx_document_drafts_contact
  ON document_drafts (tenant_id, company_id, suggested_contact_id)
  WHERE status IN ('new', 'ready', 'failed');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS vendor_layout_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  fingerprint varchar(128) NOT NULL,
  field_regions jsonb NOT NULL DEFAULT '{}'::jsonb,
  line_table jsonb,
  samples integer NOT NULL DEFAULT 1,
  last_used_at timestamptz,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vendor_layout_templates_samples_ck CHECK (samples >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_vendor_layout_templates
  ON vendor_layout_templates (company_id, contact_id, fingerprint);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_vendor_layout_templates_company
  ON vendor_layout_templates (tenant_id, company_id, contact_id);
--> statement-breakpoint
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS card_last4 char(4);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'accounts_card_last4_chk') THEN
    ALTER TABLE accounts ADD CONSTRAINT accounts_card_last4_chk CHECK (card_last4 IS NULL OR card_last4 ~ '^[0-9]{4}$');
  END IF;
END $$;
