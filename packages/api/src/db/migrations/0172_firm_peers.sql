-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Vibe Practice Management integration ("one client portal"). A firm
-- registers ONE trusted peer (Vibe PM) by pasting its public key or a
-- JWKS URL; PM then calls /api/peer/pm/* with short-lived signed tokens
-- and renders MyBooks portal screens natively for the client. Nothing
-- secret is stored here — the key is public. pm_client_links map a PM
-- client entity to the exact (tenant, company, portal contact) whose
-- per-company permission flags govern what PM may do on its behalf.

CREATE TABLE IF NOT EXISTS firm_peers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  provider varchar(50) NOT NULL DEFAULT 'vibe_pm',
  -- Exact-match `iss` claim. Globally unique so a token resolves to
  -- exactly one firm without any firm hint in the request.
  issuer varchar(255) NOT NULL,
  -- Exactly one of the two is set while enabled. The PEM is the
  -- re-exported SPKI form of what the admin pasted (validated).
  public_key_pem text,
  jwks_url varchar(512),
  is_enabled boolean NOT NULL DEFAULT false,
  last_seen_at timestamptz,
  -- Enum, never token text: sig_invalid | unknown_kid | expired | replay |
  -- jwks_fetch_failed | no_link
  last_error varchar(40),
  last_error_at timestamptz,
  updated_by_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS firm_peers_firm_provider_idx ON firm_peers (firm_id, provider);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS firm_peers_issuer_idx ON firm_peers (issuer);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS pm_client_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id uuid NOT NULL REFERENCES firms(id) ON DELETE CASCADE,
  -- Opaque PM-side client entity id (PM's `client.id`).
  pm_client_id varchar(120) NOT NULL,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES portal_contacts(id) ON DELETE CASCADE,
  created_by_user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS pm_client_links_firm_client_idx ON pm_client_links (firm_id, pm_client_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_pm_client_links_tenant ON pm_client_links (tenant_id);
