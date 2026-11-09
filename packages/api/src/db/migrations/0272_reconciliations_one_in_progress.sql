-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- One in-progress reconciliation per account (U-188, reconcile-exact-v1).
-- start() refused a second one with a read before its insert, so two starts
-- at the same moment could both pass. This index makes the database refuse
-- the second (start maps 23505 to 409 RECONCILIATION_IN_PROGRESS).
--
-- Existing duplicates must go first or the index can't be built. Per
-- (tenant, account) the in-progress row with the newest updated_at stays
-- (ties: created_at, then id); the older ones get the same teardown as
-- POST /reconciliations/:id/cancel: statement-line matches reset, the
-- driving statement unlinked, worksheet lines and header deleted. An
-- in-progress reconciliation posts nothing, so this has no accounting
-- effect; only the ticks of the abandoned duplicates are lost.
-- The duplicate set (every in-progress row but the newest of its account)
-- is the same in each statement below: nothing here changes a status, and
-- the headers are deleted last.
UPDATE bank_statement_lines bsl
SET match_status = 'unmatched', matched_journal_line_id = NULL,
    match_score = NULL, score_breakdown = NULL, updated_at = now()
FROM bank_statements bs
WHERE bs.id = bsl.statement_id
  AND bsl.match_status IN ('auto', 'confirmed')
  AND bs.reconciliation_id IN (
    SELECT id FROM (
      SELECT id, row_number() OVER (
        PARTITION BY tenant_id, account_id
        ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
      ) AS rn
      FROM reconciliations WHERE status = 'in_progress'
    ) ranked WHERE rn > 1
  );
--> statement-breakpoint
UPDATE bank_statements SET reconciliation_id = NULL
WHERE reconciliation_id IN (
  SELECT id FROM (
    SELECT id, row_number() OVER (
      PARTITION BY tenant_id, account_id
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
    ) AS rn
    FROM reconciliations WHERE status = 'in_progress'
  ) ranked WHERE rn > 1
);
--> statement-breakpoint
DELETE FROM reconciliation_lines
WHERE reconciliation_id IN (
  SELECT id FROM (
    SELECT id, row_number() OVER (
      PARTITION BY tenant_id, account_id
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
    ) AS rn
    FROM reconciliations WHERE status = 'in_progress'
  ) ranked WHERE rn > 1
);
--> statement-breakpoint
DELETE FROM reconciliations
WHERE id IN (
  SELECT id FROM (
    SELECT id, row_number() OVER (
      PARTITION BY tenant_id, account_id
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id DESC
    ) AS rn
    FROM reconciliations WHERE status = 'in_progress'
  ) ranked WHERE rn > 1
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_reconciliations_one_in_progress
  ON reconciliations (tenant_id, account_id) WHERE status = 'in_progress';
