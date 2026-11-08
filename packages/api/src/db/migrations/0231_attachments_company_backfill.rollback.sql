-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Rollback for 0231 (attachments company backfill, U-90): a no-op. The
-- backfill only copied each file's company from the record it is filed on,
-- which the scope rule derives from that record anyway, and uploads since
-- then record their company too, so the two can't be told apart. Leaving
-- company_id in place keeps every file where it was.
SELECT 1;
