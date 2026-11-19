-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Rollback for 0283 (U-284). LOST: the names of people who came in through
-- a transfer file; their ids stay on the rows (shown without a name), and a
-- later export of such a company by an engine without 0283 carries them as
-- ghost ids (only a super admin import accepts those).
DROP FUNCTION IF EXISTS mybooks_transfer_scrub(jsonb, jsonb, boolean);
DROP INDEX IF EXISTS uq_transfer_user_names_user;
DROP TABLE IF EXISTS transfer_user_names;
