-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
-- Anonymous copy-paste share links for published financial reports.
-- Mirrors the public-invoice token (0047): a 160-bit bearer token stored
-- on the instance, resolvable without auth but ONLY while published.
ALTER TABLE report_instances
  ADD COLUMN IF NOT EXISTS share_token VARCHAR(64) UNIQUE;

CREATE UNIQUE INDEX IF NOT EXISTS idx_report_instances_share_token
  ON report_instances (share_token) WHERE share_token IS NOT NULL;
