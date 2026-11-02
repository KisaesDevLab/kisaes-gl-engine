-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Sales tax setup (U-147, U-148, U-25 sales-tax half; sales-tax-setup-v1,
-- sales-tax-rate6-v1, company-sales-tax-flags-v1).
-- 1. sales_tax_agencies (a vendor per agency), sales_tax_items (a rate or a
--    group of rates; legacy items, one per rate a document carried before
--    this migration), sales_tax_group_members, sales_tax_codes (Tax / Non
--    system codes per company), transaction_tax_lines (one row per document
--    and tax item: base and tax, signed by liability effect) and
--    sales_tax_payment_lines (opening paid lines here; Pay Sales Tax later).
-- 2. Columns: transactions.sales_tax_id, journal_lines.tax_code_id,
--    contacts.default_sales_tax_id / tax_code_id, items.tax_code_id,
--    companies.default_sales_tax_id / sales_tax_enabled (NULL = on) /
--    sales_tax_basis (accrual) / sales_tax_ssuta (false: Q-SPF6, existing
--    and MyBooks Online companies keep today's discount and write-off rules).
-- 3. Rates to 6 places (U-148): companies.default_sales_tax_rate and
--    journal_lines.tax_rate become unconstrained numeric (binary coercible:
--    no table rewrite) with a scale <= 6 CHECK added NOT VALID, then
--    VALIDATEd (a scan, no rewrite; ACCESS EXCLUSIVE only for the ALTER).
-- 4. Backfill (sales_tax_backfill_company, also called by a pre-0252
--    archive import): legacy items per stored rate, sale rows from each
--    posted invoice / sales receipt / credit memo's Sales Tax Payable lines
--    (a gap goes to an unassigned row, so rows = STP lines exactly), daily
--    sales STP lines as unassigned rows, the company default, opening paid
--    lines (rows - STP balance, oldest first) and one audit row per company.
--
-- Additive except the two rate type changes (TYPE_CHANGES in
-- tenant-portability/plan.ts). Ordering: after 0251 (finance charges).
-- Rollback: 0252_sales_tax_setup.rollback.sql.

ALTER TABLE companies ALTER COLUMN default_sales_tax_rate TYPE numeric;
--> statement-breakpoint
ALTER TABLE journal_lines ALTER COLUMN tax_rate TYPE numeric;
--> statement-breakpoint
ALTER TABLE companies ADD CONSTRAINT companies_default_sales_tax_rate_scale CHECK (default_sales_tax_rate IS NULL OR scale(default_sales_tax_rate) <= 6) NOT VALID;
--> statement-breakpoint
ALTER TABLE companies VALIDATE CONSTRAINT companies_default_sales_tax_rate_scale;
--> statement-breakpoint
ALTER TABLE journal_lines ADD CONSTRAINT journal_lines_tax_rate_scale CHECK (tax_rate IS NULL OR scale(tax_rate) <= 6) NOT VALID;
--> statement-breakpoint
ALTER TABLE journal_lines VALIDATE CONSTRAINT journal_lines_tax_rate_scale;
--> statement-breakpoint
ALTER TABLE companies ADD COLUMN IF NOT EXISTS default_sales_tax_id uuid;
--> statement-breakpoint
ALTER TABLE companies ADD COLUMN IF NOT EXISTS sales_tax_enabled boolean;
--> statement-breakpoint
ALTER TABLE companies ADD COLUMN IF NOT EXISTS sales_tax_basis varchar(10) NOT NULL DEFAULT 'accrual';
--> statement-breakpoint
ALTER TABLE companies ADD CONSTRAINT companies_sales_tax_basis_check CHECK (sales_tax_basis IN ('accrual', 'cash'));
--> statement-breakpoint
ALTER TABLE companies ADD COLUMN IF NOT EXISTS sales_tax_ssuta boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS sales_tax_id uuid;
--> statement-breakpoint
ALTER TABLE journal_lines ADD COLUMN IF NOT EXISTS tax_code_id uuid;
--> statement-breakpoint
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS default_sales_tax_id uuid;
--> statement-breakpoint
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS tax_code_id uuid;
--> statement-breakpoint
ALTER TABLE items ADD COLUMN IF NOT EXISTS tax_code_id uuid;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS sales_tax_agencies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  vendor_id uuid NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_tax_agency_vendor ON sales_tax_agencies (company_id, vendor_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_sales_tax_agency_tenant ON sales_tax_agencies (tenant_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS sales_tax_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  kind varchar(10) NOT NULL CHECK (kind IN ('item', 'group')),
  name varchar(100) NOT NULL,
  description text,
  rate numeric(7,6),
  agency_id uuid,
  legacy_rate numeric(7,6),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sales_tax_items_rate_check CHECK (rate IS NULL OR (rate >= 0 AND rate < 1)),
  CONSTRAINT sales_tax_items_item_rate CHECK (kind = 'group' OR rate IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_tax_item_name ON sales_tax_items (company_id, lower(name)) WHERE legacy_rate IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_tax_item_legacy ON sales_tax_items (company_id, legacy_rate);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_sales_tax_item_tenant ON sales_tax_items (tenant_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS sales_tax_group_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  group_id uuid NOT NULL,
  item_id uuid NOT NULL,
  sort_order integer NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_tax_group_member ON sales_tax_group_members (group_id, item_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_sales_tax_group_member_item ON sales_tax_group_members (company_id, item_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS sales_tax_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  code varchar(8) NOT NULL,
  name varchar(100) NOT NULL,
  taxable boolean NOT NULL,
  is_system boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_tax_code ON sales_tax_codes (company_id, lower(code));
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_sales_tax_code_tenant ON sales_tax_codes (tenant_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS transaction_tax_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  transaction_id uuid NOT NULL,
  kind varchar(10) NOT NULL CHECK (kind IN ('sale', 'discount', 'bad_debt', 'recovery')),
  event_date date NOT NULL,
  sales_tax_id uuid,
  tax_item_id uuid,
  agency_id uuid,
  tax_code_id uuid,
  invoice_id uuid,
  application_id uuid,
  rate numeric(7,6),
  base numeric(19,4) NOT NULL DEFAULT 0,
  tax numeric(19,4) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_txn_tax_lines_date ON transaction_tax_lines (company_id, event_date);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_txn_tax_lines_item ON transaction_tax_lines (company_id, tax_item_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_txn_tax_lines_txn ON transaction_tax_lines (transaction_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_txn_tax_lines_invoice ON transaction_tax_lines (invoice_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_txn_tax_lines_tenant ON transaction_tax_lines (tenant_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS sales_tax_payment_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  company_id uuid NOT NULL,
  transaction_id uuid,
  tax_item_id uuid,
  agency_id uuid,
  kind varchar(12) NOT NULL CHECK (kind IN ('paid', 'adjustment', 'opening')),
  line_date date NOT NULL,
  amount numeric(19,4) NOT NULL,
  account_id uuid,
  reason varchar(255),
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_st_payment_lines_company ON sales_tax_payment_lines (company_id, tax_item_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_st_payment_lines_txn ON sales_tax_payment_lines (transaction_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_st_payment_lines_tenant ON sales_tax_payment_lines (tenant_id);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION sales_tax_legacy_name(p_rate numeric) RETURNS text
LANGUAGE sql IMMUTABLE AS $fn$
  SELECT 'Sales tax ' || rtrim(rtrim(to_char(round(p_rate * 100, 4), 'FM9990.9999'), '0'), '.') || '%'
$fn$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION sales_tax_backfill_company(p_tenant uuid, p_company uuid) RETURNS jsonb
LANGUAGE plpgsql AS $fn$
DECLARE
  v_items integer := 0;
  v_rows integer := 0;
  v_unassigned integer := 0;
  v_default numeric;
  v_default_id uuid;
  v_rows_tax numeric;
  v_stp numeric;
  v_open numeric := 0;
  v_open_lines integer := 0;
BEGIN
  INSERT INTO sales_tax_codes (tenant_id, company_id, code, name, taxable, is_system)
  VALUES (p_tenant, p_company, 'Tax', 'Taxable', true, true), (p_tenant, p_company, 'Non', 'Non-taxable', false, true)
  ON CONFLICT DO NOTHING;

  -- Idempotent: a company that already has rows was backfilled (or posted
  -- through the new writers) and is left alone.
  IF EXISTS (SELECT 1 FROM transaction_tax_lines WHERE company_id = p_company) THEN
    RETURN jsonb_build_object('skipped', true);
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS st_bf_docs (id uuid PRIMARY KEY, txn_type varchar(30), txn_date date, stp numeric) ON COMMIT DROP;
  CREATE TEMP TABLE IF NOT EXISTS st_bf_rates (txn_id uuid, rate numeric, base numeric, tax numeric) ON COMMIT DROP;
  TRUNCATE st_bf_docs;
  TRUNCATE st_bf_rates;

  -- Documents of the company with a Sales Tax Payable line (S3). The
  -- reports' company predicate (t.company_id = the company): a transaction
  -- with no company_id is in no company's sales tax report, so it gets no
  -- rows and its STP lines do not count toward the opening paid lines below.
  INSERT INTO st_bf_docs (id, txn_type, txn_date, stp)
  SELECT t.id, t.txn_type, t.txn_date, SUM(jl.credit - jl.debit)
  FROM transactions t
  JOIN journal_lines jl ON jl.transaction_id = t.id AND jl.tenant_id = t.tenant_id
  JOIN accounts a ON a.id = jl.account_id AND a.tenant_id = jl.tenant_id
  WHERE t.tenant_id = p_tenant AND t.status = 'posted'
    AND t.company_id = p_company
    AND t.txn_type IN ('invoice', 'cash_sale', 'credit_memo', 'daily_sales')
    AND a.system_tag = 'sales_tax_payable' AND COALESCE(jl.is_void_reversal, false) = false
  GROUP BY t.id, t.txn_type, t.txn_date
  HAVING SUM(jl.credit - jl.debit) <> 0;

  -- Taxable lines by rate (memos negated: their line tax is stored positive).
  INSERT INTO st_bf_rates (txn_id, rate, base, tax)
  SELECT d.id, round(jl.tax_rate, 6), SUM(jl.credit - jl.debit),
    SUM(COALESCE(jl.tax_amount, 0)) * CASE WHEN d.txn_type = 'credit_memo' THEN -1 ELSE 1 END
  FROM st_bf_docs d
  JOIN journal_lines jl ON jl.transaction_id = d.id AND jl.tenant_id = p_tenant
  JOIN accounts a ON a.id = jl.account_id AND a.tenant_id = jl.tenant_id
  WHERE d.txn_type <> 'daily_sales' AND jl.is_taxable = true AND jl.tax_rate > 0 AND jl.tax_rate < 1
    AND COALESCE(a.system_tag, '') NOT IN ('sales_tax_payable', 'accounts_receivable')
    AND COALESCE(jl.is_void_reversal, false) = false
  GROUP BY d.id, d.txn_type, round(jl.tax_rate, 6);

  INSERT INTO sales_tax_items (tenant_id, company_id, kind, name, rate, legacy_rate)
  SELECT DISTINCT p_tenant, p_company, 'item', sales_tax_legacy_name(r.rate), r.rate, r.rate FROM st_bf_rates r
  ON CONFLICT (company_id, legacy_rate) DO NOTHING;
  GET DIAGNOSTICS v_items = ROW_COUNT;

  INSERT INTO transaction_tax_lines (tenant_id, company_id, transaction_id, kind, event_date, sales_tax_id, tax_item_id, rate, base, tax)
  SELECT p_tenant, p_company, r.txn_id, 'sale', d.txn_date, i.id, i.id, r.rate, r.base, r.tax
  FROM st_bf_rates r JOIN st_bf_docs d ON d.id = r.txn_id
  JOIN sales_tax_items i ON i.company_id = p_company AND i.legacy_rate = r.rate;
  GET DIAGNOSTICS v_rows = ROW_COUNT;

  -- The gap between a document's STP lines and its rows (and every daily
  -- sale's STP lines) is an unassigned row: rows = STP lines exactly.
  INSERT INTO transaction_tax_lines (tenant_id, company_id, transaction_id, kind, event_date, rate, base, tax)
  SELECT p_tenant, p_company, d.id, 'sale', d.txn_date, NULL, 0, d.stp - COALESCE(s.tax, 0)
  FROM st_bf_docs d LEFT JOIN (SELECT txn_id, SUM(tax) AS tax FROM st_bf_rates GROUP BY txn_id) s ON s.txn_id = d.id
  WHERE d.stp - COALESCE(s.tax, 0) <> 0;
  GET DIAGNOSTICS v_unassigned = ROW_COUNT;

  -- The company default: the legacy item for the default rate.
  SELECT default_sales_tax_rate INTO v_default FROM companies WHERE id = p_company;
  IF COALESCE(v_default, 0) > 0 AND v_default < 1 THEN
    INSERT INTO sales_tax_items (tenant_id, company_id, kind, name, rate, legacy_rate)
    VALUES (p_tenant, p_company, 'item', sales_tax_legacy_name(round(v_default, 6)), round(v_default, 6), round(v_default, 6))
    ON CONFLICT (company_id, legacy_rate) DO NOTHING;
    SELECT id INTO v_default_id FROM sales_tax_items WHERE company_id = p_company AND legacy_rate = round(v_default, 6);
    UPDATE companies SET default_sales_tax_id = v_default_id WHERE id = p_company AND default_sales_tax_id IS NULL;
  END IF;
  UPDATE companies SET sales_tax_enabled = true
  WHERE id = p_company AND sales_tax_enabled IS NULL AND (COALESCE(v_default, 0) > 0 OR v_rows + v_unassigned > 0);

  -- Opening paid lines (B2, Q-P23r): what the rows say is owed beyond the
  -- STP balance was paid before this migration (a check or JE debiting
  -- STP); written oldest row first until it is used up.
  SELECT COALESCE(SUM(tax), 0) INTO v_rows_tax FROM transaction_tax_lines WHERE company_id = p_company;
  SELECT COALESCE(SUM(jl.credit - jl.debit), 0) INTO v_stp
  FROM journal_lines jl
  JOIN transactions t ON t.id = jl.transaction_id AND t.tenant_id = jl.tenant_id
  JOIN accounts a ON a.id = jl.account_id AND a.tenant_id = jl.tenant_id
  WHERE jl.tenant_id = p_tenant AND t.status = 'posted' AND a.system_tag = 'sales_tax_payable'
    AND t.company_id = p_company;
  v_open := v_rows_tax - v_stp;
  IF v_open > 0 THEN
    INSERT INTO sales_tax_payment_lines (tenant_id, company_id, transaction_id, tax_item_id, agency_id, kind, line_date, amount, reason)
    SELECT p_tenant, p_company, NULL, x.tax_item_id, NULL, 'opening', MAX(x.event_date),
      SUM(LEAST(x.tax, v_open - (x.cum - x.tax))), 'Paid before sales tax setup'
    FROM (
      SELECT tax_item_id, event_date, tax, SUM(tax) OVER (ORDER BY event_date, created_at, id) AS cum
      FROM transaction_tax_lines WHERE company_id = p_company AND tax > 0
    ) x
    WHERE x.cum - x.tax < v_open
    GROUP BY x.tax_item_id;
    GET DIAGNOSTICS v_open_lines = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object('legacyItems', v_items, 'rows', v_rows, 'unassignedRows', v_unassigned,
    'openingPaid', to_char(GREATEST(v_open, 0), 'FM999999999999990.00'), 'openingLines', v_open_lines,
    'defaultSalesTaxId', v_default_id);
END
$fn$;
--> statement-breakpoint
DO $do$
DECLARE c record; r jsonb;
BEGIN
  FOR c IN SELECT tenant_id, id FROM companies ORDER BY tenant_id, created_at NULLS LAST, id LOOP
    r := sales_tax_backfill_company(c.tenant_id, c.id);
    INSERT INTO audit_log (tenant_id, company_id, action, entity_type, entity_id, after_data)
    VALUES (c.tenant_id, c.id, 'create', 'sales_tax_backfill', c.id, r);
  END LOOP;
END
$do$;
