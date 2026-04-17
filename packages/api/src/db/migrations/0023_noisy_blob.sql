-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
ALTER TABLE "bank_rules" ALTER COLUMN "tenant_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "bank_rules" ADD COLUMN "is_global" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "bank_rules" ADD COLUMN "assign_account_name" varchar(255);--> statement-breakpoint
ALTER TABLE "bank_rules" ADD COLUMN "assign_contact_name" varchar(255);