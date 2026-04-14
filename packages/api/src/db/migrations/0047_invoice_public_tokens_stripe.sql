-- Public invoice tokens for customer-facing payment links
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS public_token VARCHAR(64) UNIQUE,
  ADD COLUMN IF NOT EXISTS stripe_payment_intent_id VARCHAR(255);

CREATE UNIQUE INDEX IF NOT EXISTS idx_txn_public_token
  ON transactions (public_token) WHERE public_token IS NOT NULL;

-- Per-company Stripe configuration for online payments
ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS stripe_secret_key_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS stripe_publishable_key VARCHAR(255),
  ADD COLUMN IF NOT EXISTS stripe_webhook_secret_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS online_payments_enabled BOOLEAN DEFAULT false;

-- Stripe webhook idempotency log
CREATE TABLE IF NOT EXISTS stripe_webhook_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID,
  event_id VARCHAR(255) NOT NULL UNIQUE,
  event_type VARCHAR(100) NOT NULL,
  payment_intent_id VARCHAR(255),
  payload JSONB NOT NULL,
  processed BOOLEAN DEFAULT false,
  processed_at TIMESTAMPTZ,
  error TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_swl_event ON stripe_webhook_log (event_id);
CREATE INDEX IF NOT EXISTS idx_swl_pi ON stripe_webhook_log (payment_intent_id);
