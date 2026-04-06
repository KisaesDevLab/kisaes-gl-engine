-- Add original_description column to bank_feed_items
ALTER TABLE "bank_feed_items" ADD COLUMN IF NOT EXISTS "original_description" varchar(500);

-- Backfill: copy existing description to original_description
UPDATE "bank_feed_items" SET "original_description" = "description" WHERE "original_description" IS NULL;
