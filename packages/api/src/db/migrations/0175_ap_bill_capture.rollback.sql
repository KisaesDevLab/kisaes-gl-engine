-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Drops the capture queue. Posted bills and their attachments survive: a
-- capture that reached 'entered' already re-linked its file to the bill.
-- Files of un-entered captures stay in `attachments` under
-- attachable_type 'bill_capture' (orphaned but recoverable).

DROP TABLE IF EXISTS bill_captures;
ALTER TABLE contacts DROP COLUMN IF EXISTS bill_lines_mode;
ALTER TABLE portal_contact_companies DROP COLUMN IF EXISTS bill_upload_access;
DELETE FROM tenant_feature_flags WHERE flag_key = 'AP_BILL_CAPTURE_V1';
