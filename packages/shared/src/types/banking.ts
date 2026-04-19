// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

export type BankFeedStatus = 'pending' | 'matched' | 'categorized' | 'excluded';
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
}

export interface BankFeedFilters {
  status?: BankFeedStatus;
  bankConnectionId?: string;
  startDate?: string;
  endDate?: string;
  search?: string;
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
}
