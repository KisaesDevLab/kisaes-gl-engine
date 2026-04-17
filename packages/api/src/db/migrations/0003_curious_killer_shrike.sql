-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
-- migration-policy: non-additive-exception
-- Drops the tenant_id FK on accounts + companies because a later
-- migration re-creates it with ON DELETE CASCADE semantics. The
-- drop-then-add is intentional; grandfathered since the migration is
-- already shipped. See scripts/check-migration-policy.sh.
ALTER TABLE "accounts" DROP CONSTRAINT "accounts_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "companies" DROP CONSTRAINT "companies_tenant_id_tenants_id_fk";
