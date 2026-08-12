-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Bank connection invites: a staff user emails/SMSes a client a tokenized
-- public link; the client connects their bank via Plaid Link with no login
-- (W-9 request pattern). The token itself is never stored — only its
-- SHA-256 — and one invite stays connectable for multiple institutions
-- until it expires or is revoked. connected_plaid_item_id has NO foreign
-- key: plaid_items is appliance-global (no tenant_id) and force-removal
-- paths delete rows outside this tenant's control.

CREATE TABLE IF NOT EXISTS bank_connect_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id uuid REFERENCES companies(id) ON DELETE SET NULL,
  recipient_name varchar(255) NOT NULL,
  recipient_email varchar(320),
  recipient_phone varchar(30),
  message text,
  token_hash varchar(64) NOT NULL,
  -- sent | viewed | connected | expired | revoked
  status varchar(20) NOT NULL DEFAULT 'sent',
  -- email | sms | both
  sent_via varchar(10) NOT NULL,
  expires_at timestamptz NOT NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  viewed_at timestamptz,
  connected_at timestamptz,
  connected_plaid_item_id uuid,
  connections_count integer NOT NULL DEFAULT 0,
  revoked_at timestamptz,
  revoked_by uuid,
  created_by uuid NOT NULL,
  created_by_name varchar(255),
  created_by_email varchar(255),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bci_token ON bank_connect_invites(token_hash);
CREATE INDEX IF NOT EXISTS idx_bci_tenant ON bank_connect_invites(tenant_id, status);
