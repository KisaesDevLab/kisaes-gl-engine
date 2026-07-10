// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// 'assigned' — a category has been STAGED on the item (assigned_* columns)
// but NOT yet posted to the ledger. It stays actionable ("ready to approve")
// until approval flips it to 'categorized'. See migration 0119.
export type BankFeedStatus = 'pending' | 'assigned' | 'matched' | 'categorized' | 'excluded';
export type SyncStatus = 'active' | 'error' | 'disconnected';
export type ReconciliationStatus = 'in_progress' | 'complete';

export interface BankConnection {
  id: string;
  tenantId: string;
  accountId: string;
  provider: string;
  providerAccountId: string | null;
  providerItemId: string | null;
  institutionName: string | null;
  mask: string | null;
  lastSyncAt: string | null;
  syncStatus: SyncStatus;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  // The list endpoint joins the connection's account row and includes
  // its display name so the UI can label imports without a second fetch.
  accountName?: string | null;
}

export interface BankFeedItem {
  id: string;
  tenantId: string;
  bankConnectionId: string;
  providerTransactionId: string | null;
  feedDate: string;
  description: string | null;
  amount: string;
  category: string | null;
  status: BankFeedStatus;
  matchedTransactionId: string | null;
  suggestedAccountId: string | null;
  suggestedContactId: string | null;
  confidenceScore: string | null;
  createdAt: string;
  updatedAt: string;
  // Server-enriched display fields (joined from the bank connection and
  // suggestion tables). Present on list responses, absent on raw inserts.
  bankAccountName?: string | null;
  institutionName?: string | null;
  originalDescription?: string | null;
  suggestedAccountName?: string | null;
  matchType?: 'rule' | 'ai' | 'manual' | string | null;
  // STATEMENT_CHECK_PAYEE_V1 — payee read off a check-image thumbnail and the
  // parsed check number; shown in the UI so they're visible/confirmable.
  payeeNameOnCheck?: string | null;
  checkNumber?: number | null;
  // Feed-item memo (migration 0118): Plaid seeds it with the bank's raw
  // payee text; user edits persist; categorize stamps it on the txn.
  memo?: string | null;
  // Two-phase workflow (migration 0119): the STAGED assignment on an
  // 'assigned' item — the human-chosen category awaiting approval. Distinct
  // from suggested* (AI guess) and lineTags (posted). assignedAccountName /
  // assignedTagName are joined display names on list responses.
  assignedAccountId?: string | null;
  assignedAccountName?: string | null;
  assignedContactId?: string | null;
  assignedTagId?: string | null;
  assignedTagName?: string | null;
  assignedMemo?: string | null;
  // Rule-staged suggested tag (bank_feed_items.suggested_tag_id) and its
  // resolved name — surfaced on the feed so a rule-set tag is visible on a
  // PENDING item as a "suggested" pill before it's categorized.
  suggestedTagId?: string | null;
  suggestedTagName?: string | null;
  // For a CATEGORIZED/MATCHED item, the distinct tag names actually applied
  // on the matched transaction's journal lines (ADR 0XX §4.1). Null when
  // untagged / not yet posted; one element when uniform; two+ when mixed.
  lineTags?: string[] | null;
  // Count of already-posted ledger transactions that this PENDING item likely
  // corresponds to (same bank account, ±5 days, matching amount, not yet
  // matched to another feed item). Lets the feed surface a "Match" indicator so
  // in-system transactions (e.g. checks written in the ledger) aren't duplicated.
  // 0 for non-pending / already-matched rows.
  matchCandidateCount?: number;
}

export interface BankFeedFilters {
  status?: BankFeedStatus;
  bankConnectionId?: string;
  startDate?: string;
  endDate?: string;
  search?: string;
  // When true, restrict the feed to actionable (pending) items by excluding
  // matched/categorized/excluded. A specific `status` filter takes precedence.
  actionableOnly?: boolean;
  // Server-side column sort — the list paginates, so ordering must happen
  // in SQL, not on the loaded page.
  sortBy?: 'feedDate' | 'description' | 'category' | 'status' | 'amount';
  sortDir?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export interface CategorizeInput {
  accountId: string;
  contactId?: string;
  memo?: string;
  // ADR 0XY §6 — tag stamped onto the categorized transaction's
  // user-side journal line. Typically sourced from a matching bank
  // rule's assign_tag_id or from explicit user selection in the
  // categorization drawer. Null means explicitly untagged.
  tagId?: string | null;
}

export interface Reconciliation {
  id: string;
  tenantId: string;
  accountId: string;
  statementDate: string;
  statementEndingBalance: string;
  beginningBalance: string;
  clearedBalance: string | null;
  difference: string | null;
  status: ReconciliationStatus;
  completedAt: string | null;
  completedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReconciliationLine {
  id: string;
  reconciliationId: string;
  journalLineId: string;
  isCleared: boolean;
  clearedAt: string | null;
}

export interface StartReconciliationInput {
  accountId: string;
  statementDate: string;
  statementEndingBalance: string;
}

export interface CsvColumnMapping {
  date: number;
  description: number;
  amount: number;
  debitColumn?: number;
  creditColumn?: number;
  // Optional check-number column; when absent the importer parses the
  // check number from the description ("CHECK 1234", ...).
  checkNumber?: number;
}
