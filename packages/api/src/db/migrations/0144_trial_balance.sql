-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Trial Balance module foundation (docs/tb/BUILD_PLAN.md Phase 1,
-- ADR-TB-01…06). Additive only: new tables, two new columns each on
-- companies/transactions, gl-version-stamp triggers, and a disabled
-- TRIAL_BALANCE_V1 flag row per existing tenant. Balances are never
-- stored (rule TB1) — these tables hold tax-code metadata, assignments,
-- workpaper annotations, tax-only (RJE) entries, and change counters.

-- ── Seed code library (global, ADR-TB-05) ─────────────────────────

CREATE TABLE IF NOT EXISTS tax_code_seed_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tax_year INTEGER NOT NULL,
  version INTEGER NOT NULL,
  label VARCHAR(200),
  source_file_hash VARCHAR(64) NOT NULL,
  row_count INTEGER NOT NULL DEFAULT 0,
  imported_by UUID,
  imported_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_tax_code_seed_versions
  ON tax_code_seed_versions (tax_year, version);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS tax_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version_id UUID NOT NULL REFERENCES tax_code_seed_versions(id) ON DELETE CASCADE,
  return_form VARCHAR(10) NOT NULL,
  activity_type VARCHAR(20) NOT NULL,
  code VARCHAR(50) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_m1_adjustment BOOLEAN NOT NULL DEFAULT FALSE,
  notes TEXT,
  ultratax_code VARCHAR(50),
  cch_code VARCHAR(50),
  lacerte_code VARCHAR(50),
  gosystem_code VARCHAR(50),
  generic_code VARCHAR(50)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_tax_codes_version_form_activity_code
  ON tax_codes (version_id, return_form, activity_type, code);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tax_codes_version_form
  ON tax_codes (version_id, return_form);
