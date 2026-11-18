// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// Bulk-import canonical row shapes + session types. Source-system
// adapters (accounting-power, quickbooks-online, …) parse their native
// formats into these structures; the validate/commit pipeline operates
// on the canonical shape regardless of source.

import type { AccountType } from './accounts.js';

/**
 * open_invoices / unpaid_bills (U-264, qbd-open-items-v1): the A/R and A/P
 * open items as of a date (QuickBooks Desktop "Open Invoices" and "Unpaid
 * Bills Detail", QuickBooks Online and Generic equivalents). Each row becomes
 * a real one-line invoice, credit memo, bill or vendor credit.
 */
export type ImportKind = 'coa' | 'contacts' | 'trial_balance' | 'gl_transactions' | 'open_invoices' | 'unpaid_bills'
  // U-265 (qbd-mapping-v1): the item list, and inventory on hand and value as of a date.
  | 'items' | 'inventory_valuation';

/** The engine item kinds an imported item becomes (U-265). */
export type ImportItemType = 'service' | 'non_inventory' | 'other_charge' | 'discount' | 'subtotal' | 'inventory_part';

/**
 * items (U-265): one row of an item list (QuickBooks Desktop Item Listing,
 * QuickBooks Online Products and Services, the Generic template). Accounts are
 * source account keys (number, else name), resolved at commit like journal lines.
 */
export interface CanonicalItemRow {
  rowNumber: number;
  /** Full name; a QuickBooks sub-item keeps "Parent:Sub". */
  name: string;
  /** The source Type, verbatim. */
  sourceType: string;
  /** The engine kind, or null for a source type that is not imported (see skipReason). */
  itemType: ImportItemType | null;
  /** Why a row is listed but not imported (sales tax items, groups, payment items). */
  skipReason?: 'sales_tax' | 'group' | 'payment';
  description?: string;
  purchaseDescription?: string;
  /** Exact decimal text (at most 4 places). */
  unitPrice?: string;
  /** Discount items: percent off, exact decimal text. */
  discountPercent?: string;
  purchaseCost?: string;
  /** Source account keys (accountNumber ?? accountName), with their parts. */
  incomeAccount?: { accountNumber?: string; accountName?: string };
  expenseAccount?: { accountNumber?: string; accountName?: string };
  assetAccount?: { accountNumber?: string; accountName?: string };
  cogsAccount?: { accountNumber?: string; accountName?: string };
  preferredVendor?: string;
  isTaxable?: boolean;
  isActive: boolean;
  reorderPoint?: string;
}

/**
 * inventory_valuation (U-265): on hand and asset value of each inventory item
 * as of the report date (QuickBooks Desktop Inventory Valuation Summary). Both
 * exact, as the report shows them; never quantity x average cost.
 */
export interface CanonicalValuationRow {
  rowNumber: number;
  /** Item full name ("Parent:Sub" for a sub-item). */
  item: string;
  /** Exact decimal text, at most 4 places, above 0. */
  onHand: string;
  /** Exact decimal text, at most 2 places, 0 or more. */
  assetValue: string;
}

/**
 * How the engine matched an account a file names (U-265, preview.accountMatches):
 * one entry per distinct source account key over EVERY row of the file (not the
 * preview sample). `sourceKey` is the key of the batch's accountMap and of the
 * commit's unmappedAccountKeys: the source account number, else its name.
 */
export interface ImportAccountMatch {
  sourceKey: string;
  number?: string;
  name?: string;
  /**
   * existing: the company has it (accountId); create: a chart row of this file
   * that the commit creates; unmatched: neither (a batch commit refuses it
   * unless the accountMap names an account, or a chart file of the batch has it).
   */
  match: 'existing' | 'create' | 'unmatched';
  accountId?: string;
  /** How an existing account was found. */
  matchedBy?: 'number' | 'name';
  /** Rows (chart, trial balance, item) or journal lines naming it. */
  rows: number;
  /** A chart row of type A/R or A/P (Q-P31k), or QuickBooks' Retained Earnings (U-272). */
  systemRole?: SourceSystemRole;
}

