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
  })).min(1),
  tagIds: z.array(z.string().uuid()).optional(),
  // Client-generated id the form's attachments were uploaded against while
  // the check was still a draft; the route relinks them once it has a real
  // transaction id (same contract as POST /transactions).
  draftAttachmentId: z.string().uuid().optional(),
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
});
