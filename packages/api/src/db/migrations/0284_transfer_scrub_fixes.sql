-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- U-284 E6 (ClientLedger P32 review, M6): two fixes to the transfer audit
-- image scrub of 0283. Function bodies only; no table or data change.
--
-- 1. A display name is the replacement text of regexp_replace, where `\1`
--    to `\9` and `\&` are special: a name holding a backslash came out
--    mangled (or as the matched email itself, `\&`). Backslashes in the
--    name are now doubled, so every name is written literally.
-- 2. The check printing account number was removed only from an object
--    that also carried a routing number, so a check-settings diff holding
--    just `accountNumber` kept it. Now every `accountNumber` /
--    `account_number` key inside a check-settings value (`check_settings` /
--    `checkSettings` key, at any depth) is removed as well. GL account
--    numbers in other images (accounts rows) stay.
--
-- mybooks_transfer_scrub(doc, names, strip_email) keeps its signature (the
-- export calls it); the recursion lives in mybooks_transfer_scrub_in, which
-- carries whether the value sits inside check settings. Additive only.

CREATE OR REPLACE FUNCTION mybooks_transfer_scrub_in(doc jsonb, names jsonb, strip_email boolean, in_check boolean) RETURNS jsonb
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
      -- account number of an object that carries a routing number or sits
      -- inside check settings).
      RETURN COALESCE(
        (SELECT jsonb_object_agg(o.k, mybooks_transfer_scrub_in(o.v, names, strip_email, in_check OR o.k ~* '^check_?settings$'))
           FROM jsonb_each(doc) AS o(k, v)
          WHERE NOT (strip_email AND o.k ~* '^e_?mail$')
            AND o.k !~* '^smtp_?(host|user)$'
            AND o.k !~* '^(routing_?number|fractional_?routing)$'
            AND NOT (o.k ~* '^account_?number$' AND (in_check OR doc ? 'routingNumber' OR doc ? 'routing_number'))),
        '{}'::jsonb);
    WHEN 'array' THEN
      RETURN COALESCE(
        (SELECT jsonb_agg(mybooks_transfer_scrub_in(a.v, names, strip_email, in_check) ORDER BY a.o)
           FROM jsonb_array_elements(doc) WITH ORDINALITY AS a(v, o)),
        '[]'::jsonb);
    WHEN 'string' THEN
      BEGIN
        inner_doc := (doc #>> '{}')::jsonb;
      EXCEPTION WHEN OTHERS THEN
        inner_doc := NULL;
      END;
      IF inner_doc IS NOT NULL AND jsonb_typeof(inner_doc) IN ('object', 'array') THEN
        RETURN to_jsonb(mybooks_transfer_scrub_in(inner_doc, names, strip_email, in_check)::text);
      END IF;
      s := doc #>> '{}';
      IF names IS NOT NULL AND jsonb_typeof(names) = 'object' AND position('@' IN s) > 0 THEN
        FOR e IN SELECT key, value #>> '{}' AS name FROM jsonb_each(names) LOOP
          IF position(e.key IN lower(s)) > 0 THEN
            s := regexp_replace(s, regexp_replace(e.key, '([^[:alnum:]])', '\\\1', 'g'), replace(e.name, '\', '\\'), 'gi');
          END IF;
        END LOOP;
        RETURN to_jsonb(s);
      END IF;
      RETURN doc;
    ELSE
      RETURN doc;
  END CASE;
END $$;

CREATE OR REPLACE FUNCTION mybooks_transfer_scrub(doc jsonb, names jsonb, strip_email boolean) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT mybooks_transfer_scrub_in(doc, names, strip_email, false)
$$;
