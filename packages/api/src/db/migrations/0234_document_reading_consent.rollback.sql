-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Rollback for 0234 (document reading consent; U-92d). The code that reads
-- the switches must be rolled back with it. Lost: each company's
-- document_text_cloud / document_images_cloud choice (an absent key is off,
-- so cloud document reading stays off). Nothing else changes.

UPDATE companies
  SET ai_enabled_tasks = ai_enabled_tasks - 'document_text_cloud' - 'document_images_cloud'
  WHERE jsonb_typeof(ai_enabled_tasks) = 'object'
    AND (ai_enabled_tasks ? 'document_text_cloud' OR ai_enabled_tasks ? 'document_images_cloud');
--> statement-breakpoint
ALTER TABLE companies
  ALTER COLUMN ai_enabled_tasks SET DEFAULT '{"categorization":false,"receipt_ocr":false,"statement_parsing":false,"document_classification":false}'::jsonb;
