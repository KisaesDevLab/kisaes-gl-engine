-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- U-291b (ClientLedger P33, stale-all-v1): the record-stamp triggers of 0286
-- on every other stale-checked table (company settings, layouts, permission
-- templates, bank rules, drafts, learned layouts, companies' names, sales tax,
-- daily sales, JE templates, unit sets, price levels, recurring schedules),
-- with their child tables. Desktop connections only (mybooks.desktop = on).
-- Ignore lists: columns the engine maintains itself (utils/record-stamps.ts).
-- Backfill: NULL updated_at becomes created_at (or now). Additive only.

UPDATE companies SET updated_at = coalesce(created_at, now()) WHERE updated_at IS NULL;
--> statement-breakpoint
UPDATE recurring_schedules SET updated_at = coalesce(created_at, now()) WHERE updated_at IS NULL;
--> statement-breakpoint
UPDATE invoice_templates SET updated_at = coalesce(created_at, now()) WHERE updated_at IS NULL;
--> statement-breakpoint
UPDATE permission_templates SET updated_at = coalesce(created_at, now()) WHERE updated_at IS NULL;
--> statement-breakpoint
UPDATE conditional_rules SET updated_at = coalesce(created_at, now()) WHERE updated_at IS NULL;
--> statement-breakpoint
UPDATE document_drafts SET updated_at = coalesce(created_at, now()) WHERE updated_at IS NULL;
--> statement-breakpoint
UPDATE vendor_layout_templates SET updated_at = coalesce(created_at, now()) WHERE updated_at IS NULL;
--> statement-breakpoint
UPDATE tenants SET updated_at = coalesce(created_at, now()) WHERE updated_at IS NULL;
--> statement-breakpoint
UPDATE sales_tax_agencies SET updated_at = coalesce(created_at, now()) WHERE updated_at IS NULL;
--> statement-breakpoint
UPDATE sales_tax_codes SET updated_at = coalesce(created_at, now()) WHERE updated_at IS NULL;
--> statement-breakpoint
UPDATE sales_tax_items SET updated_at = coalesce(created_at, now()) WHERE updated_at IS NULL;
--> statement-breakpoint
UPDATE contact_tax_exemptions SET updated_at = coalesce(created_at, now()) WHERE updated_at IS NULL;
--> statement-breakpoint
UPDATE daily_sales_entries SET updated_at = coalesce(created_at, now()) WHERE updated_at IS NULL;
--> statement-breakpoint
UPDATE daily_sales_templates SET updated_at = coalesce(created_at, now()) WHERE updated_at IS NULL;
--> statement-breakpoint
UPDATE je_templates SET updated_at = coalesce(created_at, now()) WHERE updated_at IS NULL;
--> statement-breakpoint
UPDATE unit_sets SET updated_at = coalesce(created_at, now()) WHERE updated_at IS NULL;
--> statement-breakpoint
UPDATE price_levels SET updated_at = coalesce(created_at, now()) WHERE updated_at IS NULL;
--> statement-breakpoint
CREATE TRIGGER mybooks_stamp BEFORE UPDATE ON companies FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_stamp_header('invoice_next_number', 'remote_backup_last_at', 'remote_backup_last_status', 'remote_backup_last_size');
--> statement-breakpoint
CREATE TRIGGER mybooks_stamp_ins BEFORE INSERT ON companies FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_stamp_insert();
--> statement-breakpoint
CREATE TRIGGER mybooks_stamp BEFORE UPDATE ON recurring_schedules FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_stamp_header('next_occurrence', 'last_posted_at', 'remaining_count');
--> statement-breakpoint
CREATE TRIGGER mybooks_stamp_ins BEFORE INSERT ON recurring_schedules FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_stamp_insert();
--> statement-breakpoint
CREATE TRIGGER mybooks_stamp BEFORE UPDATE ON invoice_templates FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_stamp_header();
--> statement-breakpoint
CREATE TRIGGER mybooks_stamp_ins BEFORE INSERT ON invoice_templates FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_stamp_insert();
--> statement-breakpoint
CREATE TRIGGER mybooks_stamp BEFORE UPDATE ON permission_templates FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_stamp_header();
--> statement-breakpoint
CREATE TRIGGER mybooks_stamp_ins BEFORE INSERT ON permission_templates FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_stamp_insert();
--> statement-breakpoint
CREATE TRIGGER mybooks_stamp BEFORE UPDATE ON conditional_rules FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_stamp_header();
--> statement-breakpoint
CREATE TRIGGER mybooks_stamp_ins BEFORE INSERT ON conditional_rules FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_stamp_insert();
--> statement-breakpoint
CREATE TRIGGER mybooks_stamp BEFORE UPDATE ON document_drafts FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_stamp_header();
--> statement-breakpoint
CREATE TRIGGER mybooks_stamp_ins BEFORE INSERT ON document_drafts FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_stamp_insert();
--> statement-breakpoint
CREATE TRIGGER mybooks_stamp BEFORE UPDATE ON vendor_layout_templates FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_stamp_header('last_used_at', 'samples');
--> statement-breakpoint
CREATE TRIGGER mybooks_stamp_ins BEFORE INSERT ON vendor_layout_templates FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_stamp_insert();
--> statement-breakpoint
CREATE TRIGGER mybooks_stamp BEFORE UPDATE ON tenants FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_stamp_header();
--> statement-breakpoint
CREATE TRIGGER mybooks_stamp_ins BEFORE INSERT ON tenants FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_stamp_insert();
--> statement-breakpoint
CREATE TRIGGER mybooks_stamp BEFORE UPDATE ON sales_tax_agencies FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_stamp_header();
--> statement-breakpoint
CREATE TRIGGER mybooks_stamp_ins BEFORE INSERT ON sales_tax_agencies FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_stamp_insert();
--> statement-breakpoint
CREATE TRIGGER mybooks_stamp BEFORE UPDATE ON sales_tax_codes FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_stamp_header();
--> statement-breakpoint
CREATE TRIGGER mybooks_stamp_ins BEFORE INSERT ON sales_tax_codes FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_stamp_insert();
--> statement-breakpoint
CREATE TRIGGER mybooks_stamp BEFORE UPDATE ON sales_tax_items FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_stamp_header();
--> statement-breakpoint
CREATE TRIGGER mybooks_stamp_ins BEFORE INSERT ON sales_tax_items FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_stamp_insert();
--> statement-breakpoint
CREATE TRIGGER mybooks_stamp BEFORE UPDATE ON contact_tax_exemptions FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_stamp_header();
--> statement-breakpoint
CREATE TRIGGER mybooks_stamp_ins BEFORE INSERT ON contact_tax_exemptions FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_stamp_insert();
--> statement-breakpoint
CREATE TRIGGER mybooks_stamp BEFORE UPDATE ON daily_sales_entries FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_stamp_header();
--> statement-breakpoint
CREATE TRIGGER mybooks_stamp_ins BEFORE INSERT ON daily_sales_entries FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_stamp_insert();
--> statement-breakpoint
CREATE TRIGGER mybooks_stamp BEFORE UPDATE ON daily_sales_templates FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_stamp_header();
--> statement-breakpoint
CREATE TRIGGER mybooks_stamp_ins BEFORE INSERT ON daily_sales_templates FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_stamp_insert();
--> statement-breakpoint
CREATE TRIGGER mybooks_stamp BEFORE UPDATE ON je_templates FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_stamp_header();
--> statement-breakpoint
CREATE TRIGGER mybooks_stamp_ins BEFORE INSERT ON je_templates FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_stamp_insert();
--> statement-breakpoint
CREATE TRIGGER mybooks_stamp BEFORE UPDATE ON unit_sets FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_stamp_header();
--> statement-breakpoint
CREATE TRIGGER mybooks_stamp_ins BEFORE INSERT ON unit_sets FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_stamp_insert();
--> statement-breakpoint
CREATE TRIGGER mybooks_stamp BEFORE UPDATE ON price_levels FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_stamp_header();
--> statement-breakpoint
CREATE TRIGGER mybooks_stamp_ins BEFORE INSERT ON price_levels FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_stamp_insert();
--> statement-breakpoint
CREATE TRIGGER mybooks_stamp_child AFTER INSERT OR UPDATE OR DELETE ON daily_sales_entry_values FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_stamp_child('daily_sales_entries', 'entry_id');
--> statement-breakpoint
CREATE TRIGGER mybooks_stamp_child AFTER INSERT OR UPDATE OR DELETE ON daily_sales_template_lines FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_stamp_child('daily_sales_templates', 'template_id');
--> statement-breakpoint
CREATE TRIGGER mybooks_stamp_child AFTER INSERT OR UPDATE OR DELETE ON je_template_lines FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_stamp_child('je_templates', 'template_id');
--> statement-breakpoint
CREATE TRIGGER mybooks_stamp_child AFTER INSERT OR UPDATE OR DELETE ON unit_set_units FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_stamp_child('unit_sets', 'unit_set_id');
--> statement-breakpoint
CREATE TRIGGER mybooks_stamp_child AFTER INSERT OR UPDATE OR DELETE ON price_level_items FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_stamp_child('price_levels', 'price_level_id');
