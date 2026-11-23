// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

/**
 * Route classes (U-288, capability `route-classes-v1`).
 *
 * Two classifications, kept in this one table so the OpenAPI export and the
 * request-time code read the same rules:
 *
 * - `x-lan` (every operation): who may call the route when the desktop engine
 *   serves a LAN (CL_LAN=1).
 *     - `workstation`: a request carrying the workstation token may call it.
 *     - `host`: only the host app (the launch token) may call it.
 *   Default deny: an operation that matches no workstation rule is `host`, and
 *   a host rule always wins over a workstation rule. So a new route is
 *   host-only until someone lists it here on purpose.
 *
 * - `x-stale` (every mutating operation): how a client proves it saw the
 *   current record before changing it.
 *     - `stale(updatedAt)`: the body (or query, for DELETE) carries
 *       `expectedUpdatedAt`; a mismatch is 409 STALE.
 *     - `stale(version)`: carries `version`; a mismatch is 409 STALE_VERSION.
 *     - `stale(schedule)`: recurring schedules; `expectedUpdatedAt`, a mismatch
 *       is 409 STALE_SCHEDULE.
 *     - `create`: makes a new record; nothing to be stale against.
 *     - `state-guarded`: the service locks and checks the record's state (open
 *       balance, deposited, voided, number in use) and refuses with its own 409.
 *     - `bulk`: changes many records; in LAN mode each item carries its stamp.
 *     - `n-a`: no stored record to be stale against (sign-in, previews, AI,
 *       reports), or a host-only route (one writer, so no lost update).
 *   The classes are the target contract: they bind once the engine also
 *   reports `stale-all-v1` (U-291) and `stale-required-v1` (U-292). Before
 *   that, the stamp stays optional, as it always was.
 *
 * Patterns: `METHOD /path`, where METHOD is an HTTP method, `*` (any) or
 * `WRITE` (anything but GET/HEAD/OPTIONS). In the path, `*` matches one
 * segment, `bulk-*` one segment starting with `bulk-`, and a trailing `/**`
 * the rest of the path, including nothing. A segment written `{x}` in an OpenAPI path counts as a concrete
 * value, so the same rules classify `/api/v1/accounts/{id}` and
 * `/api/v1/accounts/0b6c...`.
 *
 * Nothing here runs on the server appliance: the OpenAPI export reads the
 * table, and LAN mode (U-289, U-292) reads it at request time.
 */

export type LanClass = 'workstation' | 'host';

export type StaleClass =
  | 'stale(updatedAt)'
  | 'stale(version)'
  | 'stale(schedule)'
  | 'create'
  | 'state-guarded'
  | 'bulk'
  | 'n-a';

export const STALE_CLASSES: readonly StaleClass[] = [
  'stale(updatedAt)', 'stale(version)', 'stale(schedule)', 'create', 'state-guarded', 'bulk', 'n-a',
];

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export function isMutating(method: string): boolean {
  return !READ_METHODS.has(method.toUpperCase());
}

// ── x-lan ────────────────────────────────────────────────────────────

/**
 * Host-only, whatever a workstation rule says (Q-P33y, B1, B2). Each line is
 * a route a workstation must never reach in LAN mode.
 */
