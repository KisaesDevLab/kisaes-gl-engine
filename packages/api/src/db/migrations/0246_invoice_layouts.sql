-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Invoice print layouts (U-130 invoice-layouts-v1).
--
-- A company keeps several named invoice layouts (e.g. Standard, Service with
-- dates, Product); exactly one is its default. invoice_templates already
-- holds name, is_default and company_id, so each row is a layout.
--
-- 1. invoice_templates.line_columns (jsonb): which line columns the printed
--    form shows. The default is today's form (description, quantity, rate;
--    amount always prints).
-- 2. transactions.invoice_layout_id (uuid, NULL = the company default): the
--    layout an invoice prints with. Soft reference (no FK), like the other
--    template references. Partial index for the in-use check.
-- 3. One default per company: where a company has several defaults (a race
--    of the lazy first write, U-111) the newest stays default; where it has
--    layouts but no default, the newest becomes default. Then a partial
--    unique index keeps it so. Legacy tenant-wide rows (company_id NULL) are
--    left alone.
-- 4. The seeded default named 'Default' is renamed 'Standard'.
--
-- Additive; idempotent. Ordering: after 0245. Rollback:
-- 0246_invoice_layouts.rollback.sql.

ALTER TABLE invoice_templates ADD COLUMN IF NOT EXISTS line_columns jsonb NOT NULL
  DEFAULT '{"item": false, "description": true, "serviceDate": false, "quantity": true, "rate": true}'::jsonb;
--> statement-breakpoint
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS invoice_layout_id uuid;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_txn_invoice_layout
  ON transactions (tenant_id, invoice_layout_id) WHERE invoice_layout_id IS NOT NULL;
--> statement-breakpoint
UPDATE invoice_templates t SET is_default = false
  FROM (
    SELECT id, row_number() OVER (PARTITION BY tenant_id, company_id ORDER BY updated_at DESC NULLS LAST, id) AS rn
    FROM invoice_templates WHERE company_id IS NOT NULL AND is_default IS TRUE
  ) d
  WHERE t.id = d.id AND d.rn > 1;
--> statement-breakpoint
UPDATE invoice_templates t SET is_default = true
  FROM (
    SELECT DISTINCT ON (tenant_id, company_id) id, tenant_id, company_id
    FROM invoice_templates WHERE company_id IS NOT NULL
    ORDER BY tenant_id, company_id, updated_at DESC NULLS LAST, id
  ) d
  WHERE t.id = d.id
    AND NOT EXISTS (
      SELECT 1 FROM invoice_templates x
      WHERE x.tenant_id = d.tenant_id AND x.company_id = d.company_id AND x.is_default IS TRUE
    );
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_invoice_templates_company_default
  ON invoice_templates (tenant_id, company_id) WHERE is_default IS TRUE AND company_id IS NOT NULL;
--> statement-breakpoint
UPDATE invoice_templates SET name = 'Standard' WHERE name = 'Default' AND is_default IS TRUE;
