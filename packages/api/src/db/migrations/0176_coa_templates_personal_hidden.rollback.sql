-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Un-hides the built-in `personal_activities` COA template.
UPDATE coa_templates SET is_hidden = false, updated_at = now()
WHERE slug = 'personal_activities' AND is_builtin = true;
