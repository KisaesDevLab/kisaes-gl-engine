// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import type { CheckCategory, FindingSeverity, FindingStatus } from '../constants/review-checks.js';

// One row in the check_registry table — the catalog of
// available checks. `default_params` is opaque per check
// (e.g., `{thresholdAmount: 75}` for missing-attachment).
export interface CheckRegistryEntry {
  checkKey: string;
  name: string;
  description: string | null;
  handlerName: string;
  defaultSeverity: FindingSeverity;
  defaultParams: Record<string, unknown>;
  category: CheckCategory;
  enabled: boolean;
  createdAt: string;
}

// Result a handler returns. The orchestrator wraps these into
// finding rows after dedupe + suppression filtering.
export interface FindingDraft {
  checkKey: string;
  transactionId?: string | null;
  vendorId?: string | null;
  severity?: FindingSeverity; // overrides registry default
  payload: Record<string, unknown>;
  // Optional dedupe key for handlers without a transaction or
  // vendor (per plan §D4). Falls back to ''.
  dedupeKey?: string;
}

export interface Finding {
  id: string;
  tenantId: string;
  companyId: string | null;
  checkKey: string;
  transactionId: string | null;
  vendorId: string | null;
  severity: FindingSeverity;
  status: FindingStatus;
  assignedTo: string | null;
  payload: Record<string, unknown> | null;
  createdAt: string;
  resolvedAt: string | null;
  resolutionNote: string | null;
}

export interface CheckRun {
  id: string;
  tenantId: string;
  companyId: string | null;
  startedAt: string;
  completedAt: string | null;
  checksExecuted: number;
  findingsCreated: number;
  truncated: boolean;
  error: string | null;
}

export interface CheckSuppression {
  id: string;
  tenantId: string;
  companyId: string | null;
  checkKey: string;
  matchPattern: SuppressionPattern;
  reason: string | null;
  createdBy: string | null;
  createdAt: string;
  expiresAt: string | null;
}

// Match-pattern shape per plan §D9. Either a transaction id, a
// vendor id, or a payload-equality predicate. Multiple keys
// are AND-combined.
export interface SuppressionPattern {
  transactionId?: string;
  vendorId?: string;
  payloadEquals?: Record<string, unknown>;
}

// Per-(tenant, company, check) param overrides. Resolved by the
// orchestrator into the merged `params` the handler sees.
export interface CheckParamsOverride {
  id: string;
  tenantId: string;
  companyId: string | null;
  checkKey: string;
  params: Record<string, unknown>;
}
