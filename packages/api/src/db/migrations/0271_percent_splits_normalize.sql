-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- See LICENSE and NOTICE.md for terms.
--
-- Percentage splits total exactly 100 (feed-exact-v1 follow-up).
--
-- Since U-164 / U-170 the Bank Feed posts a percentage split only when its
-- percentages add up to exactly 100 as decimals (400 SPLITS_DONT_BALANCE),
-- and a rule is saved only under the same test (percentsTotalExactly100).
-- Before that, a total within 0.01 of 100 was accepted and the remainder
-- went to the last split, so a stored rule at 33.33 / 33.33 / 33.33 (99.99)
-- posted then and is refused now. This data step brings every stored
-- percentage split that the old tolerance accepted onto the new rule the
-- same way the old posting did: the LAST split's percent takes the
-- remainder (33.33 / 33.33 / 33.34). A total outside the tolerance
-- (|total - 100| > 0.01), a negative percent, a percent that is not a
-- number, or a last split that would go negative is left alone for the
-- owner to fix (counted as rulesNeedOwner / itemsNeedOwner).
--
-- Where percentage splits are stored:
--   conditional_rules.actions   split_by_percentage actions, in a flat
--                               action list or anywhere in an if / then /
--                               elif / else tree (tenant and global rows);
--   bank_feed_items.splits_config  a staged {kind: 'percentage', splits}
--                               copied from a rule when it fired.
-- bank_rules (legacy) and global_rule_submissions carry no splits;
-- conditional_rule_audit.actions_applied is history and is left as it was.
--
-- Data only, no schema change. Idempotent: a normalized action totals 100
-- and is never touched again; a second run changes nothing. All arithmetic
-- is numeric on the JSON number text (33.33 is 33.33, never a double), and
-- the new percent is written back as a JSON number with its scale trimmed.
-- updated_at is left alone (the feed accept groups compare it). Every
-- changed tenant row gets an audit_log row (before / after actions), one
-- per rule or feed item, so the previous values can be read back.
--
-- The functions stay: a tenant archive made before this migration gets
-- percent_splits_normalize_tenant on import (tenant-portability
-- import.service, PERCENT_SPLITS_NORMALIZE_SCHEMA_VERSION).
-- Ordering: after 0270. Rollback: 0271_percent_splits_normalize.rollback.sql
-- (a no-op: the old totals were refused already, the audit rows hold them).

CREATE OR REPLACE FUNCTION percent_split_total(p_action jsonb) RETURNS numeric
LANGUAGE plpgsql IMMUTABLE AS $fn$
-- The total of a split_by_percentage action's percents as exact decimals,
-- or NULL when any percent is not a non-negative number (as a JSON number
-- or a numeric string) or the action has fewer than two splits.
DECLARE
  v_splits jsonb := p_action->'splits';
  v_s jsonb;
  v_pct numeric;
  v_total numeric := 0;
BEGIN
  IF p_action IS NULL OR jsonb_typeof(p_action) <> 'object' OR COALESCE(p_action->>'type', '') <> 'split_by_percentage'
     OR COALESCE(jsonb_typeof(v_splits), '') <> 'array' OR jsonb_array_length(v_splits) < 2 THEN
    RETURN NULL;
  END IF;
  FOR v_s IN SELECT value FROM jsonb_array_elements(v_splits) LOOP
    IF jsonb_typeof(v_s) <> 'object' OR COALESCE(jsonb_typeof(v_s->'percent'), '') NOT IN ('number', 'string') THEN RETURN NULL; END IF;
    IF (v_s->>'percent') !~ '^\s*\d+(\.\d+)?\s*$' THEN RETURN NULL; END IF;
    v_pct := (v_s->>'percent')::numeric;
    v_total := v_total + v_pct;
  END LOOP;
  RETURN v_total;
END
$fn$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION percent_split_action_normalize(p_action jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE AS $fn$
-- A split_by_percentage action whose total is within 0.01 of 100 but not
-- 100 comes back with the last split's percent adjusted so the total is
-- exactly 100; anything else comes back unchanged.
DECLARE
  v_total numeric := percent_split_total(p_action);
  v_n integer;
  v_last numeric;
BEGIN
  IF v_total IS NULL OR v_total = 100 OR abs(v_total - 100) > 0.01 THEN RETURN p_action; END IF;
  v_n := jsonb_array_length(p_action->'splits');
  v_last := (p_action->'splits'->(v_n - 1)->>'percent')::numeric + (100 - v_total);
  IF v_last < 0 THEN RETURN p_action; END IF;
  RETURN jsonb_set(p_action, ARRAY['splits', (v_n - 1)::text, 'percent'], to_jsonb(trim_scale(v_last)));
END
$fn$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION percent_splits_normalize(p_actions jsonb) RETURNS jsonb
LANGUAGE plpgsql IMMUTABLE AS $fn$
-- Walks a conditional rule's actions (a flat action list or an if / then /
-- elif / else tree) and normalizes every split_by_percentage action in it.
DECLARE
  v_out jsonb;
  v_e jsonb;
