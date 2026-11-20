-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Rollback for 0289 (U-294). LOST: the change feed (clients fall back to a full reload).
DROP TRIGGER IF EXISTS mybooks_feed ON transactions;
DROP TRIGGER IF EXISTS mybooks_feed ON accounts;
DROP TRIGGER IF EXISTS mybooks_feed ON contacts;
DROP TRIGGER IF EXISTS mybooks_feed ON items;
DROP TRIGGER IF EXISTS mybooks_feed ON tags;
DROP TRIGGER IF EXISTS mybooks_feed ON tag_groups;
DROP TRIGGER IF EXISTS mybooks_feed ON companies;
DROP TRIGGER IF EXISTS mybooks_feed ON recurring_schedules;
DROP TRIGGER IF EXISTS mybooks_feed ON invoice_templates;
DROP TRIGGER IF EXISTS mybooks_feed ON permission_templates;
DROP TRIGGER IF EXISTS mybooks_feed ON conditional_rules;
DROP TRIGGER IF EXISTS mybooks_feed ON document_drafts;
DROP TRIGGER IF EXISTS mybooks_feed ON vendor_layout_templates;
DROP TRIGGER IF EXISTS mybooks_feed ON tenants;
DROP TRIGGER IF EXISTS mybooks_feed ON sales_tax_agencies;
DROP TRIGGER IF EXISTS mybooks_feed ON sales_tax_codes;
DROP TRIGGER IF EXISTS mybooks_feed ON sales_tax_items;
DROP TRIGGER IF EXISTS mybooks_feed ON contact_tax_exemptions;
DROP TRIGGER IF EXISTS mybooks_feed ON daily_sales_entries;
DROP TRIGGER IF EXISTS mybooks_feed ON daily_sales_templates;
DROP TRIGGER IF EXISTS mybooks_feed ON je_templates;
DROP TRIGGER IF EXISTS mybooks_feed ON unit_sets;
DROP TRIGGER IF EXISTS mybooks_feed ON price_levels;
DROP FUNCTION IF EXISTS mybooks_feed();
DROP TABLE IF EXISTS change_feed_state;
DROP TABLE IF EXISTS change_feed;
