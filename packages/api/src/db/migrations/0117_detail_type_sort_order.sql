-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.

-- Presentation order for tenant-defined custom detail types. NULL means
-- "no explicit position" — such rows sort after explicitly ordered ones
-- (ASC NULLS LAST) and tie-break by label, so newly created types land
-- at the end until the user reorders them in Settings → Detail Types.
-- Additive only (CLAUDE.md rule 13).

ALTER TABLE tenant_detail_types ADD COLUMN IF NOT EXISTS sort_order integer;
