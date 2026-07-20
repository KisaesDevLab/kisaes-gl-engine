-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- CPA engagement letters / reports (SSARS 21). A `report_letter` is an
-- admin-authored, SYSTEM-level HTML template (shared across the appliance,
-- no tenant scoping) that references {{variables}} resolved at render time
-- from the tenant/company + the report pack's date range + basis. Two
-- system defaults are seeded here with accurate AICPA wording:
--   compilation  → AR-C 80 "Accountant's Compilation Report"
--   preparation  → AR-C 70 preparation-of-financial-statements disclaimer
-- `letter_type` is a bounded varchar (not an enum) so a later review
-- engagement (AR-C 90) can be added without a schema migration.
--
-- Report packs may reference one letter (report_packs.letter_id); when set,
-- the resolved letter renders as the FIRST content section of the pack.

CREATE TABLE IF NOT EXISTS report_letters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  -- compilation | preparation | review (review reserved for AR-C 90).
  letter_type VARCHAR(30) NOT NULL,
  -- WYSIWYG body with {{variables}}. HTML; variable VALUES are escaped at
  -- render time, the template body itself is authored by the super-admin.
  body_html TEXT NOT NULL DEFAULT '',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  -- Marks the seeded SSARS-21 system defaults.
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT report_letters_type_check
    CHECK (letter_type IN ('compilation', 'preparation', 'review'))
);

CREATE INDEX IF NOT EXISTS idx_report_letters_active_sort
  ON report_letters (is_active, sort_order);

-- A report pack may include one engagement letter, rendered as the first
-- content section. NULL = no letter. ON DELETE SET NULL so deleting a
-- template does not delete packs that referenced it.
ALTER TABLE report_packs
  ADD COLUMN IF NOT EXISTS letter_id UUID REFERENCES report_letters(id) ON DELETE SET NULL;

-- ── Seed SSARS-21 system defaults (only when the table is empty) ──

INSERT INTO report_letters (name, letter_type, body_html, is_active, is_default, sort_order)
SELECT
  'Accountant''s Compilation Report (AR-C 80)',
  'compilation',
  '<p>Management is responsible for the accompanying financial statements of {{client_name}}, which comprise the {{financial_statement_titles}} as of {{as_of_date}} and for the {{period_description}}, and the related notes to the financial statements in accordance with {{basis_of_accounting}}. I (We) have performed a compilation engagement in accordance with Statements on Standards for Accounting and Review Services promulgated by the Accounting and Review Services Committee of the AICPA. I (We) did not audit or review the financial statements nor was (were) I (we) required to perform any procedures to verify the accuracy or completeness of the information provided by management. Accordingly, I (we) do not express an opinion, a conclusion, nor provide any assurance on these financial statements.</p>' ||
  '<!-- OPTIONAL (special-purpose framework): when the financial statements are prepared on the tax or cash basis, add a paragraph identifying the framework and referring readers to the note that describes it. -->' ||
  '<!-- OPTIONAL (lack of independence, AR-C 80.28): if not independent, disclose it, e.g. "I am (We are) not independent with respect to {{client_name}}." -->' ||
  '<p>{{firm_name}}<br>{{firm_city_state}}<br>{{letter_date}}</p>',
  TRUE, TRUE, 0
WHERE NOT EXISTS (SELECT 1 FROM report_letters);

INSERT INTO report_letters (name, letter_type, body_html, is_active, is_default, sort_order)
SELECT
  'Preparation of Financial Statements (AR-C 70)',
  'preparation',
  '<p>The accompanying financial statements of {{client_name}} as of {{as_of_date}} and for the {{period_description}} were prepared in accordance with {{basis_of_accounting}}.</p>' ||
  '<p style="font-weight:bold;font-size:15px;">No assurance is provided on these financial statements.</p>',
  TRUE, TRUE, 1
WHERE NOT EXISTS (
  SELECT 1 FROM report_letters WHERE letter_type = 'preparation'
);
