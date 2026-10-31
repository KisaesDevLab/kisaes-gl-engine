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
   * 423, 403, 400) are never stored. POST /bill-payments (Pay Bills) is keyed by its own
   * idempotency-pay-bills-v1 (U-102). The set is fixed: more routes get a new name.
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
  /**
   * Document drafts take kind `statement` (kindHint on create, kind on PUT, the list's `kind` filter): a vendor
   * statement (accounts payable) a client filed for the owner, a label only. Permission: bills. Convert and attach of a statement
   * draft are 400 INVALID_KIND, whatever kind the body names; change its kind first. Intake folders
   * (intake-settings-v1) take defaultKind `statements`. Migration 0235 widens document_drafts_kind_ck (U-94).
   */
  'document-drafts-statement-v1',
  /**
   * Early-payment discounts on POST /bill-payments: bills[].discountAmount (on top of amount, which stays the coverage
   * including credits; amount + discount <= balance due; amount 0 allowed with a discount) and discountAccountId, default
   * the company setting billDiscountAccountId (GET/PUT /company/settings); 400 DISCOUNT_ACCOUNT_REQUIRED /
   * DISCOUNT_ACCOUNT_INVALID. Posts DR A/P / CR bank / CR discount account; application rows carry discount_amount;
   * void reverses. GET /bills/payable?paymentDate= adds discountAvailable (engine-rounded) and updatedAt to each bill.
   * Migration 0238 (U-101).
   */
  'bill-discounts-v1',
  /**
   * Idempotency-Key, with idempotency-v1's contract, on POST /bill-payments (Pay Bills; `x-idempotency: true` in
   * openapi.json). A replay returns the same {payments}. The set is fixed: more routes get a new name (U-102).
   */
  'idempotency-pay-bills-v1',
  /**
   * checkNumber on POST /bill-payments (method check, printLater false): consecutive numbers, one per vendor payment that
   * pays cash in response order, the bank account's counter moved past the last; 409 CHECK_NUMBER_IN_USE (U-103).
   */
  'bill-payment-check-number-v1',
  /**
   * Check printing (U-106..U-109). POST /checks/requeue and /checks/reprint/:batchId clear each check's number, record
   * it as spoiled on the check's bank account (GET /checks/spoiled?bank_account_id=; also PUT /checks/:id sending a
   * numbered check back to the queue) and write one audit row per check with the before state; they return
   * {message, checks: [{id, spoiledCheckNumber, bankAccountId}]} and never void the payment. A spoiled number is
   * listed only; it may be used again. Company scope on requeue (404), reprint (404), print (404; 400
   * CHECK_NOT_ON_BANK_ACCOUNT for a check drawn on another account) and the print counter; a taken number in the print
   * range is 409 CHECK_NUMBER_IN_USE. GET /checks/print-queue rows add txnType, bankAccountId and payeeAddress
   * (string[] mailing rows). GET /bill-payments/:id applications add `bill` / `credit` {txnNumber,
   * vendorInvoiceNumber, txnDate, total}. checkSettings.layouts[bankAccountId] = {format (voucher | check_middle |
   * z_fold | standard), printCompanyBlock (default false)}; GET /checks/settings?bank_account_id= adds `layout`
   * {format, printCompanyBlock, source 'bank_account' | 'company'}. Migration 0239.
   */
  'check-reprint-audit-v1',
  /** GET /api/v1/company/logo: the company's uploaded logo bytes with its image Content-Type; 404 when none (U-110). */
  'company-logo-v1',
  /**
   * Document numbering per company (U-111): GET /document-numbers ({numbers: [{type, prefix, nextNumber, next}]}),
   * GET /document-numbers/next?type= (peek), POST /document-numbers/claim {type} ({type, number, txnNumber}),
   * PUT /document-numbers/:type {prefix?, nextNumber?} for invoice, cash_sale, credit_memo, statement. Invoices, cash
   * sales and credit memos take the next number when created without txnNumber; a typed duplicate of the same type in
   * the company is 409 DOCUMENT_NUMBER_IN_USE (details {txnNumber, transactionId}), or with warnOnly: true it posts
   * and the response carries warnings: [{code, txnNumber, transactionId, message}]. The invoice counter moves only the
   * request's company. GET/PUT /company/invoice-template is company-scoped, takes footerOverrides per form type and
   * returns resolvedFooters. Migration 0240.
   */
  'document-numbers-v1',
  /**
   * printLater on invoices, cash sales and credit memos (create default false, edit absent keeps);
   * GET /forms/print-queue?type= ({data: [{id, type, txnNumber, txnDate, contactName, total}]}) and
   * POST /forms/mark-printed {ids} ({marked, alreadyPrinted}; one audit row per form; 404 for an id not a form of the
   * company). Migration 0240 (U-113).
   */
  'forms-print-queue-v1',
  /**
   * Idempotency-Key, with idempotency-v1's contract, on POST /checks/print (`x-idempotency: true` in openapi.json): a
   * replay returns the original {batchId, checksPrinted, checkNumberRange}. The set is fixed: more routes get a new name
   * (U-116). With it (U-115, U-117): a void check leaves the print queue and print refuses it (400 CHECK_VOID);
   * requeue / reprint skip void and deleted checks and return them in skipped: [{id, reason: 'void' | 'deleted'}].
   */
  'idempotency-check-print-v1',
  /**
   * Sales forms to the cent (U-122): invoice and sales receipt lines are round2(qty x unitPrice) half away from zero; tax is
   * round2(taxable base x rate) once per document and rate, allocated to the taxable lines by largest remainder (floor, earlier
   * line first on ties) so line taxes sum exactly; a taxable line without taxRate takes the request company's default rate;
   * credit memo lines round to the cent. Golden cases: packages/shared/fixtures/invoice-golden.json. History is not restated.
   */
  'sales-cents-v1',
  /**
   * Invoices (U-124): POST, PUT and void take closingPassword / overrideConfirmed for a date on or before the closing date
   * (423 / 403 / 429); PUT and void take expectedUpdatedAt (409 STALE, details.updatedAt); void with a live payment or credit
   * applied is 409 INVOICE_HAS_PAYMENTS (also through POST /transactions/:id/void); every /invoices route is company-scoped
   * (another company's invoice 404; customer, item, tag and default tax rate from the request's company).
   */
  'invoice-edit-v1',
  /**
   * Idempotency-Key, with idempotency-v1's contract, on exactly PUT /invoices/:id, POST /invoices/:id/void and
   * POST /invoices/:id/sent (each `x-idempotency: true` in openapi.json). Refusals (409 STALE, INVOICE_HAS_PAYMENTS, 423, 403,
   * 400) are never stored. The set is fixed: more routes get a new name (U-124).
   */
  'idempotency-invoice-v1',
  /**
   * Invoice terms (U-125): paymentTerms is a PAYMENT_TERMS code (GET /payment-terms; custom takes termsDays), omitted the
   * client's default, else the company's; discount terms store discountPercent / discountDays / discountDate; dueDate sent wins
   * (dueDateOverridden); PUT keeps the terms when omitted and recomputes the due date when the date or the terms change.
   */
  'invoice-terms-v1',
  /**
   * Invoice fields (U-123): line itemId (an item of the company; supplies the income account and the taxable flag when omitted)
   * and serviceDate; header poNumber, customerMessage (printed; memo internal), tagIds, hideZeroLines; GET /invoices/:id returns
   * them. The invoice PDF prints the message (else the memo), the PO number (template showPoNumber) and negative lines, and
   * leaves $0 lines off with hideZeroLines. Migration 0242.
   */
  'invoice-fields-v1',
  /**
   * Send history (U-126): POST /invoices/:id/sent {method: printed|email|pdf, recipients?, sentAt?}; POST /forms/mark-printed
   * records "printed" for each form it takes out of the queue; GET /invoices/:id returns sendHistory (kept across edits);
   * GET /invoices?sent=false lists invoices never sent, whatever their payment status. Recipients are never logged or audited.
   * Migration 0242 (document_send_events).
   */
  'invoice-sent-history-v1',
  /**
   * Contact open balances (U-38): GET /contacts and GET /contacts/:id add openBalance / oldestOpenDate (A/R) and
   * payableBalance / oldestOpenBillDate (A/P), 4-place decimal strings, for the request's company.
   */
  'contact-balance-v1',
  /**
   * Sales item kinds (U-39a): items.itemType service | non_inventory | other_charge | discount | subtotal (existing items read as
   * service; GET /items?itemType=); a discount item has discountPercent (0 < p <= 100) or unitPrice (the amount off), not both,
   * and is taxable unless set otherwise; a subtotal item has neither. Migration 0243. (Purchase side and units: U-39b, item-types-v1.)
   */
  'item-kinds-sales-v1',
  /**
   * Price levels (U-40, Q-P20l): GET/POST /price-levels, GET/PUT/DELETE /price-levels/:id ({priceLevel: {id, name, percent, isActive,
   * itemPrices: [{itemId, unitPrice}]}}); percent signed (-7.5 = 7.5 % down); fixed item prices stored rounded to the cent; 409
   * PRICE_LEVEL_NAME_IN_USE / PRICE_LEVEL_IN_USE. contacts.priceLevelId (one level per client; active, of the company). Migration 0243.
   */
  'price-levels-v1',
  /**
   * Invoice pricing (U-129): POST /invoices/preview computes what POST / PUT /invoices posts (same code, nothing written): lines
   * {unitPrice, unitPriceSource, discountPercent, amount, taxAmount, ...}, subtotal, taxableBase, taxRate, taxTotal, total, dueDate,
   * priceLevel, contactBalanceAfter. Invoice lines: quantity omitted is 1; unitPrice omitted takes the client's level, else the item's
   * price; discount lines (% or amount of the lines since the last subtotal; a taxable discount reduces the taxable base) and shown-only
   * subtotal lines; lines read back with discountPercent and unitPriceSource. Golden: invoice-golden.json pricingCases.
   */
  'invoice-pricing-v1',
  /**
   * Invoice email and the Outbox (U-127): POST /invoices/:id/email {to[], cc[], bcc[], subject, body, pdfFileName, pdfBase64
   * (application/pdf, <= 10 MB decoded), outboxId?} sends through the company SMTP (desktop: the session password,
   * smtp-session-v1) and, only on success, records an "email" send event (to + cc + bcc) in the same commit; 200 {invoice}.
   * 400 SMTP_NOT_CONFIGURED / SMTP_SEND_FAILED (details.reason auth|send), ATTACHMENT_TOO_LARGE, INVOICE_VOID; 503 OFFLINE_UNAVAILABLE.
   * POST /invoices/:id/email-later stores the message (no PDF; made at send time, Q-P20q) in the Outbox: 201 {item};
   * GET /forms/email-queue {data} oldest first; DELETE /forms/email-queue/:id 204 (404 OUTBOX_ITEM_NOT_FOUND). Company scope;
   * recipients never logged or audited. Idempotency-Key (idempotency-v1's contract) on POST /invoices/:id/email and
   * /email-later; this set is fixed. Migration 0244 (form_email_queue).
   */
  'invoice-email-v1',
];
