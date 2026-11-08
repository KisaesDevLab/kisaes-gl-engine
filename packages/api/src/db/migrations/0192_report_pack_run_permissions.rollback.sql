-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.

ALTER TABLE report_pack_runs DROP COLUMN IF EXISTS allow_transactions;
ALTER TABLE report_pack_runs DROP COLUMN IF EXISTS allow_attachments;
