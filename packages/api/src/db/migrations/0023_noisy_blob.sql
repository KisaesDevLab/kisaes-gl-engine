-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
-- migration-policy: non-additive-exception
-- Global bank rules (is_global = true) have no owning tenant, so
-- tenant_id must be nullable. The rule engine + route layer enforce
-- tenant isolation at the query level. Grandfathered exception.
ALTER TABLE "bank_rules" ALTER COLUMN "tenant_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "bank_rules" ADD COLUMN "is_global" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "bank_rules" ADD COLUMN "assign_account_name" varchar(255);--> statement-breakpoint
ALTER TABLE "bank_rules" ADD COLUMN "assign_contact_name" varchar(255);