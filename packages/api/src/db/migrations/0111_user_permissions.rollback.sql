-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.

-- Rollback for 0111_user_permissions.sql
DROP TABLE IF EXISTS user_permissions;
DROP TABLE IF EXISTS permission_templates;
