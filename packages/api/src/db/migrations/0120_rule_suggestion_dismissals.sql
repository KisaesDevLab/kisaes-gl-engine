-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.

-- Dismissible rule suggestions. Rule suggestions are computed on demand from
-- categorization_history (see rule-suggestions.service) and have no persisted
-- row of their own — a suggestion's identity is the tuple
-- (tenant, payee pattern, target account). To let a bookkeeper permanently
-- dismiss a suggestion we persist a suppression record keyed on that tuple and
-- filter the detection query against it. Mirrors duplicate_dismissals.
--
-- payee_pattern is stored lower-cased so dismissal matching is case-insensitive,
-- consistent with the existing rule-overlap de-dup in detectSuggestions.
-- Additive only.

CREATE TABLE IF NOT EXISTS rule_suggestion_dismissals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  payee_pattern varchar(255) NOT NULL,
  account_id uuid NOT NULL,
  dismissed_by uuid,
  dismissed_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_rsd_suggestion
  ON rule_suggestion_dismissals (tenant_id, payee_pattern, account_id);
