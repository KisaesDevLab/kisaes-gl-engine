-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- transaction_classification_state.matched_rule_id still referenced the
-- legacy bank_rules table, but the categorization pipeline records
-- conditional_rules ids there — so every rule-attribution upsert failed
-- the FK check and was swallowed by the pipeline's best-effort catch
-- (the column has stayed entirely NULL in prod). Repoint the FK.
-- The column is empty everywhere, so no data rewrite is needed.

ALTER TABLE transaction_classification_state
  DROP CONSTRAINT IF EXISTS transaction_classification_state_matched_rule_id_fkey;
--> statement-breakpoint
ALTER TABLE transaction_classification_state
  ADD CONSTRAINT transaction_classification_state_matched_rule_id_fkey
  FOREIGN KEY (matched_rule_id) REFERENCES conditional_rules(id) ON DELETE SET NULL;
