-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Exemption certificates (U-151; tax-exemptions-v1). contact_tax_exemptions:
-- a client's resale or exemption certificate — number (at most 50), state,
-- expiry (NULL = does not expire), an optional attachment (a file of the
-- same company filed on the same client), a note; deactivated, never deleted.
-- Previews warn when a non-taxable client has no current certificate.
--
-- Additive. Ordering: after 0254 (Pay Sales Tax).
-- Rollback: 0255_tax_exemptions.rollback.sql.

CREATE TABLE IF NOT EXISTS contact_tax_exemptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  number varchar(50) NOT NULL,
  state varchar(20),
  expires_on date,
  attachment_id uuid,
  note text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tax_exemptions_contact ON contact_tax_exemptions (company_id, contact_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tax_exemptions_expiry ON contact_tax_exemptions (company_id, expires_on);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tax_exemptions_tenant ON contact_tax_exemptions (tenant_id);