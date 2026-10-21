-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
-- migration-policy: non-additive-exception (recurring_schedules.template_transaction_id DROP NOT NULL; rollback restores it)
--
-- Memorized transactions without posting (ClientLedger U-62, templates-v1)
-- and the idempotent recurring catch-up run (U-63, recurring-run-due-v1).
--
-- 1. template_groups: folders for templates (name unique per company,
--    case-insensitive). A group has no schedule of its own.
-- 2. template_transactions: a draft that posts nothing. One row per
--    template: the header of its kind (check, expense, deposit, transfer,
--    journal_entry, daily_sales) or 'legacy' (a schedule made from a posted
--    transaction before 0225, or a kind templates can't hold: invoice,
--    bill...). Money is numeric(19,4). Names are unique per company among
--    live (not deleted) rows, case-insensitive. created_by / updated_by
--    name the template's owner: an auto run posts only while that user
--    (the last editor, else the creator) still holds the kind's write
--    permission; rows the data step makes have no owner and post as before.
-- 3. template_transaction_lines / template_transaction_tags: the draft's
--    lines and header tags. They stay out of every ledger query by
--    construction (no journal_lines, no transactions row).
-- 4. template_occurrences: one row per (template, date) handled by the
--    runner, "Enter now", skip or resolve. UNIQUE (template_id,
--    occurrence_date) is the exactly-once key.
-- 5. recurring_schedules: template_id (FK, one schedule per template),
--    remaining_count (NULL = no limit) and anchor_date (the day-of-month
--    anchor; NULL reads as start_date). template_transaction_id becomes
--    nullable (a desktop-made template has no posted source), with a CHECK
--    that one of the two is set.
--
-- Data step (backward compatible): every existing schedule gets a 'legacy'
-- template named after the schedule ('Recurring YYYY-MM-DD' when it has no
-- name; a clash gets " (2)", " (3)"...), carrying source_transaction_id =
-- template_transaction_id and the company of the schedule, else of its
-- source transaction, else the tenant's only company. Converting a legacy
-- row into a full draft happens in TypeScript (templates.service.ts). A
-- schedule that already has a template is left alone, so running the file
-- again changes nothing.
--
-- Locking cost: the new tables are created empty. recurring_schedules gets
-- three metadata-only ADD COLUMNs, a DROP NOT NULL (metadata only), one
-- UPDATE per existing schedule, a CHECK constraint (one scan of a small
-- table) and a partial unique index; it is a small table (one row per
-- schedule), so the ACCESS EXCLUSIVE lock is held briefly.
CREATE TABLE IF NOT EXISTS "template_groups" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "company_id" uuid,
  "name" varchar(100) NOT NULL,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_template_groups_name"
  ON "template_groups" ("tenant_id", COALESCE("company_id", '00000000-0000-0000-0000-000000000000'::uuid), lower("name"));
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "template_transactions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "company_id" uuid,
  "name" varchar(255) NOT NULL,
  "group_id" uuid REFERENCES "template_groups"("id") ON DELETE SET NULL,
  "kind" varchar(20) NOT NULL,
  "client_form" varchar(30),
  "account_id" uuid,
  "to_account_id" uuid,
  "contact_id" uuid,
  "amount" numeric(19, 4),
  "memo" text,
  "payee_name_on_check" varchar(255),
  "payee_address" text,
  "printed_memo" varchar(255),
  "print_later" boolean,
  "basis" varchar(10),
  "is_adjusting" boolean,
  "cash_back_account_id" uuid,
  "cash_back_amount" numeric(19, 4),
  "cash_back_memo" text,
  "daily_sales_template_id" uuid,
  "source_transaction_id" uuid,
  "version" integer DEFAULT 1 NOT NULL,
  "deleted_at" timestamp with time zone,
  "created_by" uuid,
  "updated_by" uuid,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  CONSTRAINT "template_transactions_kind_check"
    CHECK ("kind" IN ('check', 'expense', 'deposit', 'transfer', 'journal_entry', 'daily_sales', 'legacy')),
  CONSTRAINT "template_transactions_version_check" CHECK ("version" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_template_transactions_name"
  ON "template_transactions" ("tenant_id", COALESCE("company_id", '00000000-0000-0000-0000-000000000000'::uuid), lower("name"))
  WHERE "deleted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_template_transactions_scope" ON "template_transactions" ("tenant_id", "company_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "template_transaction_lines" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "company_id" uuid,
  "template_id" uuid NOT NULL REFERENCES "template_transactions"("id") ON DELETE CASCADE,
  "line_order" integer NOT NULL,
  "account_id" uuid,
  "amount" numeric(19, 4),
  "debit" numeric(19, 4) DEFAULT '0' NOT NULL,
  "credit" numeric(19, 4) DEFAULT '0' NOT NULL,
  "description" text,
  "contact_id" uuid,
  "tag_id" uuid,
  "is_billable" boolean DEFAULT false NOT NULL,
  "daily_sales_line_id" uuid,
  CONSTRAINT "template_transaction_lines_side_check"
    CHECK ("debit" >= 0 AND "credit" >= 0 AND NOT ("debit" > 0 AND "credit" > 0)),
  CONSTRAINT "template_transaction_lines_target_check"
    CHECK ("account_id" IS NOT NULL OR "daily_sales_line_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_template_transaction_lines_template"
  ON "template_transaction_lines" ("tenant_id", "template_id", "line_order");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "template_transaction_tags" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "template_id" uuid NOT NULL REFERENCES "template_transactions"("id") ON DELETE CASCADE,
  "tag_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_template_transaction_tags"
  ON "template_transaction_tags" ("template_id", "tag_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_template_transaction_tags_tenant"
  ON "template_transaction_tags" ("tenant_id", "template_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "template_occurrences" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "company_id" uuid,
  "template_id" uuid NOT NULL REFERENCES "template_transactions"("id") ON DELETE CASCADE,
  "schedule_id" uuid,
  "occurrence_date" date NOT NULL,
  "status" varchar(12) NOT NULL,
  "reason" varchar(40),
  "transaction_id" uuid,
  "run_id" uuid,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now(),
  "resolved_at" timestamp with time zone,
  CONSTRAINT "template_occurrences_status_check"
    CHECK ("status" IN ('posted', 'skipped', 'dismissed', 'entered', 'claiming'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_template_occurrences_date"
  ON "template_occurrences" ("template_id", "occurrence_date");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_template_occurrences_attention"
  ON "template_occurrences" ("tenant_id", "company_id")
  WHERE "status" IN ('skipped', 'claiming');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_template_occurrences_run"
  ON "template_occurrences" ("tenant_id", "run_id")
  WHERE "run_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "recurring_schedules" ADD COLUMN IF NOT EXISTS "template_id" uuid REFERENCES "template_transactions"("id");
--> statement-breakpoint
ALTER TABLE "recurring_schedules" ADD COLUMN IF NOT EXISTS "remaining_count" integer;
--> statement-breakpoint
ALTER TABLE "recurring_schedules" ADD COLUMN IF NOT EXISTS "anchor_date" date;
--> statement-breakpoint
ALTER TABLE "recurring_schedules" ALTER COLUMN "template_transaction_id" DROP NOT NULL;
--> statement-breakpoint
DO $$
DECLARE
  r record;
  zero constant uuid := '00000000-0000-0000-0000-000000000000';
  co uuid;
  base text;
  candidate text;
  n integer;
  new_id uuid;
BEGIN
  FOR r IN
    SELECT rs.id, rs.tenant_id, rs.company_id, rs.name, rs.created_at, rs.template_transaction_id,
           t.company_id AS txn_company_id,
           (SELECT CASE WHEN count(*) = 1 THEN min(c.id::text)::uuid END
              FROM companies c WHERE c.tenant_id = rs.tenant_id) AS only_company_id
    FROM recurring_schedules rs
    LEFT JOIN transactions t ON t.id = rs.template_transaction_id AND t.tenant_id = rs.tenant_id
    WHERE rs.template_id IS NULL
    ORDER BY rs.created_at ASC NULLS FIRST, rs.id ASC
  LOOP
    co := COALESCE(r.company_id, r.txn_company_id, r.only_company_id);
    base := left(COALESCE(NULLIF(btrim(r.name), ''),
                          'Recurring ' || to_char(COALESCE(r.created_at, now()), 'YYYY-MM-DD')), 240);
    candidate := base;
    n := 1;
    WHILE EXISTS (
      SELECT 1 FROM template_transactions x
      WHERE x.tenant_id = r.tenant_id AND COALESCE(x.company_id, zero) = COALESCE(co, zero)
        AND lower(x.name) = lower(candidate) AND x.deleted_at IS NULL
    ) LOOP
      n := n + 1;
      candidate := base || ' (' || n || ')';
    END LOOP;
    INSERT INTO template_transactions (tenant_id, company_id, name, kind, source_transaction_id)
    VALUES (r.tenant_id, co, candidate, 'legacy', r.template_transaction_id)
    RETURNING id INTO new_id;
    UPDATE recurring_schedules SET template_id = new_id WHERE id = r.id;
  END LOOP;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'recurring_schedules_template_check') THEN
    ALTER TABLE "recurring_schedules" ADD CONSTRAINT "recurring_schedules_template_check"
      CHECK ("template_id" IS NOT NULL OR "template_transaction_id" IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'recurring_schedules_remaining_count_check') THEN
    ALTER TABLE "recurring_schedules" ADD CONSTRAINT "recurring_schedules_remaining_count_check"
      CHECK ("remaining_count" IS NULL OR "remaining_count" >= 0);
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_recurring_schedules_template"
  ON "recurring_schedules" ("template_id") WHERE "template_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_recurring_schedules_due"
  ON "recurring_schedules" ("tenant_id", "next_occurrence") WHERE "is_active" = true;
