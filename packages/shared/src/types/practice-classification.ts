// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// Bucket enum for Phase 2 Close Review workflow. `potential_match`
// is populated by Phase 3 (matcher); `rule` is stamped when a
// legacy bank rule fires; `auto_high` / `auto_medium` fall out of
// the confidence thresholds; `needs_review` is the fallthrough.
export const CLASSIFICATION_BUCKETS = [
  'potential_match',
  'rule',
  'auto_high',
  'auto_medium',
  'needs_review',
] as const;
export type ClassificationBucket = typeof CLASSIFICATION_BUCKETS[number];

// One match candidate inside `match_candidates` JSONB. Shape
// reserved for Phase 3 (this phase ships the UI scaffolding but
// does not populate the column). Kept here so Phase 3 doesn't
// invent a different shape.
export interface MatchCandidate {
  kind: 'invoice' | 'bill' | 'journal_entry' | 'transfer' | 'recurring';
  targetId: string;
  amount: string;
  date: string | null;
  contactName: string | null;
  score: number;
  amountScore: number;
  dateScore: number;
  nameScore: number;
  reason: string;
}

// Reasoning blob stored on every state row. Gives the UI enough
// detail to surface "why this bucket?" without a second API call.
export interface ClassificationReasoning {
  bucket: ClassificationBucket;
  baseConfidence: number;
  adjustments: Array<{ reason: string; delta: number }>;
  finalConfidence: number;
  vendorConsistency: number | null;
  isNewVendor: boolean;
  isMultiAccountHistory: boolean;
  matchType: string | null;
}

export interface ClassificationState {
  id: string;
  tenantId: string;
  companyId: string | null;
  bankFeedItemId: string;
  transactionId: string | null;
  bucket: ClassificationBucket;
  confidenceScore: number;
  suggestedAccountId: string | null;
  suggestedVendorId: string | null;
  matchedRuleId: string | null;
  reasoningBlob: ClassificationReasoning | null;
  modelUsed: string | null;
  matchCandidates: MatchCandidate[] | null;
  vendorEnrichment: VendorEnrichment | null;
  createdAt: string;
  updatedAt: string;
}

export interface VendorEnrichment {
  likelyBusinessType: string | null;
  suggestedAccountType: string | null;
  sourceUrl: string | null;
  summary: string | null;
  provider: string | null;
  fetchedAt: string;
}

// Per-bucket summary tile payload returned by GET /summary.
// `totalUncategorized` is the count of state rows still awaiting
// approval (transaction_id IS NULL); `totalApproved` is the count
// of rows in the same period that have been posted. Together they
// drive the page-level progress bar.
export interface BucketSummary {
  periodStart: string;
  periodEnd: string;
  buckets: Record<ClassificationBucket, number>;
  totalUncategorized: number;
  totalApproved: number;
  findingsCount: number;
}

// Row payload returned by GET /bucket/:bucket.
export interface BucketRow {
  stateId: string;
  bankFeedItemId: string;
  bankConnectionId: string;
  feedDate: string;
  description: string;
  amount: string;
  suggestedAccountId: string | null;
  suggestedAccountName: string | null;
  suggestedVendorId: string | null;
  suggestedVendorName: string | null;
  matchedRuleId: string | null;
  matchedRuleName: string | null;
  bucket: ClassificationBucket;
  confidenceScore: number;
  reasoning: ClassificationReasoning | null;
  matchCandidates: MatchCandidate[] | null;
  // OCR snapshot from the most recent attached receipt (when one
  // exists with ocrStatus='complete'). Drives the in-row receipt
  // comparison panel without requiring a second round-trip per row.
  receiptOcr: BucketReceiptOcr | null;
}

export interface BucketReceiptOcr {
  attachmentId: string;
  vendor: string | null;
  date: string | null;
  total: string | null;
  tax: string | null;
}
