-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Rollback for 0284 (U-284 E6): mybooks_transfer_scrub gets 0283's body
-- back and the helper is dropped. LOST: the two scrub fixes (a display name
-- holding a backslash is mangled again; an account number inside check
-- settings without a routing number travels again in a transfer's audit
-- images). No data changes.
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

DROP FUNCTION IF EXISTS mybooks_transfer_scrub_in(jsonb, jsonb, boolean, boolean);
