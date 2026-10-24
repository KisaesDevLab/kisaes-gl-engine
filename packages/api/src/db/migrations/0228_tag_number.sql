-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Optional tag number (tag-number-v1), like accounts.account_number: up to
-- 20 characters, unique per tenant when set. Tags without a number stay
-- NULL and never collide (partial unique index). Additive only.

ALTER TABLE tags ADD COLUMN IF NOT EXISTS tag_number varchar(20);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_tenant_tag_number
  ON tags (tenant_id, tag_number)
  WHERE tag_number IS NOT NULL;
