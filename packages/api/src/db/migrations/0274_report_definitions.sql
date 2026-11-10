-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Saved report definitions (memorized reports) and their groups (U-118,
-- report-defs-v1; ClientLedger P28 PR-F, ADD-03 Q-310 / Q-312). Additive:
-- two new, empty tables.
--
-- 1. report_definition_groups: folders for saved reports, per company.
--    Names are unique per company among live (not deleted) rows,
--    case-insensitive. Soft delete; `version` guards edits (409 when stale).
-- 2. report_definitions: one saved report. `kind` is 'standard' (a catalog
--    report with its options) for now; the Report Builder (A07) widens the
--    named CHECK report_definitions_kind_check to add 'builder'.
--    definition_json is {schemaVersion, kind, reportKey, options}; entity
--    ids appear only at fixed option paths (routes/report-builder.routes.ts)
--    and are remapped by tenant archives like report_pack_items.options_json.
--    created_by is the author (only the author, an owner or a super admin
--    may change it, Q-310); names are unique per company among live rows,
--    case-insensitive. Soft delete; `version` guards edits.
--
-- Both tables are tenant-scoped (tenant_id), so backups and tenant
-- archives (the ClientLedger transfer file) carry them without other
-- changes. Locking: new tables only.
CREATE TABLE IF NOT EXISTS "report_definition_groups" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "name" varchar(100) NOT NULL,
  "sort" integer DEFAULT 0 NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_report_definition_groups_name"
  ON "report_definition_groups" ("tenant_id", "company_id", lower("name"))
  WHERE "deleted_at" IS NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "report_definitions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "group_id" uuid REFERENCES "report_definition_groups"("id") ON DELETE SET NULL,
  "name" varchar(200) NOT NULL,
  "kind" varchar(20) NOT NULL,
  "definition_json" jsonb NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "created_by" uuid,
  "updated_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone,
  CONSTRAINT "report_definitions_kind_check" CHECK ("kind" IN ('standard'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_report_definitions_name"
  ON "report_definitions" ("tenant_id", "company_id", lower("name"))
  WHERE "deleted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_report_definitions_group"
  ON "report_definitions" ("tenant_id", "company_id", "group_id")
  WHERE "deleted_at" IS NULL;
