-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Release bills and vendor credits still held by VOIDED bill payments.
--
-- Before ap-edit-v1 (commit f0855137), voiding a bill payment from the check
-- register / transaction detail (POST /transactions/:id/void) ran the plain
-- ledger void: the payment and its journal lines were reversed, but its
-- bill_payment_applications / vendor_credit_applications rows were left in
-- place. The bills it paid therefore still read as paid (amount_paid,
-- balance_due, bill_status) and the Pay Bills screen offered nothing to pay.
-- The void path now removes those rows (bill-payment.service
-- voidBillPaymentInTx); this repairs the rows that the old path left behind.
--
-- For each bill / vendor credit holding an application of a void (or
-- deleted) payment, the stored amounts are recomputed exactly as
-- bill.service recomputeBillStatus / deposit-links recomputeVendorCreditBalance
-- do, counting only live payments; then the stale application rows are
-- removed — the same end state the current void path produces. The ledger
-- is not touched: the void already wrote its reversing journal lines.
--
-- Idempotent: a second run finds no stale rows and changes nothing.
-- Rollback: 0236_release_voided_bill_payments.rollback.sql (a no-op).

-- 1. Bills holding a payment or credit application of a void payment.
WITH affected AS (
  SELECT DISTINCT a.tenant_id, a.bill_id
  FROM bill_payment_applications a
  JOIN transactions p ON p.id = a.payment_id AND p.tenant_id = a.tenant_id
  WHERE p.status IN ('void', 'deleted')
  UNION
  SELECT DISTINCT v.tenant_id, v.bill_id
  FROM vendor_credit_applications v
  JOIN transactions p ON p.id = v.payment_id AND p.tenant_id = v.tenant_id
  WHERE p.status IN ('void', 'deleted')
),
sums AS (
  SELECT
    b.id,
    b.tenant_id,
    COALESCE(b.total, 0) AS total,
    COALESCE((
      SELECT SUM(a.amount) FROM bill_payment_applications a
      JOIN transactions p ON p.id = a.payment_id AND p.tenant_id = a.tenant_id
      WHERE a.bill_id = b.id AND a.tenant_id = b.tenant_id AND p.status NOT IN ('void', 'deleted')
    ), 0) AS paid,
    COALESCE((
      SELECT SUM(a.discount_amount) FROM bill_payment_applications a
      JOIN transactions p ON p.id = a.payment_id AND p.tenant_id = a.tenant_id
      WHERE a.bill_id = b.id AND a.tenant_id = b.tenant_id AND p.status NOT IN ('void', 'deleted')
    ), 0) AS discounts,
    COALESCE((
      SELECT SUM(v.amount) FROM vendor_credit_applications v
      JOIN transactions p ON p.id = v.payment_id AND p.tenant_id = v.tenant_id
      WHERE v.bill_id = b.id AND v.tenant_id = b.tenant_id AND p.status NOT IN ('void', 'deleted')
    ), 0) AS credits
  FROM transactions b
  JOIN affected x ON x.bill_id = b.id AND x.tenant_id = b.tenant_id
),
computed AS (
  SELECT id, tenant_id, paid, discounts, credits,
         GREATEST(total - paid - discounts - credits, 0) AS balance_due
  FROM sums
)
UPDATE transactions b
SET amount_paid     = c.paid,
    credits_applied = c.credits,
    balance_due     = c.balance_due,
    bill_status     = CASE
                        WHEN c.balance_due = 0 THEN 'paid'
                        WHEN c.paid > 0 OR c.discounts > 0 OR c.credits > 0 THEN 'partial'
                        ELSE 'unpaid'
                      END,
    paid_at         = CASE WHEN c.balance_due = 0 THEN b.paid_at ELSE NULL END,
    updated_at      = now()
FROM computed c
WHERE b.id = c.id AND b.tenant_id = c.tenant_id;
--> statement-breakpoint

-- 2. Vendor credits a void payment had applied.
WITH affected AS (
  SELECT DISTINCT v.tenant_id, v.credit_id
  FROM vendor_credit_applications v
  JOIN transactions p ON p.id = v.payment_id AND p.tenant_id = v.tenant_id
  WHERE p.status IN ('void', 'deleted')
),
sums AS (
  SELECT
    c.id,
    c.tenant_id,
    COALESCE(c.total, 0) AS total,
    COALESCE((
      SELECT SUM(v.amount) FROM vendor_credit_applications v
      JOIN transactions p ON p.id = v.payment_id AND p.tenant_id = v.tenant_id
      WHERE v.credit_id = c.id AND v.tenant_id = c.tenant_id AND p.status NOT IN ('void', 'deleted')
    ), 0)
    + COALESCE((
      SELECT SUM(dl.amount) FROM deposit_lines dl
      JOIN transactions d ON d.id = dl.deposit_id
      WHERE dl.source_transaction_id = c.id AND d.tenant_id = c.tenant_id AND d.status = 'posted'
    ), 0) AS used
  FROM transactions c
  JOIN affected x ON x.credit_id = c.id AND x.tenant_id = c.tenant_id
)
UPDATE transactions c
SET credits_applied = s.used,
    balance_due     = GREATEST(s.total - s.used, 0),
    bill_status     = CASE WHEN GREATEST(s.total - s.used, 0) = 0 THEN 'paid' ELSE 'unpaid' END,
    updated_at      = now()
FROM sums s
WHERE c.id = s.id AND c.tenant_id = s.tenant_id;
--> statement-breakpoint

-- 3. Remove the stale application rows (what the void path does today).
DELETE FROM bill_payment_applications a
USING transactions p
WHERE p.id = a.payment_id AND p.tenant_id = a.tenant_id
  AND p.status IN ('void', 'deleted');
--> statement-breakpoint
DELETE FROM vendor_credit_applications v
USING transactions p
WHERE p.id = v.payment_id AND p.tenant_id = v.tenant_id
  AND p.status IN ('void', 'deleted');
