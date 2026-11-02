-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for 0255 (exemption certificates, U-151). The code that reads
-- them must be rolled back with it. LOST: the certificates (number, state,
-- expiry, note, attachment link); the attachment files stay on the client.
DROP TABLE IF EXISTS contact_tax_exemptions;