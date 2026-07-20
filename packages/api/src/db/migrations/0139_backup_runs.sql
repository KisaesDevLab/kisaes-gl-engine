-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Backup run log: one row per backup execution (scheduled or manual),
-- written at start and updated at completion, so operators can see a
-- history of backups and their state (success / partial / failed)
-- instead of grepping container logs. Per-destination outcomes (local
-- artifact, remote/B2 upload, local mirror copy) land in `destinations`
-- as jsonb; the periodic backup-verifier stamps its proof into `verify`
-- on the matching run (or inserts its own `verify` row when no run
-- matches, e.g. history predating this table).

CREATE TABLE IF NOT EXISTS backup_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- What was backed up: a single tenant's data, the full system bundle
  -- (attachments included), the DB-only system backup, an operator-
  -- downloaded DR bundle, or a standalone verifier result.
  kind VARCHAR(20) NOT NULL,
  -- NULL for system-wide runs (system/db/dr_bundle); set for per-tenant.
  tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL,
  trigger VARCHAR(10) NOT NULL DEFAULT 'scheduled',
  status VARCHAR(10) NOT NULL DEFAULT 'running',
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  size_bytes BIGINT,
  -- Base artifact name (multi-part .vmx series stored under the base
  -- name with the .partNNofMM suffix stripped, matching the verifier's
  -- unit naming so its result can find the producing run).
  artifact_name TEXT,
  -- { local: {ok,...}, remote: {configured, ok, error?, skipped?},
  --   mirror: {configured, ok, copied?, failed?, error?} }
  destinations JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- { ok, depth, error?, warning?, at } — written by the backup-verifier.
  verify JSONB,
  error TEXT,
  CONSTRAINT backup_runs_kind_check
    CHECK (kind IN ('tenant_backup', 'system_backup', 'db_backup', 'dr_bundle', 'verify')),
  CONSTRAINT backup_runs_trigger_check
    CHECK (trigger IN ('scheduled', 'manual')),
  CONSTRAINT backup_runs_status_check
    CHECK (status IN ('running', 'success', 'partial', 'failed'))
);

CREATE INDEX IF NOT EXISTS idx_backup_runs_started_at ON backup_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_backup_runs_kind_started ON backup_runs (kind, started_at DESC);
