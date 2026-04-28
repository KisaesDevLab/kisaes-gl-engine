// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { z } from 'zod';

// RECURRING_DOC_REQUESTS_V1 — DTOs + Zod schemas shared across the
// API and web packages. The doc_request trigger type is already
// declared in the existing reminder system; these types add the
// "standing rule" + "issued instance" layers on top.

export const DOCUMENT_TYPES = [
  'bank_statement',
  'cc_statement',
  'payroll_report',
  'receipt_batch',
  'other',
] as const;
export type DocumentType = typeof DOCUMENT_TYPES[number];

export const RECURRING_FREQUENCIES = ['monthly', 'quarterly', 'annually'] as const;
export type RecurringFrequency = typeof RECURRING_FREQUENCIES[number];

export const DOC_REQUEST_STATUSES = ['pending', 'submitted', 'cancelled', 'superseded'] as const;
export type DocRequestStatus = typeof DOC_REQUEST_STATUSES[number];

// Cadence array — reused from the existing portal-reminders model.
// Empty array means "no escalation"; the opening email is the only send.
const cadenceDays = z.array(z.number().int().min(1).max(365)).max(20);

export const CADENCE_KINDS = ['frequency', 'cron'] as const;
export type CadenceKind = typeof CADENCE_KINDS[number];

export const recurringDocRequestCreateSchema = z.object({
  contactId: z.string().uuid(),
  companyId: z.string().uuid().nullable().optional(),
  documentType: z.enum(DOCUMENT_TYPES),
  description: z.string().min(1).max(2000),
  // RECURRING_CRON_V1 — picks between the simple frequency model and a
  // cron expression. Defaults to 'frequency' so existing API calls
  // are unchanged.
  cadenceKind: z.enum(CADENCE_KINDS).default('frequency'),
  frequency: z.enum(RECURRING_FREQUENCIES).default('monthly'),
  intervalValue: z.number().int().min(1).max(12).default(1),
  // Required for monthly/quarterly when cadenceKind=frequency; ignored
  // for annually (the start date drives the calendar). Validated as
  // 1..28 to avoid the 30/31 → February foot-gun; the service clamps
  // further if needed.
  dayOfMonth: z.number().int().min(1).max(28).nullable().optional(),
  // Required when cadenceKind=cron. Standard 5-field cron, plus the
  // sentinel '@last-business-day-of-month' for the named preset that
  // cron alone can't express. Validated server-side via cron-parser.
  cronExpression: z.string().min(1).max(120).nullable().optional(),
  cronTimezone: z.string().max(64).nullable().optional(),
  dueDaysAfterIssue: z.number().int().min(0).max(365).default(7),
  cadenceDays: cadenceDays.default([3, 7, 14]),
  // Optional first-issue moment. Defaults to "the next valid
  // dayOfMonth in the future".
  startAt: z.string().datetime().optional(),
  endsAt: z.string().datetime().nullable().optional(),
  active: z.boolean().default(true),
  // STATEMENT_AUTO_IMPORT_V1 — when set, an upload that fulfils this
  // rule is routed into the given bank_connection's bank_feed_items
  // pipeline instead of the receipts inbox.
  bankConnectionId: z.string().uuid().nullable().optional(),
});
export type RecurringDocRequestCreateInput = z.infer<typeof recurringDocRequestCreateSchema>;

export const recurringDocRequestUpdateSchema = recurringDocRequestCreateSchema
  .partial()
  .omit({ contactId: true });
export type RecurringDocRequestUpdateInput = z.infer<typeof recurringDocRequestUpdateSchema>;

export interface RecurringDocRequestSummary {
  id: string;
  tenantId: string;
  companyId: string | null;
  contactId: string;
  contactEmail: string;
  contactName: string | null;
  documentType: DocumentType;
  description: string;
  cadenceKind: CadenceKind;
  frequency: RecurringFrequency;
  intervalValue: number;
  dayOfMonth: number | null;
  cronExpression: string | null;
  cronTimezone: string | null;
  nextIssueAt: string;
  lastIssuedAt: string | null;
  dueDaysAfterIssue: number;
  cadenceDays: number[];
  active: boolean;
  endsAt: string | null;
  bankConnectionId: string | null;
  outstandingCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface DocumentRequestSummary {
  id: string;
  tenantId: string;
  companyId: string | null;
  recurringId: string | null;
  contactId: string;
  contactEmail: string;
  contactName: string | null;
  documentType: DocumentType;
  description: string;
  periodLabel: string;
  requestedAt: string;
  dueDate: string | null;
  status: DocRequestStatus;
  submittedAt: string | null;
  submittedReceiptId: string | null;
  // Most-recent reminder-send timestamps for the in-grid columns.
  lastRemindedAt: string | null;
  lastOpenedAt: string | null;
  lastClickedAt: string | null;
  reminderSendCount: number;
}

export const documentRequestListFiltersSchema = z.object({
  status: z.enum(DOC_REQUEST_STATUSES).optional(),
  contactId: z.string().uuid().optional(),
  recurringId: z.string().uuid().optional(),
  overdue: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
export type DocumentRequestListFilters = z.infer<typeof documentRequestListFiltersSchema>;
