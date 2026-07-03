-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.

-- Firm-level external integration credentials (first provider:
-- tax1099.com e-filing). Credentials are AES-GCM encrypted with
-- PLAID_ENCRYPTION_KEY (same idiom as plaid_config / stripe columns).
-- One row per (firm, provider). Additive only (rule 13).

CREATE TABLE IF NOT EXISTS firm_integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  provider varchar(50) NOT NULL,
  api_key_encrypted text,
  username_encrypted text,
  password_encrypted text,
  environment varchar(20) NOT NULL DEFAULT 'sandbox',
  base_url_override varchar(255),
  is_enabled boolean NOT NULL DEFAULT false,
  updated_by_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS firm_integrations_firm_provider_idx
  ON firm_integrations (firm_id, provider);

-- E-file submission tracking on the existing filings ledger. The
-- export_format column already reserved the 'tax1099' value.
ALTER TABLE annual_1099_filings ADD COLUMN IF NOT EXISTS submission_status varchar(20);
ALTER TABLE annual_1099_filings ADD COLUMN IF NOT EXISTS provider_reference varchar(120);
ALTER TABLE annual_1099_filings ADD COLUMN IF NOT EXISTS submitted_at timestamptz;
ALTER TABLE annual_1099_filings ADD COLUMN IF NOT EXISTS status_message text;
ALTER TABLE annual_1099_filings ADD COLUMN IF NOT EXISTS firm_id uuid;
