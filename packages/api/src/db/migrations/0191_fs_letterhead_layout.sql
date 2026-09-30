-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Letterhead layout options for report-ready financial statements: what
-- the letterhead shows (text, logo, or both) and how large the logo is
-- (small / medium / full width within the margins / edge to edge).
-- Additive; defaults keep today's look.

ALTER TABLE fs_firm_profiles ADD COLUMN IF NOT EXISTS letterhead_content VARCHAR(10) NOT NULL DEFAULT 'both';
ALTER TABLE fs_firm_profiles ADD COLUMN IF NOT EXISTS logo_size VARCHAR(15) NOT NULL DEFAULT 'small';