BEGIN
  IF p_actions IS NULL THEN RETURN NULL; END IF;
  IF jsonb_typeof(p_actions) = 'array' THEN
    v_out := '[]'::jsonb;
    FOR v_e IN SELECT value FROM jsonb_array_elements(p_actions) LOOP
      IF jsonb_typeof(v_e) = 'object' AND v_e->>'type' = 'split_by_percentage' THEN
        v_out := v_out || jsonb_build_array(percent_split_action_normalize(v_e));
      ELSE
        v_out := v_out || jsonb_build_array(v_e);
      END IF;
    END LOOP;
    RETURN v_out;
  END IF;
  IF jsonb_typeof(p_actions) = 'object' AND p_actions ? 'then' THEN
    v_out := jsonb_set(p_actions, '{then}', percent_splits_normalize(p_actions->'then'));
    IF jsonb_typeof(p_actions->'elif') = 'array' THEN
      v_out := jsonb_set(v_out, '{elif}', COALESCE((
        SELECT jsonb_agg(CASE WHEN jsonb_typeof(b) = 'object' AND b ? 'then' THEN jsonb_set(b, '{then}', percent_splits_normalize(b->'then')) ELSE b END ORDER BY o)
        FROM jsonb_array_elements(p_actions->'elif') WITH ORDINALITY AS t(b, o)
      ), '[]'::jsonb));
    END IF;
    IF p_actions ? 'else' AND jsonb_typeof(p_actions->'else') <> 'null' THEN
      v_out := jsonb_set(v_out, '{else}', percent_splits_normalize(p_actions->'else'));
    END IF;
    RETURN v_out;
  END IF;
  RETURN p_actions;
END
$fn$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION percent_split_actions(p_actions jsonb) RETURNS SETOF jsonb
LANGUAGE plpgsql IMMUTABLE AS $fn$
-- Every split_by_percentage action in a rule's actions, wherever it sits.
DECLARE
  v_e jsonb;
BEGIN
  IF p_actions IS NULL THEN RETURN; END IF;
  IF jsonb_typeof(p_actions) = 'array' THEN
    FOR v_e IN SELECT value FROM jsonb_array_elements(p_actions) LOOP
      IF jsonb_typeof(v_e) = 'object' AND v_e->>'type' = 'split_by_percentage' THEN RETURN NEXT v_e; END IF;
    END LOOP;
    RETURN;
  END IF;
  IF jsonb_typeof(p_actions) = 'object' AND p_actions ? 'then' THEN
    RETURN QUERY SELECT * FROM percent_split_actions(p_actions->'then');
    IF jsonb_typeof(p_actions->'elif') = 'array' THEN
      FOR v_e IN SELECT value FROM jsonb_array_elements(p_actions->'elif') LOOP
        IF jsonb_typeof(v_e) = 'object' THEN RETURN QUERY SELECT * FROM percent_split_actions(v_e->'then'); END IF;
      END LOOP;
    END IF;
    IF p_actions ? 'else' THEN RETURN QUERY SELECT * FROM percent_split_actions(p_actions->'else'); END IF;
  END IF;
  RETURN;
