-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Document drafts by the entry they were entered as or attached to (U-180,
-- document-drafts-reopen-v1). Additive: one partial index.
--
--   idx_document_drafts_converted  converted drafts by entry: deleting an
--                                  entry (DELETE /transactions/:id, bank
--                                  feed Undo, ...) reopens its drafts in the
--                                  same database transaction and looks them
--                                  up here.
CREATE INDEX IF NOT EXISTS idx_document_drafts_converted
  ON document_drafts (tenant_id, converted_transaction_id)
  WHERE converted_transaction_id IS NOT NULL;