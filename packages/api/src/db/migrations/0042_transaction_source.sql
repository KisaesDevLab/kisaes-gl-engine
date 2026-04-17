-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "source" varchar(30);
--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN IF NOT EXISTS "source_id" varchar(100);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_txn_source" ON "transactions" USING btree ("tenant_id","source","source_id");
