-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.

-- Bank feed items get a real memo column. The review panel has always
-- offered a memo input, but the value was silently dropped (no column);
-- it only reached the books when categorize() stamped it on the posted
-- transaction. With the column in place: Plaid sync stores the bank's
-- raw payee text (payment_meta.payee) here so it displays in the memo
-- during review, user edits persist, and categorize() falls back to it.

ALTER TABLE bank_feed_items ADD COLUMN IF NOT EXISTS memo text;
