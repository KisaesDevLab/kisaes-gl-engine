-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for the portal live P&L flag (0221). The code reading this
-- column must be rolled back with it; the grants are lost.
ALTER TABLE IF EXISTS portal_contact_companies DROP COLUMN IF EXISTS profit_loss_access;
