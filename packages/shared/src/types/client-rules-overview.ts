// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Client rules overview — one row per client the staff user can reach:
// how many pending bank-feed items the client's conditional rules (own +
// firm + global) match, how many of those are ready to post, which global
// rule accounts still need a per-client mapping, and the client portal
// counters. Counts only; transactions stay on each client's Bank Feed.

export interface ClientRulesOverviewRule {
  ruleId: string;
  ruleName: string;
  scope: 'tenant_user' | 'tenant_firm' | 'global_firm';
  /** Pending items this rule is the first match for. */
  matched: number;
  /** Of `matched`, items whose category resolved and that the rule does
   *  not flag for review — what "Post" would post. */
  ready: number;
  /** Of `matched`, items held back because a global rule's account has
   *  no mapping in this client yet. */
  needsMapping: number;
  /** Of `matched`, items the rule marks for review (never auto-posted). */
  needsReview: number;
}

export interface ClientRulesOverviewUnmappedAccount {
  /** Account id from the client the global rule was written on. */
  sourceAccountId: string;
  sourceAccountName: string;
  sourceAccountNumber: string | null;
  /** A mapping must target an account of the same type. */
  sourceAccountType: string;
  /** Pending items in this client waiting on this mapping. */
  items: number;
}

export interface ClientRulesOverviewRow {
  tenantId: string;
  tenantName: string;
  /** Firm managing this client — mappings are stored under it. Null for
   *  a client no firm manages (global rules never reach it). */
  firmId: string | null;
  /** False when RULES_TIERED_V1 is off for this client: only its own
   *  personal rules are evaluated, never firm or global rules. */
  tieredRules: boolean;
  pendingItems: number;
  /** True when the pending backlog exceeded the scan ceiling; counts
   *  cover the first `pendingItems` scanned. */
  truncated: boolean;
  rulesMatched: number;
  matched: number;
  ready: number;
  needsMapping: number;
  needsReview: number;
  rules: ClientRulesOverviewRule[];
  unmappedAccounts: ClientRulesOverviewUnmappedAccount[];
  /** Client submissions against a document request not yet reviewed. */
  unreadDocuments: number;
  /** Document requests still waiting on the client. */
  openDocumentRequests: number;
  overdueDocumentRequests: number;
  /** Portal questions sent to the client and not yet answered. */
  openQuestions: number;
  /** True when the client is excluded from bulk rule posting
   *  (tenants.practice_settings.excludeFromRulesOverview). Such a
   *  client is hidden unless the query asks for excluded clients, and
   *  the post endpoint refuses it. */
  excluded: boolean;
  /** Set when this client's counts could not be computed. */
  error: string | null;
}

export interface ClientRulesOverviewResponse {
  data: ClientRulesOverviewRow[];
  /** Clients in the listing (after search and the exclusion filter). */
  total: number;
  /** Accessible clients (matching the search) that are excluded from
   *  bulk posting — hidden when `includeExcluded` is false. */
  excludedTotal: number;
  limit: number;
  offset: number;
}

export interface ClientRulesPostTenantResult {
  tenantId: string;
  posted: number;
  skipped: number;
  failed: number;
  failures: Array<{ feedItemId: string; error: string }>;
  /** True when more ready items remain past this request's batch cap. */
  more: boolean;
  error: string | null;
}

export interface ClientRulesPostResult {
  results: ClientRulesPostTenantResult[];
  posted: number;
  failed: number;
}

export interface ClientAccountMapping {
  sourceAccountId: string;
  accountId: string;
}
