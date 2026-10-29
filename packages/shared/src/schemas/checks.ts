// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { z } from 'zod';
import { CHECK_LAYOUT_VALUES } from '../types/checks.js';

export const writeCheckSchema = z.object({
  bankAccountId: z.string().uuid(),
  contactId: z.string().uuid().optional(),
  payeeNameOnCheck: z.string().min(1).max(255),
  // Freeform, newline-separated. Prints on the z-fold mailing panel and the
  // #10 envelope; check-pdf splits it on '\n' and keeps the first four rows.
  // Bounded because the Write Check form exposes it as a free textarea.
  payeeAddress: z.string().max(500).optional(),
  txnDate: z.string().min(1),
  amount: z.string().min(1),
  printedMemo: z.string().max(255).optional(),
  memo: z.string().optional(),
  printLater: z.boolean().default(false),
  // Manual check-number override for hand-written checks (the physical
  // checkbook may not match the auto counter). Ignored for printLater
  // (print assigns numbers at print time). Service enforces uniqueness
  // per bank account and advances the auto counter past it.
  checkNumber: z.coerce.number().int().min(1).optional(),
  lines: z.array(z.object({
    accountId: z.string().uuid(),
    description: z.string().optional(),
    amount: z.string().min(1),
    // ADR 0XX: per-line tag. `tagIds` remains for header-level multi-tag
    // compatibility; `tagId` here is the line-level value.
    tagId: z.string().uuid().nullable().optional(),
    // Per-line customer (U-49), persisted on journal_lines.contact_id.
    contactId: z.string().uuid().nullable().optional(),
    // Billable to the line's customer (U-50). Requires contactId; the
    // service refuses it otherwise (400 VALIDATION_ERROR).
    isBillable: z.boolean().optional(),
  })).min(1),
  tagIds: z.array(z.string().uuid()).optional(),
  // Client-generated id the form's attachments were uploaded against while
  // the check was still a draft; the route relinks them once it has a real
  // transaction id (same contract as POST /transactions).
  draftAttachmentId: z.string().uuid().optional(),
});

// What to do with a PRINTED check whose printed face changes (amount, payee,
// payee name or address, printed memo, bank account, date or number) on
// PUT /checks/:id: 'reprint' sends it back to the print queue (number and
// print stamp cleared); 'keep_number' keeps it numbered as a hand-written
// check (print stamp cleared). Required in that case — 409 CHECK_PRINTED
// without it.
export const PRINTED_CHECK_CHANGES = ['reprint', 'keep_number'] as const;

// PUT /checks/:id body (check-edit-v1). As writeCheckSchema, except:
// printLater has NO default — absent keeps the check's current print state
// (a queued check stays queued, a numbered one keeps its number) — and
// printedCheckChange answers the printed-check question above.
export const updateCheckSchema = writeCheckSchema.omit({ draftAttachmentId: true, printLater: true }).extend({
  printLater: z.boolean().optional(),
  printedCheckChange: z.enum(PRINTED_CHECK_CHANGES).optional(),
});

// Edit the memo line of a check that hasn't printed yet. Empty string is
// meaningful — it means "print no memo" (see check.service).
export const updateCheckMemoSchema = z.object({
  printedMemo: z.string().max(255),
});

export const printCheckSchema = z.object({
  bankAccountId: z.string().uuid(),
  checkIds: z.array(z.string().uuid()).min(1),
  startingCheckNumber: z.number().int().min(1),
  format: z.enum(CHECK_LAYOUT_VALUES),
  // Signature image to apply (must be one the caller is authorized for;
  // server re-validates). stepUpToken proves fresh re-authentication —
  // required whenever signatureId is present.
  signatureId: z.string().uuid().optional(),
  stepUpToken: z.string().optional(),
});

export const renderChecksSchema = z.object({
  checkIds: z.array(z.string().uuid()).min(1),
  format: z.enum(CHECK_LAYOUT_VALUES).optional(),
  startingCheckNumber: z.number().int().min(1).optional(),
  signatureId: z.string().uuid().optional(),
  stepUpToken: z.string().optional(),
});

// Decimal string like the money fields elsewhere (writeCheckSchema.amount).
const decimalString = z.string().regex(/^\d+(\.\d{1,4})?$/, 'Must be a positive amount');

export const createCheckSignatureSchema = z.object({
  label: z.string().min(1).max(100),
  maxAmount: decimalString.nullish(),
});

export const updateCheckSignatureSchema = z.object({
  label: z.string().min(1).max(100).optional(),
  maxAmount: decimalString.nullish(),
});

export const setSignatureUsersSchema = z.object({
  userIds: z.array(z.string().uuid()).max(200),
});

// Step-up re-authentication: password, or TOTP code for 2FA-enrolled users.
export const stepUpSchema = z.object({
  password: z.string().min(1).optional(),
  totpCode: z.string().regex(/^\d{6}$/).optional(),
}).refine((v) => v.password || v.totpCode, { message: 'Password or authenticator code required' });

// Check stock formats a per-bank-account layout may name (U-109): the
// engine's own layouts plus 'standard' (a check with no stub, for clients
// that render checks themselves; the engine PDF does not draw it).
export const CHECK_ACCOUNT_FORMAT_VALUES = [...CHECK_LAYOUT_VALUES, 'standard'] as const;

// Check style for one bank account's check stock (U-109,
// check-reprint-audit-v1). Alignment is not per bank account: it belongs to
// the printer (kept by the client) or the company alignmentOffsetX/Y below.
// printCompanyBlock: print the logo and company name/address on this
// account's checks (default false).
export const checkLayoutSchema = z.object({
  format: z.enum(CHECK_ACCOUNT_FORMAT_VALUES),
  printCompanyBlock: z.boolean().default(false),
}).strict();

export const checkSettingsSchema = z.object({
  format: z.enum(CHECK_LAYOUT_VALUES).optional(),
  bankName: z.string().optional(),
  bankAddress: z.string().optional(),
  routingNumber: z.string().max(9).optional(),
  accountNumber: z.string().optional(),
  fractionalRouting: z.string().optional(),
  printOnBlankStock: z.boolean().optional(),
  printCompanyInfo: z.boolean().optional(),
  printSignatureLine: z.boolean().optional(),
  printDateLine: z.boolean().optional(),
  printPayeeLine: z.boolean().optional(),
  printPayeeAddress: z.boolean().optional(),
  printAmountBox: z.boolean().optional(),
  printAmountWords: z.boolean().optional(),
  printMemoLine: z.boolean().optional(),
  printBankInfo: z.boolean().optional(),
  printMicrLine: z.boolean().optional(),
  printCheckNumber: z.boolean().optional(),
  printVoucherStub: z.boolean().optional(),
  alignmentOffsetX: z.number().optional(),
  alignmentOffsetY: z.number().optional(),
  nextCheckNumber: z.number().int().min(1).optional(),
  nextCheckNumbers: z.record(z.string(), z.number().int().min(1)).optional(),
  defaultBankAccountId: z.string().uuid().nullish(),
  // Per bank account layout (U-109), keyed by the bank GL account id. Sent:
  // merged per bank account (U-117), so accounts not sent keep their
  // entries; an account sent as null loses its entry. An account without
  // an entry falls back to the company format.
  layouts: z.record(z.string().uuid(), checkLayoutSchema.nullable()).optional(),
});