export const LAN_HOST_RULES: readonly string[] = [
  // Desktop first run, password recovery with the recovery key, session
  // secrets (AI keys, SMTP password). Every /desktop read other than the two
  // workstation rules below is host-only by default.
  'WRITE /api/v1/desktop/**',
  // Archives: export (returns a host path), import and restore (B2: backup
  // first, on the host), download of a host file, job state (carries the path).
  '* /api/v1/tenant-archives/**',
  // New company; company delete (archives first), backup export, transfer totals.
  'POST /api/v1/tenants',
  '* /api/v1/tenants/*/*/**',
  // QuickBooks Desktop and spreadsheet import, commit and undo (Q-P33y).
  'WRITE /api/v1/imports/**',
  // Payroll import: upload, mapping, post, reverse (Q-P33y).
  'WRITE /api/v1/payroll-import/**',
  // New companies and new tenants; company delete.
  'POST /api/v1/auth/create-tenant',
  'POST /api/v1/auth/create-client',
  'POST /api/v1/company/create',
  'DELETE /api/v1/company/*',
  // Recovery key rotation, open registration, emailed password resets.
  '* /api/v1/auth/recovery-key/**',
  'POST /api/v1/auth/register',
  'POST /api/v1/auth/forgot-password',
  'POST /api/v1/auth/reset-password',
  // Verify Data fixes (U-12): on the host, under a maintenance hold.
  'POST /api/v1/integrity/fixes',
  // Settings only the host sets (Q-P33l): AI configuration, SMTP, Stripe.
  'WRITE /api/v1/ai/admin/**',
  'WRITE /api/v1/chat/admin/**',
  'WRITE /api/v1/company/smtp/**',
  '* /api/v1/company/stripe/**',
  // API keys reach the engine without a session.
  '* /api/v1/api-keys/**',
  // Public API v2 writes (API-key callers; they send no record stamps).
  'WRITE /api/v2/**',
  // Report packs: a firm tool the desktop app does not offer.
  '* /api/v1/reports/packs/**',
  '* /api/v1/reports/pack-templates/**',
];

/** Routes a workstation may call (still subject to the user's permissions). */
export const LAN_WORKSTATION_RULES: readonly string[] = [
  // Probes.
  'GET /health', 'GET /ping', 'GET /api/health', 'GET /api/ping', 'GET /api/v1/health', 'GET /api/v1/ping',
  // Desktop: engine info and capabilities (S12), secret presence (never values).
  'GET /api/v1/desktop/info',
  'GET /api/v1/desktop/session-secrets',
  // Sign-in and the signed-in user.
  'POST /api/v1/auth/login',
  'POST /api/v1/auth/refresh',
  'POST /api/v1/auth/logout',
  'GET /api/v1/auth/me',
  'PUT /api/v1/auth/me/preferences',
  'GET /api/v1/auth/methods',
  'POST /api/v1/auth/change-password',
  'POST /api/v1/auth/switch-tenant',
  '* /api/v1/auth/tfa/**',
  '* /api/v1/auth/passkeys/**',
  'GET /api/v1/auth/accessible-tenants/**',
  'GET /api/v1/auth/create-tenant/eligibility',
  '* /api/v1/users/me/**',
  // Companies the user can open; rename.
  'GET /api/v1/tenants',
  'PATCH /api/v1/tenants/*',
  // Company settings and users.
  '* /api/v1/company/**',
  'GET /api/v1/coa-templates/options',
  'GET /api/v1/fs-fonts/*',
  'GET /api/v1/feature-flags/**',
  'GET /api/v1/knowledge/**',
  // The books.
  ...[
    'accounts', 'contacts', 'transactions', 'journal-entries', 'invoices', 'bills', 'bill-captures',
    'document-drafts', 'vendor-layout-templates', 'document-reading', 'vendor-credits', 'bill-payments',
    'payment-terms', 'estimates', 'tags', 'reports', 'report-builder', 'banking', 'dashboard', 'ledger-version',
    'attachments', 'recurring', 'templates', 'batch', 'daily-sales', 'je-templates', 'items', 'inventory',
    'unit-sets', 'price-levels', 'billable-costs', 'payments', 'customer-refunds', 'credit-memos',
    'customer-statement-runs', 'customer-statements', 'finance-charges', 'sales-tax', 'sales-receipts', 'checks',
    'duplicates', 'budgets', 'document-numbers', 'forms', 'downloads', 'export', 'sensitive-doors',
  ].map((f) => `* /api/v1/${f}/**`),
  'GET /api/v1/audit-log/**',
  // The desktop change feed (U-294).
  'GET /api/v1/changes',
  // Verify Data (U-12): checks, runs and the summary; fixes are host-only above.
  '* /api/v1/integrity/**',
  // Import and payroll history can be read; the writes are host-only above.
  'GET /api/v1/imports/**',
  'GET /api/v1/payroll-import/**',
  // Practice tools the desktop app uses.
  '* /api/v1/practice/1099/**',
  '* /api/v1/practice/conditional-rules/**',
  // AI with the host's keys (Q-P33l); the admin writes are host-only above.
  '* /api/v1/ai/**',
  '* /api/v1/chat/**',
  // Public API v2 reads.
  'GET /api/v2/**',
];

