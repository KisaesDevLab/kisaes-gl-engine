-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Idempotency-Key records for POST /api/v1/batch/save (U-72). One row per
-- (tenant, company, key) whose batch saved: the SHA-256 of the request body
-- and the response, so a retry with the same key and body gets the same
-- result back instead of posting the batch twice, and the same key with a
-- different body is refused (409). The row is written in the same database
-- transaction as the batch, so a failed batch leaves no row. Install-local
-- bookkeeping: never exported with a tenant (job-bookkeeping in the
-- portability plan) and removed with the tenant or company. Additive only.
CREATE TABLE IF NOT EXISTS batch_save_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  idempotency_key VARCHAR(255) NOT NULL,
  request_sha256 VARCHAR(64) NOT NULL,
  batch_id UUID NOT NULL,
  response_status INTEGER NOT NULL,
  response_body JSONB NOT NULL,
  user_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_batch_save_requests_key
  ON batch_save_requests (tenant_id, company_id, idempotency_key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_batch_save_requests_created
  ON batch_save_requests (tenant_id, created_at);
