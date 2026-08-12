-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.

DROP INDEX IF EXISTS idx_bci_repair_item;
ALTER TABLE bank_connect_invites DROP COLUMN IF EXISTS kind;
ALTER TABLE bank_connect_invites DROP COLUMN IF EXISTS repair_plaid_item_id;
ALTER TABLE bank_connect_invites DROP COLUMN IF EXISTS auto_sent;
ALTER TABLE plaid_config DROP COLUMN IF EXISTS auto_repair_invites;
