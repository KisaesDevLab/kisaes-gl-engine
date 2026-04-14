-- Add a unique constraint on (transaction_id, tag_id) for transaction_tags.
--
-- tags.service.ts addTags/replaceTags has always emitted
--   INSERT ... ON CONFLICT (transaction_id, tag_id) DO NOTHING
-- but the table was created without any matching unique constraint
-- (see migration 0005). Postgres rejects the INSERT with 42P10
-- "there is no unique or exclusion constraint matching the ON CONFLICT
-- specification", breaking every attempt to tag a transaction.
--
-- Defensive de-duplication before creating the index in case historical
-- rows with duplicates exist (none expected, but migrations are immutable).
DELETE FROM transaction_tags t1
USING transaction_tags t2
WHERE t1.ctid < t2.ctid
  AND t1.transaction_id = t2.transaction_id
  AND t1.tag_id = t2.tag_id;

CREATE UNIQUE INDEX IF NOT EXISTS uq_transaction_tags_txn_tag
  ON transaction_tags (transaction_id, tag_id);
