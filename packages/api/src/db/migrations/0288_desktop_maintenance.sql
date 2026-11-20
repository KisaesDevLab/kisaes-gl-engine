-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- U-293 (ClientLedger P33, maintenance-v1): desktop maintenance mode, stored
-- in the database so it survives an engine restart. One row at most (id 1).
-- holder_session is the session chain (sessions.chain_id) that holds it;
-- only that session works while the row exists. cl-host clears it with
-- POST /api/v1/desktop/maintenance/reset after a file-level restore.
-- Install-wide (no tenant); never travels in tenant archives. Additive only.

CREATE TABLE IF NOT EXISTS desktop_maintenance (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  holder_session uuid NOT NULL,
  holder_user uuid NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now()
);