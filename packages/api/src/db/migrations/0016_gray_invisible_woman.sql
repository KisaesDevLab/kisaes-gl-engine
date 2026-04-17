-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
ALTER TABLE "audit_log" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "journal_lines" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "saved_report_filters" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "tag_groups" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "tags" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "transaction_tags" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "email_templates" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "invoice_templates" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "bank_connections" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "bank_feed_items" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "reconciliations" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "recurring_schedules" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "items" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "payment_applications" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "bank_rules" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "duplicate_dismissals" ADD COLUMN "company_id" uuid;--> statement-breakpoint
ALTER TABLE "budgets" ADD COLUMN "company_id" uuid;