-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Rollback for 0287 (U-291b). Nothing is lost: backfilled stamps stay.
DROP TRIGGER IF EXISTS mybooks_stamp_child ON daily_sales_entry_values;
DROP TRIGGER IF EXISTS mybooks_stamp_child ON daily_sales_template_lines;
DROP TRIGGER IF EXISTS mybooks_stamp_child ON je_template_lines;
DROP TRIGGER IF EXISTS mybooks_stamp_child ON unit_set_units;
DROP TRIGGER IF EXISTS mybooks_stamp_child ON price_level_items;
DROP TRIGGER IF EXISTS mybooks_stamp_ins ON companies;
DROP TRIGGER IF EXISTS mybooks_stamp ON companies;
DROP TRIGGER IF EXISTS mybooks_stamp_ins ON recurring_schedules;
DROP TRIGGER IF EXISTS mybooks_stamp ON recurring_schedules;
DROP TRIGGER IF EXISTS mybooks_stamp_ins ON invoice_templates;
DROP TRIGGER IF EXISTS mybooks_stamp ON invoice_templates;
DROP TRIGGER IF EXISTS mybooks_stamp_ins ON permission_templates;
DROP TRIGGER IF EXISTS mybooks_stamp ON permission_templates;
DROP TRIGGER IF EXISTS mybooks_stamp_ins ON conditional_rules;
DROP TRIGGER IF EXISTS mybooks_stamp ON conditional_rules;
DROP TRIGGER IF EXISTS mybooks_stamp_ins ON document_drafts;
DROP TRIGGER IF EXISTS mybooks_stamp ON document_drafts;
DROP TRIGGER IF EXISTS mybooks_stamp_ins ON vendor_layout_templates;
DROP TRIGGER IF EXISTS mybooks_stamp ON vendor_layout_templates;
DROP TRIGGER IF EXISTS mybooks_stamp_ins ON tenants;
DROP TRIGGER IF EXISTS mybooks_stamp ON tenants;
DROP TRIGGER IF EXISTS mybooks_stamp_ins ON sales_tax_agencies;
DROP TRIGGER IF EXISTS mybooks_stamp ON sales_tax_agencies;
DROP TRIGGER IF EXISTS mybooks_stamp_ins ON sales_tax_codes;
DROP TRIGGER IF EXISTS mybooks_stamp ON sales_tax_codes;
DROP TRIGGER IF EXISTS mybooks_stamp_ins ON sales_tax_items;
DROP TRIGGER IF EXISTS mybooks_stamp ON sales_tax_items;
DROP TRIGGER IF EXISTS mybooks_stamp_ins ON contact_tax_exemptions;
DROP TRIGGER IF EXISTS mybooks_stamp ON contact_tax_exemptions;
DROP TRIGGER IF EXISTS mybooks_stamp_ins ON daily_sales_entries;
DROP TRIGGER IF EXISTS mybooks_stamp ON daily_sales_entries;
DROP TRIGGER IF EXISTS mybooks_stamp_ins ON daily_sales_templates;
DROP TRIGGER IF EXISTS mybooks_stamp ON daily_sales_templates;
DROP TRIGGER IF EXISTS mybooks_stamp_ins ON je_templates;
DROP TRIGGER IF EXISTS mybooks_stamp ON je_templates;
DROP TRIGGER IF EXISTS mybooks_stamp_ins ON unit_sets;
DROP TRIGGER IF EXISTS mybooks_stamp ON unit_sets;
DROP TRIGGER IF EXISTS mybooks_stamp_ins ON price_levels;
DROP TRIGGER IF EXISTS mybooks_stamp ON price_levels;
