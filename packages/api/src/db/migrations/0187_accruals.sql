-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Close Review -> Accruals (ACCRUALS_V1): schedules that spread an amount
-- across months and post one journal entry per month on the reviewer's
-- click. Additive. Flag seeded OFF for every tenant.

CREATE TABLE IF NOT EXISTS accrual_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id UUID,
  kind VARCHAR(20) NOT NULL CHECK (kind IN ('prepaid', 'deferred_revenue', 'accrued_expense', 'fixed_asset')),
  description TEXT NOT NULL,
  contact_id UUID,
  source_transaction_id UUID,
  balance_account_id UUID NOT NULL,
  recognition_account_id UUID NOT NULL,
  total_amount NUMERIC(19,4) NOT NULL CHECK (total_amount > 0),
  start_date DATE NOT NULL,
  months INTEGER NOT NULL CHECK (months BETWEEN 1 AND 600),
  method VARCHAR(20) NOT NULL DEFAULT 'full_month' CHECK (method IN ('full_month', 'mid_month', 'actual_days')),
  post_from DATE NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'cancelled', 'completed')),
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_accrual_schedules_tenant ON accrual_schedules (tenant_id, company_id, status);

CREATE TABLE IF NOT EXISTS accrual_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  schedule_id UUID NOT NULL REFERENCES accrual_schedules(id) ON DELETE CASCADE,
  period_start DATE NOT NULL,
  post_period DATE NOT NULL,
  amount NUMERIC(19,4) NOT NULL,
  is_catch_up BOOLEAN NOT NULL DEFAULT FALSE,
  status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'cancelled')),
  transaction_id UUID,
  posted_by UUID,
  posted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_accrual_entries_schedule ON accrual_entries (schedule_id, period_start);
CREATE INDEX IF NOT EXISTS idx_accrual_entries_post ON accrual_entries (tenant_id, post_period, status);

INSERT INTO tenant_feature_flags (tenant_id, flag_key, enabled)
SELECT t.id, 'ACCRUALS_V1', FALSE FROM tenants t
ON CONFLICT DO NOTHING;
