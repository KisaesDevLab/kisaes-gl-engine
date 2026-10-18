-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- mybooks_strip_secret_keys(doc, pattern): a deep copy of a jsonb document
-- without any object key that matches `pattern` (case-insensitive ARE), at
-- every depth. The tenant-archive export applies it to
-- audit_log.before_data / after_data so a credential that an audited row
-- carried (companies.smtp_pass, a Stripe key, a password hash) never
-- leaves the install inside an archive; middleware/audit.ts strips the
-- same keys when it writes (utils/secret-keys.ts).
--
-- Rows written through middleware/audit.ts hold the image as a JSON
-- *string* (the already-serialized value is encoded once more by the ORM;
-- the engine's readers unwrap it with `#>> '{}'`). A string document that
-- parses as an object or array is stripped inside and re-wrapped, so the
-- stored shape is unchanged; any other string is returned as it is.
-- IMMUTABLE and STRICT (NULL in, NULL out). Additive only; no table is
-- touched.
CREATE OR REPLACE FUNCTION mybooks_strip_secret_keys(doc jsonb, pattern text) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
  inner_doc jsonb;
BEGIN
  CASE jsonb_typeof(doc)
    WHEN 'object' THEN
      RETURN COALESCE(
        (SELECT jsonb_object_agg(e.k, mybooks_strip_secret_keys(e.v, pattern))
           FROM jsonb_each(doc) AS e(k, v)
          WHERE e.k !~* pattern),
        '{}'::jsonb);
    WHEN 'array' THEN
      RETURN COALESCE(
        (SELECT jsonb_agg(mybooks_strip_secret_keys(a.v, pattern) ORDER BY a.o)
           FROM jsonb_array_elements(doc) WITH ORDINALITY AS a(v, o)),
        '[]'::jsonb);
    WHEN 'string' THEN
      BEGIN
        inner_doc := (doc #>> '{}')::jsonb;
      EXCEPTION WHEN OTHERS THEN
        RETURN doc;
      END;
      IF jsonb_typeof(inner_doc) IN ('object', 'array') THEN
        RETURN to_jsonb(mybooks_strip_secret_keys(inner_doc, pattern)::text);
      END IF;
      RETURN doc;
    ELSE
      RETURN doc;
  END CASE;
END $$;
