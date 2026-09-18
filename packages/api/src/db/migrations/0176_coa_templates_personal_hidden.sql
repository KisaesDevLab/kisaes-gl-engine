-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- The built-in `personal_activities` COA template is not a business chart
-- of accounts (balance sheet plus a few stray expense rows). Hide it from
-- the business-type dropdowns on existing installs; fresh installs seed it
-- hidden via bootstrapBuiltins(). Built-in template ACCOUNTS are re-synced
-- from BUSINESS_TEMPLATES at startup, so no account data changes here.
UPDATE coa_templates SET is_hidden = true, updated_at = now()
WHERE slug = 'personal_activities' AND is_builtin = true;
