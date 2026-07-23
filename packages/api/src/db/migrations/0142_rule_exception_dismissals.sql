-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rule-exception audit (Close Review → Buckets → Rules): a bookkeeper can
-- DISMISS a flagged posted transaction whose booked category account differs
-- from what a Practice Rule would assign, so it does not resurface on the next
-- audit. One row per dismissed transaction (keyed on tenant + transaction).

CREATE TABLE IF NOT EXISTS rule_exception_dismissals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  transaction_id UUID NOT NULL,
  -- The rule whose suggestion was dismissed (informational; NULL-safe).
  rule_id UUID,
  dismissed_by UUID,
  dismissed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_red_txn
  ON rule_exception_dismissals (tenant_id, transaction_id);
