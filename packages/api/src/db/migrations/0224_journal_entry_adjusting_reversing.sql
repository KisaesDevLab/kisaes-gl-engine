-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Journal entry adjusting flag and reversing link (ClientLedger U-60, U-61).
-- Additive only.
--
-- 1. transactions.is_adjusting (boolean, NOT NULL, default false): the entry
--    is an adjusting entry. Reports take adjusting=include|exclude|only.
--    Metadata-only ADD COLUMN (constant default, PostgreSQL 11+). The TB
--    module's AJEs (txn_type 'aje') are adjusting entries by definition, so
--    the existing ones are marked; the engine marks new ones when it posts
--    them. No other row changes.
-- 2. transactions.reverses_transaction_id (uuid, NULL): on an automatic
--    reversing entry, the journal entry it reverses. No FK (like
--    applied_to_invoice_id); tenant-scoped through the partial index. NULL
--    on every existing row.
--
-- Locking: the migrator runs pending migrations in one transaction, so the
-- ACCESS EXCLUSIVE lock on transactions is held until commit. Both ADD
-- COLUMNs are metadata-only; the cost under the lock is the AJE UPDATE (AJE
-- rows only) and the partial index build (one scan of transactions; the
-- index itself is empty). Desktop: migrations run before the engine serves.
-- Server: a short pause proportional to the transactions table.
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "is_adjusting" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "reverses_transaction_id" uuid;
--> statement-breakpoint
UPDATE "transactions" SET "is_adjusting" = true WHERE "txn_type" = 'aje' AND "is_adjusting" = false;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_txn_reverses" ON "transactions" ("tenant_id", "reverses_transaction_id")
  WHERE "reverses_transaction_id" IS NOT NULL;
