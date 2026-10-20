-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Portal live Profit & Loss — a portal contact may view a live P&L for a
-- linked company (date range, row drill-down, ask a question on a transaction).
-- Per contact per company, like the other portal access flags. Default off.

ALTER TABLE portal_contact_companies
  ADD COLUMN IF NOT EXISTS profit_loss_access boolean NOT NULL DEFAULT false;
