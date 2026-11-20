-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- U-291 (ClientLedger P33, stale-all-v1): record stamps owned by the database.
--
-- In desktop mode every pool connection starts with mybooks.desktop = on (the
-- pg startup option, db/index.ts). Only then do these triggers run, so the
-- server appliance (MyBooks Online) pays nothing and keeps setting
-- updated_at in code as before.
--
-- Header tables (stale-checked records): a BEFORE UPDATE trigger owns
-- updated_at. When any column but the table's ignore list changes (columns the
-- engine maintains itself, such as accounts.balance, and updated_at), the
-- stamp becomes greatest(now to the millisecond, old + 1 ms); otherwise it
-- keeps the old stamp, whatever the code wrote. So a posting that moves an
-- account's balance never moves the account's stamp, and a write the code
-- forgot to stamp still moves it. An ignore list (not an editable list) errs
-- toward a false 409, never toward a lost update.
--
-- Child tables (lines, tags, applications, deposit lines, attachment links):
-- an AFTER ROW trigger bumps the header, once per database transaction: a
-- transaction-local setting keyed by table and id records that the header
-- was bumped (or edited) in this transaction. Writers that must not bump
-- (the inventory costing walk, merges, backfills) set
-- mybooks.stamp_quiet = on for their statements (utils/record-stamps.ts).
--
-- Backfill: NULL updated_at becomes created_at (or now). Additive only.

CREATE OR REPLACE FUNCTION mybooks_stamp_key(tbl text, rec uuid) RETURNS text
LANGUAGE sql IMMUTABLE AS $$ SELECT 'mybooks.s_' || substr(md5(tbl || ':' || rec::text), 1, 24) $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION mybooks_stamp_next(old_stamp timestamptz) RETURNS timestamptz
LANGUAGE sql VOLATILE AS $$
  SELECT greatest(date_trunc('milliseconds', clock_timestamp()),
                  coalesce(old_stamp, '-infinity'::timestamptz) + interval '1 millisecond')
$$;
--> statement-breakpoint

-- BEFORE UPDATE on a header table. TG_ARGV: the ignored columns (updated_at always).
CREATE OR REPLACE FUNCTION mybooks_stamp_header() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  k text := mybooks_stamp_key(TG_TABLE_NAME, NEW.id);
  st text := coalesce(current_setting(k, true), '');
  ignored text[] := array_append(coalesce(TG_ARGV::text[], '{}'::text[]), 'updated_at');
BEGIN
  IF st = 'done' THEN
    NEW.updated_at := OLD.updated_at;
  ELSIF st = 'bump' OR (to_jsonb(NEW) - ignored) IS DISTINCT FROM (to_jsonb(OLD) - ignored) THEN
    NEW.updated_at := mybooks_stamp_next(OLD.updated_at);
    PERFORM set_config(k, 'done', true);
  ELSE
    NEW.updated_at := OLD.updated_at;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

-- BEFORE INSERT on a header table: a new record always has a stamp, and its own
-- creating transaction (lines, tags, applications written with it) does not move it,
-- so a record nobody edited keeps updated_at = its creation stamp.
CREATE OR REPLACE FUNCTION mybooks_stamp_insert() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.updated_at IS NULL THEN NEW.updated_at := date_trunc('milliseconds', clock_timestamp()); END IF;
  PERFORM set_config(mybooks_stamp_key(TG_TABLE_NAME, NEW.id), 'done', true);
  RETURN NEW;
END $$;
--> statement-breakpoint

