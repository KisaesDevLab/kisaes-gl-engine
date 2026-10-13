// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Wire contract for the AI parameter check (OPEN-QUESTIONS Q44). Advisory only: a check never
// changes a parameter and never marks anything verified; "Apply AI value" writes an audited
// override that stays UNVERIFIED until a super admin uses Mark verified.

export const AI_CHECK_VERDICTS = ['matches', 'differs', 'unconfirmed', 'error'] as const;
export type AiCheckVerdict = typeof AI_CHECK_VERDICTS[number];

export const AI_CHECK_TARGET_KINDS = ['federal_param', 'state_rule'] as const;
export type AiCheckTargetKind = typeof AI_CHECK_TARGET_KINDS[number];

export const AI_CHECK_RUN_SCOPES = ['single', 'federal', 'state', 'all'] as const;
export type AiCheckRunScope = typeof AI_CHECK_RUN_SCOPES[number];

export const AI_CHECK_RUN_STATUSES = ['queued', 'running', 'completed', 'cancelled', 'failed'] as const;
export type AiCheckRunStatus = typeof AI_CHECK_RUN_STATUSES[number];

export interface AiCheckUsage {
  inputTokens: number;
  outputTokens: number;
  webSearches: number;
  webFetches: number;
  /** Rough USD estimate (token list price + $10 / 1,000 searches); null when the model's price is unknown. */
  estimatedCostUsd: number | null;
}

export interface AiCheckDetails {
  /** The model's own verdict before the server re-decided it. */
  modelVerdict?: 'matches' | 'differs' | 'unconfirmed' | null;
  sourceKind?: string | null;
  inflationIndexed?: boolean | null;
  governingAuthority?: string | null;
  /** Why the server downgraded / re-decided the verdict (empty when it agreed). */
  notes?: string[];
  /** URLs the search / fetch tools actually returned during the call. */
  retrievedUrls?: string[];
  /** Trusted domains the call was limited to. */
  allowedDomains?: string[];
}

export interface AiCheckDTO {
  id: string;
  targetKind: AiCheckTargetKind;
  key: string;
  /** 'US' for a federal parameter, else the state code. */
  jurisdiction: string;
  taxYear: number;
  /** The row's value when the check ran. */
  storedValue: unknown;
  verdict: AiCheckVerdict;
  /** Parsed value the source states (same JSON shape as the stored value); null unless matches / differs. */
  foundValue: unknown;
  quote: string | null;
  sourceUrl: string | null;
  sourceTitle: string | null;
  sourceDate: string | null;
  sourceTaxYear: number | null;
  rationale: string | null;
  confidence: 'low' | 'medium' | 'high' | null;
  model: string | null;
  usage: AiCheckUsage | null;
  error: string | null;
  details: AiCheckDetails;
  runId: string | null;
  createdAt: string;
  createdBy: string | null;
  appliedAt: string | null;
  appliedBy: string | null;
  /** The row's current value differs from `storedValue` (the check is out of date). Set on list / get. */
  stale?: boolean;
}

export interface AiCheckLatestDTO {
  year: number;
  jurisdiction: string;
  /** Latest check per key (only keys that have one). */
  checks: Record<string, AiCheckDTO>;
}

export interface AiCheckRunCounts { matches: number; differs: number; unconfirmed: number; error: number }

export interface AiCheckRunDTO {
  id: string;
  taxYear: number;
  scope: AiCheckRunScope;
  state: string | null;
  key: string | null;
  status: AiCheckRunStatus;
  total: number;
  done: number;
  counts: AiCheckRunCounts;
  cancelRequested: boolean;
  error: string | null;
  createdBy: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface AiCheckAvailabilityDTO {
  available: boolean;
  /** Why the Check buttons are disabled (no Anthropic key, AI turned off). */
  reason: string | null;
  model: string | null;
  maxSearchesPerCheck: number;
  concurrency: number;
}

export interface ApplyAiCheckResult {
  check: AiCheckDTO;
  key: string;
  jurisdiction: string;
  year: number;
  value: unknown;
}

/**
 * Prefix of a citation written by "Apply AI value" (when the admin ticks "use the AI source as the
 * citation"). The override row's citation is shown instead of the shipped seed's only when it carries
 * this prefix, and a later manual value change clears it (the AI source no longer describes the value).
 */
export const AI_CITATION_PREFIX = 'AI-sourced, verify: ';

/** True for a citation written by Apply AI value. */
export const isAiCitation = (citation: string | null | undefined): boolean => !!citation && citation.startsWith(AI_CITATION_PREFIX);

/** Extra inputs an override write accepts from Apply AI value (services only; not a route body). */
export interface OverrideWriteOptions {
  /** New citation for the override row (AI_CITATION_PREFIX + source). undefined = leave as is. */
  citation?: string;
  /** Extra fields merged into the override_set audit row (aiCheckId, sourceUrl). */
  audit?: Record<string, unknown>;
}
