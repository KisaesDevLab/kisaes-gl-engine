-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- U-12 (ClientLedger P34, integrity-v1): stored Verify Data runs, so the
-- weekly check and Home's summary are company-wide (and shared over LAN).
-- findings carry ids, check codes, labels and exact amounts as text. The
-- service keeps the newest 20 runs per company. Never travels in tenant
-- archives (plan.ts: job-bookkeeping); deleted with its tenant. Additive only.

CREATE TABLE IF NOT EXISTS integrity_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  level varchar(10) NOT NULL CHECK (level IN ('quick', 'full')),
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL DEFAULT now(),
  ledger_version text NOT NULL,
  summary jsonb NOT NULL,
  findings jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by uuid
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_integrity_runs_latest ON integrity_runs (tenant_id, company_id, level, finished_at DESC);