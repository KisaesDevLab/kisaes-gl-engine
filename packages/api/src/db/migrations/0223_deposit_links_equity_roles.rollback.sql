-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for 0223 (deposit links, equity roles). The code reading these
-- must be rolled back with it. Deposit lines lose their source and
-- cash-back marks (deposit_lines rows stay). The equity role tags are
-- cleared; the accounts 0223 created stay as ordinary equity accounts,
-- because they may carry postings by then.
UPDATE "accounts" SET "system_tag" = NULL, "updated_at" = now()
WHERE "system_tag" IN ('owner_draw', 'owner_contribution', 'partner_draws', 'partner_contributions', 'shareholder_distributions', 'paid_in_capital');
--> statement-breakpoint
ALTER TABLE IF EXISTS "journal_lines" DROP COLUMN IF EXISTS "line_role";
--> statement-breakpoint
ALTER TABLE IF EXISTS "journal_lines" DROP COLUMN IF EXISTS "source_transaction_id";
