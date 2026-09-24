-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Pin a portal session to the address its holder actually proved control of.
--
-- Switching between firms was authorised by comparing the TARGET contact's
-- email to the CURRENT contact's email column. That column is mutable:
-- `PUT /practice/portal/contacts/:id` lets any non-readonly staff user of a
-- tenant change it, and nothing invalidated the sessions minted before the
-- change. A staff user could therefore create a contact with an address they
-- control, sign in as it, repoint that contact at a victim's address in an
-- unrelated tenant, and switch into the victim's portal.
--
-- The session now records the address it was minted against, and the switch
-- compares against that instead. A session with no recorded address (issued
-- before this migration) cannot use the email path at all; those expire
-- within the 24-hour session TTL.

ALTER TABLE portal_contact_sessions
  ADD COLUMN IF NOT EXISTS verified_email varchar(320);
