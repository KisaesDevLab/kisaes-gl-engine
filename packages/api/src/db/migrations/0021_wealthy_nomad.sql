CREATE TABLE IF NOT EXISTS "accountant_company_exclusions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "acct_excl_user_company_idx" ON "accountant_company_exclusions" USING btree ("user_id","company_id");