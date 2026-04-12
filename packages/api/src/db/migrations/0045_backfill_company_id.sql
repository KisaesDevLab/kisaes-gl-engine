-- Backfill company_id on all tables where it is NULL.
-- Assigns to the oldest company per tenant (correct for the common case
-- where a tenant starts with one company and adds more later).

-- Core transactional tables
UPDATE transactions t
SET company_id = (
  SELECT c.id FROM companies c
  WHERE c.tenant_id = t.tenant_id
  ORDER BY c.created_at
  LIMIT 1
)
WHERE t.company_id IS NULL;
--> statement-breakpoint
UPDATE journal_lines jl
SET company_id = (
  SELECT c.id FROM companies c
  WHERE c.tenant_id = jl.tenant_id
  ORDER BY c.created_at
  LIMIT 1
)
WHERE jl.company_id IS NULL;
--> statement-breakpoint
UPDATE bill_payment_applications bpa
SET company_id = (
  SELECT c.id FROM companies c
  WHERE c.tenant_id = bpa.tenant_id
  ORDER BY c.created_at
  LIMIT 1
)
WHERE bpa.company_id IS NULL;
--> statement-breakpoint
UPDATE vendor_credit_applications vca
SET company_id = (
  SELECT c.id FROM companies c
  WHERE c.tenant_id = vca.tenant_id
  ORDER BY c.created_at
  LIMIT 1
)
WHERE vca.company_id IS NULL;
--> statement-breakpoint
UPDATE payment_applications pa
SET company_id = (
  SELECT c.id FROM companies c
  WHERE c.tenant_id = pa.tenant_id
  ORDER BY c.created_at
  LIMIT 1
)
WHERE pa.company_id IS NULL;
--> statement-breakpoint
UPDATE contacts ct
SET company_id = (
  SELECT c.id FROM companies c
  WHERE c.tenant_id = ct.tenant_id
  ORDER BY c.created_at
  LIMIT 1
)
WHERE ct.company_id IS NULL;
--> statement-breakpoint
UPDATE items i
SET company_id = (
  SELECT c.id FROM companies c
  WHERE c.tenant_id = i.tenant_id
  ORDER BY c.created_at
  LIMIT 1
)
WHERE i.company_id IS NULL;
--> statement-breakpoint
UPDATE bank_connections bc
SET company_id = (
  SELECT c.id FROM companies c
  WHERE c.tenant_id = bc.tenant_id
  ORDER BY c.created_at
  LIMIT 1
)
WHERE bc.company_id IS NULL;
--> statement-breakpoint
UPDATE bank_feed_items bfi
SET company_id = (
  SELECT c.id FROM companies c
  WHERE c.tenant_id = bfi.tenant_id
  ORDER BY c.created_at
  LIMIT 1
)
WHERE bfi.company_id IS NULL;
--> statement-breakpoint
UPDATE reconciliations r
SET company_id = (
  SELECT c.id FROM companies c
  WHERE c.tenant_id = r.tenant_id
  ORDER BY c.created_at
  LIMIT 1
)
WHERE r.company_id IS NULL;
--> statement-breakpoint
UPDATE budgets b
SET company_id = (
  SELECT c.id FROM companies c
  WHERE c.tenant_id = b.tenant_id
  ORDER BY c.created_at
  LIMIT 1
)
WHERE b.company_id IS NULL;
--> statement-breakpoint
UPDATE tag_groups tg
SET company_id = (
  SELECT c.id FROM companies c
  WHERE c.tenant_id = tg.tenant_id
  ORDER BY c.created_at
  LIMIT 1
)
WHERE tg.company_id IS NULL;
--> statement-breakpoint
UPDATE tags t
SET company_id = (
  SELECT c.id FROM companies c
  WHERE c.tenant_id = t.tenant_id
  ORDER BY c.created_at
  LIMIT 1
)
WHERE t.company_id IS NULL;
--> statement-breakpoint
UPDATE transaction_tags tt
SET company_id = (
  SELECT c.id FROM companies c
  WHERE c.tenant_id = tt.tenant_id
  ORDER BY c.created_at
  LIMIT 1
)
WHERE tt.company_id IS NULL;
--> statement-breakpoint
UPDATE saved_report_filters srf
SET company_id = (
  SELECT c.id FROM companies c
  WHERE c.tenant_id = srf.tenant_id
  ORDER BY c.created_at
  LIMIT 1
)
WHERE srf.company_id IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_txn_tenant_company ON transactions (tenant_id, company_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_jl_tenant_company ON journal_lines (tenant_id, company_id);
