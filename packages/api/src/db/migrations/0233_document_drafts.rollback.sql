-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for 0233 (document drafts, vendor layout templates, card last 4;
-- U-92). The code that reads them must be rolled back with it. Lost: every
-- unconverted draft's reading and claim (the files stay as draft
-- attachments), the learned vendor layouts and the card last 4 digits.
-- Posted transactions are untouched: a converted draft's bill, expense or
-- check and its attachments stay as they are.

DROP TABLE IF EXISTS vendor_layout_templates;
DROP TABLE IF EXISTS document_drafts;
ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_card_last4_chk;
ALTER TABLE accounts DROP COLUMN IF EXISTS card_last4;
