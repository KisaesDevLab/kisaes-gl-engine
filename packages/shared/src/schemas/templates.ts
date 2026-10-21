// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Memorized transactions (templates, U-62 templates-v1) and the recurring
// catch-up run (U-63 recurring-run-due-v1).
//
// A template's `draft` is the create body of its kind's endpoint minus the
// date and numbers. Every amount is a decimal string with at most four
// places; a JSON number is refused (400 VALIDATION_ERROR). Fields a template
// can't hold (a date, a check or entry number, a reversal date, a deposit
// line's sourceTransactionId) are refused by the engine before these
// schemas run (400 TEMPLATE_FIELD_NOT_ALLOWED / TEMPLATE_DEPOSIT_GROUPING).

import { z } from 'zod';

export const TEMPLATE_MONEY_RE = /^-?\d{1,15}(\.\d{1,4})?$/;
const money = z.string().regex(TEMPLATE_MONEY_RE, 'a decimal string with at most 4 decimal places');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const uuid = z.string().uuid();
const MAX_LINES = 500;

export const txnTemplateKinds = ['check', 'expense', 'deposit', 'transfer', 'journal_entry', 'daily_sales'] as const;
export type TemplateDraftKind = (typeof txnTemplateKinds)[number];

export const checkTemplateDraftSchema = z.object({
  bankAccountId: uuid,
  contactId: uuid.nullable().optional(),
  payeeNameOnCheck: z.string().trim().min(1).max(255),
  payeeAddress: z.string().max(500).nullable().optional(),
  printedMemo: z.string().max(255).nullable().optional(),
  memo: z.string().max(5000).nullable().optional(),
  amount: money,
  printLater: z.boolean().default(false),
  tagIds: z.array(uuid).max(50).default([]),
  lines: z.array(z.object({
    accountId: uuid,
    amount: money,
    description: z.string().max(5000).nullable().optional(),
    tagId: uuid.nullable().optional(),
    contactId: uuid.nullable().optional(),
    isBillable: z.boolean().optional(),
  }).strict()).min(1).max(MAX_LINES),
}).strict();

export const expenseTemplateDraftSchema = z.object({
  payFromAccountId: uuid,
  contactId: uuid.nullable().optional(),
  memo: z.string().max(5000).nullable().optional(),
  // Header tags (E3): the expense create body has none; the replay applies them.
  tagIds: z.array(uuid).max(50).default([]),
  lines: z.array(z.object({
    expenseAccountId: uuid,
    amount: money,
    description: z.string().max(5000).nullable().optional(),
    tagId: uuid.nullable().optional(),
    contactId: uuid.nullable().optional(),
    isBillable: z.boolean().optional(),
  }).strict()).min(1).max(MAX_LINES),
}).strict();

export const depositTemplateDraftSchema = z.object({
  depositToAccountId: uuid,
  memo: z.string().max(5000).nullable().optional(),
  lines: z.array(z.object({
    accountId: uuid,
    // Negative = a fee taken out of the deposit.
    amount: money,
    description: z.string().max(5000).nullable().optional(),
    tagId: uuid.nullable().optional(),
    contactId: uuid.nullable().optional(),
  }).strict()).min(1).max(MAX_LINES),
  cashBack: z.object({
    accountId: uuid,
    amount: money,
    memo: z.string().max(1000).nullable().optional(),
  }).strict().nullable().optional(),
}).strict();

export const transferTemplateDraftSchema = z.object({
  fromAccountId: uuid,
  toAccountId: uuid,
  amount: money,
  memo: z.string().max(5000).nullable().optional(),
}).strict();

export const journalEntryTemplateDraftSchema = z.object({
  memo: z.string().max(5000).nullable().optional(),
  basis: z.enum(['cash', 'accrual', 'both']).default('both'),
  isAdjusting: z.boolean().optional(),
  lines: z.array(z.object({
    accountId: uuid,
    debit: money.default('0'),
    credit: money.default('0'),
    description: z.string().max(5000).nullable().optional(),
    tagId: uuid.nullable().optional(),
    contactId: uuid.nullable().optional(),
  }).strict()).min(2).max(MAX_LINES),
}).strict();

