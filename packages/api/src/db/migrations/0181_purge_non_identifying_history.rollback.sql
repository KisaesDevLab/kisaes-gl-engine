-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- 0181 deleted learned rows and cleared machine guesses. Neither can be
-- restored here: the learning is rebuilt from future confirmations, and the
-- cleared suggestions are re-derived by the rules, the statement importer
-- and the categorizer on the next pass. Rolling the SCHEMA back needs
-- nothing — 0181 changed no structure — so this file is deliberately a
-- no-op rather than a lie about what it can undo.

SELECT 1;
