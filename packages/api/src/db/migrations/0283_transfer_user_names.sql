-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- U-284 (ClientLedger P32 E3): tenant archive transfer mode.
--
-- transfer_user_names: people of a company who travelled as names only. A
-- transfer file carries no users or access rows (Q-P32a); every user id its
-- rows reference (created_by, audit_log.user_id, ...) gets a row here with
-- the person's display name, so readers show "Name (ClientLedger)" and the
-- ids stay allowed on every later export and import. user_id has no foreign
-- key: it never names a users row of this install (an import that finds the
-- id taken by a real user gives it a fresh id first).
--
-- mybooks_transfer_scrub(doc, names, strip_email): a deep copy of an audit
-- row image in which every string holding one of the exporting install's
-- user emails (keys of `names`, lower-case) has it replaced by that user's
-- display name, and, when strip_email, every `email` key is removed; the
-- mail-server login keys (smtp_host, smtp_user) and the check printing bank
-- numbers are removed at every depth (Q-P32t). JSON
-- string images (as middleware/audit.ts writes them) are scrubbed inside and
-- re-wrapped. Used by the transfer export only. Additive only.

CREATE TABLE IF NOT EXISTS transfer_user_names (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  display_name varchar(255) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_transfer_user_names_user ON transfer_user_names (tenant_id, user_id);

CREATE OR REPLACE FUNCTION mybooks_transfer_scrub(doc jsonb, names jsonb, strip_email boolean) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  inner_doc jsonb;
  s text;
  e record;
BEGIN
  IF doc IS NULL THEN
    RETURN NULL;
  END IF;
  CASE jsonb_typeof(doc)
    WHEN 'object' THEN
      -- Always removed: the mail-server login (smtp host and user) and the
      -- check printing bank numbers (routing, fractional routing, and the
      -- account number of an object that carries a routing number).
      RETURN COALESCE(
        (SELECT jsonb_object_agg(o.k, mybooks_transfer_scrub(o.v, names, strip_email))
           FROM jsonb_each(doc) AS o(k, v)
          WHERE NOT (strip_email AND o.k ~* '^e_?mail$')
            AND o.k !~* '^smtp_?(host|user)$'
            AND o.k !~* '^(routing_?number|fractional_?routing)$'
            AND NOT (o.k ~* '^account_?number$' AND (doc ? 'routingNumber' OR doc ? 'routing_number'))),
        '{}'::jsonb);
    WHEN 'array' THEN
      RETURN COALESCE(
        (SELECT jsonb_agg(mybooks_transfer_scrub(a.v, names, strip_email) ORDER BY a.o)
           FROM jsonb_array_elements(doc) WITH ORDINALITY AS a(v, o)),
        '[]'::jsonb);
    WHEN 'string' THEN
      BEGIN
        inner_doc := (doc #>> '{}')::jsonb;
      EXCEPTION WHEN OTHERS THEN
        inner_doc := NULL;
      END;
      IF inner_doc IS NOT NULL AND jsonb_typeof(inner_doc) IN ('object', 'array') THEN
        RETURN to_jsonb(mybooks_transfer_scrub(inner_doc, names, strip_email)::text);
      END IF;
      s := doc #>> '{}';
      IF names IS NOT NULL AND jsonb_typeof(names) = 'object' AND position('@' IN s) > 0 THEN
        FOR e IN SELECT key, value #>> '{}' AS name FROM jsonb_each(names) LOOP
          IF position(e.key IN lower(s)) > 0 THEN
            s := regexp_replace(s, regexp_replace(e.key, '([^[:alnum:]])', '\\\1', 'g'), e.name, 'gi');
          END IF;
        END LOOP;
        RETURN to_jsonb(s);
      END IF;
      RETURN doc;
    ELSE
      RETURN doc;
  END CASE;
END $$;
