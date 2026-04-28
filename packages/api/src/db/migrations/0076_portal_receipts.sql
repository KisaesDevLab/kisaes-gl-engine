-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
--
-- VIBE_MYBOOKS_PRACTICE_BUILD_PLAN Phase 18 — receipt inbox.

CREATE TABLE portal_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  capture_source VARCHAR(20) NOT NULL DEFAULT 'portal' CHECK (capture_source IN ('portal', 'practice')),
  uploaded_by UUID NOT NULL,
  uploaded_by_type VARCHAR(20) NOT NULL CHECK (uploaded_by_type IN ('bookkeeper', 'contact')),
  storage_key TEXT NOT NULL,
  filename VARCHAR(512) NOT NULL,
  mime_type VARCHAR(120),
  size_bytes BIGINT,
  content_sha256 VARCHAR(64),
  extracted_vendor VARCHAR(255),
  extracted_date DATE,
  extracted_total DECIMAL(19, 4),
  extracted_tax DECIMAL(19, 4),
  extracted_line_items JSONB,
  extracted_raw JSONB,
  status VARCHAR(30) NOT NULL DEFAULT 'pending_ocr' CHECK (status IN ('pending_ocr', 'ocr_failed', 'unmatched', 'auto_matched', 'manually_matched', 'dismissed')),
  matched_transaction_id UUID,
  match_score DECIMAL(5, 4),
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_portal_receipts_tenant_status ON portal_receipts (tenant_id, status);
CREATE INDEX idx_portal_receipts_tenant_company ON portal_receipts (tenant_id, company_id);
CREATE INDEX idx_portal_receipts_content_hash ON portal_receipts (tenant_id, content_sha256);
