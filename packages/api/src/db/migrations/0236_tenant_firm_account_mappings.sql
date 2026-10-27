-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Client rules overview — per-client account mappings for global_firm rules.
--
-- A global rule's set_account / split legs store an account id from the
-- client the rule was written on (the "source account"). Other clients name
-- their accounts differently, and only system accounts carry a portable
-- system_tag, so the resolver could not place the rule's category anywhere
-- else. This table records, per (firm, client), which of the client's own
-- accounts stands in for a given source account. The resolver checks it
-- before falling back to system_tag (rule-symbol-resolution.service).
--
-- Keyed on the source account id rather than a name so renaming the source
-- account never orphans a mapping, and existing global rules need no rewrite.
--
-- Additive only: one new table. Rollback:
-- 0236_tenant_firm_account_mappings.rollback.sql.

CREATE TABLE IF NOT EXISTS tenant_firm_account_mappings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_tfam_firm_tenant_source
  ON tenant_firm_account_mappings (firm_id, tenant_id, source_account_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tfam_tenant
  ON tenant_firm_account_mappings (tenant_id);
