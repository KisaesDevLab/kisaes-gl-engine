-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Rollback for the Tax Estimator taxpayers part (children first).
ALTER TABLE portal_contact_companies DROP COLUMN IF EXISTS tax_estimates_access;
DROP TABLE IF EXISTS tax_est_taxpayer_contacts;
DROP TABLE IF EXISTS tax_est_links;
DROP TABLE IF EXISTS tax_est_persons;
DROP TABLE IF EXISTS tax_est_taxpayers;
