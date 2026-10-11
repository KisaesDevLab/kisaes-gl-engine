-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for the Tax Estimator taxpayers part (children first).
ALTER TABLE portal_contact_companies DROP COLUMN IF EXISTS tax_estimates_access;
DROP TABLE IF EXISTS tax_est_taxpayer_contacts;
DROP TABLE IF EXISTS tax_est_links;
DROP TABLE IF EXISTS tax_est_persons;
DROP TABLE IF EXISTS tax_est_taxpayers;
