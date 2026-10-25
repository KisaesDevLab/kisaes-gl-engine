// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Capabilities the engine advertises on GET /api/v1/desktop/info. A client
 * gates a feature on the presence of its name; a missing array means none.
 * Names are append-only: a changed contract gets a new `-v2` name.
 */
export const DESKTOP_CAPABILITIES: readonly string[] = [
  /** GET /api/v1/tenants (U-05, E5a). */
  'tenants-list-v1',
  /** Archive export job, download, import and rename (U-05, E5a). */
  'tenant-archive-v1',
  /** PUT/GET/DELETE /api/v1/desktop/session-secrets (U-09, U-13, E6). */
  'session-secrets-v1',
  /** Per-session AI credentials, provider allowlist, usage summary (U-09, U-11, E6). */
  'ai-desktop-v1',
  /** SMTP password from the session store (U-13, E6). */
  'smtp-session-v1',
  /** Integer monthly token cap, applied to every AI call in desktop mode (U-29, E6). */
  'ai-token-cap-v1',
  /** `?exact=1` on GET /accounts/:id/register and /register/summary: money as decimal strings (P12 R2). */
  'register-exact-v1',
  /** Closing-date password: companies.closing_password_hash, closingPassword on postings and lockDate changes (U-15). */
  'closing-password-v1',
  /** DELETE /transactions/:id: soft delete with reversing lines, status 'deleted' hidden everywhere (P12 R7). */
  'txn-delete-v1',
  /** PUT /checks/:id with the create body; exact line sum on create and edit (U-48). */
  'check-edit-v1',
  /** contactId + isBillable per line on checks and expenses; journal_lines.is_billable / billed_status (U-49, U-50). */
  'line-billable-v1',
  /** POST /practice/conditional-rules/evaluate: read-only rule match for one entry (U-51). */
  'rules-evaluate-v1',
  /** Deposit lines take sourceTransactionId (Payments Clearing item, exact amount, once); GET /payments/pending-deposits?exact=1 (U-52). */
  'deposit-grouping-v1',
  /** Deposit cashBack {accountId, amount, memo?}; negative line amounts post as debits; total > 0 (U-53). */
  'deposit-cashback-v1',
  /** A deposit line with sourceTransactionId = a vendor credit refunds it (A/P, ≤ open balance) (U-54). */
  'vendor-refund-v1',
  /** Equity role system tags seeded by entity type; GET /company/equity-roles (U-55). */
  'equity-roles-v1',
  /** GET /banking/feed/:id/deposit-groupings: exact-sum Payments Clearing sets (U-56). */
  'feed-deposit-groupings-v1',
  /** Daily-sales post/void honour the closing date and closingPassword; company-scoped; string amounts only (U-57). */
  'daily-sales-lock-v1',
  /** Journal entry lines take contactId; an A/R or A/P line needs one, one such line per entry (U-58). */
  'je-names-v1',
  /** Journal entry txnNumber (≤ 20 characters); GET /journal-entries/next-number (U-59). */
  'je-number-v1',
  /** isAdjusting on journal entries; adjusting=include|exclude|only on reports and the transaction list (U-60). */
  'je-adjusting-v1',
  /** Journal entry reverseOn: automatic reversing entry, voided / deleted / re-created with the original (U-61). */
  'je-reversing-v1',
  /** Debits must equal credits exactly at 4 places; no tolerance (U-65). */
  'balance-exact-v1',
  /** Recurring copies line names and billable marks; PUT /recurring/:id takes expectedUpdatedAt (409 STALE_SCHEDULE) (U-64, U-66). */
  'recurring-guard-v1',
  /** /templates CRUD, groups, from-transaction, GET /templates/:id/draft, enter, skip, resolve; templates post nothing until entered (U-62). */
  'templates-v1',
  /** POST /recurring/run-due (exactly once per template and date, closed periods skipped) and GET /recurring/attention (U-63). */
  'recurring-run-due-v1',
  /** POST /batch/save (grouped shape) posts every row in ONE database transaction; any failing row rolls back all, with its rowNumber (U-67). */
  'batch-atomic-v1',
  /** Batch check rows: refNo is the check number (unique per bank account, counter advanced), printLater per row (U-70). */
  'batch-check-v1',
  /** POST /batch/validate and /batch/save take groups: [{txn_type, context_account_id, rows}] in one request (U-69). */
  'batch-mixed-v1',
  /** Grouped batch amounts are exact decimal strings; journal entries balance exactly; parse-csv returns string amounts (U-71, U-73). */
  'batch-exact-v1',
  /** Idempotency-Key on POST /batch/save: same key and body replays, a different body is 409 IDEMPOTENCY_KEY_REUSED (U-72). */
  'batch-idempotent-v1',
  /** Batch rows dated on or before the closing date need closingPassword; 423 / 403 list the row numbers (U-68). */
  'batch-closing-v1',
  /**
   * Idempotency-Key header (16-64 of [A-Za-z0-9_-]) on exactly these routes
   * (U-18); each carries `x-idempotency: true` in openapi.json:
   *   POST /transactions, PUT /transactions/:id, POST /transactions/:id/void,
   *   DELETE /transactions/:id, POST /checks, PUT /checks/:id, POST /invoices,
   *   POST /bills, POST /daily-sales/entries, POST /daily-sales/entries/:id/post,
   *   POST /daily-sales/entries/:id/void, POST /templates,
   *   POST /templates/from-transaction, POST /templates/:id/enter,
   *   POST /templates/:id/occurrences/:date/skip,
   *   POST /templates/:id/occurrences/:date/resolve, POST /accounts,
   *   POST /contacts, POST /items, POST /tags.
   * Same user, key and request: the stored result replays (header
   * Idempotent-Replayed: true); another request: 422 IDEMPOTENCY_KEY_REUSED
   * with details {entityType, entityId}; still running: 409
   * IDEMPOTENCY_IN_PROGRESS with Retry-After: 1. Kept 24 hours. The set is
   * fixed: more routes get a new name. /batch/save keeps batch-idempotent-v1.
   */
  'idempotency-v1',
  /**
   * PUT /transactions/:id refuses a deposit edit that drops its links (409 DEPOSIT_LINKS_DROPPED) and a printed
   * check's face change as an expense (409 CHECK_PRINTED); checks keep header tags (U-80). Void reversal lines keep
   * the line contact; the check print routes (memo, print, requeue, reprint) honour the closing date (U-81).
   */
  'ledger-guards-v1',
  /** tags.tag_number: optional, unique per tenant when set (409 TAG_NUMBER_EXISTS); list sorts by it and search matches it (U-75). */
  'tag-number-v1',
  /** /dashboard/*: exact=1 money as decimal strings, asOf = today, one overdue-invoice rule, cash-position accountNumber, payables dueWithinDays (U-76). */
  'dashboard-exact-v1',
  /** POST /contacts/merge and /tags/merge honour the closing date and closingPassword; audit row in the same transaction lists the transaction ids (U-47). */
  'merge-closing-date-v1',
];
