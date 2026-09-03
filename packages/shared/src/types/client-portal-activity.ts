// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Per-client document-request activity for the Clients screen — one row per
 * tenant the caller can reach. Sibling of ClientBankingStatus and fetched
 * the same way (its own endpoint, merged by tenantId), never via /auth/me.
 */
export interface ClientPortalActivity {
  tenantId: string;
  /**
   * Document requests the client has fulfilled that no staff member has
   * acknowledged yet (status 'submitted' with no reviewed_at). This is the
   * same predicate as the dashboard banner's "submissions to review".
   */
  unreadSubmissions: number;
  /** Pending document requests whose due date has passed. */
  overdueDocRequests: number;
}
