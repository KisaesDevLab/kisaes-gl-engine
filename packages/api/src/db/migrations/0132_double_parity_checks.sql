-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.
--
-- Seven new review checks closing the gap with best-in-class file-review
-- tools (expenses without payees, account-level miscoding vs. vendor
-- history, unsupported journal entries, new-entity review, backdated
-- entries inside a reconciled window, final-review flux analysis, and
-- duplicate contact names). Additive: INSERTs only, idempotent via
-- ON CONFLICT.

INSERT INTO check_registry (check_key, name, handler_name, default_severity, default_params, category, description) VALUES
  (
    'expense_without_payee',
    'Expense without a payee',
    'expense_without_payee',
    'low',
    '{}'::JSONB,
    'data',
    'Expenses and checks recorded with no vendor — they vanish from vendor reports and 1099 totals.'
  ),
  (
    'account_inconsistency_vs_history',
    'Category unusual for this vendor',
    'account_inconsistency_vs_history',
    'med',
    '{}'::JSONB,
    'data',
    'Expenses coded to a different account than this vendor''s history strongly suggests — the classic miscode.'
  ),
  (
    'journal_entry_without_attachment',
    'Journal entry without support',
    'journal_entry_without_attachment',
    'low',
    '{"thresholdAmount":0}'::JSONB,
    'compliance',
    'Journal entries with no supporting document attached — the entry type reviewers scrutinize most.'
  ),
  (
    'new_entities_review',
    'New vendors, customers & accounts',
    'new_entities_review',
    'low',
    '{}'::JSONB,
    'data',
    'Vendors, customers, and accounts added this period — verify they aren''t near-duplicates and are set up correctly.'
  ),
  (
    'posted_into_reconciled_range',
    'Backdated into a reconciled period',
    'posted_into_reconciled_range',
    'med',
    '{}'::JSONB,
    'close',
    'New transactions dated inside an already-reconciled statement window — they''ll surprise the next reconciliation.'
  ),
  (
    'flux_variance',
    'Unusual account activity (flux)',
    'flux_variance',
    'med',
    '{"minAmountDollars":100,"minPercent":0.2}'::JSONB,
    'close',
    'P&L accounts whose activity this period moved sharply from their trailing average — coding errors and real trends both show up here.'
  ),
  (
    'duplicate_entity_names',
    'Possible duplicate vendors/customers',
    'duplicate_entity_names',
    'low',
    '{}'::JSONB,
    'data',
    'Contacts whose names differ only in punctuation or capitalization — split histories break vendor totals and 1099s.'
  )
ON CONFLICT (check_key) DO NOTHING;
