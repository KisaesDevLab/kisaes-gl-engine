// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  can,
  type ClientAccountMapping,
  type ClientRulesOverviewQuery,
  type ClientRulesOverviewResponse,
  type ClientRulesOverviewRow,
  type ClientRulesOverviewRule,
  type ClientRulesPostResult,
  type ClientRulesPostTenantResult,
} from '@kis-books/shared';
import { db } from '../db/index.js';
import {
  accounts,
  bankConnections,
  bankFeedItems,
  tenantFirmAccountMappings,
  tenantFirmAssignments,
} from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import * as permissionService from './permission.service.js';
import * as rulesApply from './conditional-rules-apply.service.js';
import * as symbolResolution from './rule-symbol-resolution.service.js';
import * as bankFeedService from './bank-feed.service.js';
import { resolveCompanyForConnection } from './feed-item-company.service.js';

/**
 * Client rules overview — a staff-facing, cross-client summary of what the
 * conditional rules would post, plus the client portal counters, with a
 * "post" action per client or for many clients at once.
 *
 * Like client-banking-status / client-portal-activity, this deliberately
 * crosses tenants, so the tenant set comes from `user_tenant_access` for the
 * calling user and NEVER from client input; a tenantId supplied to a write
 * is re-checked against that table plus the caller's banking permission in
 * that tenant. Every per-tenant query below is scoped to the tenant being
 * processed, and every write goes through the tenant-scoped services
 * (applyForFeedItem → categorize → postTransaction), so the ledger guards,
 * fire audit and per-tenant audit log are exactly those of the Bank Feed.
 *
 * Counts only: no feed item is returned to the caller.
 */

// Pending items scanned per client for the counts. A backlog past this is
// reported as truncated rather than evaluated in one request.
const SCAN_LIMIT = 2_000;
const SCAN_BATCH = 500;
// Items posted per client per request — matches the Bank Feed's bulk caps.
const POST_LIMIT = 500;
// Clients evaluated concurrently while building a page.
const CONCURRENCY = 4;

interface AccessibleTenant {
  tenantId: string;
  tenantName: string;
}

