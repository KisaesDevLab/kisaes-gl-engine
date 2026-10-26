-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Company intake settings (U-93, intake-settings-v1): the folders a desktop
-- client watches for bills and receipts, one list per company, read and
-- replaced through GET/PUT /api/v1/company/intake-settings. The value is
-- {"version":1,"folders":[...],"updatedAt":<ISO 8601 or null>}; updatedAt is
-- the optimistic-concurrency token of the list (not companies.updated_at).
--
-- Additive: a new NOT NULL column with a constant default, so existing rows
-- get the default without a table rewrite (PostgreSQL 11+ fast default).
ALTER TABLE companies ADD COLUMN IF NOT EXISTS intake_settings jsonb NOT NULL
  DEFAULT '{"version":1,"folders":[],"updatedAt":null}'::jsonb;
