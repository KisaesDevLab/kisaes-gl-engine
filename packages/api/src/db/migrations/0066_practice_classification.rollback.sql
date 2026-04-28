-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
--
-- migration-policy: non-additive-exception
-- Reason: ROLLBACK file for 0066_practice_classification.sql. DROP is
-- the point of a rollback. Not registered in _journal.json; never
-- auto-applied. Any populated bucket assignments and cached vendor
-- enrichment are lost on apply.

DROP TABLE IF EXISTS transaction_classification_state;
DROP TABLE IF EXISTS vendor_enrichment_cache;
ALTER TABLE tenants DROP COLUMN IF EXISTS practice_settings;