/**
 * The system role a source chart row stands for (U-264, U-272). In a batch an
 * A/R or A/P row merges into the company's account of that role when the batch
 * has open items; a retained earnings row merges in every batch (unless the
 * accountMap says "create").
 */
export type SourceSystemRole = 'accounts_receivable' | 'accounts_payable' | 'retained_earnings';

/** The open-item document a row becomes: by the sign of its open balance. */
export type OpenItemDocType = 'invoice' | 'credit_memo' | 'bill' | 'vendor_credit';

export interface CanonicalOpenItemRow {
  rowNumber: number;
  /** The report's Type, verbatim (e.g. "Invoice", "Payment", "Credit"). */
  sourceType: string;
  docType: OpenItemDocType;
  /** ISO YYYY-MM-DD: the document's own date. */
  date: string;
  /** The source document number (kept on the document). */
  number?: string;
  /** Customer (open_invoices) or vendor (unpaid_bills) name. */
  name: string;
  dueDate?: string;
  /** Exact decimal text, signed as the report shows it (credits negative). */
  openBalance: string;
  /** Exact decimal text, when the report has an Amount column. */
  originalAmount?: string;
}

export type SourceSystem = 'accounting_power' | 'quickbooks_online' | 'quickbooks_desktop' | 'generic';

export type ImportStatus =
  | 'uploaded'      // file persisted, parsed, validation errors recorded
  | 'validated'     // re-validated against current DB; ready to commit
  | 'committing'    // commit transaction in flight
  | 'committed'     // commit succeeded; commitResult populated
  | 'failed'        // commit threw; partial state possible (caller should
                    //   inspect commitResult.error and consider rollback)
  | 'cancelled'     // operator deleted before commit
  | 'undone';       // U-261: the batch holding the session was undone

export type ContactKind = 'customer' | 'vendor';

/**
 * The list a contacts upload holds (U-265): 'other' is a QuickBooks Desktop
 * Other Names list, imported as vendors (Q-78).
 */
export type ContactUploadKind = ContactKind | 'other';

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
  /**
   * U-264: the source account's type is A/R or A/P (QuickBooks Desktop and
   * Online). In a batch with open-item files the account merges into the
   * company's system account of that role (Q-P31k), or becomes it when the
   * company has none; elsewhere it imports as before (a plain account).
   * U-272: 'retained_earnings' (QuickBooks' Retained Earnings) merges into the
   * company's retained earnings account in every batch.
   */
  systemRole?: SourceSystemRole;
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
  /** Vendor default expense account as exported by the source system
   *  (account number or name, e.g. Accounting Power's "Account" column).
   *  Commit resolves it against the tenant's chart of accounts. */
  defaultExpenseAccountRaw?: string;
  /** U-265: false for a name the source marks inactive (it comes in inactive). Absent: active. */
  isActive?: boolean;
  /**
   * U-265: a QuickBooks job row ("Customer:Job"). The engine has no projects
   * list yet (U-35), so a job is not a contact of its own: the customer is
   * (created when missing) and the job name stays on what refers to it.
   */
  jobOf?: string;
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
  /** Tag name to apply to this posted line. Resolved (or auto-created) at
   *  commit time and written to journal_lines.tag_id. Populated by the
   *  Generic import (Tag column) and the QBO/QBD Journal imports (Class
   *  column, when class tracking is on). */
  tagName?: string;
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

  // Open items (U-264): the exact sum of the open balances.
  openTotal?: string;

  /**
   * U-265: every account the file names (chart, trial balance, journal, item
   * files), over all rows, sorted by sourceKey.
   */
  accountMatches?: ImportAccountMatch[];
  /** inventory_valuation (U-265): the exact sum of the asset values. */
  valuationTotal?: string;
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
  /** U-261: the batch the session belongs to (null until it joins one). */
  batchId?: string | null;
  /** U-261: 'post' (posted on commit) or 'reference' (only compared against). */
  role?: 'post' | 'reference';
  /** U-263: a journal file's first and last entry date (null for other kinds). */
  dateFrom?: string | null;
  dateTo?: string | null;
}

