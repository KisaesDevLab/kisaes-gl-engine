-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Month-end close record per (tenant, company, month): the preparer →
-- reviewer sign-off chain for the Close Review workspace. Additive.

CREATE TABLE IF NOT EXISTS closes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id UUID,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'not_started'
    CHECK (status IN ('not_started', 'in_progress', 'prepared', 'closed')),
  prepared_by UUID,
  prepared_at TIMESTAMPTZ,
  prepared_note TEXT,
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ,
  reviewed_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_closes_tenant_company_period
  ON closes (tenant_id, COALESCE(company_id, '00000000-0000-0000-0000-000000000000'::uuid), period_start);
CREATE INDEX IF NOT EXISTS idx_closes_tenant_period ON closes (tenant_id, period_start);

-- Months already reviewed under the manual flow start as in progress.
INSERT INTO closes (tenant_id, company_id, period_start, period_end, status)
SELECT DISTINCT r.tenant_id, r.company_id, r.period_start, r.period_end, 'in_progress'
FROM check_runs r
WHERE r.period_start IS NOT NULL AND r.period_end IS NOT NULL AND r.completed_at IS NOT NULL
ON CONFLICT DO NOTHING;
