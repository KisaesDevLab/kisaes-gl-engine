-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- U-294 (ClientLedger P33, changes-v1): the desktop change feed.
--
-- change_feed: one row per changed record (ids and kinds only: no amounts,
-- names or memos), written by AFTER ROW triggers on the stale-checked tables
-- that run only on desktop connections (mybooks.desktop = on), so the server
-- appliance pays nothing. A row carries the writing transaction's id
-- (pg_current_xact_id()). Readers return the rows with
-- prev_horizon <= xid < pg_snapshot_xmin(pg_current_snapshot()): every
-- transaction below the horizon has committed or aborted, so a reader never
-- skips a late commit, and no counter row is locked by writers (no
-- deadlock, B4). An UPDATE is fed only when it moved the record's stamp
-- (a posting's balance update does not).
--
-- change_feed_state: one row. epoch changes on a maintenance reset (after a
-- file-level restore) and on an archive import; pruned_below is the horizon
-- under which rows were deleted (7-day retention). Additive only.

CREATE TABLE IF NOT EXISTS change_feed (
  id bigserial PRIMARY KEY,
  xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
  tenant_id uuid,
  company_id uuid,
  kind varchar(40) NOT NULL,
  entity_id uuid NOT NULL,
  op varchar(10) NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_change_feed_xid ON change_feed (xid);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_change_feed_at ON change_feed (at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS change_feed_state (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  epoch uuid NOT NULL DEFAULT gen_random_uuid(),
  pruned_below xid8 NOT NULL DEFAULT '0'::xid8
);
--> statement-breakpoint
INSERT INTO change_feed_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION mybooks_feed() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  r jsonb;
  op text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at THEN RETURN NULL; END IF;
  IF TG_OP = 'DELETE' THEN r := to_jsonb(OLD); op := 'delete'; ELSE r := to_jsonb(NEW); op := 'upsert'; END IF;
  INSERT INTO change_feed (tenant_id, company_id, kind, entity_id, op)
  VALUES (
    CASE WHEN TG_TABLE_NAME = 'tenants' THEN (r ->> 'id')::uuid ELSE (r ->> 'tenant_id')::uuid END,
    (r ->> 'company_id')::uuid,
    TG_TABLE_NAME,
    (r ->> 'id')::uuid,
    op
  );
  RETURN NULL;
END $$;
--> statement-breakpoint
CREATE TRIGGER mybooks_feed AFTER INSERT OR UPDATE OR DELETE ON transactions FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_feed();
--> statement-breakpoint
CREATE TRIGGER mybooks_feed AFTER INSERT OR UPDATE OR DELETE ON accounts FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_feed();
--> statement-breakpoint
CREATE TRIGGER mybooks_feed AFTER INSERT OR UPDATE OR DELETE ON contacts FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_feed();
--> statement-breakpoint
CREATE TRIGGER mybooks_feed AFTER INSERT OR UPDATE OR DELETE ON items FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_feed();
--> statement-breakpoint
CREATE TRIGGER mybooks_feed AFTER INSERT OR UPDATE OR DELETE ON tags FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_feed();
--> statement-breakpoint
CREATE TRIGGER mybooks_feed AFTER INSERT OR UPDATE OR DELETE ON tag_groups FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_feed();
--> statement-breakpoint
CREATE TRIGGER mybooks_feed AFTER INSERT OR UPDATE OR DELETE ON companies FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_feed();
--> statement-breakpoint
CREATE TRIGGER mybooks_feed AFTER INSERT OR UPDATE OR DELETE ON recurring_schedules FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_feed();
--> statement-breakpoint
CREATE TRIGGER mybooks_feed AFTER INSERT OR UPDATE OR DELETE ON invoice_templates FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_feed();
--> statement-breakpoint
CREATE TRIGGER mybooks_feed AFTER INSERT OR UPDATE OR DELETE ON permission_templates FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_feed();
--> statement-breakpoint
CREATE TRIGGER mybooks_feed AFTER INSERT OR UPDATE OR DELETE ON conditional_rules FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_feed();
--> statement-breakpoint
CREATE TRIGGER mybooks_feed AFTER INSERT OR UPDATE OR DELETE ON document_drafts FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_feed();
--> statement-breakpoint
CREATE TRIGGER mybooks_feed AFTER INSERT OR UPDATE OR DELETE ON vendor_layout_templates FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_feed();
--> statement-breakpoint
CREATE TRIGGER mybooks_feed AFTER INSERT OR UPDATE OR DELETE ON tenants FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_feed();
--> statement-breakpoint
CREATE TRIGGER mybooks_feed AFTER INSERT OR UPDATE OR DELETE ON sales_tax_agencies FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_feed();
--> statement-breakpoint
CREATE TRIGGER mybooks_feed AFTER INSERT OR UPDATE OR DELETE ON sales_tax_codes FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_feed();
--> statement-breakpoint
CREATE TRIGGER mybooks_feed AFTER INSERT OR UPDATE OR DELETE ON sales_tax_items FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_feed();
--> statement-breakpoint
CREATE TRIGGER mybooks_feed AFTER INSERT OR UPDATE OR DELETE ON contact_tax_exemptions FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_feed();
--> statement-breakpoint
CREATE TRIGGER mybooks_feed AFTER INSERT OR UPDATE OR DELETE ON daily_sales_entries FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_feed();
--> statement-breakpoint
CREATE TRIGGER mybooks_feed AFTER INSERT OR UPDATE OR DELETE ON daily_sales_templates FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_feed();
--> statement-breakpoint
CREATE TRIGGER mybooks_feed AFTER INSERT OR UPDATE OR DELETE ON je_templates FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_feed();
--> statement-breakpoint
CREATE TRIGGER mybooks_feed AFTER INSERT OR UPDATE OR DELETE ON unit_sets FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_feed();
--> statement-breakpoint
CREATE TRIGGER mybooks_feed AFTER INSERT OR UPDATE OR DELETE ON price_levels FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_feed();
