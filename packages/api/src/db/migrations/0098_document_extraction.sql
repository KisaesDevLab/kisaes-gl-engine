-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Local document-extraction module (Qwen3.5 vision via Ollama). Purely
-- additive: four new tables, no changes to existing schema.
--
--   extraction_jobs          one row per uploaded document
--   extraction_pages         one row per rendered page (prompt + raw response)
--   extracted_records        one validated, schema-conformant payload per page
--   extraction_review_queue  one row per job routed to human review
--
-- Audit invariant: file hash, page image refs, exact prompt, raw model
-- response, parsed payload, model tag, and timestamps are all retained.

CREATE TABLE extraction_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  company_id UUID,
  doc_type VARCHAR(20) NOT NULL,          -- bank_statement | invoice | receipt | w2 | 1099 | generic
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  file_hash VARCHAR(64) NOT NULL,         -- sha256 hex; unique per tenant for idempotency
  storage_key VARCHAR(500),
  page_count INTEGER,
  model_tag VARCHAR(100),
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX idx_extr_jobs_status ON extraction_jobs (tenant_id, status);
-- Re-uploading the same bytes returns the existing job rather than dup work.
CREATE UNIQUE INDEX idx_extr_jobs_tenant_hash ON extraction_jobs (tenant_id, file_hash);

CREATE TABLE extraction_pages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  job_id UUID NOT NULL,
  page_no INTEGER NOT NULL,
  image_ref VARCHAR(500),
  prompt TEXT,                            -- exact schemaInstruction sent (audit)
  raw_response TEXT,                      -- verbatim model output (audit)
  page_confidence DECIMAL(3,2),
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_extr_pages_job ON extraction_pages (tenant_id, job_id);
-- One page row per (job, page) → render + extract are idempotent on retry.
CREATE UNIQUE INDEX idx_extr_pages_job_page ON extraction_pages (job_id, page_no);

CREATE TABLE extracted_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  job_id UUID NOT NULL,
  page_no INTEGER NOT NULL,
  doc_type VARCHAR(20) NOT NULL,
  payload JSONB,
  confidence DECIMAL(3,2),
  validated BOOLEAN NOT NULL DEFAULT false,
  posted BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_extr_recs_job ON extracted_records (tenant_id, job_id);
-- One record per (job, page) → re-extraction upserts rather than duplicates.
CREATE UNIQUE INDEX idx_extr_recs_job_page ON extracted_records (job_id, page_no);

CREATE TABLE extraction_review_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  job_id UUID NOT NULL,
  reason TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'open',
  reviewer UUID,
  correction JSONB,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_extr_review_status ON extraction_review_queue (tenant_id, status);
-- One review row per job (the whole document routes to review).
CREATE UNIQUE INDEX idx_extr_review_job ON extraction_review_queue (job_id);
