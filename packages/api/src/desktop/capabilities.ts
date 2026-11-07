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
   * PUT /invoices/:id pricingLinesComplete: true (U-129 review): the lines sent are every line the invoice keeps, so a discount or
   * subtotal left out was removed on purpose. Without it, a PUT that sends no itemId on an invoice with discount or subtotal lines is
   * 409 INVOICE_LINES_MISSING and nothing changes.
   */
  'invoice-pricing-lines-v1',
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
  /**
   * Billable costs (U-128): GET /billable-costs?contactId=&limit=&offset= lists the unbilled costs of the company (items
   * {sourceLineId, sourceTransactionId, sourceTxnType, sourceNumber, sourceDate, vendorName, description, expenseAccountId, itemId,
   * quantity, unitCost, sourceAmount, costAmount, suggestedIncomeAccountId}, totalCount, totalAmount over all pages,
   * defaultMarkupPercent). An invoice line {billableSourceLineId, accountId (required), markupPercent? (a percent, 0-1000)} bills a cost
   * whole, once, to its own customer: cost = round2(source), markup = round2(cost x pct / 100) (none on a negative cost), one visible
   * line (rate = amount / quantity), journal cost line (lineRole billable_cost) + markup line (billable_markup, company
   * billableMarkupAccountId, kept on edit). PUT re-sends or releases (releaseBillableSourceLineIds) every billed cost, else 409
   * BILLABLE_LINES_MISSING; void / delete of the invoice through any route releases them. GET /invoices/:id billableCosts; source
   * reads add billedInvoiceId / billedInvoiceNumber; contacts.defaultMarkupPercent. 409 BILLABLE_ALREADY_BILLED / COST_UNAVAILABLE /
   * INVOICE_TOTAL_BELOW_PAID / RETRY; 400 BILLABLE_CONTACT_MISMATCH / DUPLICATE_LINE / FIELDS_READONLY / INCOME_ACCOUNT_REQUIRED,
   * MARKUP_ACCOUNT_REQUIRED / INVALID. Golden: invoice-golden.json billableCases. Migration 0245.
   */
  'billable-costs-v1',
  /**
   * Invoice print layouts (U-130, Q-P20ac): GET /company/invoice-layouts[?includeArchived=true], POST /company/invoice-layouts,
   * GET/PUT /company/invoice-layouts/:id, POST /company/invoice-layouts/:id/default. A layout {id, name, isDefault, isArchived,
   * accentColor, logoUrl, showShipTo, showPoNumber, showTerms, footerText, footerOverrides, columns {item, description, serviceDate,
   * quantity, rate}, resolvedFooters, invoiceCount, createdAt, updatedAt}; exactly one default per company (the first is "Standard");
   * names unique per company (409 INVOICE_LAYOUT_NAME_IN_USE); PUT expectedUpdatedAt (409 STALE) and isArchived. Layouts are archived,
   * never deleted (DELETE 405 INVOICE_LAYOUT_DELETE_NOT_ALLOWED); the default can't be archived (409 INVOICE_LAYOUT_IS_DEFAULT) and an
   * archived layout can't become the default (409 INVOICE_LAYOUT_ARCHIVED). GET/PUT /company/invoice-template read and write the
   * default layout. Invoices: layoutId (null = the company default; edit: absent keeps) on POST / PUT / preview / GET; a new invoice
   * without layoutId starts on the client's contacts.defaultInvoiceLayoutId (unless archived). 400 INVOICE_LAYOUT_NOT_FOUND /
   * INVOICE_LAYOUT_ARCHIVED for a new choice; an invoice or client keeps an archived layout it already has. GET /invoices/:id/pdf
   * prints with it. Migration 0246.
   */
  'invoice-layouts-v1',
  /**
   * Receive Payment (U-132, Q-P21g / Q-P21t): POST /payments/preview (posts nothing; the engine computes allocation oldest first or
   * explicit rows with fill, totals, shortfalls, contact balance before/after, pendingDeposits, averageDaysToPay, problems[]);
   * POST /payments/receive in one database transaction returning {payment: PaymentRecord}; GET /payments, GET /payments/:id,
   * PUT /payments/:id (old applications set aside, closing date on both dates, deposited -> memo/refNo only), POST /payments/:id/void,
   * POST /payments/unapply (validated, audited, closing date). Exact whole cents, no tolerance: an invoice takes at most its cent
   * balance round2(balance_due); balanceDueExact echoed as applications[].expectedBalanceDue (409 INVOICE_BALANCE_CHANGED). Application
   * rows are never deleted (voidedAt / reversedByTxnId); every void path reopens invoices; reopen status from the cent balance (paid /
   * partial / viewed / sent / draft). Company-scoped (404). POST /invoices/:id/payment, bank-feed match, Stripe and MCP go through the
   * same path (Stripe and the feed never refuse: the rest stays an A/R credit). Migration 0247.
   */
  'receive-payment-v1',
  /**
   * Idempotency-Key, with idempotency-v1's contract, on POST /payments/receive, PUT /payments/:id, POST /payments/:id/void,
   * POST /payments/unapply and POST /payments/:id/bounce (`x-idempotency: true` in openapi.json) (U-132).
   */
  'idempotency-receive-payment-v1',
  /**
   * Bounced payments (U-132, Q-P21i/k/u): POST /payments/:id/bounce posts one dated returned_payment ('Bounced payment'): Cr the
   * account holding the money (deposit bank, bank, or Payments Clearing), Dr A/R; reopens the invoices (applications reversedByTxnId);
   * optional bank fee expense (source_txn_id = the bounce); response {returnId, feeId?, heldIn, reopened}. Only the bounce date meets
   * the closing date. Afterwards the payment has no credit, leaves pending deposits, can't be deposited (409 PAYMENT_BOUNCED) and its
   * deposit can't be voided, edited or deleted (409 PAYMENT_BOUNCED). Voiding the returned_payment re-applies (409 INVOICE_VOIDED /
   * INVOICE_BALANCE_CHANGED). Company settings nsfBankFeeAccountId, nsfFeeIncomeAccountId, nsfCustomerFee (GET/PUT /company/settings,
   * 400 NSF_ACCOUNT_INVALID). Cash basis reverses revenue at the bounce date. transactions.source_txn_id. Migration 0247.
   */
  'payment-bounce-v1',
  /**
   * Under- and overpayment (U-133): applications[].writeOffAmount with writeOffAccountId (default company writeOffAccountId; 400
   * WRITE_OFF_ACCOUNT_REQUIRED / INVALID); amount 0.00 with a write-off; applications may be empty (credit); creditApplications on
   * receive / PUT / preview (409 CREDIT_NOT_AVAILABLE, PAYMENT_BOUNCED); POST /payments/:id/apply; POST /customer-refunds (and
   * POST /transactions customer_refund) with sourcePaymentId within the remaining credit; void / bounce of a payment with a live refund
   * 409 PAYMENT_REFUNDED; PUT leaving less than the credit in use 409 CREDIT_IN_USE; void bounce 409 CREDIT_SOURCE_CHANGED. Preview
   * credits[], overpayment, totals.writeOffs, shortfalls[].withinWriteOffLimit (company writeOffThreshold, 1.00 by default). Company
   * settings writeOffAccountId, writeOffThreshold. Cash basis: c + discount + write-off; credits applied later recognised on their date.
   * Migration 0248.
   */
  'payment-settle-v1',
  /**
   * Early-payment discounts (U-134, Q-P21c): open invoices and preview rows carry discountPercent, discountDate, discountAvailable
   * (round2(total x percent / 100) half away from zero, capped at the cent balance, on or before the discount date, once per invoice)
   * and suggestDiscount; applications[].discountAmount with discountAccountId (default company salesDiscountAccountId; 400
   * DISCOUNT_ACCOUNT_REQUIRED / INVALID). A bounce or void reverses discounts and write-offs exactly. Migration 0248.
   */
  'payment-discounts-v1',
  /**
   * Customer deposits (U-135, Q-P21e/f): receive / PUT / preview holdAsDeposit (Dr depositTo, Cr the lazy customer_deposits liability;
   * 400 DEPOSIT_WITH_APPLICATIONS); POST /payments/:id/apply on a hold posts a draw (customer_payment, fromDepositId, Dr Customer
   * Deposits / Cr A/R) with drawId; a hold as a creditApplications source draws inside the receipt (source_txn_id, voided with it);
   * 409 DEPOSIT_NOT_AVAILABLE; GET /payments/deposits-on-hand?customerId=; preview depositsOnHand[] and holdAsDepositOffered; refund of a
   * hold debits Customer Deposits; void of a hold with draws 409 DEPOSIT_APPLIED; bounce of a hold: Cr the bank, Dr A/R the draws, Dr
   * Customer Deposits the rest, draws' applications reversed, no draw voided; a draw of a bounced deposit 409 PAYMENT_BOUNCED. Holds and
   * draws never appear in credits[] or pending deposits. PaymentRecord holdsDeposit, depositRemaining, fromDepositId. Migration 0249.
   */
  'customer-deposits-v1',
  /**
   * Bank feed and customer payments (U-136): match candidates include customer payments deposited straight to the feed's bank
   * (money in; not in a deposit, not bounced) and bounced-payment entries (money out); amounts compared exactly (no parseFloat, no
   * 0.01 tolerance), also in the list's matchCandidateCount. POST /payments/receive bankFeedItemId matches the line in the payment's
   * transaction (400 FEED_ITEM_MISMATCH, 409 FEED_ITEM_NOT_PENDING). No migration.
   */
  'feed-customer-payments-v1',
  /**
   * Credit memos as A/R credit sources (U-137): a memo's remaining = total - live applications - live refunds drawn on it.
   * GET /payments/credits?customerId= ({data: [{sourceId, kind: payment | credit_memo, date, number, total, remaining,
   * intendedInvoiceId?}], total}); POST /credit-memos/:id/apply ({date, applications: [{invoiceId, amount?, expectedBalanceDue}],
   * expectedUpdatedAt?} -> {applied, remaining}); POST /credit-memos/:id/unapply ({invoiceId, expectedUpdatedAt} -> {remaining});
   * creditApplications[].sourcePaymentId (alias sourceId) accepts a memo on receive / PUT / preview; preview credits[] gain kind and
   * number. Dates (B1b): an application is dated on or after its source (400 APPLY_DATE_BEFORE_SOURCE); a payment PUT may not move
   * its date after its credit was used or refunded (400 SOURCE_DATE_AFTER_USE). POST /payments/unapply refuses a row with a
   * discount or write-off (409 APPLICATION_HAS_ADJUSTMENTS {invoiceId}). Voiding a memo (every void path) unapplies it and reopens
   * its invoices; 409 CREDIT_REFUNDED {refundIds} while a refund is live; closing date on the memo date and every applied date;
   * the memo is locked with the receipts it was applied inside. Legacy appliedToInvoiceId on memos is an open credit (Q-P22f):
   * invoice void, related transactions and averageDaysToPay ignore it; POST /transactions credit_memo with appliedToInvoiceId writes
   * a real application. Cash basis: memo applications are not cash; a refund of a memo's credit books the memo's lines at the
   * refund date (rule 3b). No migration.
   */
  'credit-memo-apply-v1',
  /** Idempotency-Key on POST /credit-memos/:id/apply and /unapply (`x-idempotency: true` in openapi.json) (U-137). */
  'idempotency-credit-memo-v1',
  /**
   * A/R open items as of any date (U-142, U-121 A/R half): items from each posted transaction's own A/R lines per client
   * (Σ = the client's A/R balance), moved by the applications in effect on the date; later payments, unapplies and bounces
   * dated after the date don't count. Customer statements and finance charges read the same helper. No migration.
   */
  'ar-open-items-asof-v1',
  /**
   * Exact A/R aging (U-142, Q-P22o): GET /reports/ar-aging-summary keeps its numeric fields and adds bucketsExact {current,
   * days1to30, days31to60, days61to90, over90}, totalExact, difference, customers [{contactId | null, name, buckets, total}] (a
   * "(no client)" row for A/R lines without a client) and details[].openExact / kind (invoice | credit | charge | other). Open
   * credits are aged by their own date; the total equals the A/R account balance as of the date.
   */
  'ar-aging-exact-v1',
  /**
   * Customer statements (U-112, Q-175, Q-177, Q-P22h): GET /reports/customer-statement?contactId=&asOf=&format=open_item|balance_forward|
   * transaction&start= -> {statement: CustomerStatement} (aging = the client's A/R aging row; amountDue = the client's A/R balance as of
   * asOf; difference); GET /reports/customer-statements?asOf=&minDaysOverdue=&openOnly=&limit=&offset= (the batch picker). Built on the
   * open-items helper. No GL effect.
   */
  'customer-statement-v1',
  /**
   * Statement runs and sending (U-140, Q-P22c, Q-P22n): POST /customer-statement-runs {asOf, format, start?, contactIds (1..500)} ->
   * numbered snapshots (statement counter; display data only, no ids); GET /customer-statements(?contactId=), GET /customer-statements/:id
   * (snapshot + sendHistory); POST /customer-statements/:id/sent, /email (client-made PDF, U-127 errors), /email-later (Outbox). GET
   * /forms/email-queue rows gain kind (transaction | customer_statement) and customerStatementId (transactionId null for statements);
   * DELETE /forms/email-queue/:id removes either kind. Migration 0250.
   */
  'customer-statement-send-v1',
  /** Idempotency-Key on POST /customer-statement-runs and the /customer-statements/:id send routes (U-140). */
  'idempotency-customer-statements-v1',
  /**
   * Finance charges (U-141, Q-P22a, Q-P22g, Q-P22p, Q-P22s): company settings financeChargeAnnualRate (null = off), financeChargeMinimum,
   * financeChargeGraceDays, financeChargeOnFinanceCharges, financeChargeIncomeAccountId, financeChargePrintLater on GET/PUT
   * /company/settings; POST /finance-charges/preview, POST /finance-charges/assess (all or nothing; expectedCharge; 409
   * FINANCE_CHARGE_ASSESSED / FINANCE_CHARGE_CHANGED; 400 FINANCE_CHARGE_NOT_SET_UP; closing date), GET /finance-charges?period=.
   * Charged-through dates never go backwards; voiding the finance-charge invoice frees its month and days. transactions.is_finance_charge;
   * A/R open items mark finance-charge invoices. Migration 0251. A finance-charge invoice keeps its client (U-145, Q-P22v): an
   * edit (PUT /invoices/:id or PUT /transactions/:id) that changes its contactId is 409 FINANCE_CHARGE_CLIENT_CHANGE ("Void it and
   * assess again for the right client"); amount and date edits are allowed.
   */
  'finance-charges-v1',
  /** Idempotency-Key on POST /finance-charges/assess; the run is the stored entity, a replay rebuilds the response (U-141). */
  'idempotency-finance-charges-v1',
  /**
   * Refunds of credit-memo credit (U-139): POST /customer-refunds sourcePaymentId (alias sourceId) accepts a credit memo of the client,
   * locked; within its remaining (409 CREDIT_NOT_AVAILABLE {remaining}); dated on or after the source (400 REFUND_DATE_BEFORE_SOURCE);
   * refundFromAccountId a bank-type account of the company (400 REFUND_ACCOUNT_INVALID). GET /customer-refunds/:id -> {refund:
   * RefundRecord}. Voiding a memo with a live refund is 409 CREDIT_REFUNDED. Cash basis books the memo's lines at the refund date.
   */
  'refund-credit-memo-v1',
  /**
   * Refunds by check (U-139, Q-P22d): printLater (default for paymentMethod check without checkNumber) puts the refund in the check
   * print queue with the client's billing address (GET /checks/print-queue, POST /checks/print assigns numbers); a typed checkNumber
   * is checked on the bank account (409 CHECK_NUMBER_IN_USE); GET /checks lists refund checks; voiding a queued refund leaves the
   * queue (U-115). No migration.
   */
  'refund-checks-v1',
  /**
   * Credit memos on the invoice line model (U-138): POST /credit-memos/preview (posts nothing; lines, subtotal, taxableBase, taxRate,
   * taxTotal, total, contactBalanceAfter, openInvoices, suggestedApplications oldest first, remainingCredit, problems[]); POST
   * /credit-memos (lines with items, quantities, rates, discount percents, taxable flags; customerMessage, tagIds, hideZeroLines,
   * layoutId; applications at save in the same transaction, applied_date NULL; total <= 0.00 400 CREDIT_MEMO_TOTAL_NOT_POSITIVE;
   * stores subtotal and tax_amount); GET and PUT /credit-memos/:id (409 STALE, CREDIT_IN_USE; 400 SOURCE_DATE_AFTER_USE; closing date
   * on old, new and live refund dates). Posting Dr income, Dr Sales Tax Payable, Cr A/R. The sales tax liability report counts
   * credit memos negated. Idempotency-Key on POST and PUT. No migration.
   */
  'credit-memo-edit-v1',
  /**
   * Sales receipts on the invoice line model (U-143): POST /sales-receipts/preview, POST /sales-receipts, GET and PUT
   * /sales-receipts/:id; depositToAccountId optional (Payments Clearing), paymentMethod, refNo; a total below 0.00 needs a bank
   * account (400 NEGATIVE_RECEIPT_NEEDS_BANK); a deposited receipt can't change its account or amount (409 TXN_DEPOSITED).
   * Idempotency-Key on POST and PUT. No migration.
   */
  'sales-receipt-lines-v1',
  /**
   * Emailing credit memos and sales receipts (U-144, Q-P22u): POST /credit-memos/:id/email and /sales-receipts/:id/email (the
   * POST /invoices/:id/email body and errors, U-127: client-made PDF, company mail server, outboxId; response {creditMemo} /
   * {salesReceipt} with sendHistory), POST /credit-memos/:id/email-later and /sales-receipts/:id/email-later (201 {item}). A void
   * document is 400 DOCUMENT_VOID; an unknown id, another type or another company 404. GET /credit-memos/:id and
   * GET /sales-receipts/:id gain sendHistory. GET /forms/email-queue rows gain kind credit_memo and sales_receipt (txnType
   * credit_memo / cash_sale; invoices stay kind transaction). Permissions as each document's routes (invoices / transactions).
   * Idempotency-Key on the four routes (x-idempotency). Email templates stay with the client. No migration.
   */
  'sales-doc-email-v1',
  /**
   * An invoice keeps its client while anything points at it (U-146 B1): PUT /invoices/:id or PUT /transactions/:id that changes
   * contactId is 409 FINANCE_CHARGE_CLIENT_CHANGE on a finance-charge invoice (whatever is applied), else 409 INVOICE_HAS_PAYMENTS
   * {payments, credits} while a live payment or credit (memo) application or a legacy payment pointer is on it. Same-client edits
   * are unchanged. An edit down to exactly the amount paid makes the invoice paid (N2).
   */
  'invoice-client-guard-v1',
  /**
   * A deadlock on the receivables routers (/payments, /credit-memos, /customer-refunds, /finance-charges) is 409 RETRY: nothing
   * was saved, resend with the same Idempotency-Key (U-146 S1). Lock order payments -> invoices -> counter -> accounts; account
   * balances are updated in account-id order.
   */
  'receivables-retry-v1',
  /**
   * Sales tax rates to 6 places (U-148, migration 0252): journal_lines.tax_rate and companies.default_sales_tax_rate keep up to 6
   * places (8.875 % = "0.088750"); document responses and /company/settings defaultSalesTaxRate send 6-place strings. Document routes
   * accept a line taxRate as a JSON number or a long decimal and round it half up to 6 places (0.011000000000000001 -> "0.011000",
   * review B3); setup rates are strict (a string, at most 6 places, 0 <= r < 1).
   */
  'sales-tax-rate6-v1',
  /**
   * Company sales tax flags (U-25 sales-tax half, U-147): GET/PUT /company/settings salesTaxEnabled (boolean; stored NULL = on),
   * salesTaxBasis ('accrual' default | 'cash', Q-P23a), defaultSalesTaxId (an active sales tax item or group of the company, or null;
   * 400 VALIDATION_ERROR), salesTaxSsuta (boolean, default false: Q-SPF6; ClientLedger sets it true for new companies). A PUT of
   * defaultSalesTaxRate alone (MyBooks Online) moves defaultSalesTaxId to the legacy item for that rate (null for 0); a PUT of
   * defaultSalesTaxId alone sets defaultSalesTaxRate to its combined rate.
   */
  'company-sales-tax-flags-v1',
  /**
   * Idempotency-Key on the /sales-tax setup writes (U-147): POST /sales-tax/agencies, /items, /codes; PUT /:id of each; POST
   * /:id/deactivate and /:id/reactivate of each. A replay rebuilds the record.
   */
  'idempotency-sales-tax-v1',
  /**
   * Sales tax setup and documents (U-147, Q-P23d, Q-P23k, Q-P23i): /sales-tax/agencies, /items (items and groups), /codes; invoices,
   * credit memos and sales receipts (create, PUT, preview, GET) take salesTaxId (null = none; omitted: the edited document's, else the
   * client's default, else the company's), useCurrentRates and line taxCodeId, and answer salesTax {id, name, kind, rate, members [{id,
   * name, rate, tax}]} (a credit memo's member tax negative) and line taxCode {id, code, taxable, source on previews: request | client | item | is_taxable | default (a subtotal line)}. One sales tax per
   * document, tax rounded once and allocated to lines and members by largest remainder. A line taxRate selects the legacy path (rows on a
   * legacy item per rate); with salesTaxId it is 400 TAX_RATE_WITH_SALES_TAX; 400 SALES_TAX_OFF; 400 TAX_ITEM_INACTIVE (new to the
   * document); an edit keeps its saved member rates (preview problem RATE_CHANGED) unless useCurrentRates. Contacts take
   * defaultSalesTaxId and taxCodeId, items taxCodeId. Every posted sales document writes transaction_tax_lines (sum = STP lines).
   */
  'sales-tax-setup-v1',
  /**
   * Sales tax liability v2 (U-149): GET /reports/sales-tax-liability adds basis (start_date, end_date, basis accrual|cash, default the
   * company's; agency_id) and agencies [{agencyId, name, items [{taxItemId, name, rate, taxableSales, nonTaxable [{codeId, code, amount}],
   * collected, discounts, badDebts, recoveries, adjustments, paid, owedAtEnd}], totals}], totals, total, unassigned, openingPaid,
   * otherEntries, glMovement, roundingDifference (6 places) and balanceCheck, all decimal strings (totalSales / totalTax stay numbers).
   * GET /sales-tax/owed?asOf&basis&agencyId: owed per agency and item (S1: every live payment and adjustment counts whatever its date).
   * GET /reports/sales-tax-payments lists payments and linked payments. Cash collected is the running-total share per settlement (Q-P23e).
   */
  'sales-tax-liability-v2',
  /**
   * Pure-cash receipts on every cash-basis report (U-152, Q-SPF1, Q-SPF3, Q-SPF7): money received and not applied to an invoice
   * (unapplied payment remainders, held deposits, their refunds and bounces) is income in the system account "Unapplied receipts"
   * (system_tag unapplied_receipts) until applied, then moves to the invoice's income and tax at the apply date; no A/R or Customer
   * Deposits from payments on the cash Balance Sheet. Write-offs never appear on cash; invoices are recognised by cash + discount. Bill
   * payments clear A/P by cash + discount. GET /sales-tax/diagnostics/cash-basis counts what moves in closed periods (Q-P23z).
   */
  'cash-basis-spf-v1',
  /**
   * Daily sales tax (U-149, Q-P23g): daily sales template lines take salesTaxId (one active tax line, credit side, forced to Sales Tax
   * Payable) and taxCodeId (a sales line's code; none = taxable). POST /daily-sales/entries/preview adds salesTaxId, expectedTax
   * (round2(taxable sales x the rate)) and problems [TAX_DIFFERS] (a warning); posting writes tax rows for the typed tax by item.
   */
  'daily-sales-tax-v1',
  /**
   * Pay Sales Tax (U-150): POST /sales-tax/payments/preview and /payments (method check | electronic, lines, signed adjustments with a
   * reason, expectedOwed checked under the agency lock: 409 SALES_TAX_OWED_CHANGED), transaction type sales_tax_payment in /checks and the
   * print queue, GET /sales-tax/payments and /:id (stubLines), POST /payments/link and /:id/unlink (match a payment made outside),
   * POST /payments/mark-paid-through (opening lines, no GL; closing password on throughDate; 201 {runId, ...}) with GET /payments/mark-paid-through
   * and POST /payments/mark-paid-through/:runId/undo. lines[].amount null or absent = owed + adjustments (computed by the engine). An edit of a
   * linked check or journal entry that moves its date or Sales Tax Payable debit is 409 SALES_TAX_LINKED. Void with POST
   * /transactions/:id/void; no edit.
   */
  'sales-tax-pay-v1',
  /** Idempotency-Key on POST /sales-tax/payments, /payments/link, /payments/:id/unlink, /payments/mark-paid-through and its /:runId/undo (U-150). */
  'idempotency-sales-tax-pay-v1',
  /**
   * Exemption certificates (U-151): GET/POST /sales-tax/exemptions (?contactId), GET/PUT /:id, POST /:id/deactivate|reactivate (keyed
   * like the other setup writes, idempotency-sales-tax-v1); GET /reports/exemptions-expiring?asOf&within=60 (status expired | expiring).
   * Invoice and sales receipt previews add warnings [{code: EXEMPTION_MISSING | EXEMPTION_EXPIRED | EXEMPTION_EXPIRING (30 days)}] for a
   * client whose tax code is not taxable.
   */
  'tax-exemptions-v1',
  /**
   * SSUTA early-payment discounts and bad debts (U-153, Q-P23m / Q-SPF3 / Q-SPF6): while the company setting salesTaxSsuta is on
   * (default off; a new ClientLedger company turns it on), a payment's discount D and write-off W carry their share of the invoice's
   * sales tax (running total over cash + discount + write-off, split by largest remainder): Dr Sales Tax Payable d + w, discount D - d,
   * write-off W - w; rows kind discount / bad_debt with the application id. POST /payments/preview adds invoices[].discountTax,
   * .writeOffTax, totals.discountTax, .writeOffTax and salesTaxSsuta. A bounce gives back the stored shares and mirrors the rows. The
   * switch applies to postings made while it is on. Bad-debt rows count on accrual only (the liability report), discount rows on both.
   */
  'sales-tax-ssuta-v1',
  /**
   * Recovered bad debts (U-154): POST /payments/write-off-recoveries {invoiceId, date, amount, memo?} -> 201 RecoveryRecord {id,
   * txnType bad_debt_recovery, status, date, customerId, invoiceId, invoiceNumber, amount, recoveredTax, taxLines, invoiceBalanceDue,
   * memo, updatedAt}: Dr A/R, Cr the write-off account, Cr Sales Tax Payable the recovered tax; the invoice reopens. GET
   * /payments/write-off-recoveries/:id; GET /payments/write-offs?customerId&invoiceId&includeRecovered (what can be recovered). 409
   * RECOVERY_EXCEEDS_WRITE_OFF {available}, 400 RECOVERY_DATE_INVALID; void via /transactions/:id/void (409 RECOVERY_IN_USE once the
   * reopened balance was paid); 409 WRITE_OFF_RECOVERED on bounce, void and edit of the payment that wrote it off. Transaction type
   * bad_debt_recovery ("Recovered bad debt"); cash basis ignores it.
   */
  'bad-debt-recovery-v1',
  /** Idempotency-Key on POST /payments/write-off-recoveries (U-154). */
  'idempotency-recovery-v1',
  /**
   * Item kinds and the purchase side (U-39b): itemType inventory_part; purchaseDescription, purchaseCost, expenseAccountId and
   * preferredVendorId on every kind; assetAccountId and cogsAccountId (required) and reorderPoint / reorderQuantity on parts; unitLabel
   * (at most 10 characters); read-only quantityOnHand (4 places), averageCost (6) and assetValue (2) strings on parts (null on other
   * kinds). PUT /items/:id locks the row and takes expectedUpdatedAt (409 STALE); the name check runs in the transaction. Moving the
   * kind to or from inventory_part with posted lines is 409 ITEM_IN_USE; a part's asset account can't change once it has stock
   * movements (409 ITEM_HAS_INVENTORY); a new part while inventory is off is 400 INVENTORY_OFF.
   */
  'item-types-v1',
  /**
   * Inventory asset account (U-156): turning inventory on adopts the active other-current-asset account named "Inventory Asset" or
   * creates it, tags it system_tag inventory_asset and makes sure a cost of goods sold account exists. The tagged account and the
   * accounts parts name (active parts, and inactive parts with stock movements) can't be deactivated, merged away or change type (409 ACCOUNT_IN_USE).
   */
  'inventory-account-v1',
  /** inventoryEnabled on GET/PUT /company/settings (U-25; stored NULL = off); off while stock or value remains is 409 INVENTORY_IN_USE. */
  'company-inventory-flag-v1',
  /**
   * Average-cost inventory costing in the ledger core (U-157, U-158; P24 E2a + E2b): inventory_movements, one per (document, part,
   * linked sale); the item re-walked from the first affected position on every post, edit, void and delete; derived lines (lineRole cogs |
   * inventory_relief | cost_correction | cost_residual) on bills, checks and card charges (expense), vendor credits, invoices, sales
   * receipts / cash sales, credit memos and inventory adjustments, returned outside lines as inventoryLines [{role, accountId, amount,
   * movementId}] on GET /transactions/:id, /invoices/:id, /bills/:id, /vendor-credits/:id, /credit-memos/:id, /sales-receipts/:id and the
   * PUT /checks/:id reply. Credit-memo lines take returnOf {transactionId} (an invoice or sales receipt that sold the item): returned at
   * that sale's cost by cumulative difference (Q-P24e), re-valued when the sale re-costs; 400 RETURN_BEFORE_SALE, 400
   * RETURN_EXCEEDS_SALE, 409 SALE_HAS_RETURNS (Q-P24x); without returnOf at the current average. NEGATIVE_STOCK {itemId, date, onHand}
   * in warnings[] of posting replies and of the invoice, credit memo and sales receipt previews. A part line needs a quantity; purchases
   * post to the part's asset account; a line on an inventory asset account without a part outside journal entries is 400
   * INVENTORY_ACCOUNT_DIRECT; a client-sent derived lineRole is 400 VALIDATION_ERROR; parts on other document types are 400
   * INVENTORY_DOCUMENT_UNSUPPORTED; any document with part lines dated on or before the closing date (old or new date) is 409
   * INVENTORY_PERIOD_CLOSED before any write, closingPassword or not (owner decision 2026-11-06; no restatement); bulk moves and memorize of inventory documents are 409 INVENTORY_DOCUMENT;
   * deadlocks, serialization failures and lock timeouts are 409 RETRY. GET /items stock figures come from the movements.
   */
  'inventory-costing-v1',
  /**
   * Inventory adjustments and counts (U-159, P24 E3): POST/GET/PUT/DELETE /inventory/adjustments(/:id) and POST /:id/void (Idempotency-Key,
   * expectedUpdatedAt 409 STALE), one line per part {itemId, quantityChange?, valueChange?} against an adjustment account; quantity only at
   * average cost; a value-only line with nothing on hand is 400 INVENTORY_NO_STOCK (Q-P24s). GET /inventory/count-sheet?asOf (active parts,
   * on hand and value as of the date) and POST /inventory/counts {asOf, adjustmentAccountId, lines: [{itemId, sheetOnHand, countedQuantity}]}:
   * on hand recomputed under the item locks, any mismatch 409 STALE listing every such item, else one adjustment for the differences (Q-P24g).
   * POST /items takes opening {quantity, value, asOf} on a part: an adjustment against Opening Balances (created if missing) in the item's
   * transaction (Q-P24h). Anything dated on or before the closing date is 409 INVENTORY_PERIOD_CLOSED.
   */
  'inventory-adjust-v1',
  /**
   * Inventory reports (U-160, P24 E4), from the stock ledger as decimal strings: GET /reports/inventory-valuation?asOf (per item on hand,
   * average cost, value, percentOfTotal; per inventory asset account valuation, accrual glBalance as of the date and difference; totalValue;
   * basisNote on cash-basis companies), GET /reports/inventory-valuation-detail?from&to&itemId&limit&offset (movement rows in posting order
   * with running figures, opening per item) and GET /reports/inventory-stock-status?asOf (active items, on hand, reorder point, reorder flag).
   * Inventory off: 400 INVENTORY_OFF.
   */
  'inventory-reports-v1',
  /**
   * Reorder alerts (U-78, P24 E4): GET /items/reorder-alerts {data, total} and GET /reports/reorder {title, asOf, data}: active inventory items
   * with a reorder point whose on hand now is at or below it, with reorder quantity and preferred vendor.
   */
  'reorder-alerts-v1',
  /**
   * Units of measure (U-161, P24 E5, Q-P24i): GET/POST /unit-sets, GET/PUT/DELETE /unit-sets/:id (a base unit and units with fixed factors,
   * base units per unit, 6 places; expectedUpdatedAt 409 STALE); items take unitSetId, defaultPurchaseUnitId, defaultSaleUnitId and return
   * unitPrices; every item line (bills, vendor credits, checks, card charges, invoices, credit memos, sales receipts, cash sales, inventory
   * adjustments and counts) takes unitId (null = base): quantity and unitPrice stay in that unit, baseQuantity = round4(quantity x factor) half
   * away from zero drives stock, costing and reports; 400 UNIT_NOT_IN_SET, 400 UNIT_QUANTITY_TOO_SMALL; a unit on any line keeps its factor and
   * set, and an item on any line keeps its set (409 UNIT_IN_USE, Q-P24w). GET /reports/reorder adds purchaseUnit and
   * reorderQuantityInPurchaseUnit; stock status adds unitSetId and baseUnit. Migration 0260.
   */
  'units-of-measure-v1',
  /**
   * Inventory checkpoint fixes (U-162, ClientLedger PR-4; migration 0261): one total position order for stock ledger reads (a credit memo's
   * unlinked row first, then its linked rows by their sale's date and entry order, so the order survives a tenant import; the import
   * re-walks every item; on hand, valuation, count sheet and walk agree); NEGATIVE_STOCK (one per item) also when a void, delete or
   * edit takes a later row below 0, when an earlier value-only adjustment is left at on hand 0 or below, and on each sale while already
   * below 0 (previews too), never for the posting's own inflow; parts on a new or edited document while inventory is off are 400
   * INVENTORY_OFF (an edit of only the memo of an older document with parts included); a return linked to a sale sold below 0 comes back
   * at relief + the correction attributed to it (its own returns cure its short units first), never below 0;
   * cash-basis COGS and inventory relief follow every settlement (payment, write-off, applied credit memo, $0 sale, Q-PR4a);
   * valuation detail rows carry expenseKind; adjustment lines with opposite-sign quantity and value, and part lines with more than 2
   * decimals, are 400 VALIDATION_ERROR.
   */
  'inventory-checkpoint-v1',];

