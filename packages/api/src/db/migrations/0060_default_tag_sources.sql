-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
--
-- ADR 0XY + repo-alignment addendum §C: three default-tag sources feed
-- the resolver. Bank rules assign a tag at categorization time; items
-- carry a blanket default; vendor-type contacts carry a fallback default.
-- Every column is nullable and defaults to NULL — behavior is unchanged
-- until a tenant starts populating them.
--
-- Customer-type contacts are NOT a default-tag source per the resolved
-- product decision (ADR 0XY §2.1). We still store the column on the
-- unified `contacts` table because the repo does not split customers
-- from vendors; the service layer only consults the column when the
-- transaction's referenced contact has contact_type in ('vendor','both').

ALTER TABLE items
  ADD COLUMN default_tag_id uuid;

ALTER TABLE items
  ADD CONSTRAINT fk_items_default_tag_id
  FOREIGN KEY (default_tag_id) REFERENCES tags(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_items_default_tag_id
  ON items(default_tag_id)
  WHERE default_tag_id IS NOT NULL;

ALTER TABLE contacts
  ADD COLUMN default_tag_id uuid;

ALTER TABLE contacts
  ADD CONSTRAINT fk_contacts_default_tag_id
  FOREIGN KEY (default_tag_id) REFERENCES tags(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_contacts_default_tag_id
  ON contacts(default_tag_id)
  WHERE default_tag_id IS NOT NULL;

ALTER TABLE bank_rules
  ADD COLUMN assign_tag_id uuid;

ALTER TABLE bank_rules
  ADD CONSTRAINT fk_bank_rules_assign_tag_id
  FOREIGN KEY (assign_tag_id) REFERENCES tags(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_bank_rules_assign_tag_id
  ON bank_rules(assign_tag_id)
  WHERE assign_tag_id IS NOT NULL;
