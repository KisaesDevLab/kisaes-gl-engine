-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
ALTER TABLE "companies" ADD COLUMN "smtp_host" varchar(255);--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "smtp_port" integer DEFAULT 587;--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "smtp_user" varchar(255);--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "smtp_pass" varchar(500);--> statement-breakpoint
ALTER TABLE "companies" ADD COLUMN "smtp_from" varchar(255);