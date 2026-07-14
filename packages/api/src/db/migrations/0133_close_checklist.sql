-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Close checklist sign-offs. The checklist itself is DERIVED live
-- (reconciliation state, bank-feed backlog, open findings) — this table
-- only stores the human acts: manual task completions and their notes,
-- keyed by (tenant, company, period, task). Additive: new table only.

CREATE TABLE IF NOT EXISTS close_checklist_signoffs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id UUID,
  period_start DATE NOT NULL,
  task_key VARCHAR(120) NOT NULL,
  note TEXT,
  completed_by UUID,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Nullable company_id would let duplicate tenant-wide sign-offs slip
-- through a plain UNIQUE (NULLs compare distinct) — normalize via COALESCE.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_close_checklist_signoffs
  ON close_checklist_signoffs (
    tenant_id,
    COALESCE(company_id, '00000000-0000-0000-0000-000000000000'::uuid),
    period_start,
    task_key
  );

CREATE INDEX IF NOT EXISTS idx_close_checklist_tenant_period
  ON close_checklist_signoffs (tenant_id, period_start);
