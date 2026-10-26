-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Document reading consent (U-92d; capability document-assist-v1).
--
-- Two new per-company AI task switches in companies.ai_enabled_tasks:
--   document_text_cloud    the page text of a document may go to a cloud AI
--                          provider (POST /api/v1/document-reading/assist)
--   document_images_cloud  page images (at most 3 PNGs) may go too
-- Both are off for every company, existing ones included. receipt_ocr never
-- implies them, and accepting the company AI disclosure leaves them off
-- (ai-consent.service SENSITIVE_TASKS_OPT_IN). A key a company already has
-- is kept, so applying this file twice changes nothing.
--
-- Additive only: no column, table or index; the column default gains the
-- two keys. Rollback: 0234_document_reading_consent.rollback.sql.

UPDATE companies
  SET ai_enabled_tasks = '{"document_text_cloud":false,"document_images_cloud":false}'::jsonb || ai_enabled_tasks
  WHERE jsonb_typeof(ai_enabled_tasks) = 'object'
    AND NOT (ai_enabled_tasks ? 'document_text_cloud' AND ai_enabled_tasks ? 'document_images_cloud');
--> statement-breakpoint
ALTER TABLE companies
  ALTER COLUMN ai_enabled_tasks SET DEFAULT '{"categorization":false,"receipt_ocr":false,"statement_parsing":false,"document_classification":false,"document_text_cloud":false,"document_images_cloud":false}'::jsonb;