// ── x-stale ──────────────────────────────────────────────────────────

const U: StaleClass = 'stale(updatedAt)';
const V: StaleClass = 'stale(version)';
const S: StaleClass = 'stale(schedule)';
const C: StaleClass = 'create';
const G: StaleClass = 'state-guarded';
const B: StaleClass = 'bulk';
const N: StaleClass = 'n-a';

/**
 * Ordered, first match wins; only mutating methods are looked up. Every
 * workstation write must match one rule (route-classes.test.ts), so a new
 * write route has to be classified before it ships. A host-only write that
 * matches no rule is `n-a` (one writer).
 */
export const STALE_RULES: ReadonlyArray<readonly [string, StaleClass]> = [
  // Accounts.
  ['POST /api/v1/accounts', C], ['PUT /api/v1/accounts/bulk', B], ['POST /api/v1/accounts/import', C],
  ['POST /api/v1/accounts/merge', B], ['PUT /api/v1/accounts/*', U], ['DELETE /api/v1/accounts/*', U],
  ['PUT /api/v1/accounts/*/sensitive', U],
  // AI: suggestions, consent and the caller's own statement-reading jobs.
  ['POST /api/v1/ai/categorize/accept', G], ['POST /api/v1/ai/parse/statement/import', C], ['WRITE /api/v1/ai/**', N],
  // Attachments are immutable files; linking bumps the parent record (U-291).
  ['POST /api/v1/attachments', C], ['WRITE /api/v1/attachments/**', N],
  // Sign-in and the signed-in user's own settings.
  ['WRITE /api/v1/auth/**', N], ['WRITE /api/v1/users/me/**', N],
  // Banking.
  ['POST /api/v1/banking/connections', C], ['WRITE /api/v1/banking/connections/**', N],
  // Feed actions act on pending feed items: each item is locked and its status checked.
  ['POST /api/v1/banking/feed/accept', G], ['POST /api/v1/banking/feed/bulk-*', G],
  ['POST /api/v1/banking/feed/import', C], ['POST /api/v1/banking/feed/import-batch', C],
  ['DELETE /api/v1/banking/feed/import-batches/*', G], ['POST /api/v1/banking/feed/undo', G],
  ['POST /api/v1/banking/feed/backfill-check-payees', N], ['POST /api/v1/banking/check-payees/backfill', N],
  ['WRITE /api/v1/banking/feed/*', G], ['WRITE /api/v1/banking/feed/*/*', G],
  ['POST /api/v1/banking/reconciliations', C], ['WRITE /api/v1/banking/reconciliations/**', G],
  ['WRITE /api/v1/banking/statement-lines/**', G],
  ['POST /api/v1/banking/statements/import-ofx', C], ['WRITE /api/v1/banking/statements/**', N],
  // Batch entry.
  ['POST /api/v1/batch/save', C], ['WRITE /api/v1/batch/**', N],
  // Bills and bill capture.
  ['POST /api/v1/bill-captures', C], ['WRITE /api/v1/bill-captures/*/*', G],
  ['POST /api/v1/bill-payments', C], ['POST /api/v1/bill-payments/*/void', U],
  ['POST /api/v1/bills', C], ['POST /api/v1/bills/extract-from-attachment/*', N], ['PUT /api/v1/bills/*', U],
  ['POST /api/v1/bills/*/attach-draft', G], ['POST /api/v1/bills/*/void', U],
  // Budgets carry a version (budgets-exact-v1).
  ['POST /api/v1/budgets', C], ['WRITE /api/v1/budgets/**', V],
  // Assistant chat: the caller's own conversations.
  ['WRITE /api/v1/chat/**', N],
  // Checks.
  ['POST /api/v1/checks', C], ['POST /api/v1/checks/print', G], ['POST /api/v1/checks/reprint/*', G],
  ['POST /api/v1/checks/requeue', G], ['PUT /api/v1/checks/settings', U],
  ['POST /api/v1/checks/envelopes', N], ['POST /api/v1/checks/render', N], ['POST /api/v1/checks/test-print', N],
  ['PUT /api/v1/checks/*', U], ['PATCH /api/v1/checks/*/memo', U],
  // Company settings and users.
  // 1099 thresholds: the body states the whole set for the year.
  ['PUT /api/v1/company', U], ['PUT /api/v1/company/settings', U], ['PUT /api/v1/company/1099-thresholds', N],
  ['PUT /api/v1/company/closing-password', U], ['POST /api/v1/company/closing-password/reset', N],
  // The default invoice layout: edited as a layout through PUT /company/invoice-layouts/:id (stamped).
  ['PUT /api/v1/company/intake-settings', U], ['PUT /api/v1/company/invoice-template', N],
  ['POST /api/v1/company/invite-user', C], ['POST /api/v1/company/logo', N], ['POST /api/v1/company/setup-complete', N],
  ['POST /api/v1/company/invoice-layouts', C], ['POST /api/v1/company/invoice-layouts/*/default', N],
  ['WRITE /api/v1/company/invoice-layouts/*', U],
  ['POST /api/v1/company/permission-templates', C], ['WRITE /api/v1/company/permission-templates/*', U],
  // Team settings: an owner or admin edits them; the body states the whole value.
  ['PATCH /api/v1/company/users/*', N], ['PUT /api/v1/company/users/*/permissions', N],
  ['POST /api/v1/company/users/*/*', G],
  // Contacts.
  ['POST /api/v1/contacts', C], ['POST /api/v1/contacts/bulk-type', B], ['POST /api/v1/contacts/import', C],
  ['POST /api/v1/contacts/merge', B], ['PUT /api/v1/contacts/*', U], ['DELETE /api/v1/contacts/*', U],
  // Credit memos, refunds, statements.
  ['POST /api/v1/credit-memos', C], ['POST /api/v1/credit-memos/preview', N], ['PUT /api/v1/credit-memos/*', U],
  ['POST /api/v1/credit-memos/*/apply', G], ['POST /api/v1/credit-memos/*/unapply', G],
  ['POST /api/v1/credit-memos/*/email', N], ['POST /api/v1/credit-memos/*/email-later', N],
  ['POST /api/v1/customer-refunds', C], ['POST /api/v1/customer-statement-runs', C],
  ['POST /api/v1/customer-statements/*/*', N],
  // Daily sales.
  ['POST /api/v1/daily-sales/entries', C], ['POST /api/v1/daily-sales/entries/preview', N],
  ['PUT /api/v1/daily-sales/entries/*', U], ['DELETE /api/v1/daily-sales/entries/*', U],
  ['POST /api/v1/daily-sales/entries/*/post', G], ['POST /api/v1/daily-sales/entries/*/void', G],
  ['POST /api/v1/daily-sales/templates', C], ['POST /api/v1/daily-sales/templates/*/duplicate', C],
  ['WRITE /api/v1/daily-sales/templates/*', U], ['PUT /api/v1/daily-sales/templates/*/lines', U],
  ['POST /api/v1/dashboard/**', N],
  // Document drafts and numbers.
  ['POST /api/v1/document-drafts', C], ['PUT /api/v1/document-drafts/*', U], ['POST /api/v1/document-drafts/*/*', G],
  ['POST /api/v1/document-numbers/claim', G], ['PUT /api/v1/document-numbers/*', N],
  ['POST /api/v1/document-reading/**', N], ['POST /api/v1/downloads/**', N],
  ['POST /api/v1/duplicates/merge', B], ['POST /api/v1/duplicates/**', N],
  ['POST /api/v1/estimates', C], ['POST /api/v1/estimates/*/convert', G],
  ['POST /api/v1/export/opening-balances', C],
  ['POST /api/v1/finance-charges/assess', C], ['POST /api/v1/finance-charges/preview', N],
  ['DELETE /api/v1/forms/email-queue/*', G], ['POST /api/v1/forms/mark-printed', N],
  // Inventory.
  ['POST /api/v1/inventory/adjustments', C], ['WRITE /api/v1/inventory/adjustments/*', U],
  ['POST /api/v1/inventory/adjustments/*/void', U], ['POST /api/v1/inventory/counts', C],
  // Invoices.
  ['POST /api/v1/invoices', C], ['POST /api/v1/invoices/preview', N], ['PUT /api/v1/invoices/*', U],
  ['POST /api/v1/invoices/*/duplicate', C], ['POST /api/v1/invoices/*/void', U],
  ['POST /api/v1/invoices/*/mark-sent', G], ['POST /api/v1/invoices/*/sent', G], ['POST /api/v1/invoices/*/payment', G],
  ['WRITE /api/v1/invoices/*/share-link', G],
  ['POST /api/v1/invoices/*/email', N], ['POST /api/v1/invoices/*/email-later', N], ['POST /api/v1/invoices/*/remind', N],
  ['POST /api/v1/invoices/*/send', N],
  // Items, units, price levels, JE templates, transaction templates.
  ['POST /api/v1/items', C], ['POST /api/v1/items/import', C], ['WRITE /api/v1/items/*', U],
  ['POST /api/v1/unit-sets', C], ['WRITE /api/v1/unit-sets/*', U],
  ['POST /api/v1/price-levels', C], ['WRITE /api/v1/price-levels/*', U],
  ['POST /api/v1/je-templates', C], ['POST /api/v1/je-templates/*/duplicate', C],
  ['WRITE /api/v1/je-templates/*', U], ['PUT /api/v1/je-templates/*/lines', U],
  ['POST /api/v1/templates', C], ['POST /api/v1/templates/from-transaction', C], ['POST /api/v1/templates/groups', C],
  // Transaction templates carry a version (templates-v1: 409 STALE details.version); a group is a name.
  ['WRITE /api/v1/templates/groups/*', N], ['WRITE /api/v1/templates/*', V], ['POST /api/v1/templates/*/enter', C],
  ['POST /api/v1/templates/*/occurrences/*/*', G],
  // Payments.
  ['POST /api/v1/payments/preview', N], ['POST /api/v1/payments/receive', C], ['POST /api/v1/payments/unapply', G],
  ['POST /api/v1/payments/write-off-recoveries', C], ['PUT /api/v1/payments/*', U],
  ['POST /api/v1/payments/*/apply', G], ['POST /api/v1/payments/*/bounce', G], ['POST /api/v1/payments/*/void', U],
  // 1099 preparation.
  ['WRITE /api/v1/practice/1099/account-mappings/*', N], ['POST /api/v1/practice/1099/corrections', C],
  ['POST /api/v1/practice/1099/tin-match/import', C], ['POST /api/v1/practice/1099/w9-requests', C],
  ['WRITE /api/v1/practice/1099/vendors/**', N], ['POST /api/v1/practice/1099/**', N],
  // Conditional (bank) rules.
  ['POST /api/v1/practice/conditional-rules', C], ['POST /api/v1/practice/conditional-rules/import', C],
  ['POST /api/v1/practice/conditional-rules/reorder', N], ['POST /api/v1/practice/conditional-rules/evaluate', N],
  ['WRITE /api/v1/practice/conditional-rules/*', U],
  ['POST /api/v1/practice/conditional-rules/*/fork-to-tenant', C],
  ['POST /api/v1/practice/conditional-rules/*/demote', G], ['POST /api/v1/practice/conditional-rules/*/promote', G],
  ['POST /api/v1/practice/conditional-rules/**', N],
  // Recurring schedules (recurring-guard-v1: STALE_SCHEDULE).
  ['POST /api/v1/recurring', C], ['POST /api/v1/recurring/run-due', N], ['POST /api/v1/recurring/*/post-now', G],
  ['WRITE /api/v1/recurring/*', S], ['POST /api/v1/recurring/*/archive', G], ['POST /api/v1/recurring/*/unarchive', G],
  // Saved reports carry a version (report-definitions).
  ['POST /api/v1/report-builder/definition-groups', C], ['WRITE /api/v1/report-builder/definition-groups/*', V],
  ['POST /api/v1/report-builder/definitions', C], ['POST /api/v1/report-builder/definitions/export', N],
  ['WRITE /api/v1/report-builder/definitions/*', V],
  ['POST /api/v1/report-builder/**', N], ['POST /api/v1/reports/**', N],
  // Sales receipts and sales tax.
  ['POST /api/v1/sales-receipts', C], ['POST /api/v1/sales-receipts/preview', N], ['PUT /api/v1/sales-receipts/*', U],
  ['POST /api/v1/sales-receipts/*/*', N],
  ['POST /api/v1/sales-tax/payments', C], ['POST /api/v1/sales-tax/payments/preview', N],
  ['POST /api/v1/sales-tax/payments/mark-paid-through', C], ['POST /api/v1/sales-tax/payments/**', G],
  ['POST /api/v1/sales-tax/*', C], ['PUT /api/v1/sales-tax/*/*', U], ['POST /api/v1/sales-tax/*/*/*', G],
  // Tags.
  ['POST /api/v1/tags', C], ['POST /api/v1/tags/bulk-tag', B], ['POST /api/v1/tags/bulk-untag', B],
  ['POST /api/v1/tags/merge', B], ['POST /api/v1/tags/groups', C], ['PUT /api/v1/tags/groups/reorder', N],
  ['WRITE /api/v1/tags/groups/*', U], ['POST /api/v1/tags/saved-filters', C],
  ['DELETE /api/v1/tags/saved-filters/*', N], ['PUT /api/v1/tags/transactions/*', U],
  ['POST /api/v1/tags/transactions/*/*', N], ['WRITE /api/v1/tags/*', U],
  // Verify Data (U-12): a check stores a run but changes no record.
  ['POST /api/v1/integrity/checks', N],
  // Companies (tenants): rename.
  ['PATCH /api/v1/tenants/*', U],
  // Transactions (journal entries, expenses, transfers, deposits, cash sales).
  ['POST /api/v1/transactions', C], ['POST /api/v1/transactions/bulk-update', B],
  ['WRITE /api/v1/transactions/*', U], ['POST /api/v1/transactions/*/duplicate', C],
  ['POST /api/v1/transactions/*/void', U],
  // Vendor credits and learned vendor layouts.
  ['POST /api/v1/vendor-credits', C], ['PUT /api/v1/vendor-credits/*', U], ['POST /api/v1/vendor-credits/*/void', U],
  ['WRITE /api/v1/vendor-layout-templates/**', U],
];

