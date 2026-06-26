-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.

-- Fine-grained progress stage for AI jobs, surfaced over the statement-import
-- SSE progress stream (queued | detecting | ocr | extracting | reconciling |
-- done | failed). Null for jobs that don't report stages. Additive (CLAUDE.md
-- rule 13).
ALTER TABLE ai_jobs
  ADD COLUMN IF NOT EXISTS stage varchar(20);
