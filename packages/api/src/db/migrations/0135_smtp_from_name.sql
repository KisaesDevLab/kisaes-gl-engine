-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Per-company SMTP From display name ("Acme Books <billing@acme.com>").
-- The system-level counterpart lives in system_settings (smtp_from_name)
-- and needs no migration. Additive: one nullable column.

ALTER TABLE companies ADD COLUMN IF NOT EXISTS smtp_from_name VARCHAR(255);
