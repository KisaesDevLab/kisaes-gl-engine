-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.

-- Optional per-page footer text for a report pack's generated PDF. When set,
-- it prints on every page and overrides the tenant's default report footer.
ALTER TABLE report_packs
  ADD COLUMN IF NOT EXISTS page_footer varchar(500);
