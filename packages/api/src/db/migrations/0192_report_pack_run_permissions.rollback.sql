-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.

ALTER TABLE report_pack_runs DROP COLUMN IF EXISTS allow_transactions;
ALTER TABLE report_pack_runs DROP COLUMN IF EXISTS allow_attachments;