END
$fn$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION percent_splits_normalize_tenant(p_tenant uuid) RETURNS jsonb
LANGUAGE plpgsql AS $fn$
-- Normalizes the tenant's conditional rules and staged feed items (p_tenant
-- NULL = the global rules, which have no tenant) and returns the counts:
-- rulesNormalized / itemsNormalized (changed by this call) and
-- rulesNeedOwner / itemsNeedOwner (a percentage split still not totalling
-- 100 afterwards: outside the old tolerance, the owner has to fix it).
-- Tenant rows get an audit_log row each (before / after); global rows have
-- no tenant to file one under.
DECLARE
  v_rules integer := 0;
  v_items integer := 0;
  v_rules_left integer := 0;
  v_items_left integer := 0;
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS psn_rules (id uuid PRIMARY KEY, tenant_id uuid, company_id uuid, before_actions jsonb) ON COMMIT DROP;
  CREATE TEMP TABLE IF NOT EXISTS psn_items (id uuid PRIMARY KEY, tenant_id uuid, company_id uuid, before_config jsonb) ON COMMIT DROP;
  TRUNCATE psn_rules;
  TRUNCATE psn_items;

  INSERT INTO psn_rules (id, tenant_id, company_id, before_actions)
  SELECT r.id, r.tenant_id, r.company_id, r.actions
  FROM conditional_rules r
  WHERE r.tenant_id IS NOT DISTINCT FROM p_tenant
    AND r.actions::text LIKE '%split_by_percentage%'
    AND percent_splits_normalize(r.actions) IS DISTINCT FROM r.actions
  FOR UPDATE OF r;
  UPDATE conditional_rules r SET actions = percent_splits_normalize(r.actions)
  FROM psn_rules b WHERE r.id = b.id;
  GET DIAGNOSTICS v_rules = ROW_COUNT;
  INSERT INTO audit_log (tenant_id, company_id, action, entity_type, entity_id, before_data, after_data)
  SELECT b.tenant_id, b.company_id, 'update', 'conditional_rule', b.id,
    jsonb_build_object('actions', b.before_actions, 'reason', 'percent_splits_normalize'),
    jsonb_build_object('actions', r.actions, 'reason', 'percent_splits_normalize')
  FROM psn_rules b JOIN conditional_rules r ON r.id = b.id
  WHERE b.tenant_id IS NOT NULL;

  INSERT INTO psn_items (id, tenant_id, company_id, before_config)
  SELECT i.id, i.tenant_id, i.company_id, i.splits_config
  FROM bank_feed_items i
  WHERE i.tenant_id IS NOT DISTINCT FROM p_tenant
    AND i.splits_config->>'kind' = 'percentage'
    AND percent_split_action_normalize(i.splits_config || '{"type": "split_by_percentage"}'::jsonb) - 'type' IS DISTINCT FROM i.splits_config
  FOR UPDATE OF i;
  UPDATE bank_feed_items i SET splits_config = percent_split_action_normalize(i.splits_config || '{"type": "split_by_percentage"}'::jsonb) - 'type'
  FROM psn_items b WHERE i.id = b.id;
  GET DIAGNOSTICS v_items = ROW_COUNT;
  INSERT INTO audit_log (tenant_id, company_id, action, entity_type, entity_id, before_data, after_data)
  SELECT b.tenant_id, b.company_id, 'update', 'bank_feed_item', b.id,
    jsonb_build_object('splitsConfig', b.before_config, 'reason', 'percent_splits_normalize'),
    jsonb_build_object('splitsConfig', i.splits_config, 'reason', 'percent_splits_normalize')
  FROM psn_items b JOIN bank_feed_items i ON i.id = b.id
  WHERE b.tenant_id IS NOT NULL;

  SELECT count(*) INTO v_rules_left FROM conditional_rules r
  WHERE r.tenant_id IS NOT DISTINCT FROM p_tenant AND r.actions::text LIKE '%split_by_percentage%'
    AND EXISTS (SELECT 1 FROM percent_split_actions(r.actions) a WHERE percent_split_total(a) IS DISTINCT FROM 100);
  SELECT count(*) INTO v_items_left FROM bank_feed_items i
  WHERE i.tenant_id IS NOT DISTINCT FROM p_tenant AND i.splits_config->>'kind' = 'percentage'
    AND percent_split_total(i.splits_config || '{"type": "split_by_percentage"}'::jsonb) IS DISTINCT FROM 100;

  RETURN jsonb_build_object('rulesNormalized', v_rules, 'itemsNormalized', v_items,
    'rulesNeedOwner', v_rules_left, 'itemsNeedOwner', v_items_left);
END
$fn$;
--> statement-breakpoint
DO $do$
DECLARE
  t record;
  r jsonb;
  v_rules integer := 0;
  v_items integer := 0;
  v_rules_left integer := 0;
  v_items_left integer := 0;
BEGIN
  FOR t IN
    SELECT DISTINCT tenant_id FROM conditional_rules WHERE actions::text LIKE '%split_by_percentage%'
    UNION
    SELECT DISTINCT tenant_id FROM bank_feed_items WHERE splits_config->>'kind' = 'percentage'
    ORDER BY 1 NULLS FIRST
  LOOP
    r := percent_splits_normalize_tenant(t.tenant_id);
    v_rules := v_rules + (r->>'rulesNormalized')::integer;
    v_items := v_items + (r->>'itemsNormalized')::integer;
    v_rules_left := v_rules_left + (r->>'rulesNeedOwner')::integer;
    v_items_left := v_items_left + (r->>'itemsNeedOwner')::integer;
  END LOOP;
  RAISE NOTICE '0271 percent splits: % rules and % feed items normalized to 100; % rules and % feed items still not 100 (the owner has to fix them)',
    v_rules, v_items, v_rules_left, v_items_left;
END
$do$;