-- Bumps one header once per transaction.
CREATE OR REPLACE FUNCTION mybooks_stamp_bump(tbl text, rec uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  k text;
BEGIN
  IF rec IS NULL THEN RETURN; END IF;
  k := mybooks_stamp_key(tbl, rec);
  IF coalesce(current_setting(k, true), '') = 'done' THEN RETURN; END IF;
  PERFORM set_config(k, 'bump', true);
  EXECUTE format('UPDATE %I SET updated_at = updated_at WHERE id = $1', tbl) USING rec;
  PERFORM set_config(k, 'done', true);
END $$;
--> statement-breakpoint

-- AFTER INSERT/UPDATE/DELETE on a child table. TG_ARGV: pairs of
-- (header table, foreign key column), optionally followed by one argument
-- '-col1,col2': columns the engine maintains on the child (an UPDATE that
-- changes only those does not bump). Quiet writers skip.
CREATE OR REPLACE FUNCTION mybooks_stamp_child() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  i int := 0;
  o jsonb := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END;
  n jsonb := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END;
  nargs int := TG_NARGS;
  ignored text[];
BEGIN
  IF coalesce(current_setting('mybooks.stamp_quiet', true), '') = 'on' THEN RETURN NULL; END IF;
  IF nargs > 0 AND left(TG_ARGV[nargs - 1], 1) = '-' THEN
    ignored := string_to_array(substr(TG_ARGV[nargs - 1], 2), ',');
    nargs := nargs - 1;
    IF TG_OP = 'UPDATE' AND (o - ignored) = (n - ignored) THEN RETURN NULL; END IF;
  END IF;
  WHILE i + 1 < nargs LOOP
    IF o IS NOT NULL AND (o ->> TG_ARGV[i + 1]) IS NOT NULL THEN
      PERFORM mybooks_stamp_bump(TG_ARGV[i], (o ->> TG_ARGV[i + 1])::uuid);
    END IF;
    IF n IS NOT NULL AND (n ->> TG_ARGV[i + 1]) IS NOT NULL
       AND (o IS NULL OR (o ->> TG_ARGV[i + 1]) IS DISTINCT FROM (n ->> TG_ARGV[i + 1])) THEN
      PERFORM mybooks_stamp_bump(TG_ARGV[i], (n ->> TG_ARGV[i + 1])::uuid);
    END IF;
    i := i + 2;
  END LOOP;
  RETURN NULL;
END $$;
--> statement-breakpoint

-- Attachments: only the link (attachable_type, attachable_id) bumps the record it names: a contact,
-- or else a transaction of that id (journal_entry, bill, expense, deposit, ...; an id of another kind of
-- record matches no transaction).
CREATE OR REPLACE FUNCTION mybooks_stamp_attachment() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF coalesce(current_setting('mybooks.stamp_quiet', true), '') = 'on' THEN RETURN NULL; END IF;
  IF TG_OP <> 'INSERT' AND OLD.attachable_id IS NOT NULL THEN
    PERFORM mybooks_stamp_bump(CASE WHEN OLD.attachable_type = 'contact' THEN 'contacts' ELSE 'transactions' END, OLD.attachable_id);
  END IF;
  IF TG_OP <> 'DELETE' AND NEW.attachable_id IS NOT NULL THEN
    PERFORM mybooks_stamp_bump(CASE WHEN NEW.attachable_type = 'contact' THEN 'contacts' ELSE 'transactions' END, NEW.attachable_id);
  END IF;
  RETURN NULL;
END $$;
--> statement-breakpoint

UPDATE transactions SET updated_at = coalesce(created_at, now()) WHERE updated_at IS NULL;
--> statement-breakpoint
UPDATE accounts SET updated_at = coalesce(created_at, now()) WHERE updated_at IS NULL;
--> statement-breakpoint
UPDATE contacts SET updated_at = coalesce(created_at, now()) WHERE updated_at IS NULL;
--> statement-breakpoint
UPDATE items SET updated_at = coalesce(created_at, now()) WHERE updated_at IS NULL;
--> statement-breakpoint
UPDATE tags SET updated_at = coalesce(created_at, now()) WHERE updated_at IS NULL;
--> statement-breakpoint
UPDATE tag_groups SET updated_at = coalesce(created_at, now()) WHERE updated_at IS NULL;
--> statement-breakpoint

-- Header triggers. Ignore lists: columns the engine maintains (catalogue in
-- utils/record-stamps.ts, pinned by record-stamps.test.ts).
CREATE TRIGGER mybooks_stamp BEFORE UPDATE ON transactions FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_stamp_header('viewed_at');
--> statement-breakpoint
CREATE TRIGGER mybooks_stamp BEFORE UPDATE ON accounts FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_stamp_header('balance');
--> statement-breakpoint
CREATE TRIGGER mybooks_stamp BEFORE UPDATE ON contacts FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_stamp_header('bill_lines_mode');
--> statement-breakpoint
CREATE TRIGGER mybooks_stamp BEFORE UPDATE ON items FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_stamp_header();
--> statement-breakpoint
CREATE TRIGGER mybooks_stamp BEFORE UPDATE ON tags FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_stamp_header('usage_count');
--> statement-breakpoint
CREATE TRIGGER mybooks_stamp BEFORE UPDATE ON tag_groups FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_stamp_header();
--> statement-breakpoint
CREATE TRIGGER mybooks_stamp_ins BEFORE INSERT ON transactions FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_stamp_insert();
--> statement-breakpoint
CREATE TRIGGER mybooks_stamp_ins BEFORE INSERT ON accounts FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_stamp_insert();
--> statement-breakpoint
CREATE TRIGGER mybooks_stamp_ins BEFORE INSERT ON contacts FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_stamp_insert();
--> statement-breakpoint
CREATE TRIGGER mybooks_stamp_ins BEFORE INSERT ON items FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_stamp_insert();
--> statement-breakpoint
CREATE TRIGGER mybooks_stamp_ins BEFORE INSERT ON tags FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_stamp_insert();
--> statement-breakpoint
CREATE TRIGGER mybooks_stamp_ins BEFORE INSERT ON tag_groups FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_stamp_insert();
--> statement-breakpoint

-- Child triggers.
CREATE TRIGGER mybooks_stamp_child AFTER INSERT OR UPDATE OR DELETE ON journal_lines FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_stamp_child('transactions', 'transaction_id', '-billed_status,inventory_movement_id');
--> statement-breakpoint
CREATE TRIGGER mybooks_stamp_child AFTER INSERT OR UPDATE OR DELETE ON transaction_tags FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_stamp_child('transactions', 'transaction_id');
--> statement-breakpoint
CREATE TRIGGER mybooks_stamp_child AFTER INSERT OR UPDATE OR DELETE ON payment_applications FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_stamp_child('transactions', 'payment_id', 'transactions', 'invoice_id');
--> statement-breakpoint
CREATE TRIGGER mybooks_stamp_child AFTER INSERT OR UPDATE OR DELETE ON bill_payment_applications FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_stamp_child('transactions', 'payment_id', 'transactions', 'bill_id');
--> statement-breakpoint
CREATE TRIGGER mybooks_stamp_child AFTER INSERT OR UPDATE OR DELETE ON vendor_credit_applications FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_stamp_child('transactions', 'payment_id', 'transactions', 'credit_id', 'transactions', 'bill_id');
--> statement-breakpoint
CREATE TRIGGER mybooks_stamp_child AFTER INSERT OR UPDATE OR DELETE ON deposit_lines FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_stamp_child('transactions', 'deposit_id');
--> statement-breakpoint
CREATE TRIGGER mybooks_stamp_child AFTER INSERT OR DELETE OR UPDATE OF attachable_type, attachable_id ON attachments FOR EACH ROW
  WHEN (current_setting('mybooks.desktop', true) = 'on') EXECUTE FUNCTION mybooks_stamp_attachment();