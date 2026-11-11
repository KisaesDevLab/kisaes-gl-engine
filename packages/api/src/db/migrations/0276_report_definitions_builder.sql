-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- migration-policy: non-additive-exception
--
-- Report Builder definitions (U-118 / U-119, capability
-- report-defs-builder-v1; ClientLedger A07). report_definitions.kind adds
-- 'builder': report_definitions_kind_check is widened (dropped and re-added
-- with the extra value in this file); every existing row ('standard')
-- satisfies the new rule. The marker above is needed because the policy
-- check treats any constraint replacement as non-additive; no data changes.
-- Idempotent: the check is replaced only while it lacks 'builder'.
-- Locking: a brief ACCESS EXCLUSIVE on report_definitions (a small table)
-- while the CHECK is re-validated.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'report_definitions_kind_check' AND pg_get_constraintdef(oid) NOT LIKE '%builder%'
  ) THEN
    ALTER TABLE report_definitions DROP CONSTRAINT report_definitions_kind_check;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'report_definitions_kind_check') THEN
    ALTER TABLE report_definitions ADD CONSTRAINT report_definitions_kind_check
      CHECK (kind IN ('standard', 'builder'));
  END IF;
END $$;
