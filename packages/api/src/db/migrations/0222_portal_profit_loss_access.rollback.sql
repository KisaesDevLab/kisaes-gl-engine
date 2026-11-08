-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Rollback for the portal live P&L flag (0222). The code reading this
-- column must be rolled back with it; the grants are lost.
ALTER TABLE IF EXISTS portal_contact_companies DROP COLUMN IF EXISTS profit_loss_access;
