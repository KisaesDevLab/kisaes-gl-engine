// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

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
   * Bank Feed closed period (U-165): PUT /banking/feed/:id/categorize, POST /banking/feed/:id/approve, POST /banking/feed/bulk-approve,
   * POST /banking/feed/bulk-categorize and POST /banking/feed/bulk-post-to-suspense take `closingPassword` (or a staff
   * `overrideConfirmed: true` when the company has no closing-date password) like POST /transactions. Single item: 423
   * TB_PERIOD_LOCKED (details lockDate, canOverride, closingPasswordRequired), 403 CLOSING_PASSWORD_INVALID, 429
   * CLOSING_PASSWORD_RATE_LIMIT; an allowed posting writes a closing_date_override audit row. Bulk: a wrong password is 403 before any
   * item posts; a closed-period item without one is a `failures` entry {id, error, code: 'TB_PERIOD_LOCKED'}; every failure carries
   * its error `code` when there is one.
   */
  'feed-closing-date-v1',
  /**
   * Exact Bank Feed posting (U-164): categorize and approve post the item amount exactly as stored (decimal.js, no floating point).
   * PUT /banking/feed/:id/categorize and PUT /banking/feed/:id/assign take `splits?: [{accountId, amount ^\d{1,12}(\.\d{1,2})?$ > 0,
   * tagId?|null, memo? <= 500}]`, 2-50 lines, adding up exactly to |amount|, else 400 SPLITS_DONT_BALANCE {kind: 'fixed', difference,
   * splitTotal, amount}; an amount with more than 2 decimals can't be split (400 AMOUNT_NOT_CENTS). The owner's account overrides a
   * rule's staged split: categorize or assign without `splits` posts or stages one line on accountId (assign clears the staged split).
   * Staged percentage splits must total exactly 100 as decimals (400 SPLITS_DONT_BALANCE {kind: 'percentage', percentTotal}; rule
   * create and update also refuse any other total) and are allocated in cents by largest remainder, equal remainders by line order
   * (100.00 at 33.334 / 33.333 / 33.333% = 33.34 / 33.33 / 33.33; 0.03 at 50 / 50% = 0.02 / 0.01); staged fixed splits round to cents half away from zero and must add up exactly
   * (400 SPLITS_DONT_BALANCE); a negative fixed line posts on the other side; 0.00 lines are left off.
   */
  'feed-exact-v1',
  /**
   * Line-level bank feed matches (U-166, U-172; migration 0265): a feed item matches one journal line on its own bank account, a
   * credit for money out (feed amount > 0) or a debit for money in (< 0), for exactly |amount|, on a posted entry, not held by another
   * item (bank_feed_items.matched_journal_line_id, unique). The same predicate drives GET /banking/feed/:id/match-candidates (one row
   * per line: id = the entry, journalLineId, amount in the feed sign), the list's matchCandidateCount, the review buckets and GET
   * /banking/feed/:id/payroll-overlap ({overlaps: [{txnId, journalLineId, memo, date, amount}]}, money out only, exact; each payroll
   * bank line matches its own item). PUT /banking/feed/:id/match {transactionId, journalLineId?} on a pending or assigned item: 400
   * LINE_REQUIRED {journalLineIds} when more than one line fits, 400 MATCH_MISMATCH {field}, 409 LINE_ALREADY_MATCHED; audited;
   * response {message, item}. U-136 sign fix: money in is a negative feed amount (match candidates, POST /payments/receive
   * bankFeedItemId). Categorize and approve stamp the posted entry's bank line. Voiding an entry a feed item points at is allowed
   * (Q-P26u): every such item keeps its status and link, gets entryVoided / entryVoidedAt (list filter entryVoided=true|false,
   * GET /banking/feed/counts entryVoided) and an audit row (bank_feed, entry_voided). POST /banking/feed/:id/review-again (Idempotency-Key
   * required) unlinks it back to pending with its suggestion and no staged values, audited; 409 ENTRY_NOT_VOIDED otherwise.
   */
  'feed-match-v2',
  /**
   * Feed review states and keys (U-173): categorize, approve, assign, match, exclude and unexclude answer 409 FEED_ITEM_NOT_PENDING
   * {status} (was 400) for an item not waiting for that action; categorize takes pending or assigned items; categorize and approve
   * claim, post and flip the item in one database transaction (no 'categorizing' left behind); on engine start rows left
   * 'categorizing' for more than 5 minutes go back to assigned or pending. Idempotency-Key (`x-idempotency: true`) is optional on PUT
   * /banking/feed/:id/categorize, POST /banking/feed/:id/approve and PUT /banking/feed/:id/match, and required (400
   * IDEMPOTENCY_KEY_REQUIRED) on POST /banking/feed/:id/duplicate and /review-again; none on the bulk routes. Rules never post in
   * desktop mode (legacy auto_confirm rules only stage, Q-P26o), and AI never runs unattended there (imports, recleanse; Q-P26c).
   */
  'feed-idempotency-v1',
  /**
   * Bank feed review (U-174, U-168; migration 0266): POST /banking/feed/:id/duplicate {decision: keep | remove} (Idempotency-Key
   * required): keep clears possibleDuplicate, remove excludes the row with exclusionReason 'duplicate' (unexclude brings it back
   * still flagged); 409 NOT_A_POSSIBLE_DUPLICATE; an import Undo counts removed duplicates as untouched. GET /banking/feed rows add
   * duplicateOf {id, date, amount, description, memo, status} | null, suggestedRule {id, kind: conditional | legacy, name, autoAccept,
   * updatedAt} | null (the rule that staged the suggestion, bank_feed_items.suggested_rule_id / _kind, written with the suggestion;
   * autoAccept = a legacy rule's auto_confirm, false for conditional rules until feed-accept-v1), bucket, entryVoided, entryVoidedAt,
   * matchedJournalLineId and exclusionReason; filters bucket=ready|review|matches, possibleDuplicate=true|false, entryVoided=true|false.
   * GET /banking/feed/counts {waiting, ready, review, matches, possibleDuplicate, accepted, entryVoided, excluded, inProgress} uses the
   * same predicates (scope bankConnectionId, startDate, endDate). Buckets, first match wins: possible duplicate = review; a match signal
   * (a candidate line, or one Payments Clearing item for exactly a money-in amount within 10 days) = matches; no account, a non-rule
   * suggestion under 0.80, mark_for_review or a staged split that can't post = review; else ready. Classification rows of legacy rules
   * carry matched_bank_rule_id. Waiting conditional-rule rows of earlier imports were backfilled; legacy-rule rows get their
   * attribution on the next Reprocess Rules.
   */
  'feed-review-v1',

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
  'inventory-checkpoint-v1',
  /**
   * Bank file import batches (U-06; migrations 0262 U-163 and 0263): POST /banking/feed/import-batch takes one account section of a
   * parsed bank file {accountId, format, fileName, sourceFileSha256, sectionIndex, sectionStart, sectionEnd, amountsFlipped, csvMapping?
   * (at most 16,384 characters as JSON), dryRun, relinkIdentity?, bankIdentity?: {bankId?, acctId} (the raw OFX BANKID/ACCTID, loopback
   * only, Q-P25u: the engine keeps the last 4 characters of acctId as the mask and an HMAC-SHA256 of "v1|" + trim(bankId or "") + "|" +
   * trim(acctId) under a per-company link key that it makes on the first commit, stores encrypted and carries in a tenant export; the raw
   * values are never stored, logged, audited or kept with an Idempotency-Key), fileEndingBalance? (400 VALIDATION_ERROR unless
   * ^-?\d{1,12}(\.\d{1,2})?$), fileEndingDate?, rows: [{line, date, amount, description, memo?, checkNumber?, fitid?, include?,
   * changedAction?}]}; amounts are decimal strings in the feed sign (positive = money out) matching ^-?\d{1,12}(\.\d{1,2})?$. The engine
   * computes dedupe keys v1 (packages/api/src/services/bank-import/__fixtures__/dedupe_v1.json; OFX/QFX description = NAME only, MEMO goes
   * in memo and is never keyed) and returns {batchId?, sameFileImportedAt?, identityLinkedElsewhere?, insertedItemIds, postProcessing?,
   * rows: [{line, status new|duplicate|possible_duplicate|changed, reason?, existingItemId?, existingImportedAt?, existingPending?,
   * closedPeriod, inserted, replaced?}], counts, insertedTotal, balanceCheck?}. Classification runs step by step over all rows (order
   * independent): same FITID + same amount + posted date within 5 days = duplicate; then same row key = duplicate (not when the row has a
   * new FITID and the item another one); then same FITID with another amount = changed; then look-alikes. A commit inserts new rows and
   * possible duplicates (feed items carry possibleDuplicate and possibleDuplicateOf, also on GET /banking/feed; include:false skips a row),
   * never exact duplicates; "replace" keeps the item with its own batch and undo of the replacing batch restores it. A matching saved
   * rule is staged as a suggestion (suggestedAccountId, matchType "rule"), never posted. A dry run needs read permission on banking, a
   * commit write (Q-P25ab); a dry run takes no Idempotency-Key (400 IDEMPOTENCY_KEY_NOT_ALLOWED); a commit needs one (400
   * IDEMPOTENCY_KEY_REQUIRED) and replays its stored result with the live postProcessing. 422 account_not_bank_or_card,
   * account_not_in_company, invalid_row {line, field}, too_many_rows, batch_total_too_large; 409 identity_linked_elsewhere. Never
   * posts, never calls AI. GET /banking/feed/import-batches, DELETE /banking/feed/import-batches/:id (undo {batchId, removed, restored,
   * kept, undoneAt}; 409 rows_already_used {lines} unless ?pendingOnly=true, 409 already_undone; 409 still_preparing only as in
   * bank-import-progress-v1), POST /banking/connections/lookup {bankId?, acctId?, mask?} (read permission). A bank transaction id is
   * unique per bank connection (U-163).
   */
  'bank-import-batch-v1',
  /**
   * Import post-processing progress and undo while preparing (U-06 follow-up, Q-P25ad; migration 0264). Post-processing runs in chunks
   * (20,000 rows in seconds). GET /banking/feed/import-batches rows carry processed (items done) and total (items to do; null until it
   * starts), raised after each chunk. postProcessing (list, commit replay) is scheduled | done | failed | cancelled; cancelled = an undo
   * stopped it. DELETE /banking/feed/import-batches/:id while post-processing runs stops it after its current chunk and undoes (200, as
   * before); when the undo does not go through (rows_already_used) post-processing goes on. 409 still_preparing only when it did not
   * stop within 20 s: nothing was undone, retry. Rows with status changed also carry existingAmount (the existing item's amount before
   * this batch: decimal string, feed sign, at least 2 decimals) and existingDate (YYYY-MM-DD), dry run and commit (Q-P25af).
   */
  'bank-import-progress-v1',
  /**
   * Bank file import account types (U-175): POST /banking/feed/import-batch takes an asset account with any bank register
   * detail type (bank, checking, savings, cash, petty_cash; the set bank deposits and batch groups use) or a credit_card
   * liability. Bank register types are balance-checked as a bank (debit balance). Other accounts stay 422
   * account_not_bank_or_card.
   */
  'bank-import-account-types-v1',
  /**
   * Feed transfers and deposits (U-171). GET /banking/feed/:id/transfer-candidates?windowDays=1..10 (default 3) → {candidates:
   * [{feedItemId, accountId, accountName, date, amount}]}: pending or assigned items on another GL account with the exact opposite
   * amount (feed sign, decimal string), closest date first. POST /banking/feed/:id/transfer {otherFeedItemId | toAccountId,
   * closingPassword?} posts ONE transfer (source bank_feed) dated on the money-out side (the closing date is checked against it)
   * and matches every item to it in one database transaction; 400 TRANSFER_MISMATCH {field}. POST /banking/feed/:id/deposit
   * {sourceTransactionIds (1-100), feeLines?: [{accountId, amount ^\d{1,12}(\.\d{1,2})?$ > 0, memo? ≤ 500}] (≤ 10),
   * closingPassword?} posts ONE deposit from the payments' live Payments Clearing amounts (Dr bank, Cr Clearing per payment, Dr
   * each fee account) and matches it; payments − fees must equal the bank amount exactly (400 FEED_ITEM_MISMATCH {difference}),
   * 400 FEE_ACCOUNT_INVALID {accountId} (bank/card, Payments Clearing, A/R, A/P or another company), 400
   * PAYMENT_NOT_PENDING_DEPOSIT {id}, 409 PAYMENT_BOUNCED. Both posts: response {transaction, items: [{feedItemId,
   * journalLineId}]} (deposit adds payments [{id, amount}]); Idempotency-Key required (400 IDEMPOTENCY_KEY_REQUIRED); 409
   * FEED_ITEM_NOT_PENDING {id, status}, 409 FEED_ITEM_IN_USE {id}, 409 FEED_ITEM_POSSIBLE_DUPLICATE {id, possibleDuplicateOf} (an
   * item still flagged; keep or remove it first); closed period as feed-closing-date-v1; audited. Practice
   * match-apply transfers post the same way; its amounts are exact decimals.
   */
  'feed-match-post-v1',
  /**
   * GET /dashboard/account-balances (U-77) → [{accountId, name, accountNumber, kind bank|card, booksBalance, bankFileBalance|null,
   * bankFileDate|null, booksBalanceAtFileDate|null}] per active bank, cash and card account: the latest bank file by file ending
   * date, then import time, undone imports skipped. Register sign (a card: positive = owed). Decimal strings.
   */
  'account-balances-v1',
  /**
   * POST /banking/feed/accept (U-170): {items: [{id, accountId?, contactId?, tagId?, memo?, splits?, matchTransactionId?,
   * journalLineId?}] (1-500) | ruleId + ruleKind (conditional|legacy) + ruleUpdatedAt + bankConnectionId? + afterId?,
   * closingPassword?} → {undoGroupId, posted, matched, skipped: [{id, reason}], failures: [{id, code, error, details?}],
   * remaining, nextAfterId}. Validate then post in ONE database transaction under one required Idempotency-Key (replay
   * identical; GET /banking/feed/accept-groups/:id over 512 KB). Skips not_found, in_use, not_pending, possible_duplicate,
   * has_match (any match signal, incl. the other side of a transfer, unless values or a match are sent), incomplete,
   * staging_differs; failures TB_PERIOD_LOCKED, SPLITS_DONT_BALANCE, AMOUNT_NOT_CENTS, MATCH_MISMATCH, LINE_REQUIRED,
   * LINE_ALREADY_MATCHED. Rule mode: 409 RULE_CHANGED {updatedAt}, 409 RULE_NOT_AUTO_ACCEPT, 404 RULE_NOT_FOUND; 500 rows per
   * call, continue with afterId = nextAfterId. conditional_rules.auto_accept (CRUD autoAccept; list suggestedRule.autoAccept)
   * never posts on its own. Rule conditions: amount_abs, exact decimal amount comparisons. Desktop mode skips the
   * CONDITIONAL_RULES_V1 flag check. The other side of a transfer is a match signal (bucket "matches").
   * GET /banking/feed (Q-P26y): status=accepted lists every categorized and matched row (entryVoided included; total =
   * /counts accepted), paged; rows carry transferCandidate {feedItemId, accountId, accountName} | null, the other side of a
   * transfer when exactly one waits (the matches bucket's transfer rule, 3 days or transferWindowDays, feed-transfer-window-v1), null on rows that aren't waiting.
   */
  'feed-accept-v1',
  /**
   * POST /banking/feed/undo (U-169): {feedItemIds (1-500) | undoGroupId, force?, closingPassword?} → {undone: [{id, kind,
   * transactionId, entry: deleted|kept, undoGroupId}], failures: [{id, code, error, details?}]}. Works only from accept records
   * (every accept, categorize, approve, match, payment, transfer and deposit writes one; transfer, deposit and PUT match return
   * undoGroupId) whose row still points at the recorded entry. Deletes a posted entry after unlinking every row on it (both
   * transfer sides; a deposit's payments go back to Payments Clearing exactly) whenever the posting row is in the request, also
   * with a later match selected; a request of only matches / payments, or a voided entry, is only unlinked. The changed check
   * covers date, contact, memo and each line's account, debit, credit and tag; a held entry is FEED_ITEM_IN_USE. Restores each
   * row's prior review state (Review again too); counts a learning override. 409 FEED_UNDO_CHANGED {ids}
   * (the entry changed since; nothing undone; resend with force); failures FEED_UNDO_RECONCILED, TB_PERIOD_LOCKED,
   * PAYMENT_BOUNCED, FEED_ITEM_NOT_ACCEPTED, FEED_ITEM_IN_USE. Idempotency-Key required.
   */
  'feed-undo-v1',
  /**
   * GET /banking/feed and GET /banking/feed/counts take transferWindowDays (U-177): an integer 1-10, default 3 (400
   * VALIDATION_ERROR otherwise). It is the transfer twin window of the matches bucket (bucket, ?bucket=matches, /counts matches)
   * and of the list's transferCandidate, as GET /banking/feed/:id/transfer-candidates windowDays; send the same value to both so
   * the counts equal the list totals. POST /banking/feed/accept's has_match skip keeps the 3-day window.
   */
  'feed-transfer-window-v1',
  /**
   * GET /banking/feed rows carry acceptKind (U-178): post | match | transfer | deposit | payment, the kind of the row's live accept
   * record (this item, its current entry, not undone, newest; the record POST /banking/feed/undo acts on), else null (waiting,
   * excluded, or accepted before accept records existed). A matched row with acceptKind transfer or deposit was posted by that
   * accept; match means it was linked to an entry already in the books.
   */
  'feed-accept-kind-v1',
  /**
   * Deleting an entry reopens its documents (U-180): ledger deleteTransactionInTx (DELETE /transactions/:id, POST
   * /banking/feed/undo of a posted entry, a journal entry's reversal, DELETE /inventory/adjustments/:id, any other caller)
   * sets every document draft converted onto the entry (convert, attach or a feed accept with documentDraft) back to
   * status ready with convertedTransactionId / convertedType / convertedAt cleared and a new updatedAt (kind and reading
   * kept), and moves its own file, when still on the entry, back onto a draft key (the key it was relinked from, else the
   * draft's id), together with every other file on the entry that the same relink took off that key (U-183,
   * attachments.source_draft_key); files filed on the entry by hand stay. Same database transaction, audited
   * (`reopened: true`); a draft whose file was deleted reopens without one. DELETE /transactions/:id answers
   * {transaction, reopenedDrafts: [id]} and the undo response adds reopenedDrafts (sorted). A void keeps the entry and its
   * drafts stay converted (an attach to a void entry stays 409 TRANSACTION_NOT_POSTED); an Undo that keeps the entry (a
   * match) keeps its documents. Migration 0269: index idx_document_drafts_converted; 0270: attachments.source_draft_key.
   */
  'document-drafts-reopen-v1',
  /**
   * POST /banking/feed/accept items take documentDraft {id, expectedUpdatedAt} (U-181): after the row posts or matches, the
   * draft is filed on the entry in the same database transaction as POST /document-drafts/:id/attach does (draft key files
   * move, draft converted onto the entry, audited attached: true with feedItemId and undoGroupId). A draft that can't be
   * attached fails its row with nothing posted: failures DOCUMENT_DRAFT_CLOSED (details.transactionId), STALE
   * (details.updatedAt), DOCUMENT_FILE_MISSING, ATTACHMENT_NOT_DRAFT, INVALID_KIND (statement), TARGET_NOT_ATTACHABLE,
   * PERMISSION_DENIED, NOT_FOUND. One draft on two items is 400 VALIDATION_ERROR; permission (draft kind + entry resource)
   * is checked before a replay too (403). Drafts are locked after the feed rows and before any entry. A replay returns the
   * stored response. Undo of the posted entry reopens the draft (document-drafts-reopen-v1).
   */
  'feed-accept-draft-v1',
  /**
   * POST /banking/feed/accept runs convert's duplicate check on a row that would post an expense with a documentDraft
   * (U-185), before anything posts and under convert's company + vendor advisory lock: vendor = the row's contact, else
   * the draft's suggestedContactId; reference = the draft's docReference; total and date = the row's. A posted bill or
   * expense of the vendor with that reference, or the same total within 60 days, not listed in
   * documentDraft.acknowledgeDuplicateOf (uuid[], max 50) fails the row DOCUMENT_POSSIBLE_DUPLICATE (distinct from the
   * bank line's possible_duplicate skip) with details {draftId, matches} (matches as GET /document-drafts/:id/duplicates,
   * source transaction); the row stays waiting and the draft unchanged. Acknowledged matches post once (audited as
   * acknowledgedDuplicates on the draft's attach row). Rows that match an existing entry or bring money in are not checked.
   */
  'feed-accept-draft-duplicates-v1',
  /**
   * The document duplicate check also runs when no vendor is known (U-99): on POST /document-drafts/:id/convert (no
   * body contactId), on POST /banking/feed/accept with a documentDraft (no row contact and no suggestedContactId) and in
   * GET /document-drafts/:id/duplicates (no suggestedContactId). It looks at posted bills (open ones too), expenses,
   * card charges and checks of any vendor in the company (not void or deleted): the same normalized reference (when the
   * document has one), or the exact same total dated within 7 days either side. Matches have the usual shape plus
   * noVendor: true (false on every vendor-rule match) and are acknowledged the usual way (acknowledgeDuplicateOf;
   * refusals POSSIBLE_DUPLICATE / DOCUMENT_POSSIBLE_DUPLICATE). Other live drafts are matched only with a vendor. With
   * a vendor the rules are unchanged. Vendorless checks serialize on a company-wide advisory lock.
   */
  'document-duplicates-no-vendor-v1',
  /**
   * Exact reconciliation (U-188): GET /banking/reconciliations/:id and every route returning a reconciliation add
   * clearedBalanceExact and differenceExact (decimal strings; clearedBalance / difference stay JSON numbers for older
   * clients), clearedDeposits / clearedPayments {count, total} and per line amount (debit - credit) and
   * afterStatementDate. complete only at a difference of exactly 0 (400 RECONCILE_DIFFERENCE_NOT_ZERO {difference}) and
   * stores the real difference. PUT lines / PATCH / refresh / complete / cancel on a reconciliation not in progress: 409
   * RECONCILIATION_NOT_IN_PROGRESS {status}. PATCH flips a liability's statement balance like start. PUT lines takes up
   * to 10,000 lines in two statements; ?view=summary (GET, PATCH, PUT lines) leaves the lines out. One in-progress
   * reconciliation per account (unique index, migration 0272): start answers 409 RECONCILIATION_IN_PROGRESS
   * {reconciliationId}. complete and cancel are audited in their transaction.
   */
  'reconcile-exact-v1',
  /**
   * Begin charges, later lines, bank-file pre-check, drift (U-189, migration 0271): start and PATCH take serviceCharge /
   * interest {amount, date, accountId} (or null), counted in the cleared balance until complete posts them (an expense /
   * a deposit, closing date enforced, closingPassword on complete); pending {serviceCharge, interest}; PATCH of a posted
   * charge 409 RECONCILE_CHARGE_POSTED {kind}; PATCH takes statementDate. start / refresh take includeLaterLines and
   * precheck: 'bank_feed'. Lines carry fromBankFeed, source, sourceId. beginningBalanceDrift {reconciliationId, expected,
   * actual, difference} | null and postingLocked. refresh removes rows whose journal line is gone.
   */
  'reconcile-begin-v1',
  /**
   * POST /banking/reconciliations/:id/undo {mode?: clear_checks | keep_checks | discard, closingPassword?} (U-190):
   * owner only (403 RECONCILE_ADMIN_REQUIRED); 409 RECONCILIATION_NOT_LATEST, RECONCILIATION_IN_PROGRESS,
   * RECONCILIATION_NOT_COMPLETE; closed period needs the closing password (423 TB_PERIOD_LOCKED), override audited;
   * posted charges stay; one audit row {undo: {mode}} with the cleared line ids before.
   */
  'reconcile-undo-v2',
  /**
   * GET /reports/reconciliation-discrepancy?account_id= (U-191; reports read + banking read): {accountId, rows, drift}.
   * rows: kind changed | voided | deleted (audit rows on reconciled entries written after the reconciliation was
   * finished), added_after (entries dated inside a reconciled period, entered after it was finished, not cleared),
   * reconciliation_undone (undo audit rows, with undoMode); reconciliationId, statementDate, transactionId, txnDate,
   * txnType, number, payee, reconciledAmount, effect (strings), changedAt, changedBy, fields[] (names only, never values).
   * drift: the latest completed reconciliation's {reconciliationId, expected, actual, difference} | null.
   */
  'reconcile-discrepancy-v1',
  /**
   * Editing an entry through the full-replace path keeps in-progress reconciliation ticks and bank-file links (U-192):
   * each old line referenced by an in-progress worksheet row or bank_feed_items.matched_journal_line_id moves to the single
   * new line on the same account and side. A worksheet row stays ticked only if the amount is unchanged (else unticked,
   * audited); with no single match it is removed (refresh adds the new line). A feed row moves only if the amount is
   * unchanged. Completed reconciliations are not touched.
   */
  'line-identity-v1',
  /**
   * Reconcile hardening (U-193, P27 review): GET of an in-progress worksheet and complete leave out rows whose entry is no
   * longer posted (complete deletes them first, audit droppedLineIds), so a void after ticking no longer counts. Start and
   * PATCH statementDate answer 409 RECONCILE_STATEMENT_DATE_ORDER {latestReconciliationId, latestStatementDate} for a date on
   * or before the latest completed reconciliation's; "latest" breaks a same-date tie by the later finish (beginning balance,
   * undo). An edit, void or delete of an entry on a worksheet locks that reconciliation header first, so it waits for a
   * Finish in flight and then meets the completed-reconciliation guard. PATCH of a posted charge whose entry was voided or
   * deleted is accepted: the charge is pending again and the next complete posts it.
   */
  'reconcile-hardening-v1',
  /**
   * Reconcile QA follow-ups (U-194–U-196, P27 QA). Registers of every bank detail type (bank, checking, savings, cash,
   * petty_cash) report the bank allowedEntryTypes [expense, deposit, transfer, journal_entry] (U-194). Changing the date
   * or reconciled line of an entry cleared in a completed reconciliation, voiding it, or voiding such a bill payment is
   * 409 RECONCILED_TRANSACTION like delete (was a code-less 400; message text unchanged); every RECONCILED_TRANSACTION
   * carries details {action: void | update | delete, field?: txnDate | lines (update), reconciliationId, statementDate}
   * naming the latest such reconciliation (U-195). The register summary's lastReconciliationDate is the latest completed
   * reconciliation's statement date: statement date DESC, then completedAt DESC (U-196).
   */
  'reconcile-qa-v1',
  /**
   * Category edit of a reconciled entry (U-198, P27 QA-13). An edit of an entry cleared in a completed reconciliation
   * keeps every line on a reconciled account and the date (else 409 RECONCILED_TRANSACTION as before); its other lines,
   * also balance-sheet ones such as A/R, owner's equity or a loan, can be recategorized. Before, every balance-sheet
   * line was kept, so moving a deposit's A/R line to income or a check's owner's-draw line to an expense was refused.
   * An unchanged balance-sheet line keeps its id; a replaced one carries its in-progress worksheet row and bank-file
   * link to its successor (U-192).
   */
  'reconciled-category-edit-v1',
  /**
   * Bank lines whose entry was changed (U-199, ClientLedger PR-5 B1, Q-PR5a). An edit of an entry that changes the amount of
   * a bank feed row's line, or moves it to another account, is kept (never refused); the row keeps its status and entry and
   * gets entryChanged / entryChangedAt (list filter entryChanged=true|false, /feed/counts entryChanged, audit bank_feed
   * entry_changed). matchedJournalLineId names the entry's new line when one line on the bank account and side pairs and no
   * other row holds it (the line stays held), else null (no line held, and the row no longer holds the whole entry). A flagged
   * row is never a reconcile pre-check source or fromBankFeed. POST /feed/:id/review-again takes it (as entryVoided) back to
   * waiting. POST /feed/undo's reconciled check for an unlink uses the entry's current lines on the row's account. Migration
   * 0273 clears and flags rows whose line was already gone (audited, reason backfill_0273).
   */
  'feed-entry-changed-v1',
  /**
   * Bank feed guards for direct callers (U-200, ClientLedger PR-5 S1, S3, N1, N2). POST /feed/accept takes transferWindowDays
   * (1-10, default 3) for its has_match transfer signal. PUT /feed/:id/categorize, POST /feed/:id/approve, PUT /feed/:id/match,
   * POST /payments/receive {bankFeedItemId} and a bill payment for a bank line answer 409 FEED_ITEM_POSSIBLE_DUPLICATE {id,
   * possibleDuplicateOf} for a row still flagged as a possible duplicate (bulk approve/categorize list it in failures[]); POST
   * /feed/:id/duplicate keep clears the flag, as for transfer and deposit. POST /feed/:id/transfer {toAccountId} answers 409
   * FEED_ITEM_HAS_MATCH {id, candidates: [{transactionId, journalLineId, txnType, txnDate}]} when the line matches an entry already
   * in the books, unless force: true. Import batch rows carry existingReplaceable (Replace would update the item) and, on commit,
   * replaceRefused not_waiting | staged with replaced false.
   */
  'feed-guards-v1',
  /**
   * Exact reports (U-14, U-205, ClientLedger P28 PR-A). ?exact=1 on the /reports catalog routes (profit-loss incl. compare=, balance-sheet
   * incl. compare=, trial-balance, general-ledger, account-activity-summary, transaction-list, journal-entry-report, invoice-list,
   * customer-balance-summary|detail, vendor-balance-summary, ap-aging-summary|detail, unpaid-bills, bill-payment-history, vendor-statement,
   * transaction-list-by-vendor, ap-1099-prep, vendor-1099-summary, sales-by-customer, sales-by-item, expense-by-vendor, expense-by-category,
   * revenue-by-category, deposit-detail, check-register, bank-balances): every money field x gains xExact (unrounded decimal string, same
   * sign; 4 places from the journal; a cash-basis allocation share in whole cents since U-209), totals are Decimal sums of the rows, dates are
   * YYYY-MM-DD, and meta {exact, basis, cashBasisRules, from, to | asOf, reportSchemaVersion} is added. Standard P&L / Balance Sheet / Trial
   * Balance account rows carry parentAccountId, depth and rollupExact on parents (comparative columns do not); GL lines and accrual
   * transaction-list rows carry lineId; GL takes limit and returns rowCount and truncated; comparative rows carry valuesExact (% at 1 place).
   * GET /reports/vendor-1099-summary?year=&exact=1 -> {rows [{contactId, name, tinLast4, boxes {box: exact}, totalExact, meetsThreshold}],
   * totalsExact} from the 1099 account-to-box mapping. 400 INVALID_PARAM / INVALID_DATE_RANGE with details.param. Without exact=1 the
   * response shapes are unchanged (their number totals are now summed in Decimal); an exact value other than 1/0/true/false is 400.
   */
  'reports-exact-v1',
  /**
   * Saved report definitions (U-118, ClientLedger P28 PR-F; ADD-03 Q-310 / Q-312; migration 0274). GET/POST
   * /report-builder/definitions (?groupId=<id>|none, ?kind=), GET/PUT/DELETE /report-builder/definitions/:id, GET/POST
   * /report-builder/definition-groups, PUT/DELETE /report-builder/definition-groups/:id (a deleted group's reports move to no
   * group, each with a new version). Definition {schemaVersion: 1, kind: 'standard', reportKey /^[a-z0-9_]{1,64}$/, options};
   * ids only at options.filters.{accountIds,contactIds,tagIds,itemIds}, options.tagSplit.tagGroupId, options.columnTagGroupId, options.budgetId, and they
   * must be in the company. Row {id, groupId, name, kind, definition, version, createdBy, createdByName, canEdit, updatedAt};
   * group {id, name, sort, version, definitionCount, updatedAt}. Needs report access (reports read); only the author, an owner or
   * a super admin changes or deletes a saved report (403 NOT_AUTHOR). POST/PUT take Idempotency-Key; PUT body and DELETE
   * ?version= carry the version read (409 STALE_VERSION details.current). 409 NAME_TAKEN (unique per company, case-insensitive,
   * live rows), 400 DEFINITION_INVALID details.path, 413 DEFINITION_TOO_LARGE (64 KB). Soft delete; audited; carried by backups
   * and tenant archives with ids remapped.
   */
  'report-defs-v1',
  /**
   * Report columns and tag split (U-201, ClientLedger P28 PR-B). With exact=1 on /reports/profit-loss and /reports/balance-sheet:
   * period_ranges=YYYY-MM-DD..YYYY-MM-DD,… (at most 36, in date order, not overlapping; 4-4-5 or custom; Balance Sheet as of each end),
   * ytd=1[&fiscal_year_start=] (P&L), prior=period|year[&prior_ranges= one per period, e.g. the previous 4-4-5 periods; else the same
   * number of days just before] ($ change = current - prior, % change = change / |prior|), compare=by_contact
   * (P&L: the 36 most active clients by name, an engine-summed All others, No client, Total; client = the line's contact, else its
   * transaction's), compare=by_tag&tag_group_id= (P&L: each group tag with activity, No tag in group, Total), pct_of_income=1 (P&L),
   * tag_id=untagged (on the Balance Sheet refused since report-fixes-v2), tag_split=1&tag_group_id= (rows per account: rowKind account = lines without a tag from the group, tag per group
   * tag with activity, account_total = untagged + tags; section totals unchanged; also on /reports/trial-balance and
   * /reports/general-ledger accounts[].tagSplit). Column layout: {layout: 'columns', columns [{key, caption, kind, valueType, from, to,
   * asOf?, contactId?, tagId?, baseKey?, drill}], sections of rows {rowKind, accountId, parentAccountId, depth, tagId?, valuesExact[],
   * rollupValuesExact?, pctOfIncomeExact?, drill}, totalsExact {section: values[]}, drillTarget {path, amount, params}}. Percents are
   * 1 place, half away from zero, null on a zero base. All values exact and Decimal-summed. Errors 400 INVALID_PARAM / INVALID_DATE_RANGE
   * (details.param), 404 unknown tag group; a new option without exact=1 (or with format=) is 400.
   */
  'reports-columns-v1',
  /**
   * Drill targets (U-202, ClientLedger P28 PR-B). With exact=1, /reports/general-ledger and /reports/transaction-list filter per line by
   * contact_id (ids | none | others&exclude_contact_ids=), account_ids (at most 500; POST the same parameters as a JSON body for long
   * lists), tag_id (ids | untagged), tag_scope=untagged_in_group&tag_group_id=, amount_min / amount_max (|debit - credit|, decimal
   * strings), cleared=cleared|uncleared|reconciled, txn_types, adjusting; balances and lines alike, so a report cell's drill (its row
   * drill + its column drill + drillTarget.params) sums exactly to the cell (GL netChangeExact for P&L, endingBalanceExact for Balance
   * Sheet and Trial Balance). GL accounts gain netChangeExact, lines sourceLineId and contactId; transaction-list rows accountId and
   * contactId, and cash-basis rows carry the journal line id of a line passed through. group_by=transaction on the GL is the Journal.
   * Sales by Client / by Item take adjusting and return grandTotalExact.
   */
  'reports-drill-v1',
  /**
   * A/P aging true as of a date (U-121 A/P half, ClientLedger P28 PR-D; the twin of ar-aging-exact-v1). With exact=1,
   * /reports/ap-aging-summary|detail?as_of_date= and /reports/unpaid-bills?as_of_date= (default today) are built from the A/P ledger
   * (services/ap-open-items.ts): a bill is open by the bill payments, early-payment discounts and vendor credits applied by payments
   * dated on or before the date (an application is dated by its payment; a voided payment never counts), a vendor credit by the
   * refund deposits dated on or before it. Aging: the #33 shape plus open vendor credits and unapplied payments (negative rows,
   * details[].kind bill | credit | charge | other, txn_type) and a "(no vendor)" row (contact_id null), so totalsExact.total is the
   * A/P balance on the date; buckets current, 1-30, 31-60, 61-90, over 90 days past due (Q-105); every value exact and Decimal-summed.
   * Unpaid Bills: data[] adds discount_amountExact, contact_id, days_overdue; amounts and bill_status (unpaid | partial) as of the
   * date; overdue_only means due before the as-of date. Without exact=1 the legacy responses are unchanged (today's balances).
   */
  'ap-aging-exact-v1',
  /**
   * As-of open balances (U-121, ClientLedger P28 PR-D; Q-307). With exact=1 and as_of_date (default today):
   * /reports/customer-balance-summary|detail (from the A/R open items) and /reports/vendor-balance-summary|detail (A/P; detail is
   * new and exact only) return each contact's open documents less open credits on the date: data[] {id (null = no contact),
   * display_name, balanceExact}, Detail adds items[] {txnId, txnType, kind, number, date, dueDate, amountExact, openExact,
   * runningBalanceExact}; totalsExact.balance is the A/R or A/P balance on the date (it equals the aging total). The exact Vendor
   * Balance Summary was total_spent (reports-exact-v1); it is now the open balance. /reports/invoice-list?open=1&as_of_date= is Open
   * Invoices: the invoices still open on the date, amount_paidExact = settled by then, balance_dueExact = open then (status does
   * not go with open=1). as_of_date and open without exact=1 are 400 INVALID_PARAM; the legacy responses are unchanged.
   */
  'open-balances-asof-v1',
  /**
   * Exact budgets and Budget vs. Actual (U-203, ClientLedger P28 PR-C; Q-P28c, Q-P28n; migration 0275). /budgets is company-scoped
   * (the company's budgets plus those saved before budgets had a company; new budgets take the request's company). budgets.version:
   * PUT /budgets/:id, PUT /budgets/:id/lines, POST fill-from-actuals, copy-from/:sourceId and adjust-by-percent take body version
   * (409 STALE_VERSION details.current; absent = last write wins) and bump it; they and POST /budgets take Idempotency-Key. PUT lines is
   * validated: P&L accounts of the company, cells at most 2 decimal places by value, periods month1..month12, each account once (400
   * BUDGET_LINE_INVALID details.index/field). Fill from actuals and adjust % compute in Decimal and round each cell to the cent, half away
   * from zero. GET /budgets/:id/lines and the write responses add lines[].periodsExact[12], totalExact, version and totalsExact per
   * section and net income. GET /budgets/:id/vs-actual?exact=1&period_ranges=&first_period=&basis=&adjusting=[&tag_split=1&tag_group_id=]:
   * range i = budget period first_period + i taken whole (default the 12 calendar months of the budget year); actuals are the P&L lines
   * of the company and basis matched by account id; rows = every P&L account with a budget or activity (tree fields, rollupCells);
   * cells[] per column {actualExact, budgetExact, overExact = actual - budget, pctOfBudgetExact = actual / budget x 100 at 1 place, null
   * on a zero budget}; section totals, grossProfit, netIncome; tag split rows as reports-columns-v1 with the budget on account_total
   * only; drillTarget to the GL (netChangeExact). Without exact=1 the response is unchanged.
   */
  'budgets-exact-v1',
  /**
   * Closing Date Exceptions (U-204, ClientLedger P28 PR-E; Q-P28c, Q-P28q). GET /reports/closing-date-exceptions?start_date&end_date
   * &limit (reports and audit_log read; dates filter the day of the change) → {data[], total, truncated, closingDate, timeline[] {at,
   * closingDate}, meta}: every create/update/void/delete of a company transaction whose date before or after the change was on or before
   * the closing date in effect at that moment (timeline = closing_date and company lockDate audit rows plus the current setting), and
   * every closing_date_override row; nothing before the first closing date. Rows oldest first {auditId, at, userId, userName, action,
   * transactionId, txnType, txnNumber, txnDateBefore, txnDateAfter, closingDate, method (password|confirmed|null), amountBeforeExact,
   * amountAfterExact}. The ledger's create audit row now carries txnDate. Read-only; no migration.
   */
  'closing-exceptions-v1',
  /**
   * Report fixes (U-209, ClientLedger P28 QA). Cash basis: every pro-rated line of a partly settled document (bill or invoice
   * payments, credit memo applications, refunds of a memo or vendor credit) is whole cents (a document or settlement stored with
   * sub-cent places keeps them on one line so the settlement still balances); the lines of one settlement foot to it
   * (largest non-tax line takes the rounding), a fully settled document gives each line back, Sales Tax Payable moves as the cash sales
   * tax report rounds it, and P&L cells, totals and their drills all read the same cents. General Ledger, expense/revenue detail,
   * Transaction List (both bases) rows carry a check's check number as txnNumber / txn_number (else the document number). GET
   * /reports/vendor-1099-summary?exact=1 lists only vendors the 1099 Center files for (is1099Eligible and not excluded on their 1099
   * profile; is1099Eligible is always true); GET /reports/ap-1099-prep rows add reportable_total, reportable_meets_threshold (and
   * reportable_totalExact, totalReportableExact with exact=1) from the same buckets; total_paid is unchanged. Closing Date Exceptions:
   * a transaction with no total (journal entry) shows its debit total as amountBeforeExact / amountAfterExact. No migration.
   */
  'report-fixes-v1',
  /**
   * Audit trail filters (U-204, ClientLedger P28 PR-E). GET /audit-log (and /audit-log/export) take user_id and entity_id (uuids, else
   * 400 VALIDATION_ERROR) and company ("current" = the request's company, or a company id checked as X-Company-Id; 403 otherwise): rows
   * of that company (company_id, the transaction's or company's own id, or the images' companyId) plus rows of no company. List rows add
   * userName (display name, else email; null for system rows). Default responses are unchanged.
   */
  'audit-filters-v1',
  /**
   * Report email (U-207, ClientLedger P28 PR-E). POST /reports/email {to[], cc?[], bcc?[], subject, body, filename (.pdf|.xlsx|.csv),
   * fileBase64 | pdfBase64, reportKey?} (reports read; Idempotency-Key) → {sent: true, filename, recipientCount}: the client-made file
   * (at most 10 MB decoded, 400 ATTACHMENT_TOO_LARGE; contents must match the type, 400 VALIDATION_ERROR) through the company mail
   * server as U-127 invoice email: 400 SMTP_NOT_CONFIGURED, 400 SMTP_SEND_FAILED {reason}, 503 OFFLINE_UNAVAILABLE; a bad address
   * is 400 INVALID_RECIPIENT {field, index}. One audit row create/report_email {filename, contentType, bytes, recipients, reportKey,
   * companyId}. The body may be up to 15 MB (as the invoice email route).
   */
  'reports-email-v1',
  /**
   * Ask a question (U-206, ClientLedger P28 PR-G; Q-73, Q-P28g). POST /reports/ask {question, reports: [{key, title, description?,
   * params: (range | as_of | basis | accounts | contacts | tags)[], columns?, extras?}], datePresets[], today?}. The company's AI
   * provider (the chat function, Ollama included) maps the question to ONE sent report with its options; the client runs the report.
   * The model sees the question, the catalog, today and names (active accounts, active tags, contacts the question names), never an
   * amount. Response {reportKey, dates: {preset} | {from, to} | {asOf} | null, basis, columns, extras[], filters: {accountIds,
   * contactIds, tagIds} (resolved by the engine from names), unresolved: [{kind, text}] (question text only, no digits), reader, provider,
   * model}. No amount filter. 403 AI_CONSENT_REQUIRED {reason} (needs the report_summary task; no provider call), 422 ASK_UNMAPPED
   * {field, reason}, 503 AI_UNAVAILABLE {provider, reason}.
   */
  'reports-ask-v1',
  /**
   * 1099 amounts are cash paid in the year (U-212, ClientLedger P28; Q-P28aj). The 1099 Summary by box (GET
   * /reports/vendor-1099-summary?exact=1), 1099 Preparation's reportable_total / reportable_totalExact / reportable_meets_threshold
   * and the 1099 Center's per-box totals and filing count the same payments as 1099 Preparation's total_paid: bill payments, expenses
   * (Write Checks included) and checks, each at its own date. A bill no longer counts at its bill date: each bill payment counts at the
   * payment's date as the bill's mapped lines scaled by the cash it put on the bill / the bill's total (whole cents; a bill paid in
   * full in cash gives each box back exactly; a vendor credit applied or an early-payment discount taken is not cash and is left out).
   * An unpaid bill is not on a 1099; a bill paid in a later year counts in that year. total_paid also counts 'check' transactions.
   * Thresholds depend on the year paid (One Big Beautiful Bill Act): NEC-1, MISC-1, MISC-3 and MISC-6 report from $600.00 through
   * 2025 and $2,000.00 from 2026 (a table keyed by year for later indexed amounts); MISC-2 royalties $10, MISC-10 attorney proceeds
   * $600. Applied to the Summary's meetsThreshold and boxCatalog thresholdExact, ap-1099-prep over_threshold and
   * reportable_meets_threshold, and the 1099 Center's tiles, statuses, threshold scan and filing. Response shapes are unchanged.
   * No migration.
   */
  'report-1099-paid-v1',
  /**
   * Report fixes 2 (U-213, ClientLedger PR-6 review; also U-210, U-211). Trial Balance: the computed Retained Earnings (Prior Years) row
   * is on the report's basis (it was accrual on a cash TB, which then didn't balance after an invoice or bill open at a year end), tag
   * split too; exact responses add fiscalYearStart. Exact Balance Sheet (standard layout): computed equity rows calculated: true; the
   * Retained Earnings account, when prior years' income is folded in, includesPriorYearsIncome: true and priorYearsIncomeExact; top-level
   * fiscalYearStart and calculatedEquityExact (the part of totalEquityExact no ledger line holds); column-layout as-of/prior columns add
   * fiscalYearStart. fiscal_year_start=YYYY-MM-DD[,…] (ascending, ≤ 50; each date uses the latest start on or before it, ≤ 371 days;
   * else 400 INVALID_PARAM) on exact /balance-sheet, /trial-balance (and its tag split) and /general-ledger: the income split / reset
   * date for retail 52-53 week years; the TB drillTarget carries it. Exact /balance-sheet and /trial-balance refuse tag_id with 400
   * TAG_FILTER_NOT_AVAILABLE (use tag_split); the cash TB's tag filter (legacy route) is per transaction, as the accrual one. Cash
   * exact Balance Sheet / Trial Balance meta.cashArApResidue {accountsReceivableExact, accountsPayableExact, accountIds, txnTypes} | null:
   * what A/R and A/P keep from entries other than payments. GET /reports/ap-1099-prep?exact=1: tax_id and tinLast4 are the tax id's
   * last four digits (legacy response unchanged). A recurring check copied by the legacy template path is a check (isCheck,
   * printStatus, a new number unless queued). Budget copy (POST /budgets/:id/copy-from/:sourceId) replaces all of the target's lines.
   * No migration.
   */
  'report-fixes-v2',
  /**
   * Report Builder definitions (U-118 / U-119, ClientLedger A07 PR-A; migration 0276). Saved reports (report-defs-v1) take kind
   * 'builder': a Report Builder schema v1 definition (@kis-books/shared report-builder: schemas.ts, fields.ts, starters.ts; the
   * shared fixtures under packages/shared/src/report-builder/fixtures). Strict (unknown keys refused; any new field is schema v2),
   * at most 256 KB as JSON (413 DEFINITION_TOO_LARGE {limit}), 200 nodes at any depth, groups nested at most 8 deep, 500 ids or
   * values per filter list; entity ids only at nodes.**.filters.N.ids (typed by the filter's field) and nodes.**.groupBy.N.tagGroupId,
   * a uuid anywhere else refused. 400 DEFINITION_INVALID {path, code}: SCHEMA, TOO_MANY_NODES, TOO_DEEP, DUPLICATE_ID, UUID_IN_TEXT,
   * NOT_IN_SOURCE, FILTER_OP, FORMULA_FORWARD_REF, FORMULA_UNITS, PERCENT_BASE, EARNINGS_FILTER, BUCKETS_PERIODS, RUNNING_BALANCE,
   * MIXED_POLARITY, NOT_IN_COMPANY (an id not of this company). Text is stored as sent (captions may not start or end with a
   * space); lengths count UTF-16 units. Transaction type values name a check (an expense with is_check) `check`. ?kind=builder filters the list. Standard definitions are unchanged (64 KB,
   * 1000 ids, {path}). Tenant archives remap builder ids as standard ones; an engine older than 0276 can't import builder rows.
   */
  'report-defs-builder-v1',
  /**
   * Report foundations (U-119, ClientLedger A07 PR-B; migration 0277). Output changes for MyBooks Online: Sales by Client and
   * Sales by Item use one sales rule (Q-A07b): income lines of sale documents at their natural net (a discount line reduces sales,
   * a credit memo counts negative), the line's client, else the document's, daily sales included, accrual leaves cash-only entries
   * out; cash basis keeps the rule-3 types and leaves Unapplied receipts out (a bounce's own income credits now count, so a bounced
   * payment still nets to 0). A/R Aging Summary (Q-A07c): bucketsExact are the exact sums of each item's open (were the cent
   * sums), customers[] add bucketsExact / totalExact; cent fields unchanged. The ledger stamp (GET /ledger-version) also moves when
   * a payment, credit memo, bill payment or vendor credit application is added, changed or removed (migration 0277). No change
   * to other responses: the Balance Sheet, its columns and the Trial Balance share one equity-earnings computation; cash-basis
   * lines carry a vkey (internal).
   */
  'report-foundations-v1',
  /**
   * Report Builder runs (U-119, ClientLedger A07 PR-C). POST /report-builder/run {definition | definitionId + version, dates
   * ({from,to} | {asOf}), periodRanges? (≤ 36), compareRanges? (one array per compare entry, parallel to periodRanges),
   * fiscalYearStarts[], basis?, adjusting?, open[] (≤ 1,000 paths), collapsed[] (≤ 1,000, exceptions under defaultExpanded
   * sections), expandAll?, purpose: screen | export} -> {columns, rows, meta {basis, dates, notes, truncated, hiddenNotice,
   * denied}, fingerprint, stamp}: one READ ONLY REPEATABLE READ snapshot, 30 s (503 REPORT_TIMEOUT), group-by lines ≤ 100,000
   * (422 REPORT_TOO_LARGE), detail rows 5,000 per run (100,000 for export) with more rows and cursors; denied sections per role
   * (rights from the transaction types a section admits); a client that goes away cancels the query. POST /run/detail {…, nodeId,
   * path, range?, cursor?, fingerprint, stamp} -> {rows ≤ 500, cursor, subtotal}; 409 RUN_CHANGED {reason: params | books}.
   * GET /report-builder/fields: the field catalogue. Exact strings, percents 1 place.
   */
  'report-builder-v1',
  /**
   * Report Builder starters (U-119, ClientLedger A07 PR-D). GET /report-builder/starters -> {starters: [{key, title, tiesTo,
   * definition}]}: 20 builder definitions (P&L, by month, with % of income, Balance Sheet, Trial Balance, Transaction Detail by
   * Account, Revenue / Expenses by Category, A/R and A/P Aging Summary and Detail, Open Invoices, Unpaid Bills, Customer / Vendor
   * Balance Summary, Sales by Client, Sales by Item, Check Register, Bank Account Balances). The tie-out suite proves each
   * summary starter equals its standard report to the cent on both bases. No migration (the 1M-line run stays within 30 s
   * without new indexes).
   */
  'report-builder-starters-v1',
  /**
   * Report Builder drills (U-119e, ClientLedger A07 PR-E). POST /report-builder/run/detail takes every drill path of a run:
   * a group-by line at any level, a section's Total ["n:<id>"] (every line of the section plus its earnings lines) and an
   * earnings row ["n:<id>", "earnings:prior|current"]; range? ({from|null, to}) picks one column (rows and subtotal of
   * that column only; a range of no column is 400 INVALID_PARAM). Earnings drills of a tag-filtered section carry tagIds;
   * open-item detail rows in /run carry their line's path; the Trial Balance's prior-years row has path earnings:prior;
   * aging columns refuse periodRanges/compareRanges (400 INVALID_PARAM). No migration.
   */
  'report-builder-drill-v1',
  /**
   * Report Builder starters, second edition (U-119f, ClientLedger A07 PR-F). Same 20 keys; definitions changed: every
   * starter has detail fields (its drill shows date, type, number, name, memo and, for line drills, description and account;
   * open-item starters their document fields), so a summary run sends field columns whose cells are all null. Transaction
   * Detail by Account is one natural-sign section per account type (node ids assets ... other_expenses, was one debit-sign
   * "ledger" section) and drops the `amount` field; Open Invoices / Unpaid Bills filter txn_type invoice / bill (they tie
   * row by row to /reports/invoice-list?open=1 and /reports/unpaid-bills). /run: a range section with a running balance
   * (innermost group-by account) also lists accounts with an opening balance and no activity (a zero line, its detail
   * the opening row), as the standard General Ledger does. No migration.
   */
  'report-builder-starters-v2',
  /**
   * Net summary totals in the "<Group> by Account" reports (U-216, ClientLedger A08 Q-A08h). GET
   * /reports/revenue-by-category, /assets-by-account, /liabilities-by-account and /equity-by-account (and ?exact=1
   * revenue-by-category): summary data[].total / totalExact is the account's natural net for the period (normal side minus
   * the other side; equals the detail subtotal), was the normal side only. A credit memo's or refund's debit to an income
   * account now reduces Revenue by Category, which ties to the P&L income sections per account on both bases; accounts that
   * net to zero are left out (as in Expenses by Category); a net can be negative. Detail mode unchanged. No migration.
   */
  'reports-revenue-net-v1',
];

