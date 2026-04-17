-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
-- Runtime-editable Chart of Accounts templates.
--
-- The static BUSINESS_TEMPLATES constant in @kis-books/shared is the factory
-- default. On first startup the API populates this table from those constants
-- (see packages/api/src/services/coa-templates.service.ts → bootstrapBuiltins).
-- After that, super admins can manage templates via /admin/coa-templates and
-- accounts.service.seedFromTemplate reads from this table.

CREATE TABLE IF NOT EXISTS "coa_templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "slug" varchar(100) NOT NULL,
  "label" varchar(255) NOT NULL,
  "accounts" jsonb NOT NULL,
  "is_builtin" boolean NOT NULL DEFAULT false,
  "created_by_user_id" uuid,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "idx_coa_templates_slug" ON "coa_templates" USING btree ("slug");
