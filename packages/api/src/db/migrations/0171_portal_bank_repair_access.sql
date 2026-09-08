-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Portal: "Can fix bank logins" per contact per company. Lets a client
-- re-authenticate a Plaid connection (Link update mode) from the client
-- portal when the bank asks for a fresh sign-in. Separate from
-- banking_access ("may see balances") — re-auth is a different act.

ALTER TABLE portal_contact_companies
  ADD COLUMN IF NOT EXISTS bank_repair_access boolean NOT NULL DEFAULT false;
