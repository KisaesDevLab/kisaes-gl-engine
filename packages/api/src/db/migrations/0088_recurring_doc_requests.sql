-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
--
-- RECURRING_DOC_REQUESTS_V1 — calendar-cadence document-request
-- reminders. Two new tables + one nullable FK column on portal_receipts
-- + a per-tenant feature-flag backfill row (default OFF).

CREATE TABLE recurring_document_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES portal_contacts(id) ON DELETE CASCADE,
  document_type VARCHAR(40) NOT NULL CHECK (document_type IN (
    'bank_statement', 'cc_statement', 'payroll_report', 'receipt_batch', 'other'
  )),
  description TEXT NOT NULL,
  frequency VARCHAR(20) NOT NULL DEFAULT 'monthly'
    CHECK (frequency IN ('monthly', 'quarterly', 'annually')),
  interval_value INTEGER NOT NULL DEFAULT 1 CHECK (interval_value >= 1),
  -- 1..28 only — short-month clamping happens in the issuance service.
  -- Allowing 29..31 here would let a UI write a value that silently
  -- moves around in February, which is a foot-gun.
  day_of_month INTEGER CHECK (day_of_month BETWEEN 1 AND 28),
  next_issue_at TIMESTAMPTZ NOT NULL,
  last_issued_at TIMESTAMPTZ,
  due_days_after_issue INTEGER NOT NULL DEFAULT 7
    CHECK (due_days_after_issue >= 0 AND due_days_after_issue <= 365),
  cadence_days JSONB NOT NULL DEFAULT '[3,7,14]',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  ends_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_recur_doc_req_tenant_active_next
  ON recurring_document_requests (tenant_id, active, next_issue_at);
CREATE INDEX idx_recur_doc_req_contact
  ON recurring_document_requests (contact_id, active);

CREATE TABLE document_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
  -- ON DELETE SET NULL so cancelling the recurring rule doesn't blow
  -- away historical issued rows; the practice still wants to see the
  -- audit trail of "we asked for these on these dates".
  recurring_id UUID REFERENCES recurring_document_requests(id) ON DELETE SET NULL,
  contact_id UUID NOT NULL REFERENCES portal_contacts(id) ON DELETE CASCADE,
  document_type VARCHAR(40) NOT NULL,
  description TEXT NOT NULL,
  period_label VARCHAR(40) NOT NULL,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  due_date TIMESTAMPTZ,
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'submitted', 'cancelled', 'superseded')),
  submitted_at TIMESTAMPTZ,
  -- Soft FK to portal_receipts; the FK constraint is added below
  -- after the column exists on both sides.
  submitted_receipt_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_doc_req_tenant_status_req
  ON document_requests (tenant_id, status, requested_at);
CREATE INDEX idx_doc_req_contact_status
  ON document_requests (contact_id, status);
-- Idempotency guard: one document_requests row per (rule, period). If
-- two scheduler ticks race past the advisory lock, the second insert
-- hits this and bails cleanly instead of double-issuing.
CREATE UNIQUE INDEX uq_doc_req_recurring_period
  ON document_requests (recurring_id, period_label)
  WHERE recurring_id IS NOT NULL;

-- portal_receipts gets a nullable FK so the upload route can record
-- which document request it fulfilled. Nullable so existing rows and
-- future portal-side ad-hoc uploads remain valid.
ALTER TABLE portal_receipts
  ADD COLUMN document_request_id UUID
    REFERENCES document_requests(id) ON DELETE SET NULL;
CREATE INDEX idx_portal_receipts_doc_request
  ON portal_receipts (document_request_id)
  WHERE document_request_id IS NOT NULL;

-- And the reverse direction — document_requests.submitted_receipt_id
-- gets its FK now that portal_receipts is reachable.
ALTER TABLE document_requests
  ADD CONSTRAINT fk_doc_req_submitted_receipt
    FOREIGN KEY (submitted_receipt_id)
    REFERENCES portal_receipts(id) ON DELETE SET NULL;

-- Per-tenant feature flag, default OFF for existing tenants. New
-- tenants get the same row inserted with the same default by
-- seedDefaultsForNewTenant() — the service-layer FLAGS_DEFAULT_OFF_
-- FOR_NEW_TENANTS set decides ON/OFF.
INSERT INTO tenant_feature_flags (tenant_id, flag_key, enabled)
SELECT t.id, 'RECURRING_DOC_REQUESTS_V1', FALSE
FROM tenants t
ON CONFLICT DO NOTHING;
