-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Sales tax liability and pure-cash receipts (U-149, U-152; sales-tax-liability-v2,
-- cash-basis-spf-v1, daily-sales-tax-v1).
-- 1. daily_sales_template_lines.sales_tax_id (the template's one linked tax
--    line) and .tax_code_id (a sales line's code; NULL = taxable).
-- 2. The "Unapplied receipts" system account (income, system_tag
--    'unapplied_receipts'), one per tenant like every system role. Nothing
--    posts to it: the cash-basis virtual ledger re-points money received and
--    not yet applied to an invoice (a payment's unapplied remainder, held
--    customer deposits, their refunds and bounces) onto it (Q-SPF1).
-- 3. The `sales_tax` permission resource (added with 0252) is granted to every
--    permission template and per-user override set that has an `invoices`
--    level, at that level, so no existing bookkeeper or client user loses
--    access to sales tax screens they could reach before (absent = none).
-- Steps 2 and 3 live in sales_tax_liability_upgrade_tenant(), which a
-- pre-0253 archive import calls too. One audit row per tenant.
--
-- Additive. Ordering: after 0252 (sales tax setup).
-- Rollback: 0253_sales_tax_liability.rollback.sql.

ALTER TABLE daily_sales_template_lines ADD COLUMN IF NOT EXISTS sales_tax_id uuid;
--> statement-breakpoint
ALTER TABLE daily_sales_template_lines ADD COLUMN IF NOT EXISTS tax_code_id uuid;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION sales_tax_liability_upgrade_tenant(p_tenant uuid) RETURNS jsonb
LANGUAGE plpgsql AS $fn$
DECLARE
  v_account uuid;
  v_created boolean := false;
  v_templates integer := 0;
  v_overrides integer := 0;
BEGIN
  SELECT id INTO v_account FROM accounts WHERE tenant_id = p_tenant AND system_tag = 'unapplied_receipts' ORDER BY created_at, id LIMIT 1;
  IF v_account IS NULL THEN
    INSERT INTO accounts (tenant_id, company_id, account_number, name, account_type, detail_type, is_active, is_system, system_tag)
    SELECT p_tenant, NULL,
      CASE WHEN EXISTS (SELECT 1 FROM accounts x WHERE x.tenant_id = p_tenant AND x.account_number = '49900') THEN NULL ELSE '49900' END,
      'Unapplied receipts', 'revenue', 'service', true, true, 'unapplied_receipts'
    RETURNING id INTO v_account;
    v_created := true;
  END IF;

  UPDATE permission_templates
  SET permissions = permissions || jsonb_build_object('sales_tax', permissions -> 'invoices'), updated_at = now()
  WHERE tenant_id = p_tenant AND permissions ? 'invoices' AND NOT permissions ? 'sales_tax';
  GET DIAGNOSTICS v_templates = ROW_COUNT;

  UPDATE user_permissions
  SET overrides = overrides || jsonb_build_object('sales_tax', overrides -> 'invoices'), updated_at = now()
  WHERE tenant_id = p_tenant AND overrides ? 'invoices' AND NOT overrides ? 'sales_tax';
  GET DIAGNOSTICS v_overrides = ROW_COUNT;

  RETURN jsonb_build_object('unappliedReceiptsAccountId', v_account, 'accountCreated', v_created,
    'templatesGranted', v_templates, 'overridesGranted', v_overrides);
END
$fn$;
--> statement-breakpoint
DO $do$
DECLARE t record; r jsonb;
BEGIN
  FOR t IN SELECT id FROM tenants ORDER BY id LOOP
    r := sales_tax_liability_upgrade_tenant(t.id);
    INSERT INTO audit_log (tenant_id, action, entity_type, entity_id, after_data)
    VALUES (t.id, 'create', 'sales_tax_liability_upgrade', t.id, r);
  END LOOP;
END
$do$;
