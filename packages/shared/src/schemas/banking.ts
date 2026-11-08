// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { z } from 'zod';

const bankFeedStatuses = ['pending', 'assigned', 'matched', 'categorized', 'excluded'] as const;

// A tri-state query flag: absent (no filter), 'true' or 'false'.
const optionalQueryBoolean = z
  .union([z.boolean(), z.enum(['true', 'false'])])
  .optional()
  .transform((v) => (v === undefined ? undefined : v === true || v === 'true'));

// U-177 (feed-transfer-window-v1): days either side for the other side of a
// transfer (as GET /banking/feed/:id/transfer-candidates windowDays).
const transferWindowDaysQuery = z.coerce.number().int().min(1).max(10).optional();

export const bankFeedFiltersSchema = z.object({
  // A stored status, or 'accepted' (feed-accept-v1, Q-P26y): every accepted
  // row, categorized and matched (entryVoided included), as /counts accepted.
  status: z.enum([...bankFeedStatuses, 'accepted']).optional(),
  bankConnectionId: z.string().uuid().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  search: z.string().optional(),
  // Convenience toggle: when true, show only actionable (pending) items by
  // excluding matched/categorized/excluded. A specific `status` filter, when
  // set, takes precedence in the service query. Accepts the string 'true'
  // (how it arrives as a query param) or a real boolean.
  actionableOnly: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .optional()
    .transform((v) => v === true || v === 'true'),
  // Convenience toggle: when true, show only rows a RULE mapped
  // (match_type = 'rule'). Constrained in the service WHERE so paging/counts
  // stay correct. Same query-param encoding as actionableOnly ('true' string
  // or a real boolean).
  ruleOnly: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .optional()
    .transform((v) => v === true || v === 'true'),
  // 'checkNumber' and 'payee' (assigned → suggested contact → payee read off
  // the check) serve the Uncategorized page's sortable Ref and Payee columns.
  // 'name' is what the feed's NAME column shows (assigned → suggested contact
  // → cleaned descriptor), 'originalDescription' the raw bank text, and
  // 'confidence' the AI score — the Bank Feed page's "Sort by" choices.
  sortBy: z.enum([
    'feedDate', 'description', 'category', 'status', 'amount', 'checkNumber', 'payee',
    'name', 'originalDescription', 'confidence',
  ]).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
  // U-174 (feed-review-v1) and U-166 (feed-match-v2). Absent = no filter;
  // 'true' / 'false' as query strings or booleans.
  bucket: z.enum(['ready', 'review', 'matches']).optional(),
  possibleDuplicate: optionalQueryBoolean,
  entryVoided: optionalQueryBoolean,
  // U-177 (feed-transfer-window-v1): the transfer window for bucket, the
  // matches filter and transferCandidate. Absent = 3 days.
  transferWindowDays: transferWindowDaysQuery,
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// Manual split lines on PUT /banking/feed/:id/assign and /categorize
// (U-164, feed-exact-v1): 2 to 50 lines, each a positive amount in cents.
// The lines must add up exactly to the item's |amount| (400
// SPLITS_DONT_BALANCE {kind: 'fixed', difference}, checked by the service,
// which has the item); an item amount with more than 2 decimals can't be
// split (400 AMOUNT_NOT_CENTS).
export const feedSplitLineSchema = z.object({
  accountId: z.string().uuid(),
  amount: z.string().regex(/^\d{1,12}(\.\d{1,2})?$/, 'Amount must be a positive number with at most 2 decimals')
    .refine((v) => /[1-9]/.test(v), 'Amount must be more than 0'),
  tagId: z.string().uuid().nullable().optional(),
  memo: z.string().max(500).nullable().optional(),
});
export const feedSplitsSchema = z.array(feedSplitLineSchema).min(2).max(50);

export const categorizeSchema = z.object({
  accountId: z.string().uuid(),
  contactId: z.string().uuid().optional(),
  memo: z.string().optional(),
  // ADR 0XY §6 — tag stamped on the categorized transaction's user-side
  // journal line. Zod strips unknown keys, so without this field a tag
  // picked in the categorize drawer never reached the service. Null means
  // explicitly untagged; omitted falls back to the item's suggested tag.
  tagId: z.string().uuid().nullable().optional(),
  // U-164: the owner's split. Omitted = one line on accountId; a split a
  // rule staged on the item is not used (the owner's choice wins).
  splits: feedSplitsSchema.optional(),
});

export const matchSchema = z.object({
  transactionId: z.string().uuid(),
  // U-166 (feed-match-v2): the entry's line on the bank account. Optional
  // when only one line fits (else 400 LINE_REQUIRED).
  journalLineId: z.string().uuid().optional(),
});

// U-174 (feed-review-v1): the owner's decision on a possible duplicate.
export const feedDuplicateDecisionSchema = z.object({
  decision: z.enum(['keep', 'remove']),
});

// U-174: GET /banking/feed/counts takes the list's scope.
export const bankFeedCountsQuerySchema = z.object({
  bankConnectionId: z.string().uuid().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  // U-177: the list's transfer window, so the counts equal the list totals.
  transferWindowDays: transferWindowDaysQuery,
});

// Two-phase workflow (migration 0119) — ASSIGN stages a category on a feed
// item WITHOUT posting. accountId is required (it's the category to post on
// approval); contact / tag / memo are optional. Nullable so a re-assign can
// clear a previously staged contact/tag.
export const assignSchema = z.object({
  accountId: z.string().uuid(),
  contactId: z.string().uuid().nullable().optional(),
  tagId: z.string().uuid().nullable().optional(),
  memo: z.string().max(500).nullable().optional(),
  // U-164: stage the owner's split. Omitted clears any split a rule staged,
  // so approve posts one line on accountId.
  splits: feedSplitsSchema.optional(),
});

// Bulk ASSIGN — stage the SAME assignment across many pending/assigned items
// (the toolbar "Categorize" action, which now STAGES rather than posts).
export const bulkAssignSchema = z.object({
  feedItemIds: z.array(z.string().uuid()).min(1).max(500),
  accountId: z.string().uuid(),
  contactId: z.string().uuid().nullable().optional(),
  tagId: z.string().uuid().nullable().optional(),
  memo: z.string().max(500).nullable().optional(),
});

// Bulk "Set payee" on UNPOSTED lines from the Uncategorized page. Writes the
// same field the Bank Feeds editor writes (suggested_contact_id) and leaves
// the status alone — unlike bulk-set-name, which stages the line as
// 'assigned' and so drops it off a pending-only list. null clears it.
export const bulkSetContactSchema = z.object({
  feedItemIds: z.array(z.string().uuid()).min(1).max(500),
  contactId: z.string().uuid().nullable(),
});

// Start a reconciliation either manually (accountId + statementDate +
// statementEndingBalance) or from a stored bank statement (statementId —
// the server derives account, statement date, and ending balance from the
// bank_statements row and links the reconciliation back to it).
export const startReconciliationSchema = z.object({
  accountId: z.string().uuid().optional(),
  statementDate: z.string().min(1).optional(),
  statementEndingBalance: z.string().min(1).optional(),
  statementId: z.string().uuid().optional(),
}).refine(
  (d) => !!d.statementId || (!!d.accountId && !!d.statementDate && !!d.statementEndingBalance),
  { message: 'Provide statementId, or accountId + statementDate + statementEndingBalance' },
);

// GET /banking/statements list filters (query params).
export const bankStatementFiltersSchema = z.object({
  accountId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const updateReconciliationLinesSchema = z.object({
  lines: z.array(z.object({
    journalLineId: z.string().uuid(),
    isCleared: z.boolean(),
  })),
});

// PATCH /banking/reconciliations/:id — edit header fields on an in-progress
// reconciliation. Currently just the statement ending balance (the figure the
// worksheet ties out against); enforced server-side to in_progress only.
export const updateReconciliationSchema = z.object({
  statementEndingBalance: z.string().min(1),
});

// Statement Match Engine wave 1: confirm a suggested (or manually chosen)
// worksheet journal line for a statement line.
// Wave 2 grouped matches extend the same route:
//   - journalLineIds (2..5): one statement line ↔ many worksheet lines.
//   - journalLineId + memberStatementLineIds (1..4): many statement lines
//     ↔ one worksheet line, confirmed from the primary (first) statement
//     line with the other member statement lines listed.
export const confirmStatementLineSchema = z.object({
  journalLineId: z.string().uuid().optional(),
  journalLineIds: z.array(z.string().uuid()).min(2).max(5).optional(),
  memberStatementLineIds: z.array(z.string().uuid()).min(1).max(4).optional(),
})
  .refine((d) => !!d.journalLineId !== !!d.journalLineIds, {
    message: 'Provide either journalLineId or journalLineIds (not both)',
  })
  .refine((d) => !d.memberStatementLineIds || !!d.journalLineId, {
    message: 'memberStatementLineIds requires a single journalLineId',
  });

// Statement Match Engine wave 2: create a posted transaction directly from
// an unmatched statement line ("Add to books"). Date and amount come from
// the statement line; accountId is the expense/income category account.
export const createFromStatementLineSchema = z.object({
  accountId: z.string().uuid(),
  contactId: z.string().uuid().optional(),
  memo: z.string().max(500).optional(),
});

// Reconcile-only import of a bank-download file (OFX/QFX/QBO — all OFX
// dialects). Content is the raw file text; accountId is optional on the
// first call (the server suggests one from the file's masked account
// number when it can, otherwise responds needsAccount and the client
// re-posts with the user's choice).
export const importOfxStatementSchema = z.object({
  content: z.string().min(1).max(5 * 1024 * 1024),
  accountId: z.string().uuid().optional(),
  fileName: z.string().max(255).optional(),
});

export const bankImportSchema = z.object({
  accountId: z.string().uuid(),
  mapping: z.object({
    date: z.number().int().min(0),
    description: z.number().int().min(0),
    amount: z.number().int().min(0),
    debitColumn: z.number().int().min(0).optional(),
    creditColumn: z.number().int().min(0).optional(),
    checkNumber: z.number().int().min(0).optional(),
  }),
});

// ─── Bulk bank-feed operations ─────────────────────────────────────
// Cap the array sizes: any bulk op past 500 items is almost certainly a
// client bug, and an uncapped input turns a single request into an O(n)
// DoS surface against the ledger.

export const bulkApproveSchema = z.object({
  feedItemIds: z.array(z.string().uuid()).min(1).max(500),
});

export const bulkCategorizeSchema = z.object({
  feedItemIds: z.array(z.string().uuid()).min(1).max(500),
  accountId: z.string().uuid(),
  contactId: z.string().uuid().optional(),
  memo: z.string().max(500).optional(),
  tagId: z.string().uuid().nullable().optional(),
});

// Post selected PENDING feed rows to the suspense account so the bank
// reconciles even though nobody has classified them yet. No account id: the
// destination is resolved from accounts.system_tag='suspense' server-side, so
// a client can never aim this at an arbitrary account.
export const bulkPostToSuspenseSchema = z.object({
  feedItemIds: z.array(z.string().uuid()).min(1).max(500),
});

export const bulkSetTagSchema = z.object({
  feedItemIds: z.array(z.string().uuid()).min(1).max(500),
  tagId: z.string().uuid().nullable(),
});

export const bulkExcludeSchema = z.object({
  feedItemIds: z.array(z.string().uuid()).min(1).max(500),
});

export const bulkRecleanseSchema = z.object({
  feedItemIds: z.array(z.string().uuid()).min(1).max(500),
});

// "Reprocess Rules" — re-run the rules stages over pending feed items.
// Exactly one selector: an explicit id list OR allPending (optionally
// scoped to one bank connection). The service batches the allPending
// path internally, so it takes no id array (and no 500 cap).
export const bulkReprocessRulesSchema = z.object({
  feedItemIds: z.array(z.string().uuid()).min(1).max(500).optional(),
  allPending: z.boolean().optional(),
  bankConnectionId: z.string().uuid().optional(),
}).refine(
  (v) => (v.feedItemIds !== undefined) !== (v.allPending === true),
  { message: 'Provide exactly one of feedItemIds or allPending' },
);

// Manual bank connections created from the UI ("CSV import" path).
export const createManualConnectionSchema = z.object({
  accountId: z.string().uuid(),
  institutionName: z.string().min(1).max(255).optional(),
});

// A feed item edit — memo / description / date / contact (all optional).
// Strict to reject unknown keys, since the service spreads req.body into
// the update set.
export const updateFeedItemSchema = z.object({
  feedDate: z.string().optional(),
  description: z.string().max(500).optional(),
  memo: z.string().max(500).optional(),
  contactId: z.string().uuid().nullable().optional(),
  category: z.string().max(100).optional(),
}).strict();
