-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Internal Use License 1.0.0.
-- You may not distribute this software. See LICENSE for terms.
--
-- Seed the `receipt_amount_mismatch` review check. Joins
-- bank_feed_items to attachments where OCR has completed and the
-- extracted receipt total differs from the bank amount by more
-- than max($1, 2% × bank). Default-enabled because it's pure
-- arithmetic on already-extracted OCR data — no AI fan-out.
-- Additive: single INSERT, idempotent via ON CONFLICT.

INSERT INTO check_registry (check_key, name, handler_name, default_severity, default_params, category) VALUES
  (
    'receipt_amount_mismatch',
    'Receipt total disagrees with bank amount',
    'receipt_amount_mismatch',
    'med',
    '{"toleranceDollars":1,"tolerancePercent":0.02}'::JSONB,
    'compliance'
  )
ON CONFLICT (check_key) DO NOTHING;