/**
 * Workstation PUT/PATCH/DELETE routes on a record path that are `n-a` or
 * `create` anyway, with the reason (route-classes.test.ts fails on any other).
 */
export const STALE_EXEMPT_RECORD_WRITES: Readonly<Record<string, string>> = {
  'DELETE /api/v1/ai/parse/statement/jobs/{jobId}': "the caller's own statement-reading job",
  'PATCH /api/v1/ai/parse/statement/jobs/{jobId}/transactions': "the caller's own statement-reading job",
  'PATCH /api/v1/ai/consent/{companyId}/tasks': 'AI consent switches; each call states the whole value',
  'DELETE /api/v1/attachments/{id}': 'attachments are immutable files; nothing to overwrite',
  'DELETE /api/v1/auth/passkeys/me/{id}': "the caller's own passkey",
  'PUT /api/v1/auth/passkeys/me/{id}': "the caller's own passkey",
  'DELETE /api/v1/banking/connections/{id}': 'a bank link; removing it twice is harmless',
  'DELETE /api/v1/chat/conversations/{id}': "the caller's own conversation",
  'DELETE /api/v1/practice/1099/account-mappings/{accountId}': 'one mapping per account; the call states the whole value',
  'PUT /api/v1/practice/1099/account-mappings/{formBox}': 'one mapping per box; the body states the whole value',
  'DELETE /api/v1/practice/1099/vendors/{contactId}/exclude': 'an exclusion switch; the call states the whole value',
  'PUT /api/v1/practice/1099/vendors/{contactId}/profile': 'the 1099 profile; the body states the whole value',
  'DELETE /api/v1/tags/saved-filters/{id}': "the caller's own saved filter",
  'DELETE /api/v1/users/me/tfa/devices/{id}': "the caller's own trusted device",
  'PUT /api/v1/templates/groups/{id}': 'a template group is a name; the body states the whole value',
  'DELETE /api/v1/templates/groups/{id}': 'a template group is a name; its templates stay',
  'PUT /api/v1/document-numbers/{type}': 'the next number of a kind; the body states the whole value (claims are state-guarded)',
  'PATCH /api/v1/company/users/{userId}': 'team settings an owner or admin edits; the body states the whole value',
  'PUT /api/v1/company/users/{userId}/permissions': 'team permissions an owner or admin edits; the body states the whole value',
};

