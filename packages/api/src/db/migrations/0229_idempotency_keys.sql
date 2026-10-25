-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Idempotency-Key records for the posting and master-data routes
-- (U-18, idempotency-v1). One row per (tenant, user, key) whose request
-- committed. The row is inserted in the posting's own database transaction
-- (state 'committed'), so a refused or crashed request leaves no row; after
-- the commit it is updated to 'done' with the response, which a retry with
-- the same key and request gets back instead of posting twice. Concurrent
-- requests with one key are serialized by a transaction-scoped advisory
-- lock, so there is no persisted "in progress" state. Rows expire after 24
-- hours (an hourly sweep deletes them). company_id is NULL on tenant-wide
-- routes (contacts, items, tags). Install-local bookkeeping: never exported
-- with a tenant (job-bookkeeping in the portability plan) and removed with
-- the tenant, company or user. Additive only.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key VARCHAR(64) NOT NULL,
  route VARCHAR(120) NOT NULL,
  request_sha256 CHAR(64) NOT NULL,
  state VARCHAR(16) NOT NULL CHECK (state IN ('committed', 'done')),
  success_status SMALLINT NOT NULL,
  response_status SMALLINT,
  response_body JSONB,
  response_truncated BOOLEAN NOT NULL DEFAULT false,
  entity_type VARCHAR(40),
  entity_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_idempotency_keys_key
  ON idempotency_keys (tenant_id, user_id, idempotency_key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_idempotency_keys_created
  ON idempotency_keys (created_at);
