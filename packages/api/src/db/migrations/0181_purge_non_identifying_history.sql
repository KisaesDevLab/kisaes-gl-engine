-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Learned categorization history is keyed on the CLEANED bank description.
-- "CHECK 3662" cleans to "check" — the same key for every cheque a client
-- ever wrote — so one confirmation taught the system that every future
-- cheque was written to that payee. Reported from production: an account's
-- cheques all showing "Benton County Sheriff Office", with the statement
-- importer's correct payee never getting a look in. The same held for
-- "deposit" (4,964 confirmations on one tenant), "pay", and card masks
-- like "xx1419".
--
-- The code no longer learns or matches such keys (isIdentifyingPattern).
-- This clears what was already learned, and the guesses it produced on rows
-- that have not posted. Nothing posted to the ledger is touched: only
-- suggested_* columns on pending/assigned bank feed items, and the learned
-- rows themselves, which the system rebuilds from future confirmations.

-- 1. The poisoned learning. A pattern is non-identifying when every one of
--    its alphabetic words is a generic banking word, when it has no letters
--    at all (a bare reference number), or when it is a card mask.
DELETE FROM categorization_history h
WHERE h.payee_pattern ~ '^[x*#]+ *[0-9]+$'
   OR NOT EXISTS (
        SELECT 1
        FROM unnest(regexp_split_to_array(lower(h.payee_pattern), '[^a-z]+')) AS w
        WHERE w <> ''
          AND w NOT IN (
            'check','checks','cheque','cheques','draft','drafts',
            'deposit','deposits','withdrawal','withdrawals','withdrawl',
            'transfer','transfers','payment','payments','pay',
            'debit','debits','credit','credits','card','purchase','purchases',
            'ach','eft','pos','atm','fee','fees','interest','misc','other'
          )
      );
--> statement-breakpoint

-- 2. The guesses it left on rows nobody has posted yet, so the statement
--    importer and the rules can fill them properly.
UPDATE bank_feed_items b
SET suggested_contact_id = NULL,
    suggested_account_id = NULL,
    confidence_score = NULL,
    match_type = NULL,
    updated_at = NOW()
WHERE b.match_type = 'history'
  AND b.status IN ('pending', 'assigned')
  AND (
    b.description ~* '^[x*#]+ *[0-9]+$'
    OR NOT EXISTS (
      SELECT 1
      FROM unnest(regexp_split_to_array(lower(COALESCE(b.description, '')), '[^a-z]+')) AS w
      WHERE w <> ''
        AND w NOT IN (
          'check','checks','cheque','cheques','draft','drafts',
          'deposit','deposits','withdrawal','withdrawals','withdrawl',
          'transfer','transfers','payment','payments','pay',
          'debit','debits','credit','credits','card','purchase','purchases',
          'ach','eft','pos','atm','fee','fees','interest','misc','other'
        )
    )
  );
