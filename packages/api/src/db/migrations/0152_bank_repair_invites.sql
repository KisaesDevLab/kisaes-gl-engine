-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Repair invites: bank_connect_invites gains a kind ('connect' | 'repair').
-- A repair invite targets an EXISTING plaid_item whose login broke
-- (ITEM_LOGIN_REQUIRED / PENDING_EXPIRATION) and opens Plaid Link in update
-- mode instead of creating a new Item. repair_plaid_item_id has NO foreign
-- key for the same reason connected_plaid_item_id doesn't: plaid_items is
-- appliance-global and admin force-removal deletes rows outside this
-- tenant's control. auto_sent marks invites dispatched by the sync worker
-- (throttling counts these, manual sends are never throttled).
--
-- plaid_config.auto_repair_invites is the system-wide kill switch for the
-- worker auto-send (defaults on; manual repair links are unaffected).

ALTER TABLE bank_connect_invites ADD COLUMN IF NOT EXISTS kind varchar(10) NOT NULL DEFAULT 'connect';
ALTER TABLE bank_connect_invites ADD COLUMN IF NOT EXISTS repair_plaid_item_id uuid;
ALTER TABLE bank_connect_invites ADD COLUMN IF NOT EXISTS auto_sent boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_bci_repair_item ON bank_connect_invites(repair_plaid_item_id) WHERE repair_plaid_item_id IS NOT NULL;

ALTER TABLE plaid_config ADD COLUMN IF NOT EXISTS auto_repair_invites boolean NOT NULL DEFAULT true;
