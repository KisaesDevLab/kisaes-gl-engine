-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Drops the report-ready financial statements tables. Published portal
-- copies (report_instances rows with source='financial_statements') are
-- removed too, since their PDFs are no longer tracked.

DELETE FROM report_instances WHERE source = 'financial_statements';
DROP INDEX IF EXISTS idx_report_instances_source;
ALTER TABLE report_instances DROP COLUMN IF EXISTS fs_report_version_id;
ALTER TABLE report_instances DROP COLUMN IF EXISTS source;
DROP TABLE IF EXISTS fs_cash_flow_overrides;
DROP TABLE IF EXISTS fs_report_versions;
DROP TABLE IF EXISTS fs_reports;
DROP TABLE IF EXISTS fs_company_layouts;
DROP TABLE IF EXISTS fs_layout_templates;
DROP TABLE IF EXISTS fs_style_presets;
DROP TABLE IF EXISTS fs_report_letters;
DROP TABLE IF EXISTS fs_firm_profiles;
DELETE FROM tenant_feature_flags WHERE flag_key = 'FINANCIAL_STATEMENTS_V1';