/**
 * Stale-checked writes that can also create (U-292b). The body must carry
 * `expectedUpdatedAt` (the key is required by the schema); `null` is a stamp
 * that says "I read it and nothing was stored", the service creates only then
 * and answers 409 STALE when a record exists. So in LAN mode an explicit
 * `null` body stamp counts as carried here (an absent key is still 428). On
 * every other route `null` is no stamp. Each line has its reason; the test
 * checks the list against the spec both ways.
 */
export const NULL_STAMP_CREATES: Readonly<Record<string, string>> = {
  'PUT /api/v1/vendor-layout-templates': 'create or replace by (vendor, fingerprint); null creates only',
  'PUT /api/v1/company/intake-settings': 'the intake folders; null before the first save',
};

/**
 * Stale-checked writes on a path with no record id: settings rows that always
 * exist (one per company), so no call ever creates one. Any other stale write
 * without a path parameter must be on NULL_STAMP_CREATES (route-classes.test.ts).
 */
export const STALE_SINGLETON_WRITES: Readonly<Record<string, string>> = {
  'PUT /api/v1/company': 'the company row; exists from company creation',
  'PUT /api/v1/company/settings': 'settings on the company row',
  'PUT /api/v1/company/closing-password': 'the closing password on the company row',
  'PUT /api/v1/checks/settings': 'check settings on the company row',
};

