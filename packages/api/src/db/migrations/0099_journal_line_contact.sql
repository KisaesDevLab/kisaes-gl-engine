-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
--
-- Per-line payee ("Received From") on journal lines. Additive: nullable
-- column + tenant-scoped index. Mirrors transactions.contact_id (no FK).
ALTER TABLE "journal_lines" ADD COLUMN IF NOT EXISTS "contact_id" uuid;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_jl_contact" ON "journal_lines" USING btree ("tenant_id","contact_id");