--> statement-breakpoint
-- Firm/tenant custom codes (rule TB8): owned by EITHER a firm (shared
-- across its client tenants) OR a single tenant — exactly one. Seed
-- imports never touch this table (standing invariant #5).
CREATE TABLE IF NOT EXISTS firm_tax_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id UUID REFERENCES firms(id) ON DELETE CASCADE,
  tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
  code VARCHAR(60) NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  return_form VARCHAR(10) NOT NULL,
  activity_type VARCHAR(20) NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_m1_adjustment BOOLEAN NOT NULL DEFAULT FALSE,
  ultratax_code VARCHAR(50),
  cch_code VARCHAR(50),
  lacerte_code VARCHAR(50),
  gosystem_code VARCHAR(50),
  generic_code VARCHAR(50),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_firm_tax_codes_one_owner CHECK (num_nonnulls(firm_id, tenant_id) = 1),
  CONSTRAINT chk_firm_tax_codes_namespace CHECK (code LIKE 'FIRM:%')
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_firm_tax_codes_owner_code
  ON firm_tax_codes (
    COALESCE(firm_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid),
    return_form, activity_type, code
  );
--> statement-breakpoint

-- ── Per-company tax profile & activity units (ADR-TB-02, D11) ─────

CREATE TABLE IF NOT EXISTS company_tax_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id UUID NOT NULL,
  return_form VARCHAR(10) NOT NULL,
  pinned_seed_version_id UUID REFERENCES tax_code_seed_versions(id),
  s_corp_election_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_company_tax_profiles_company
  ON company_tax_profiles (company_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_company_tax_profiles_tenant
  ON company_tax_profiles (tenant_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS activity_units (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id UUID NOT NULL,
  activity_type VARCHAR(20) NOT NULL,
  instance_number INTEGER NOT NULL DEFAULT 1,
  display_name VARCHAR(200) NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_activity_units_live
  ON activity_units (company_id, activity_type, instance_number)
  WHERE archived_at IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_activity_units_default
  ON activity_units (company_id)
  WHERE is_default AND archived_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_activity_units_tenant_company
  ON activity_units (tenant_id, company_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS tag_activity_map (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id UUID NOT NULL,
  tag_id UUID NOT NULL,
  activity_unit_id UUID NOT NULL REFERENCES activity_units(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_tag_activity_map_tag
  ON tag_activity_map (company_id, tag_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tag_activity_map_unit
  ON tag_activity_map (activity_unit_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tag_activity_map_tenant_company
  ON tag_activity_map (tenant_id, company_id);
--> statement-breakpoint

-- ── Account → tax code assignments ────────────────────────────────
-- Discriminated code ref: seed codes by STABLE identity (activity_type,
-- code) so re-pinning seed versions never orphans assignments; firm
-- codes by FK. Exactly one of the two.

CREATE TABLE IF NOT EXISTS account_tax_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id UUID NOT NULL,
  account_id UUID NOT NULL,
  activity_unit_id UUID REFERENCES activity_units(id) ON DELETE RESTRICT,
  seed_code VARCHAR(50),
  seed_activity_type VARCHAR(20),
  firm_code_id UUID REFERENCES firm_tax_codes(id) ON DELETE RESTRICT,
  source VARCHAR(10) NOT NULL DEFAULT 'manual',
  ai_confidence INTEGER,
  effective_tax_year INTEGER,
  assigned_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_account_tax_assignments_one_code CHECK (
    (seed_code IS NOT NULL AND seed_activity_type IS NOT NULL AND firm_code_id IS NULL) OR
    (seed_code IS NULL AND seed_activity_type IS NULL AND firm_code_id IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_account_tax_assignments
  ON account_tax_assignments (
    company_id, account_id,
    COALESCE(activity_unit_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_account_tax_assignments_tenant_company
  ON account_tax_assignments (tenant_id, company_id);
--> statement-breakpoint

-- ── Groupings / leadsheets / tickmarks / notes (Phase 7) ──────────

CREATE TABLE IF NOT EXISTS tb_groupings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id UUID NOT NULL,
  parent_id UUID,
  name VARCHAR(200) NOT NULL,
  leadsheet_code VARCHAR(10),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tb_groupings_tenant_company
  ON tb_groupings (tenant_id, company_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tb_groupings_parent
  ON tb_groupings (parent_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS tb_grouping_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id UUID NOT NULL,
  grouping_id UUID NOT NULL REFERENCES tb_groupings(id) ON DELETE CASCADE,
  account_id UUID NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_tb_grouping_accounts_account
  ON tb_grouping_accounts (company_id, account_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tb_grouping_accounts_grouping
  ON tb_grouping_accounts (grouping_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS tb_tickmarks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  symbol VARCHAR(8) NOT NULL,
  description VARCHAR(300) NOT NULL,
  color VARCHAR(20),
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_tb_tickmarks_symbol
  ON tb_tickmarks (tenant_id, symbol);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS tb_tickmark_applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id UUID NOT NULL,
  tax_year INTEGER NOT NULL,
  account_id UUID NOT NULL,
  "column" VARCHAR(20) NOT NULL,
  tickmark_id UUID NOT NULL REFERENCES tb_tickmarks(id) ON DELETE CASCADE,
  note TEXT,
  applied_by UUID,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tb_tickmark_apps_lookup
  ON tb_tickmark_applications (company_id, tax_year, account_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tb_tickmark_apps_tenant
  ON tb_tickmark_applications (tenant_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS tb_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id UUID NOT NULL,
  tax_year INTEGER NOT NULL,
  account_id UUID,
  body TEXT NOT NULL,
  author_id UUID,
  resolved_at TIMESTAMPTZ,
  resolved_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tb_notes_lookup
  ON tb_notes (company_id, tax_year);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tb_notes_tenant
  ON tb_notes (tenant_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS tb_leadsheet_signoffs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id UUID NOT NULL,
  tax_year INTEGER NOT NULL,
  grouping_id UUID NOT NULL REFERENCES tb_groupings(id) ON DELETE CASCADE,
  role VARCHAR(10) NOT NULL,
  user_id UUID NOT NULL,
  signed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  gl_version_stamp_at_signoff BIGINT NOT NULL,
  invalidated_at TIMESTAMPTZ
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_tb_leadsheet_signoffs_live
  ON tb_leadsheet_signoffs (grouping_id, tax_year, role)
  WHERE invalidated_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tb_leadsheet_signoffs_lookup
  ON tb_leadsheet_signoffs (company_id, tax_year);
--> statement-breakpoint

-- ── Tax RJEs (ADR-TB-03, rule TB4 — never touch the GL) ───────────

CREATE TABLE IF NOT EXISTS tb_tax_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id UUID NOT NULL,
  tax_year INTEGER NOT NULL,
  entry_number INTEGER NOT NULL,
  memo TEXT,
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_tb_tax_entries_number
  ON tb_tax_entries (company_id, tax_year, entry_number);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tb_tax_entries_tenant
  ON tb_tax_entries (tenant_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS tb_tax_entry_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entry_id UUID NOT NULL REFERENCES tb_tax_entries(id) ON DELETE CASCADE,
  account_id UUID NOT NULL,
  activity_unit_id UUID REFERENCES activity_units(id) ON DELETE RESTRICT,
  debit DECIMAL(19,4) NOT NULL DEFAULT 0,
  credit DECIMAL(19,4) NOT NULL DEFAULT 0,
  description TEXT,
  line_order INTEGER NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tb_tax_entry_lines_entry
  ON tb_tax_entry_lines (entry_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tb_tax_entry_lines_account
  ON tb_tax_entry_lines (account_id);
--> statement-breakpoint

-- ── Workflow status & sequences ───────────────────────────────────

CREATE TABLE IF NOT EXISTS tb_status (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id UUID NOT NULL,
  tax_year INTEGER NOT NULL,
  workflow_state VARCHAR(20) NOT NULL DEFAULT 'open',
  completed_by UUID,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_tb_status
  ON tb_status (company_id, tax_year);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tb_status_tenant
  ON tb_status (tenant_id);
--> statement-breakpoint
-- AJE display-number sequence (D17), claimed with SELECT … FOR UPDATE.
CREATE TABLE IF NOT EXISTS tb_aje_sequences (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id UUID NOT NULL,
  fiscal_year INTEGER NOT NULL,
  next_number INTEGER NOT NULL DEFAULT 1
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_tb_aje_sequences
  ON tb_aje_sequences (company_id, fiscal_year);
--> statement-breakpoint

-- ── glVersionStamp counters + triggers (ADR-TB-01/06, rule TB6) ───
-- Bumped at the DB layer so raw-SQL mutation paths (bill-payment
-- inserts, tenant restore, admin range-deletes) are caught too. The
-- zero-uuid company row holds tenant-wide (NULL-company) activity; a
-- company's effective stamp = SUM(its row, the sentinel row).

CREATE TABLE IF NOT EXISTS gl_version_stamps (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id UUID NOT NULL,
  counter BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_gl_version_stamps
  ON gl_version_stamps (tenant_id, company_id);
--> statement-breakpoint
-- Statement-level trigger over journal_lines transition tables: one
-- bump per distinct (tenant, company) per statement, resolved through
-- the owning transactions row.
CREATE OR REPLACE FUNCTION tb_bump_gl_stamp_lines() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO gl_version_stamps (tenant_id, company_id, counter, updated_at)
  SELECT DISTINCT
    t.tenant_id,
    COALESCE(t.company_id, '00000000-0000-0000-0000-000000000000'::uuid),
    1, now()
  FROM tb_changed_lines r
  JOIN transactions t ON t.id = r.transaction_id
  ON CONFLICT (tenant_id, company_id)
  DO UPDATE SET counter = gl_version_stamps.counter + 1, updated_at = now();
  RETURN NULL;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_tb_stamp_lines_ins ON journal_lines;
--> statement-breakpoint
CREATE TRIGGER trg_tb_stamp_lines_ins
  AFTER INSERT ON journal_lines
  REFERENCING NEW TABLE AS tb_changed_lines
  FOR EACH STATEMENT EXECUTE FUNCTION tb_bump_gl_stamp_lines();
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_tb_stamp_lines_upd ON journal_lines;
--> statement-breakpoint
CREATE TRIGGER trg_tb_stamp_lines_upd
  AFTER UPDATE ON journal_lines
  REFERENCING NEW TABLE AS tb_changed_lines
  FOR EACH STATEMENT EXECUTE FUNCTION tb_bump_gl_stamp_lines();
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_tb_stamp_lines_del ON journal_lines;
--> statement-breakpoint
CREATE TRIGGER trg_tb_stamp_lines_del
  AFTER DELETE ON journal_lines
  REFERENCING OLD TABLE AS tb_changed_lines
  FOR EACH STATEMENT EXECUTE FUNCTION tb_bump_gl_stamp_lines();
--> statement-breakpoint
-- Header-only changes that move balances between periods/bases without
-- touching lines (e.g. a date-only edit): row-level trigger on the
-- balance-relevant columns.
CREATE OR REPLACE FUNCTION tb_bump_gl_stamp_txn() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO gl_version_stamps (tenant_id, company_id, counter, updated_at)
  VALUES (
    NEW.tenant_id,
    COALESCE(NEW.company_id, '00000000-0000-0000-0000-000000000000'::uuid),
    1, now()
  )
  ON CONFLICT (tenant_id, company_id)
  DO UPDATE SET counter = gl_version_stamps.counter + 1, updated_at = now();
  -- A company move also dirties the OLD company's TB.
  IF NEW.company_id IS DISTINCT FROM OLD.company_id THEN
    INSERT INTO gl_version_stamps (tenant_id, company_id, counter, updated_at)
    VALUES (
      OLD.tenant_id,
      COALESCE(OLD.company_id, '00000000-0000-0000-0000-000000000000'::uuid),
      1, now()
    )
    ON CONFLICT (tenant_id, company_id)
    DO UPDATE SET counter = gl_version_stamps.counter + 1, updated_at = now();
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_tb_stamp_txn_upd ON transactions;
--> statement-breakpoint
CREATE TRIGGER trg_tb_stamp_txn_upd
  AFTER UPDATE OF txn_date, status, basis, txn_type, company_id ON transactions
  FOR EACH ROW EXECUTE FUNCTION tb_bump_gl_stamp_txn();
--> statement-breakpoint

-- ── Column additions ──────────────────────────────────────────────

ALTER TABLE companies ADD COLUMN IF NOT EXISTS lock_date_set_by UUID;
--> statement-breakpoint
ALTER TABLE companies ADD COLUMN IF NOT EXISTS lock_date_set_at TIMESTAMPTZ;
--> statement-breakpoint
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS aje_number INTEGER;
--> statement-breakpoint

-- ── Feature flag backfill (disabled for existing tenants) ─────────

INSERT INTO tenant_feature_flags (tenant_id, flag_key, enabled)
SELECT t.id, 'TRIAL_BALANCE_V1', FALSE
FROM tenants t
ON CONFLICT DO NOTHING;