// ── Matching ─────────────────────────────────────────────────────────

interface CompiledRule {
  method: string; // upper case, '*' or 'WRITE'
  segments: string[]; // without a trailing '**'
  rest: boolean; // trailing '/**'
}

function compile(rule: string): CompiledRule {
  const space = rule.indexOf(' ');
  if (space < 0) throw new Error(`route-classes: bad rule "${rule}"`);
  const method = rule.slice(0, space).toUpperCase();
  let path = rule.slice(space + 1);
  let rest = false;
  if (path.endsWith('/**')) {
    rest = true;
    path = path.slice(0, -3);
  }
  return { method, segments: splitPath(path), rest };
}

// Lower case: Express routes ignore case, so `/API/V1/Desktop/...` must
// classify as `/api/v1/desktop/...`. Empty segments (`//`, a trailing `/`)
// are dropped, as Express's non-strict routing ignores a trailing slash.
function splitPath(path: string): string[] {
  return path.split('?')[0]!.toLowerCase().split('/').filter((s) => s.length > 0);
}

function methodMatches(ruleMethod: string, method: string): boolean {
  if (ruleMethod === '*') return true;
  if (ruleMethod === 'WRITE') return isMutating(method);
  return ruleMethod === method;
}

function matches(rule: CompiledRule, method: string, segs: string[]): boolean {
  if (!methodMatches(rule.method, method)) return false;
  if (rule.rest ? segs.length < rule.segments.length : segs.length !== rule.segments.length) return false;
  return rule.segments.every((r, i) => {
    if (r === '*') return true;
    // `bulk-*`: a literal prefix within one segment.
    if (r.length > 1 && r.endsWith('*')) return segs[i]!.startsWith(r.slice(0, -1)) && !segs[i]!.startsWith('{');
    return r === segs[i];
  });
}

