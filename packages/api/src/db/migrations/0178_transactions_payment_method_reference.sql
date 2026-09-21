-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- How a payment was made and the reference the payer/payee knows it by
-- (ACH trace, card auth, the customer's check number). Pay Bills and
-- Receive Payment have always ASKED for these; until now the answers were
-- dropped on the floor, so a bill paid by ACH was indistinguishable from
-- one paid in cash once it posted.
--
-- payment_method holds the shared PAYMENT_METHODS values (check, ach,
-- credit_card, cash, other). A hand-written check is stored as 'check' —
-- print_status = 'hand_written' already carries that distinction.
--
-- No backfill: existing rows stay NULL and the display layer shows "Check"
-- when check_number / print_status is set. Neither column moves a balance,
-- so the gl_version_stamps triggers are untouched.

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS payment_method varchar(20);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS reference_number varchar(100);
