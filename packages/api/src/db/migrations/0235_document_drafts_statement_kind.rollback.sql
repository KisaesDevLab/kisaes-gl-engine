-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- migration-policy: non-additive-exception
--
-- Rollback for 0235 (document drafts kind 'statement'; U-94). The code that
-- writes the kind must be rolled back with it. Lost: the statement label;
-- every statement draft becomes 'unknown' (its file, reading and status
-- stay). Nothing else changes.

UPDATE document_drafts SET kind = 'unknown' WHERE kind = 'statement';
--> statement-breakpoint
ALTER TABLE document_drafts
  DROP CONSTRAINT IF EXISTS document_drafts_kind_ck;
--> statement-breakpoint
ALTER TABLE document_drafts
  ADD CONSTRAINT document_drafts_kind_ck
  CHECK (kind IN ('bill', 'card_charge', 'check', 'cash_expense', 'unknown'));
