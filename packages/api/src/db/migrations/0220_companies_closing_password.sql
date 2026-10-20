-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Closing-date password (U-15). A bcrypt hash; NULL means no password is
-- set, which is every existing company, so the closed-period rules are
-- unchanged until an owner sets one. Additive only.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS closing_password_hash VARCHAR(255);