export interface ImportUploadOptions {
  /** CoA only: when true, existing accountNumbers have name/detailType/description overwritten. */
  updateExistingCoa?: boolean;
  /** Contacts only: which file the operator is uploading (Customers, Vendors, or QBD Other Names, U-265). */
  contactKind?: ContactUploadKind;
  /** AP TB only: which signed-balance column to use for the opening JE. */
  tbColumn?: TbColumnChoice;
  /** AP TB only: ISO date for the opening JE (file doesn't carry one). */
  tbReportDate?: string;
  /**
   * TB / GL only. When a line names an account this company's chart of
   * accounts does not have, post it to the suspense account instead of
   * failing the import, and report it. Keeps the entry balanced and turns a
   * dead-end error into reviewable work on Practice -> Uncategorized.
   * Defaults to ON; set false to restore the old "Import the CoA first" hard
   * failure.
   */
  unmappedAccountsToSuspense?: boolean;
  /**
   * Open items only (U-264): the report's "as of" date when the file carries
   * none (a QuickBooks Desktop report's own date wins).
   */
  reportDate?: string;
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
  /** TB / GL — lines posted to suspense because their account was unmapped. */
  unmappedToSuspense?: number;
  /** The distinct account numbers/names that went to suspense, for the report. */
  unmappedAccountKeys?: string[];
  /** GL only — imported transactions whose description matched an existing
   *  vendor name and were assigned that vendor as the payee. */
  vendorsMatched?: number;
  /** Contacts only — vendors whose source default-expense account was
   *  resolved against the chart of accounts and linked. */
  accountsLinked?: number;
  /** GL only — tags auto-created by name during a Generic transaction import. */
  tagsCreated?: number;
  /** GL in a batch with historyFrom (U-266) — entries dated before it, not posted. */
  skippedBeforeHistory?: number;
  /** Set when commit threw partway. The UI surfaces this verbatim;
   *  combined with `created` it tells the operator how much landed before
   *  the failure so they can decide whether to roll back manually or
   *  re-upload after fixing the offending row. */
  error?: string;
  /** When commit threw mid-loop, the entry index that errored (GL only). */
  failedAtIndex?: number;
  /** Per-row errors blocking commit (for /commit dry-run). */
  blockingErrors?: ImportValidationError[];
  /** Open items (U-264): documents created by type. */
  documents?: Partial<Record<OpenItemDocType, number>>;
  /** Open items (U-264): names not found, created as customers or vendors. */
  contactsCreated?: number;
  /** CoA (U-264): A/R or A/P accounts merged into the company's system account. */
  mergedIntoSystemAccounts?: number;
  /** TB / GL (U-264): lines moved from A/R or A/P to the before-conversion accounts. */
  redirectedLines?: number;
  /** Contacts / open items (U-265, Q-77): existing contacts of the other kind that became 'both'. */
  mergedToBoth?: number;
  /** Contacts (U-265): job rows folded into their customer (no projects list yet). */
  jobsFolded?: number;
  /** Contacts / items (U-265): rows brought in inactive. */
  inactive?: number;
  /** Items (U-265): rows listed but not imported, by reason. */
  itemsSkipped?: Partial<Record<'sales_tax' | 'group' | 'payment' | 'exists' | 'no_account', number>>;
  /** GL (U-265): distinct classes turned into tags through the batch's classMap. */
  classesMapped?: number;
  /** inventory_valuation (U-265): items given opening stock, and the exact total value. */
  itemsValued?: number;
  valuationTotal?: string;
}
