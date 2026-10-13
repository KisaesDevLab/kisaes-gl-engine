-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Electronic sign-off on bank / credit-card reconciliations (Kurt,
-- 2026-10-13). A completed reconciliation is signed by a Preparer and then a
-- Reviewer (a different user, firm staff). Each sign-off stores the signer's
-- display name at signing and a fingerprint of the reconciliation's substance
-- (statement header, cleared set, book balance at the statement date,
-- outstanding set); a later mismatch, a reopen/undo, or the preparer's
-- removal invalidates it (invalidated_at + reason) and the report shows it
-- stale until re-signed. One LIVE sign-off per (reconciliation, role).
-- Additive.

CREATE TABLE IF NOT EXISTS reconciliation_signoffs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  reconciliation_id UUID NOT NULL REFERENCES reconciliations(id) ON DELETE CASCADE,
  role VARCHAR(10) NOT NULL CONSTRAINT chk_reconciliation_signoffs_role CHECK (role IN ('preparer', 'reviewer')),
  user_id UUID NOT NULL,
  signer_name VARCHAR(255) NOT NULL,
  signed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  fingerprint TEXT NOT NULL,
  invalidated_at TIMESTAMPTZ,
  invalidated_reason VARCHAR(40),
  invalidated_detail TEXT,
  invalidated_by UUID
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uniq_reconciliation_signoffs_live
  ON reconciliation_signoffs (reconciliation_id, role) WHERE invalidated_at IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_reconciliation_signoffs_rec
  ON reconciliation_signoffs (tenant_id, reconciliation_id, signed_at);
