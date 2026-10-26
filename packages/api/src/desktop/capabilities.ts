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
  /** POST /recurring/run-due takes templateIds (only these) and excludeTemplateIds (all but these); others stay due, untouched (U-82). */
  'run-due-filter-v1',
  /**
   * POST /bills/extract-from-attachment/:id: fieldConfidence and lineItems[].confidence as 'high'|'medium'|'low',
   * amounts as decimal strings or null. No OCR or AI on upload in desktop mode (?autoOcr=0, attachments.autoOcr);
   * POST /attachments/:id/ocr honours the AI on / consent gates in desktop mode (U-89).
   */
  'bill-ocr-v2',
  /**
   * Bills, vendor credits, bill payments and bill-capture enter take closingPassword / overrideConfirmed for a date on or
   * before the closing date (423 TB_PERIOD_LOCKED, 403 CLOSING_PASSWORD_INVALID) (U-83).
   */
  'ap-closing-v1',
  /**
   * PUT /vendor-credits/:id (409 CREDIT_APPLIED); bills and vendor credits deletable via DELETE /transactions/:id while
   * unapplied (409 BILL_HAS_PAYMENTS / CREDIT_APPLIED); expectedUpdatedAt on bill / credit PUT and void and on transaction
   * void / delete (409 STALE, details.updatedAt); A/P checks under the row lock; bill-payment voids keep applications right;
   * vendor-summary counts posted documents only; exact paid status (U-84).
   */
  'ap-edit-v1',
  /** Bill and vendor-credit lines: itemId, quantity, unitPrice (400 LINE_AMOUNT_MISMATCH / LINE_QTY_RATE_INCOMPLETE), contactId, isBillable (bills), tagId; draftAttachmentId on create (U-85). */
  'bill-lines-v1',
  /** PAYMENT_TERMS with discount terms; bills store discountPercent/Days/Date and override flags; GET /bills/terms-dates, GET /payment-terms; calendar-day due dates (U-86). */
  'bill-terms-v1',
  /** billReceived on bills (default true); false is left out of /bills/payable and refused by Pay Bills (409 BILL_NOT_RECEIVED) (U-87). */
  'bill-received-v1',
  /**
   * Idempotency-Key, with idempotency-v1's contract, on exactly these A/P
   * routes added after it (each `x-idempotency: true` in openapi.json):
   *   PUT /bills/:id, POST /bills/:id/void, POST /vendor-credits,
   *   PUT /vendor-credits/:id, POST /vendor-credits/:id/void,
   *   POST /bill-payments/:id/void.
   * Refusals (409 STALE, BILL_HAS_PAYMENTS, CREDIT_APPLIED, TXN_DEPOSITED,
   * 423, 403, 400) are never stored. POST /bill-payments is not keyed (Pay
   * Bills, P18). The set is fixed: more routes get a new name.
   */
  'idempotency-ap-v1',
  /**
   * Attachments are scoped by company (U-90): POST /attachments stamps the request's company; list, library, unlinked,
   * GET/download/delete/OCR/link, bulk-download, API v2 and the AI attachment routes see only that company's files and
   * those with no company that are not filed on another company's transaction; others are 404 or left out.
   */
  'attachments-company-v1',
  /**
   * GET/PUT /api/v1/company/intake-settings: the company's intake folders (companies.intake_settings, migration 0232),
   * a full replace guarded by expectedUpdatedAt (409 STALE, details.updatedAt); paths never in audit rows or the company
   * row; omitIntakeSettings on the tenant archive export (manifest `omitted`) (U-93).
   */
  'intake-settings-v1',
  /**
   * /api/v1/document-drafts (claim an uploaded draft file by its SHA-256, list, get, duplicates, PUT a reading with
   * expectedUpdatedAt, discard, convert into a bill / card charge / cash expense / check in one database transaction) and
   * /api/v1/vendor-layout-templates (GET, PUT upsert, DELETE); accounts.card_last4 on PUT /accounts/:id; DELETE
   * /attachments/:id is 409 ATTACHMENT_IN_USE while a live draft reads the file; omitDocumentDrafts on the tenant archive
   * export and resetDocumentDrafts on import (migration 0233; U-92, U-92b).
   */
  'document-drafts-v1',
  /**
   * Idempotency-Key, with idempotency-v1's contract, on exactly POST /document-drafts and
   * POST /document-drafts/:id/convert (each `x-idempotency: true` in openapi.json). Refusals (409
   * DOCUMENT_ALREADY_CLAIMED, DOCUMENT_DRAFT_CLOSED, STALE, POSSIBLE_DUPLICATE, 423, 403, 400) are never stored. The
   * set is fixed: more routes get a new name (U-92a).
   */
  'idempotency-docs-v1',
  /**
   * POST /api/v1/document-reading/assist: field suggestions (bill-ocr-v2 shape, amounts as decimal strings or null,
   * line unitPrice) from the page text and up to 3 PNG page images (2 MiB together) a client read itself; nothing stored
   * or posted. Company AI task switches document_text_cloud and document_images_cloud (off for every company, never
   * implied by receipt_ocr or by accepting the disclosure; migration 0234) gate a cloud provider: 403 CONSENT_REQUIRED.
   * A self-hosted provider needs neither, only the company's AI opt-in (U-92d).
   */
  'document-assist-v1',
  /**
   * POST /api/v1/document-drafts/:id/attach {transactionId, expectedUpdatedAt}: file a live draft's document on a posted
   * transaction in one database transaction (draft -> transaction -> file locks; the draft marked converted onto it,
   * audited `attached: true`), keyed with idempotency-docs-v1's contract. Live-draft file guard: the plain draft-key
   * relinks (draftAttachmentId on bills, checks, transactions, vendor credits, daily sales, AJEs, tax entries and
   * POST /bills/:id/attach-draft) leave a file a live draft reads on its key, and POST /attachments/:id/link of such a
   * file is 409 ATTACHMENT_IN_USE. GET /transactions?amount= filters by exact total (numeric). No migration (U-95).
   */
  'document-drafts-attach-v1',
];
