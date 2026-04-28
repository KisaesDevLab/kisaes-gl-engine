-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
--
-- VIBE_MYBOOKS_PRACTICE_BUILD_PLAN Phase 14 + 15 — 1099 / W-9
-- management. Adds two columns to contacts and creates three new
-- tables. The contacts column adds are additive defaults — no data
-- backfill needed.

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS form_1099_type VARCHAR(20);
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS exempt_payee_code VARCHAR(10);

CREATE TABLE vendor_1099_profile (
  contact_id UUID PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  w9_on_file BOOLEAN NOT NULL DEFAULT FALSE,
  w9_document_id UUID,
  w9_captured_at TIMESTAMPTZ,
  w9_expires_at TIMESTAMPTZ,
  tin_encrypted TEXT,
  tin_type VARCHAR(4) CHECK (tin_type IS NULL OR tin_type IN ('SSN', 'EIN')),
  tin_match_status VARCHAR(20),
  tin_match_date TIMESTAMPTZ,
  backup_withholding BOOLEAN NOT NULL DEFAULT FALSE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_vendor_1099_profile_tenant ON vendor_1099_profile (tenant_id);

CREATE TABLE w9_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  requested_contact_email VARCHAR(320) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'sent' CHECK (status IN ('pending', 'sent', 'viewed', 'completed', 'expired')),
  magic_link_token_hash VARCHAR(64) NOT NULL,
  message TEXT,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  viewed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  w9_document_id UUID,
  created_by UUID NOT NULL
);
CREATE INDEX idx_w9_requests_token ON w9_requests (magic_link_token_hash);
CREATE INDEX idx_w9_requests_tenant ON w9_requests (tenant_id, status);
CREATE INDEX idx_w9_requests_contact ON w9_requests (contact_id);

CREATE TABLE annual_1099_filings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  tax_year INTEGER NOT NULL,
  form_type VARCHAR(20) NOT NULL,
  export_format VARCHAR(20) NOT NULL,
  vendor_count INTEGER NOT NULL,
  total_amount DECIMAL(19, 4) NOT NULL,
  exported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  exported_by UUID NOT NULL,
  correction_of UUID,
  notes TEXT
);
CREATE INDEX idx_annual_1099_filings_year ON annual_1099_filings (tenant_id, tax_year);
