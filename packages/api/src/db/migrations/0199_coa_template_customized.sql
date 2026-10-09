-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Super admins can edit the accounts on a BUILT-IN chart-of-accounts
-- template. An edited built-in is marked customized so the startup re-sync
-- from the code constant (coa-templates.service bootstrapBuiltins) stops
-- overwriting it; "Reset to default" clears the flag. Additive.

ALTER TABLE coa_templates ADD COLUMN IF NOT EXISTS accounts_customized BOOLEAN NOT NULL DEFAULT false;
