-- Add provider-specific idempotency support to payroll import sessions
ALTER TABLE payroll_import_sessions
  ADD COLUMN IF NOT EXISTS idempotency_key varchar(255),
  ADD COLUMN IF NOT EXISTS detected_provider varchar(50);

-- Unique index: only one posted session per tenant+company+provider+idempotency key
CREATE UNIQUE INDEX IF NOT EXISTS idx_payroll_sess_idempotency
  ON payroll_import_sessions (tenant_id, company_id, detected_provider, idempotency_key)
  WHERE status = 'posted';
