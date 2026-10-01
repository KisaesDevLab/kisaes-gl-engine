-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Report pack runs render in the worker, away from the request that asked
-- for them. The new source-document sections (bank statement files, the
-- Transaction Report with its attachments) must honour the REQUESTER's
-- permissions, so the run records them when it is created. Additive;
-- the defaults deny, so a run created before this migration never carries
-- files.

ALTER TABLE report_pack_runs ADD COLUMN IF NOT EXISTS allow_attachments BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE report_pack_runs ADD COLUMN IF NOT EXISTS allow_transactions BOOLEAN NOT NULL DEFAULT false;
