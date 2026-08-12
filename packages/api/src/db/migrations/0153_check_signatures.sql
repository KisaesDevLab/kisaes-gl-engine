-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Check signature printing: a tenant-scoped library of signature images that
-- print on the check face. Each signature has a label, an encrypted image on
-- local disk (file_path is relative to UPLOAD_DIR; bytes are AES-256-GCM
-- ciphertext, never routed through tenant storage providers), a set of
-- authorized users, and an optional max_amount cap — checks above the cap
-- print with a bare signature line instead.
--
-- Deletes are soft (is_active = false) so transactions.print_signature_id
-- keeps resolving to a label for audit/history. print_signature_id has NO
-- foreign key for the same reason: it is a historical record of what was
-- printed, not a live reference.

CREATE TABLE IF NOT EXISTS check_signatures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  label varchar(100) NOT NULL,
  file_path varchar(512) NOT NULL,
  mime_type varchar(32) NOT NULL,
  width integer NOT NULL,
  height integer NOT NULL,
  sha256 varchar(64) NOT NULL,
  max_amount decimal(19,4),
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_check_signatures_tenant_label
  ON check_signatures(tenant_id, label) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_check_signatures_tenant
  ON check_signatures(tenant_id, is_active);

CREATE TABLE IF NOT EXISTS check_signature_users (
  signature_id uuid NOT NULL REFERENCES check_signatures(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  granted_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (signature_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_csu_tenant_user
  ON check_signature_users(tenant_id, user_id);

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS print_signature_id uuid;