const HOST = LAN_HOST_RULES.map(compile);
const WORKSTATION = LAN_WORKSTATION_RULES.map(compile);
const STALE = STALE_RULES.map(([r, c]) => [compile(r), c] as const);

/**
 * The LAN class of a request or an OpenAPI operation. `path` may be a
 * concrete request path or an OpenAPI template; a query string is ignored.
 */
export function lanClassOf(method: string, path: string): LanClass {
  const m = method.toUpperCase();
  const segs = splitPath(path);
  if (HOST.some((r) => matches(r, m, segs))) return 'host';
  if (WORKSTATION.some((r) => matches(r, m, segs))) return 'workstation';
  return 'host';
}

/**
 * A matcher for a list of rules in the pattern language above (first used
 * by the maintenance drain, U-293). `path` may be a request path or a template.
 */
export function routeMatcher(rules: readonly string[]): (method: string, path: string) => boolean {
  const compiled = rules.map(compile);
  return (method, path) => {
    const m = method.toUpperCase();
    const segs = splitPath(path);
    return compiled.some((r) => matches(r, m, segs));
  };
}

/** The stale class of a mutating operation; null for reads and for unclassified workstation writes. */
export function staleClassOf(method: string, path: string): StaleClass | null {
  const m = method.toUpperCase();
  if (!isMutating(m)) return null;
  const segs = splitPath(path);
  for (const [rule, cls] of STALE) if (matches(rule, m, segs)) return cls;
  // A host-only write has one writer, so nothing is overwritten unseen.
  return lanClassOf(m, path) === 'host' ? 'n-a' : null;
}

