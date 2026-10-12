-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Per-client (per-tenant) notify list for the "<Client>: <Contact> categorized
-- N transactions" email (Kurt, 2026-10-12). Until now that email went to every
-- reviewer with access to the client; it now goes only to the users listed
-- here, and a client with no row (or an empty list) sends NO email — the
-- suggestions still show as unread on the Uncategorized screen.
--
-- Additive only: a new table. Existing clients start with no row = no email.
-- notify_user_ids holds user ids (jsonb array), validated in the service as
-- active staff users with active access to the tenant, and re-checked at
-- send time — same contract as recurring_document_requests.notify_user_ids.
CREATE TABLE IF NOT EXISTS suggestion_notify_settings (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  notify_user_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_by UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
