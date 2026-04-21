-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
--
-- CLOUDFLARE_TUNNEL_PLAN Phase 6 — optional office-only staff access.
--
-- When enabled via STAFF_IP_ALLOWLIST_ENFORCED=1, /api/v1/* requests
-- from non-allowlisted IPs get a 403. Webhook paths are exempt by
-- mount-order (Stripe + Plaid routers sit BEFORE the allowlist
-- middleware in app.ts). Super-admin sessions bypass the check so a
-- wedged firm can recover via their break-glass account.
--
-- CIDR stored as TEXT rather than CIDR/inet so the value round-trips
-- unchanged through the API; we validate + parse in the service layer.

CREATE TABLE staff_ip_allowlist (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cidr text NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL
);

CREATE UNIQUE INDEX staff_ip_allowlist_cidr_unique ON staff_ip_allowlist(cidr);
