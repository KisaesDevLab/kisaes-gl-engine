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

export const startReconciliationSchema = z.object({
  accountId: z.string().uuid(),
  statementDate: z.string().min(1),
  statementEndingBalance: z.string().min(1),
});

export const updateReconciliationLinesSchema = z.object({
  lines: z.array(z.object({
    journalLineId: z.string().uuid(),
    isCleared: z.boolean(),
  })),
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
