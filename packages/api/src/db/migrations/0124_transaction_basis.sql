-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.

-- Per-transaction reporting basis. Lets a manual journal entry declare
-- whether it affects the cash basis, the accrual basis, or both. 'both' is
-- the default so every existing transaction keeps appearing on both cash-
-- and accrual-basis reports exactly as before (reporting parity).
--   accrual reports include basis IN ('accrual','both')  -> exclude 'cash'
--   cash reports    include basis IN ('cash','both')     -> exclude 'accrual'
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS basis varchar(10) NOT NULL DEFAULT 'both';

ALTER TABLE transactions
  DROP CONSTRAINT IF EXISTS transactions_basis_check;
ALTER TABLE transactions
  ADD CONSTRAINT transactions_basis_check CHECK (basis IN ('cash', 'accrual', 'both'));
