// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

export type PrintStatus = 'queue' | 'printed' | 'hand_written';

/**
 * Characters that actually fit on the printed memo line. The column stores 255,
 * but the rule is three inches wide at 6.75pt and check-pdf's drawText drops
 * whatever runs past it with no ellipsis — so warn in the UI at this length
 * rather than let a memo lose its tail on paper.
 */
export const CHECK_MEMO_PRINT_LIMIT = 60;

export interface WriteCheckInput {
  bankAccountId: string;
  contactId?: string;
  payeeNameOnCheck: string;
  payeeAddress?: string;
  txnDate: string;
  amount: string;
  printedMemo?: string;
  memo?: string;
  printLater: boolean;
  /** Manual check-number override for hand-written checks; blank = the
   *  company's auto counter. Ignored when printLater (print assigns). */
  checkNumber?: number;
  lines: Array<{
    accountId: string;
    description?: string;
    amount: string;
    tagId?: string | null;
  }>;
  tagIds?: string[];
  /** Draft id the form's attachments were uploaded against, relinked to the
   *  created check by POST /checks. */
  draftAttachmentId?: string;
}

// Single source of truth for the selectable check print layouts. The
// Zod enum (schemas/checks.ts), the TS union below, and both frontend
// selectors all derive from this, so adding a layout is a one-line
// change here plus a render branch in check-pdf.service.drawCheckPage.
export const CHECK_LAYOUTS = [
  { value: 'voucher', label: 'Check on Top', description: 'Check on the top 3.5", two identical voucher stubs below — QuickBooks-compatible stock perforated at 3.5" and 7".' },
  { value: 'check_middle', label: 'Check in Middle', description: 'Stub on top, check in the middle, stub below — QuickBooks-compatible middle stock perforated at 3.5" and 7".' },
  { value: 'z_fold', label: 'Z-Fold Pressure Seal', description: 'Z-fold self-mailer (8.5×11) — check in the middle panel with remittance stubs above/below. For blank pressure-seal stock (e.g. blue Z-fold).' },
] as const;
export type CheckLayout = typeof CHECK_LAYOUTS[number]['value'];
export const CHECK_LAYOUT_VALUES = CHECK_LAYOUTS.map((l) => l.value) as [CheckLayout, ...CheckLayout[]];

export interface PrintCheckInput {
  bankAccountId: string;
  checkIds: string[];
  startingCheckNumber: number;
  format: CheckLayout;
  /** Signature image to apply; requires stepUpToken (fresh re-auth). */
  signatureId?: string;
  stepUpToken?: string;
}

export interface CheckSettings {
  format: CheckLayout;
  bankName: string;
  bankAddress: string;
  routingNumber: string;
  accountNumber: string;
  fractionalRouting: string;
  printOnBlankStock: boolean;
  printCompanyInfo: boolean;
  printSignatureLine: boolean;
  printDateLine: boolean;
  printPayeeLine: boolean;
  /** Payee name + mailing address block under the payee line, positioned
   *  for double-window envelopes (top/middle layouts). */
  printPayeeAddress: boolean;
  printAmountBox: boolean;
  printAmountWords: boolean;
  printMemoLine: boolean;
  printBankInfo: boolean;
  printMicrLine: boolean;
  printCheckNumber: boolean;
  printVoucherStub: boolean;
  alignmentOffsetX: number;
  alignmentOffsetY: number;
  /** Legacy company-wide next check number; the per-account map below wins. */
  nextCheckNumber: number;
  /** Per-bank-account next check number, keyed by bank GL account id. */
  nextCheckNumbers?: Record<string, number>;
  defaultBankAccountId: string | null;
}

export interface PrintBatchResult {
  batchId: string;
  checksPrinted: number;
  checkNumberRange: string;
}

// ── Check signature printing ─────────────────────────────────────

/** Upload pixel-dimension caps, enforced server-side (hard reject) and
 *  prechecked client-side before the upload request. */
export const CHECK_SIGNATURE_MAX_WIDTH = 600;
export const CHECK_SIGNATURE_MAX_HEIGHT = 200;

/** Error code returned (403) when a signature-bearing render/print lacks a
 *  valid step-up token; the client keys its re-auth modal off this. */
export const STEP_UP_REQUIRED = 'STEP_UP_REQUIRED';

export type StepUpMethod = 'password' | 'totp';

/** Owner management view of a signature (never exposes file paths). */
export interface CheckSignature {
  id: string;
  label: string;
  mimeType: string;
  width: number;
  height: number;
  /** NULL = no cap; checks above the cap print with a bare signature line. */
  maxAmount: string | null;
  isActive: boolean;
  createdAt: string;
  users: Array<{ id: string; displayName: string; email: string }>;
}

/** What the print dialog needs about a signature the current user may use. */
export interface MySignature {
  id: string;
  label: string;
  maxAmount: string | null;
  width: number;
  height: number;
}
