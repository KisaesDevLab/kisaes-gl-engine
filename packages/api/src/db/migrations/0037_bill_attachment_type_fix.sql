-- Fix: existing bill OCR attachments were re-linked under
-- attachable_type='transaction' by an earlier version of
-- /bills/:id/attach-draft. The convention used by every other
-- transaction type's detail page (and now bills) is to set
-- attachable_type to the transaction's `txn_type` value. This one-shot
-- migration converts any 'transaction'-typed attachments whose
-- underlying transaction is a bill so the new bill attachment panel
-- can find them.

UPDATE attachments
SET attachable_type = 'bill'
WHERE attachable_type = 'transaction'
  AND attachable_id IN (
    SELECT id FROM transactions WHERE txn_type = 'bill'
  );
