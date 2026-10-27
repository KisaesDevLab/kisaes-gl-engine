-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for 0235_release_voided_bill_payments: intentionally a no-op.
-- The migration only removed application rows of payments that are void
-- (the state the current void path produces) and recomputed the affected
-- bills and credits from what remained. Restoring those rows would mark the
-- bills paid by a voided payment again, which is the bug being repaired.

SELECT 1;
