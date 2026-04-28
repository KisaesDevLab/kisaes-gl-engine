-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
--
-- VIBE_MYBOOKS_PRACTICE_BUILD_PLAN Phase 2a — bucket workflow state
-- and vendor enrichment cache.
--
-- transaction_classification_state is keyed 1:1 on bank_feed_item_id
-- (deviation from plan's literal "transaction_id" — see phase-2-plan.md
-- §D1 for rationale). transaction_id back-fills at approval time for
-- the post-approval audit trail.
--
-- matched_rule_id records which legacy bank rule fired on this item
-- so Bucket 2's grouped-by-rule view can render in O(1). Tracking
-- lives on this table rather than bank_feed_items to keep the
-- legacy hot-path table untouched.

-- Per-tenant Practice-feature settings bucket. Follows the
-- existing tenants.report_settings JSONB pattern rather than a
-- global system_settings key (which wouldn't be per-tenant). The
-- current payload shape is a partial ClassificationThresholds;
-- later Practice phases can extend the object with additional
-- keys without another migration.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS practice_settings JSONB;

CREATE TABLE transaction_classification_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id UUID,
  bank_feed_item_id UUID NOT NULL REFERENCES bank_feed_items(id) ON DELETE CASCADE,
  transaction_id UUID,
  bucket VARCHAR(20) NOT NULL CHECK (bucket IN (
    'potential_match', 'rule', 'auto_high', 'auto_medium', 'needs_review'
  )),
  confidence_score DECIMAL(4,3) NOT NULL DEFAULT 0,
  suggested_account_id UUID,
  suggested_vendor_id UUID,
  matched_rule_id UUID REFERENCES bank_rules(id) ON DELETE SET NULL,
  reasoning_blob JSONB,
  model_used VARCHAR(100),
  match_candidates JSONB,
  vendor_enrichment JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX tcs_bank_feed_item_unique ON transaction_classification_state (bank_feed_item_id);
CREATE INDEX idx_tcs_tenant_bucket ON transaction_classification_state (tenant_id, bucket);
CREATE INDEX idx_tcs_tenant_period ON transaction_classification_state (tenant_id, company_id, created_at);
CREATE INDEX idx_tcs_matched_rule ON transaction_classification_state (tenant_id, matched_rule_id);

CREATE TABLE vendor_enrichment_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  vendor_key VARCHAR(255) NOT NULL,
  likely_business_type VARCHAR(100),
  suggested_account_type VARCHAR(50),
  source_url TEXT,
  summary TEXT,
  provider VARCHAR(50),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE UNIQUE INDEX vec_tenant_vendor_unique ON vendor_enrichment_cache (tenant_id, vendor_key);
CREATE INDEX idx_vec_expiry ON vendor_enrichment_cache (tenant_id, expires_at);
