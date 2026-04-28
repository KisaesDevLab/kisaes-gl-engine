-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- migration-policy: non-additive-exception
--
-- Rollback for 0093_firm_tag_templates. DROP TABLE is the point
-- of a rollback. Not registered in _journal.json; never auto-
-- applied. Any persisted firm_tag_templates +
-- tenant_firm_tag_bindings rows are lost; global_firm rules
-- referencing tagTemplateKeys silently drop their set_tag
-- actions until re-applied.

DROP TABLE IF EXISTS tenant_firm_tag_bindings;
DROP TABLE IF EXISTS firm_tag_templates;
