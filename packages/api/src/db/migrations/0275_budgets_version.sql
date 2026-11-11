-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Exact budgets (U-203, budgets-exact-v1; ClientLedger P28 PR-C). Additive:
-- one new column with a default.
--
-- budgets.version guards edits: every write to a budget or its lines
-- (PUT /budgets/:id, PUT /budgets/:id/lines, fill from actuals, copy,
-- adjust %) adds one, and a caller that sends the version it read gets
-- 409 STALE_VERSION when the budget changed since. Callers that send no
-- version (MyBooks Online today) keep last-write-wins. Existing rows start
-- at 1.
--
-- Backups and tenant archives carry the column with the row (budgets is
-- tenant-scoped; budget_lines is its child). Locking: ADD COLUMN with a
-- constant default is metadata-only on PostgreSQL 11+.
ALTER TABLE "budgets" ADD COLUMN IF NOT EXISTS "version" integer DEFAULT 1 NOT NULL
  CONSTRAINT "budgets_version_positive" CHECK ("version" >= 1);
