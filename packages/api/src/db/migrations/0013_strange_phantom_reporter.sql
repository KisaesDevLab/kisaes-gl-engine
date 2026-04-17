-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
ALTER TABLE "companies" ADD COLUMN "check_settings" jsonb DEFAULT '{"format":"voucher","bankName":"","bankAddress":"","routingNumber":"","accountNumber":"","fractionalRouting":"","printOnBlankStock":false,"printCompanyInfo":true,"printSignatureLine":true,"alignmentOffsetX":0,"alignmentOffsetY":0,"nextCheckNumber":1001,"defaultBankAccountId":null}';--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "check_number" integer;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "print_status" varchar(20);--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "payee_name_on_check" varchar(255);--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "payee_address" text;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "printed_memo" varchar(255);--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "printed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "transactions" ADD COLUMN "print_batch_id" uuid;