-- Copyright 2026 Kisaes LLC
-- Licensed under the PolyForm Small Business License 1.0.0.
-- Free for small businesses; see LICENSE for terms.

-- Review-checks UX pass: plain-language names and descriptions so a
-- novice bookkeeper can tell what each check verifies without reading
-- code. Data-only UPDATEs (additive policy: no schema change).
-- "Auto-posted by rule (sample)" was developer jargon; the description
-- column shipped NULL in 0068.

UPDATE check_registry SET name = 'Rule spot-check'
WHERE check_key = 'auto_posted_by_rule_sampling';

UPDATE check_registry SET description = 'A random sample of your automation-rule postings, so you can verify the rules are categorizing correctly before errors compound.'
WHERE check_key = 'auto_posted_by_rule_sampling';

UPDATE check_registry SET description = 'Postings made directly to a parent account instead of one of its sub-accounts — these keep reports from rolling up cleanly.'
WHERE check_key = 'parent_account_posting';

UPDATE check_registry SET description = 'Expenses and bills over the documentation threshold with no receipt or bill copy attached.'
WHERE check_key = 'missing_attachment_above_threshold';

UPDATE check_registry SET description = 'Bank-feed lines that have sat uncategorized for too long — activity the books are still missing.'
WHERE check_key = 'uncategorized_stale';

UPDATE check_registry SET description = 'Entries tagged differently from how this vendor''s activity is usually tagged on the same account.'
WHERE check_key = 'tag_inconsistency_vs_history';

UPDATE check_registry SET description = 'Transactions at or above your materiality threshold — the ones reviewers and lenders look at first.'
WHERE check_key = 'transaction_above_materiality';

UPDATE check_registry SET description = 'Pairs of transactions with the same vendor and amount close together in time — possible double entry or double charge.'
WHERE check_key = 'duplicate_candidate';

UPDATE check_registry SET description = 'Larger transactions with exactly round amounts — often estimates or typos rather than real invoice figures.'
WHERE check_key = 'round_dollar_above_threshold';

UPDATE check_registry SET description = 'Transactions dated on a weekend — worth confirming the date is the real activity date.'
WHERE check_key = 'weekend_holiday_posting';

UPDATE check_registry SET description = 'Accounts whose balance runs the wrong direction for their type — usually a swapped debit/credit or a miscoded payment.'
WHERE check_key = 'negative_non_liability';

UPDATE check_registry SET description = 'Entries added to a period after it was closed — these can silently change statements that were already issued.'
WHERE check_key = 'closed_period_posting';

UPDATE check_registry SET description = 'Vendors paid over the 1099 reporting floor this year with no W-9 / tax ID on file.'
WHERE check_key = 'vendor_1099_threshold_no_w9';

UPDATE check_registry SET description = 'Invoices and customer payments recorded without a customer — they disappear from A/R aging and customer reports.'
WHERE check_key = 'missing_required_customer';

UPDATE check_registry SET description = 'Attached receipts whose total doesn''t match the bank charge beyond the allowed tolerance.'
WHERE check_key = 'receipt_amount_mismatch';

UPDATE check_registry SET description = 'AI-assisted review of posted expenses that look personal rather than business — run on demand from this tab.'
WHERE check_key = 'ai_personal_expense_review';

UPDATE check_registry SET description = 'Bank connections that are broken or haven''t synced recently — while they''re down, transactions aren''t importing.'
WHERE check_key = 'plaid_connection_health';
