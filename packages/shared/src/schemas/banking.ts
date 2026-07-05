// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { z } from 'zod';

const bankFeedStatuses = ['pending', 'matched', 'categorized', 'excluded'] as const;

export const bankFeedFiltersSchema = z.object({
  status: z.enum(bankFeedStatuses).optional(),
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
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const categorizeSchema = z.object({
  accountId: z.string().uuid(),
  contactId: z.string().uuid().optional(),
  memo: z.string().optional(),
});

export const matchSchema = z.object({
  transactionId: z.string().uuid(),
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

export const bankImportSchema = z.object({
  accountId: z.string().uuid(),
  mapping: z.object({
    date: z.number().int().min(0),
    description: z.number().int().min(0),
    amount: z.number().int().min(0),
    debitColumn: z.number().int().min(0).optional(),
    creditColumn: z.number().int().min(0).optional(),
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
