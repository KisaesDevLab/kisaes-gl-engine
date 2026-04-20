-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
--
-- migration-policy: non-additive-exception
-- Reason: ROLLBACK file for 0060_default_tag_sources.sql. DROP COLUMN /
-- DROP INDEX / DROP CONSTRAINT are the whole point of a rollback. Not
-- registered in _journal.json; never auto-applied. Operator-only. Any
-- default-tag values set on items, contacts, or bank_rules are lost on
-- apply.

DROP INDEX IF EXISTS idx_bank_rules_assign_tag_id;
ALTER TABLE bank_rules
  DROP CONSTRAINT IF EXISTS fk_bank_rules_assign_tag_id;
ALTER TABLE bank_rules
  DROP COLUMN IF EXISTS assign_tag_id;

DROP INDEX IF EXISTS idx_contacts_default_tag_id;
ALTER TABLE contacts
  DROP CONSTRAINT IF EXISTS fk_contacts_default_tag_id;
ALTER TABLE contacts
  DROP COLUMN IF EXISTS default_tag_id;

DROP INDEX IF EXISTS idx_items_default_tag_id;
ALTER TABLE items
  DROP CONSTRAINT IF EXISTS fk_items_default_tag_id;
ALTER TABLE items
  DROP COLUMN IF EXISTS default_tag_id;
