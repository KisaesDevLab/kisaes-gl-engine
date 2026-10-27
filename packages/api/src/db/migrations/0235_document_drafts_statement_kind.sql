-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- migration-policy: non-additive-exception
--
-- Document drafts: kind 'statement' (U-94; capability
-- document-drafts-statement-v1). A bank or card statement a client filed
-- for the owner to review; a label only, it never converts or attaches.
--
-- The widening is strictly additive: no value is removed and no existing
-- row is invalidated. The marker is needed because the migration policy
-- check treats any constraint replacement as non-additive (the 0087
-- precedent). Rollback: 0235_document_drafts_statement_kind.rollback.sql.

ALTER TABLE document_drafts
  DROP CONSTRAINT IF EXISTS document_drafts_kind_ck;
--> statement-breakpoint
ALTER TABLE document_drafts
  ADD CONSTRAINT document_drafts_kind_ck
  CHECK (kind IN ('bill', 'card_charge', 'check', 'cash_expense', 'unknown', 'statement'));