export const dailySalesTemplateDraftSchema = z.object({
  // The daily-sales layout (daily_sales_templates.id).
  templateId: uuid,
  tagId: uuid.nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  values: z.array(z.object({
    templateLineId: uuid,
    amount: money,
    tagId: uuid.nullable().optional(),
  }).strict()).min(1).max(MAX_LINES),
}).strict();

export const TEMPLATE_DRAFT_SCHEMAS = {
  check: checkTemplateDraftSchema,
  expense: expenseTemplateDraftSchema,
  deposit: depositTemplateDraftSchema,
  transfer: transferTemplateDraftSchema,
  journal_entry: journalEntryTemplateDraftSchema,
  daily_sales: dailySalesTemplateDraftSchema,
} as const;

export type CheckTemplateDraft = z.infer<typeof checkTemplateDraftSchema>;
export type ExpenseTemplateDraft = z.infer<typeof expenseTemplateDraftSchema>;
export type DepositTemplateDraft = z.infer<typeof depositTemplateDraftSchema>;
export type TransferTemplateDraft = z.infer<typeof transferTemplateDraftSchema>;
export type JournalEntryTemplateDraft = z.infer<typeof journalEntryTemplateDraftSchema>;
export type DailySalesTemplateDraft = z.infer<typeof dailySalesTemplateDraftSchema>;

export type TemplateDraft =
  | { kind: 'check'; draft: CheckTemplateDraft }
  | { kind: 'expense'; draft: ExpenseTemplateDraft }
  | { kind: 'deposit'; draft: DepositTemplateDraft }
  | { kind: 'transfer'; draft: TransferTemplateDraft }
  | { kind: 'journal_entry'; draft: JournalEntryTemplateDraft }
  | { kind: 'daily_sales'; draft: DailySalesTemplateDraft };

export const txnTemplateFrequencies = ['daily', 'weekly', 'biweekly', 'semimonthly', 'monthly', 'quarterly', 'annually'] as const;

export const txnTemplateScheduleSchema = z.object({
  mode: z.enum(['remind', 'auto']),
  frequency: z.enum(txnTemplateFrequencies),
  intervalValue: z.number().int().min(1).max(365).default(1),
  nextDate: isoDate,
  endDate: isoDate.nullable().optional(),
  remainingCount: z.number().int().min(1).max(9999).nullable().optional(),
}).strict();
export type TemplateScheduleInput = z.infer<typeof txnTemplateScheduleSchema>;

const draftBody = z.record(z.string(), z.unknown())
  .describe('the create body of the kind (see the templates-v1 shapes); amounts are decimal strings');

export const createTxnTemplateSchema = z.object({
  name: z.string().trim().min(1).max(255),
  groupId: uuid.nullable().optional(),
  kind: z.enum(txnTemplateKinds),
  clientForm: z.string().trim().max(30).nullable().optional(),
  draft: draftBody,
  schedule: txnTemplateScheduleSchema.nullable().optional(),
}).strict();

export const createTxnTemplateFromTransactionSchema = z.object({
  transactionId: uuid,
  name: z.string().trim().min(1).max(255),
  groupId: uuid.nullable().optional(),
  clientForm: z.string().trim().max(30).nullable().optional(),
  schedule: txnTemplateScheduleSchema.nullable().optional(),
}).strict();

export const updateTxnTemplateSchema = z.object({
  version: z.number().int().min(1),
  name: z.string().trim().min(1).max(255).optional(),
  groupId: uuid.nullable().optional(),
  clientForm: z.string().trim().max(30).nullable().optional(),
  draft: draftBody.optional(),
  // null removes the schedule ("Don't remind me").
  schedule: txnTemplateScheduleSchema.nullable().optional(),
}).strict();

export const txnTemplateGroupSchema = z.object({
  name: z.string().trim().min(1).max(100),
}).strict();

export const enterTxnTemplateSchema = z.object({
  occurrenceDate: isoDate.optional(),
}).strict();

export const resolveOccurrenceSchema = z.object({
  transactionId: uuid,
}).strict();

export const runDueSchema = z.object({
  asOf: isoDate.optional(),
  runId: uuid.optional(),
  limit: z.number().int().min(1).max(500).default(200),
}).strict();
