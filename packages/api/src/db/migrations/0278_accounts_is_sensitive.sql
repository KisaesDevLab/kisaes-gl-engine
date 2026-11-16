-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Sensitive accounts (U-33, ClientLedger P29). An Admin marks an account
-- sensitive; the account and its sub-accounts are then hidden from anyone
-- without the `sensitive_accounts` right. Additive: one column, default
-- false, so nothing changes for any company until an Admin marks one.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS is_sensitive boolean NOT NULL DEFAULT false;