/** OpenAPI extensions for one operation (the export adds them to every operation). */
export function routeClassExtensions(method: string, path: string): Record<`x-${string}`, string> {
  const ext: Record<`x-${string}`, string> = { 'x-lan': lanClassOf(method, path) };
  const stale = staleClassOf(method, path);
  if (stale) ext['x-stale'] = stale;
  return ext;
}

const NULL_STAMP = Object.keys(NULL_STAMP_CREATES).map(compile);

/** True when an explicit null `expectedUpdatedAt` is a stamp on (method, path) (NULL_STAMP_CREATES). */
export function acceptsNullStamp(method: string, path: string): boolean {
  const m = method.toUpperCase();
  const segs = splitPath(path);
  return NULL_STAMP.some((r) => matches(r, m, segs));
}

/** Test hook: the rule strings that never matched any of the given operations. */
export function unusedRules(ops: ReadonlyArray<{ method: string; path: string }>): string[] {
  const used = new Set<string>();
  const all: Array<[string, CompiledRule]> = [
    ...LAN_HOST_RULES.map((r, i) => [`lan-host:${r}`, HOST[i]!] as [string, CompiledRule]),
    ...LAN_WORKSTATION_RULES.map((r, i) => [`lan-ws:${r}`, WORKSTATION[i]!] as [string, CompiledRule]),
    ...STALE_RULES.map(([r], i) => [`stale:${r}`, STALE[i]![0]] as [string, CompiledRule]),
  ];
  for (const op of ops) {
    const m = op.method.toUpperCase();
    const segs = splitPath(op.path);
    for (const [key, rule] of all) if (matches(rule, m, segs)) used.add(key);
  }
  return all.map(([k]) => k).filter((k) => !used.has(k));
}
