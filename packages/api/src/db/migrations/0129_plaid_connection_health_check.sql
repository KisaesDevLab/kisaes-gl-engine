-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Seed the `plaid_connection_health` review check: flags a tenant's bank
-- connections that are in an error state (e.g. ITEM_LOGIN_REQUIRED) or
-- haven't synced in `staleDays` days — the status badge on the Banking
-- screen was passive, so broken connections went unnoticed while
-- transactions silently stopped arriving. Default-enabled: pure DB read,
-- no AI. Additive: single INSERT, idempotent via ON CONFLICT.

INSERT INTO check_registry (check_key, name, handler_name, default_severity, default_params, category) VALUES
  (
    'plaid_connection_health',
    'Bank connection broken or not syncing',
    'plaid_connection_health',
    'high',
    '{"staleDays":7}'::JSONB,
    'data'
  )
ON CONFLICT (check_key) DO NOTHING;
