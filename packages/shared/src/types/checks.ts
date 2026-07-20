// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

export type PrintStatus = 'queue' | 'printed' | 'hand_written';

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
}

// Single source of truth for the selectable check print layouts. The
// Zod enum (schemas/checks.ts), the TS union below, and both frontend
// selectors all derive from this, so adding a layout is a one-line
// change here plus a render branch in check-pdf.service.drawCheckPage.
export const CHECK_LAYOUTS = [
  { value: 'voucher', label: 'Check on Top', description: 'Check at the top of the page, voucher stub below (standard business check).' },
  { value: 'check_middle', label: 'Check in Middle', description: 'Check in the center of the page with stubs above and below.' },
  { value: 'z_fold', label: 'Z-Fold Pressure Seal', description: 'Z-fold self-mailer (8.5×11) — check in the middle panel with remittance stubs above/below. For blank pressure-seal stock (e.g. blue Z-fold).' },
] as const;
export type CheckLayout = typeof CHECK_LAYOUTS[number]['value'];
export const CHECK_LAYOUT_VALUES = CHECK_LAYOUTS.map((l) => l.value) as [CheckLayout, ...CheckLayout[]];

export interface PrintCheckInput {
  bankAccountId: string;
  checkIds: string[];
  startingCheckNumber: number;
  format: CheckLayout;
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
