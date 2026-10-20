-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Integer monthly AI token cap (U-29). ai_config.monthly_token_limit is the
-- number of tokens (input + output, summed from ai_usage_log) a tenant may
-- use per calendar month; NULL = no cap. Checked in ai-orchestrator.createJob
-- beside the existing dollar cap (monthly_budget_limit), which is unchanged.
-- Additive only.
ALTER TABLE ai_config ADD COLUMN IF NOT EXISTS monthly_token_limit INTEGER;
