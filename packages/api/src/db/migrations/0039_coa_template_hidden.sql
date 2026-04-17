-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
-- Add `is_hidden` to coa_templates so super admins can hide a
-- template (built-in or custom) from the registration / setup
-- business-type dropdowns without deleting it.
--
-- Hidden templates:
--   - DO NOT appear in the public /coa-templates/options endpoint
--     (driven by listOptions in coa-templates.service.ts), so they
--     vanish from RegisterPage, FirstRunSetupWizard, and any other
--     UI that drives the business-type picker from that endpoint.
--   - DO still appear in the admin list at /admin/coa-templates so
--     a super admin can un-hide them later.
--   - DO still seed correctly via getAccountsForSeed if a tenant
--     was already registered with what is now a hidden template
--     — hiding affects the picker, not historical data.

ALTER TABLE coa_templates
  ADD COLUMN IF NOT EXISTS is_hidden BOOLEAN NOT NULL DEFAULT false;
