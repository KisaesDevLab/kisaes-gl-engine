// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// Bulk-import canonical row shapes + session types. Source-system
// adapters (accounting-power, quickbooks-online, …) parse their native
// formats into these structures; the validate/commit pipeline operates
// on the canonical shape regardless of source.

import type { AccountType } from './accounts.js';

export type ImportKind = 'coa' | 'contacts' | 'trial_balance' | 'gl_transactions';

export type SourceSystem = 'accounting_power' | 'quickbooks_online';

export type ImportStatus =
  | 'uploaded'      // file persisted, parsed, validation errors recorded
  | 'validated'     // re-validated against current DB; ready to commit
  | 'committing'    // commit transaction in flight
  | 'committed'     // commit succeeded; commitResult populated
  | 'failed'        // commit threw; partial state possible (caller should
                    //   inspect commitResult.error and consider rollback)
  | 'cancelled';    // operator deleted before commit

export type ContactKind = 'customer' | 'vendor';

export type TbColumnChoice = 'beginning' | 'adjusted';

export interface CanonicalCoaRow {
  /** 1-indexed source-file row number — used for error reporting only. */
  rowNumber: number;
  accountNumber?: string;
  name: string;
  accountType: AccountType;
  detailType?: string;
  description?: string;
  /** QBO uses Parent:Child name convention; populated when adapter splits. */
  parentName?: string;
  /** Accounting Power's `SubAccount Of` column. */
  parentNumber?: string;
}

export interface CanonicalContactRow {
  rowNumber: number;
  displayName: string;
  contactType: ContactKind;
  email?: string;
  phone?: string;
  fullName?: string;
  /** Single-line address; commit splits into billing/shipping line1 if present. */
  billingAddress?: string;
  shippingAddress?: string;
}

export interface CanonicalTrialBalanceRow {
  rowNumber: number;
  accountNumber?: string;
  accountName?: string;
  /** Decimal string. Set on debit-balance rows; left undefined otherwise. */
  debit?: string;
  credit?: string;
}

export interface CanonicalGlLine {
  accountName?: string;
  accountNumber?: string;
  /** Decimal string; "0" or "0.00" when line is credit-only. */
  debit: string;
  credit: string;
  memo?: string;
}

export interface CanonicalGlEntry {
  /** Source-file row of the entry's first line. */
  rowNumber: number;
  /** ISO YYYY-MM-DD. */
  date: string;
  reference?: string;
  /** Verbatim source label, e.g. 'Check' (QBO) / 'CD' (AP). */
  transactionType: string;
  /** Memo prefix tag, e.g. 'QBO:Check' / 'AP:CD'. */
  sourceCode: string;
  /** Payee/customer name from QBO Name column or AP Description. */
  name?: string;
  memo?: string;
  lines: CanonicalGlLine[];
  /** True for the reversing half of an Accounting Power inline void. */
  isVoidReversal?: boolean;
}

export interface ImportValidationError {
  /** 1-indexed source row, or 0 for whole-file errors. */
  rowNumber: number;
  field?: string;
  code: string;
  message: string;
}

export interface ImportPreview {
  totalRows: number;
  errorCount: number;
  /** First 50 canonical rows — page renders these as a preview table. */
  sampleRows: unknown[];

  // GL-specific
  jeGroupCount?: number;
  voidEntryCount?: number;

  // TB-specific
  reportDate?: string;
  tbColumn?: TbColumnChoice;
  totalDebit?: string;
  totalCredit?: string;
}

export interface ImportSession {
  id: string;
  tenantId: string;
  companyId: string;
  kind: ImportKind;
  sourceSystem: SourceSystem;
  status: ImportStatus;
  originalFilename: string;
  fileHash: string;
  rowCount: number;
  errorCount: number;
  reportDate: string | null;
  options: ImportUploadOptions | null;
  commitResult: ImportCommitResult | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  committedAt: string | null;
}

export interface ImportUploadOptions {
  /** CoA only: when true, existing accountNumbers have name/detailType/description overwritten. */
  updateExistingCoa?: boolean;
  /** Contacts only: which file the operator is uploading (Customers vs Vendors). */
  contactKind?: ContactKind;
  /** AP TB only: which signed-balance column to use for the opening JE. */
  tbColumn?: TbColumnChoice;
  /** AP TB only: ISO date for the opening JE (file doesn't carry one). */
  tbReportDate?: string;
}

export interface ImportCommitResult {
  created?: number;
  skipped?: number;
  /** CoA only — distinct from `skipped` because we may have updated a row that
   *  already existed (when options.updateExistingCoa is true) rather than
   *  creating a new one. */
  updated?: number;
  /** GL only — non-zero when the file contained inline-void groups. */
  voidsReversed?: number;
  /** Set when commit threw partway. The UI surfaces this verbatim;
   *  combined with `created` it tells the operator how much landed before
   *  the failure so they can decide whether to roll back manually or
   *  re-upload after fixing the offending row. */
  error?: string;
  /** When commit threw mid-loop, the entry index that errored (GL only). */
  failedAtIndex?: number;
  /** Per-row errors blocking commit (for /commit dry-run). */
  blockingErrors?: ImportValidationError[];
}
