-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Tax Estimator Q41 part: CPA-decided switch (OPEN-QUESTIONS.md Q41 item 1). Assembled AFTER the
-- R6 lifecycle part. Additive only. Per entity and tax year: include the >2% S corporation
-- shareholder health insurance added to the officer's W-2 box 1 in the W-2 wages used for the
-- §199A wage limit. Default FALSE = excluded (Kurt's decision, 2026-10-12).
ALTER TABLE tax_est_entity_year_inputs ADD COLUMN IF NOT EXISTS include_sehi_in_w2_wages BOOLEAN NOT NULL DEFAULT FALSE;