async function listAccessibleTenants(
  userId: string,
  query: ClientRulesOverviewQuery,
): Promise<{ rows: AccessibleTenant[]; total: number }> {
  const search = query.search ? `%${query.search.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const searchCond = search ? sql`AND t.name ILIKE ${search}` : sql``;
  const [rowsResult, countResult] = await Promise.all([
    db.execute(sql`
      SELECT t.id AS tenant_id, t.name AS tenant_name
      FROM user_tenant_access uta
      JOIN tenants t ON t.id = uta.tenant_id
      WHERE uta.user_id = ${userId} AND uta.is_active = true ${searchCond}
      ORDER BY t.name, t.id
      LIMIT ${query.limit} OFFSET ${query.offset}
    `),
    db.execute(sql`
      SELECT COUNT(*)::int AS total
      FROM user_tenant_access uta
      JOIN tenants t ON t.id = uta.tenant_id
      WHERE uta.user_id = ${userId} AND uta.is_active = true ${searchCond}
    `),
  ]);
  return {
    rows: (rowsResult.rows as Array<{ tenant_id: string; tenant_name: string }>).map((r) => ({
      tenantId: r.tenant_id,
      tenantName: r.tenant_name,
    })),
    total: Number((countResult.rows[0] as { total: number } | undefined)?.total ?? 0),
  };
}

async function hasActiveAccess(userId: string, tenantId: string): Promise<boolean> {
  const rows = await db.execute(sql`
    SELECT 1 FROM user_tenant_access
    WHERE user_id = ${userId} AND tenant_id = ${tenantId} AND is_active = true
    LIMIT 1
  `);
  return rows.rows.length > 0;
}

/** Throws unless the user can reach `tenantId` and has banking `action`
 *  rights there. */
async function assertBankingAccess(userId: string, tenantId: string, action: 'read' | 'update'): Promise<void> {
  if (!(await hasActiveAccess(userId, tenantId))) {
    throw AppError.forbidden('You do not have access to this client', 'TENANT_ACCESS_DENIED');
  }
  const perms = await permissionService.getEffectivePermissionsForUser(tenantId, userId);
  if (!can(perms, 'banking', action)) {
    throw AppError.forbidden('You do not have banking permission for this client', 'PERMISSION_DENIED');
  }
}

async function activeFirmFor(tenantId: string): Promise<string | null> {
  const row = await db.query.tenantFirmAssignments.findFirst({
    where: and(eq(tenantFirmAssignments.tenantId, tenantId), eq(tenantFirmAssignments.isActive, true)),
    columns: { firmId: true },
  });
  return row?.firmId ?? null;
}

// Runs `fn` over `items` with at most `limit` in flight.
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

type PendingItem = typeof bankFeedItems.$inferSelect;

/** Keyset-walks a tenant's pending feed items, up to `max`. */
async function* pendingItems(tenantId: string, max: number): AsyncGenerator<PendingItem[]> {
  let lastId: string | null = null;
  let fetched = 0;
  while (fetched < max) {
    const conds = [eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.status, 'pending')];
    if (lastId) conds.push(sql`${bankFeedItems.id} > ${lastId}`);
    const batch: PendingItem[] = await db.select().from(bankFeedItems)
      .where(and(...conds))
      .orderBy(bankFeedItems.id)
      .limit(Math.min(SCAN_BATCH, max - fetched));
    if (batch.length === 0) return;
    yield batch;
    fetched += batch.length;
    lastId = batch[batch.length - 1]!.id;
  }
}

/** bank connection id → its GL account id, for the rules' account_source_id. */
async function connectionAccounts(tenantId: string): Promise<Map<string, string>> {
  const rows = await db.select({ id: bankConnections.id, accountId: bankConnections.accountId })
    .from(bankConnections)
    .where(eq(bankConnections.tenantId, tenantId));
  return new Map(rows.map((r) => [r.id, r.accountId]));
}

function feedItemInput(item: PendingItem, connAccounts: Map<string, string>) {
  return {
    description: item.description,
    originalDescription: item.originalDescription,
    amount: item.amount,
    feedDate: item.feedDate,
    bankConnectionAccountId: connAccounts.get(item.bankConnectionId) ?? item.bankConnectionId,
    payeeNameOnCheck: item.payeeNameOnCheck,
  };
}

// ─── Overview ────────────────────────────────────────────────

interface PortalCounts {
  unreadDocuments: number;
  openDocumentRequests: number;
  overdueDocumentRequests: number;
  openQuestions: number;
}

// Same predicates as client-portal-activity (unread = submitted and not yet
// reviewed; overdue = pending past its due date). Open questions are those
// still waiting on the client: 'open' (not yet seen) or 'viewed'.
async function portalCounts(tenantIds: string[]): Promise<Map<string, PortalCounts>> {
  const out = new Map<string, PortalCounts>();
  if (tenantIds.length === 0) return out;
  const idList = sql.join(tenantIds.map((id) => sql`${id}::uuid`), sql`, `);
  const rows = await db.execute(sql`
    WITH ids AS (SELECT unnest(ARRAY[${idList}]) AS tenant_id),
    reqs AS (
      SELECT dr.tenant_id,
             COUNT(*) FILTER (WHERE dr.status = 'submitted' AND dr.reviewed_at IS NULL) AS unread,
             COUNT(*) FILTER (WHERE dr.status = 'pending') AS open,
             COUNT(*) FILTER (WHERE dr.status = 'pending' AND dr.due_date IS NOT NULL AND dr.due_date < NOW()) AS overdue
      FROM document_requests dr
      WHERE dr.tenant_id IN (SELECT tenant_id FROM ids)
        AND dr.status IN ('submitted', 'pending')
      GROUP BY dr.tenant_id
    ),
    qs AS (
      SELECT pq.tenant_id, COUNT(*) AS open
      FROM portal_questions pq
      WHERE pq.tenant_id IN (SELECT tenant_id FROM ids)
        AND pq.status IN ('open', 'viewed')
      GROUP BY pq.tenant_id
    )
    SELECT ids.tenant_id,
           COALESCE(r.unread, 0)::int AS unread,
           COALESCE(r.open, 0)::int AS open_requests,
           COALESCE(r.overdue, 0)::int AS overdue,
           COALESCE(q.open, 0)::int AS open_questions
    FROM ids
    LEFT JOIN reqs r ON r.tenant_id = ids.tenant_id
    LEFT JOIN qs q ON q.tenant_id = ids.tenant_id
  `);
  for (const r of rows.rows as Array<{ tenant_id: string; unread: number; open_requests: number; overdue: number; open_questions: number }>) {
    out.set(r.tenant_id, {
      unreadDocuments: Number(r.unread),
      openDocumentRequests: Number(r.open_requests),
      overdueDocumentRequests: Number(r.overdue),
      openQuestions: Number(r.open_questions),
    });
  }
  return out;
}

type RuleCounts = Pick<ClientRulesOverviewRow,
  'tieredRules' | 'pendingItems' | 'truncated' | 'rulesMatched' | 'matched' | 'ready' | 'needsMapping' | 'needsReview' | 'rules' | 'unmappedAccounts'>;

async function ruleCountsForTenant(tenantId: string, userId: string): Promise<RuleCounts> {
  const ruleSet = await rulesApply.loadRuleSet(tenantId, userId);
  const connAccounts = await connectionAccounts(tenantId);
  const caches = symbolResolution.newCaches();
  const byRule = new Map<string, ClientRulesOverviewRule>();
  const unmapped = new Map<string, number>();
  let pending = 0;

  for await (const batch of pendingItems(tenantId, SCAN_LIMIT + 1)) {
    for (const item of batch) {
      if (pending === SCAN_LIMIT) { pending++; break; }
      pending++;
      if (ruleSet.rules.length === 0) continue;
      const result = await rulesApply.dryRunForFeedItem(tenantId, ruleSet, feedItemInput(item, connAccounts), caches);
      if (!result) continue;
      let entry = byRule.get(result.rule.id);
      if (!entry) {
        entry = {
          ruleId: result.rule.id,
          ruleName: result.rule.name,
          scope: result.rule.scope,
          matched: 0, ready: 0, needsMapping: 0, needsReview: 0,
        };
        byRule.set(result.rule.id, entry);
      }
      entry.matched++;
      if (result.outcome === 'ready') entry.ready++;
      else if (result.outcome === 'needs_review') entry.needsReview++;
      else if (result.outcome === 'needs_mapping') entry.needsMapping++;
      for (const id of result.unresolvedSourceAccountIds) unmapped.set(id, (unmapped.get(id) ?? 0) + 1);
    }
  }

  const truncated = pending > SCAN_LIMIT;
  const rules = [...byRule.values()].sort((a, b) => b.matched - a.matched || a.ruleName.localeCompare(b.ruleName));

  let unmappedAccounts: ClientRulesOverviewRow['unmappedAccounts'] = [];
  if (unmapped.size > 0) {
    // Source accounts live in other clients; only their name/number is
    // read, to label what needs mapping.
    const src = await db.select({ id: accounts.id, name: accounts.name, accountNumber: accounts.accountNumber, accountType: accounts.accountType })
      .from(accounts)
      .where(inArray(accounts.id, [...unmapped.keys()]));
    unmappedAccounts = src
      .map((a) => ({
        sourceAccountId: a.id,
        sourceAccountName: a.name,
        sourceAccountNumber: a.accountNumber ?? null,
        sourceAccountType: a.accountType,
        items: unmapped.get(a.id) ?? 0,
      }))
      .sort((a, b) => b.items - a.items || a.sourceAccountName.localeCompare(b.sourceAccountName));
  }

  const sum = (k: 'matched' | 'ready' | 'needsMapping' | 'needsReview') => rules.reduce((n, r) => n + r[k], 0);
  return {
    tieredRules: ruleSet.tiered,
    pendingItems: truncated ? SCAN_LIMIT : pending,
    truncated,
    rulesMatched: rules.length,
    matched: sum('matched'),
    ready: sum('ready'),
    needsMapping: sum('needsMapping'),
    needsReview: sum('needsReview'),
    rules,
    unmappedAccounts,
  };
}

const EMPTY_RULE_COUNTS: RuleCounts = {
  tieredRules: false, pendingItems: 0, truncated: false, rulesMatched: 0, matched: 0, ready: 0,
  needsMapping: 0, needsReview: 0, rules: [], unmappedAccounts: [],
};

export async function getOverview(userId: string, query: ClientRulesOverviewQuery): Promise<ClientRulesOverviewResponse> {
  const { rows: tenants, total } = await listAccessibleTenants(userId, query);
  const tenantIds = tenants.map((t) => t.tenantId);
  const [portal, firms] = await Promise.all([
    portalCounts(tenantIds),
    tenantIds.length === 0
      ? Promise.resolve(new Map<string, string>())
      : db.select({ tenantId: tenantFirmAssignments.tenantId, firmId: tenantFirmAssignments.firmId })
        .from(tenantFirmAssignments)
        .where(and(inArray(tenantFirmAssignments.tenantId, tenantIds), eq(tenantFirmAssignments.isActive, true)))
        .then((rs) => new Map(rs.map((r) => [r.tenantId, r.firmId]))),
  ]);

  const data = await mapWithConcurrency(tenants, CONCURRENCY, async (t): Promise<ClientRulesOverviewRow> => {
    const portalRow = portal.get(t.tenantId) ?? {
      unreadDocuments: 0, openDocumentRequests: 0, overdueDocumentRequests: 0, openQuestions: 0,
    };
    const base = { tenantId: t.tenantId, tenantName: t.tenantName, firmId: firms.get(t.tenantId) ?? null, ...portalRow };
    try {
      const perms = await permissionService.getEffectivePermissionsForUser(t.tenantId, userId);
      if (!can(perms, 'banking', 'read')) {
        return { ...base, ...EMPTY_RULE_COUNTS, error: 'No banking access for this client' };
      }
      return { ...base, ...(await ruleCountsForTenant(t.tenantId, userId)), error: null };
    } catch (err) {
      // One client's bad data must not blank the whole page.
      console.warn(`[client-rules-overview] counts failed for tenant ${t.tenantId}:`,
        err instanceof Error ? err.message : String(err));
      return { ...base, ...EMPTY_RULE_COUNTS, error: 'Could not compute rule matches for this client' };
    }
  });

  return { data, total, limit: query.limit, offset: query.offset };
}

// ─── Post ────────────────────────────────────────────────────

async function postForTenant(
  userId: string,
  tenantId: string,
  ruleIds: string[] | undefined,
): Promise<ClientRulesPostTenantResult> {
  const result: ClientRulesPostTenantResult = {
    tenantId, posted: 0, skipped: 0, failed: 0, failures: [], more: false, error: null,
  };
  await assertBankingAccess(userId, tenantId, 'update');

  const ruleFilter = ruleIds ? new Set(ruleIds) : null;
  const ruleSet = await rulesApply.loadRuleSet(tenantId, userId);
  if (ruleSet.rules.length === 0) return result;
  const connAccounts = await connectionAccounts(tenantId);
  const caches = symbolResolution.newCaches();

  // Pick the items first (read-only), then post — so the walk isn't
  // disturbed by items leaving 'pending' mid-scan.
  const toPost: string[] = [];
  scan: for await (const batch of pendingItems(tenantId, SCAN_LIMIT)) {
    for (const item of batch) {
      const dry = await rulesApply.dryRunForFeedItem(tenantId, ruleSet, feedItemInput(item, connAccounts), caches);
      if (!dry || dry.outcome !== 'ready') continue;
      if (ruleFilter && !ruleFilter.has(dry.rule.id)) continue;
      if (toPost.length === POST_LIMIT) { result.more = true; break scan; }
      toPost.push(item.id);
    }
  }

  for (const id of toPost) {
    try {
      const item = await db.query.bankFeedItems.findFirst({
        where: and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, id)),
      });
      if (!item || item.status !== 'pending') { result.skipped++; continue; }

      // Stage exactly as the import pipeline does (suggestion fields,
      // splits_config, rule fire audit), then post what was staged.
      await rulesApply.applyForFeedItem(tenantId, {
        id: item.id,
        ...feedItemInput(item, connAccounts),
      }, { currentUserId: userId });
      const staged = await db.query.bankFeedItems.findFirst({
        where: and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, id)),
      });
      // Only the first leg's account is read (categorize posts every leg
      // from splits_config itself; accountId feeds the learning history).
      const splits = staged?.splitsConfig as { splits?: Array<{ accountId: string }> } | null;
      const accountId = staged?.suggestedAccountId ?? splits?.splits?.[0]?.accountId ?? null;
      if (!staged || staged.status !== 'pending' || !accountId) { result.skipped++; continue; }

      const companyId = staged.companyId ?? (await resolveCompanyForConnection(tenantId, staged.bankConnectionId)) ?? undefined;
      await bankFeedService.categorize(tenantId, id, {
        accountId,
        contactId: staged.suggestedContactId ?? undefined,
      }, userId, companyId);
      result.posted++;
    } catch (err) {
      result.failed++;
      result.failures.push({ feedItemId: id, error: err instanceof Error ? err.message : String(err) });
    }
  }

  await auditLog(tenantId, 'update', 'bank_feed', null, null, {
    action: 'client_rules_post',
    ruleIds: ruleIds ?? null,
    posted: result.posted,
    skipped: result.skipped,
    failed: result.failed,
    more: result.more,
  }, userId);

  return result;
}

export async function post(
  userId: string,
  tenantIds: string[],
  ruleIds?: string[],
): Promise<ClientRulesPostResult> {
  const results: ClientRulesPostTenantResult[] = [];
  for (const tenantId of [...new Set(tenantIds)]) {
    try {
      results.push(await postForTenant(userId, tenantId, ruleIds));
    } catch (err) {
      results.push({
        tenantId, posted: 0, skipped: 0, failed: 0, failures: [], more: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return {
    results,
    posted: results.reduce((n, r) => n + r.posted, 0),
    failed: results.reduce((n, r) => n + r.failed, 0),
  };
}

// ─── Account mappings ────────────────────────────────────────

export interface MappableAccount {
  id: string;
  name: string;
  accountNumber: string | null;
  accountType: string;
}

/** Active accounts in `tenantId` a global rule's account can map to, plus
 *  the client's current mappings. */
export async function getMappingOptions(userId: string, tenantId: string): Promise<{
  accounts: MappableAccount[];
  mappings: ClientAccountMapping[];
}> {
  await assertBankingAccess(userId, tenantId, 'read');
  const [accts, maps] = await Promise.all([
    db.select({ id: accounts.id, name: accounts.name, accountNumber: accounts.accountNumber, accountType: accounts.accountType })
      .from(accounts)
      .where(and(eq(accounts.tenantId, tenantId), eq(accounts.isActive, true)))
      .orderBy(accounts.accountNumber, accounts.name),
    db.select({ sourceAccountId: tenantFirmAccountMappings.sourceAccountId, accountId: tenantFirmAccountMappings.accountId })
      .from(tenantFirmAccountMappings)
      .where(eq(tenantFirmAccountMappings.tenantId, tenantId)),
  ]);
  return {
    accounts: accts.map((a) => ({ ...a, accountNumber: a.accountNumber ?? null })),
    mappings: maps,
  };
}

/** Map a global rule's source account to one of `tenantId`'s accounts. */
export async function upsertMapping(
  userId: string,
  tenantId: string,
  input: ClientAccountMapping,
): Promise<ClientAccountMapping> {
  await assertBankingAccess(userId, tenantId, 'update');
  const firmId = await activeFirmFor(tenantId);
  if (!firmId) {
    throw AppError.badRequest('This client is not managed by a firm, so global rules do not apply to it', 'TENANT_NOT_MANAGED');
  }

  // The source must be an account of another client the SAME firm
  // manages — that is where its global rules are written. Anything else
  // could never be referenced by one of the firm's rules.
  const source = await db.query.accounts.findFirst({
    where: eq(accounts.id, input.sourceAccountId),
    columns: { id: true, tenantId: true, accountType: true },
  });
  if (!source || source.tenantId === tenantId || (await activeFirmFor(source.tenantId)) !== firmId) {
    throw AppError.badRequest('Source account is not a firm global-rule account', 'INVALID_SOURCE_ACCOUNT');
  }
  const target = await db.query.accounts.findFirst({
    where: and(eq(accounts.tenantId, tenantId), eq(accounts.id, input.accountId), eq(accounts.isActive, true)),
    columns: { id: true, accountType: true },
  });
  if (!target) throw AppError.badRequest('Account not found in this client', 'ACCOUNT_NOT_IN_TENANT');
  // An expense rule must keep posting to an expense account — one wrong
  // pick would otherwise send every match to a bank or equity account.
  if (target.accountType !== source.accountType) {
    throw AppError.badRequest(
      `Choose an account of type "${source.accountType}" — the same type the global rule posts to`,
      'ACCOUNT_TYPE_MISMATCH',
    );
  }

  const before = await db.query.tenantFirmAccountMappings.findFirst({
    where: and(
      eq(tenantFirmAccountMappings.firmId, firmId),
      eq(tenantFirmAccountMappings.tenantId, tenantId),
      eq(tenantFirmAccountMappings.sourceAccountId, input.sourceAccountId),
    ),
  });
  const [row] = await db.insert(tenantFirmAccountMappings)
    .values({ firmId, tenantId, sourceAccountId: input.sourceAccountId, accountId: input.accountId, createdBy: userId })
    .onConflictDoUpdate({
      target: [tenantFirmAccountMappings.firmId, tenantFirmAccountMappings.tenantId, tenantFirmAccountMappings.sourceAccountId],
      set: { accountId: input.accountId, updatedAt: new Date() },
    })
    .returning();

  await auditLog(
    tenantId,
    before ? 'update' : 'create',
    'firm_account_mapping',
    row!.id,
    before ? { sourceAccountId: before.sourceAccountId, accountId: before.accountId } : null,
    { sourceAccountId: row!.sourceAccountId, accountId: row!.accountId },
    userId,
  );
  return { sourceAccountId: row!.sourceAccountId, accountId: row!.accountId };
}
