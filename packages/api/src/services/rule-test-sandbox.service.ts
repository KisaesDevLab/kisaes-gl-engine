// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { and, desc, eq, inArray } from 'drizzle-orm';
import type {
  Action,
  ActionsField,
  ConditionAST,
  ConditionalRule,
  ConditionalRuleContext,
} from '@kis-books/shared';
import { db } from '../db/index.js';
import { accounts, bankConnections, bankFeedItems } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import {
  contextFromFeedItem,
  evaluateActions,
  evaluateCondition,
  traceCondition,
  type ConditionTrace,
} from './conditional-rules-engine.service.js';

// Phase 5b §5.5 — sandbox runner. Operates on an UNSAVED rule
// body (the editor's in-memory state) so authors can test
// before saving. Returns trace data the UI uses to highlight
// which conditions passed/failed and what action set would have
// applied.

export interface SandboxRuleBody {
  conditions: ConditionAST;
  actions: ActionsField;
}

export interface SandboxRunResult {
  matched: boolean;
  trace: ConditionTrace;
  appliedActions: Action[];
  context: ConditionalRuleContext;
}

// Run against a single sample. The caller can supply a fully-
// formed ConditionalRuleContext directly OR a bankFeedItemId
// the sandbox loads + builds the context from.
export async function runOnSample(
  tenantId: string,
  rule: SandboxRuleBody,
  input: { sampleFeedItemId?: string; sampleContext?: ConditionalRuleContext },
): Promise<SandboxRunResult> {
  const ctx = await resolveContext(tenantId, input);
  const trace = traceCondition(rule.conditions, ctx);
  const matched = trace.matched && evaluateCondition(rule.conditions, ctx);
  const appliedActions = matched ? evaluateActions(rule.actions, ctx) : [];
  return { matched, trace, appliedActions, context: ctx };
}

export interface BatchSampleHit {
  bankFeedItemId: string;
  description: string | null;
  amount: string;
  feedDate: string;
  appliedActions: Action[];
}

export interface BatchSandboxResult {
  totalScanned: number;
  totalMatched: number;
  firstMatches: BatchSampleHit[]; // up to 10 sample hits for UI display
}

// Pull the most recent feed items (capped at 100) and run the
// rule against each. Used to estimate "if I save this rule,
// how many of my pending items will it fire on?"
export async function runOnLast100(
  tenantId: string,
  rule: SandboxRuleBody,
  limit = 100,
): Promise<BatchSandboxResult> {
  const items = await db
    .select()
    .from(bankFeedItems)
    .where(eq(bankFeedItems.tenantId, tenantId))
    .orderBy(desc(bankFeedItems.feedDate), desc(bankFeedItems.createdAt))
    .limit(Math.min(limit, 100));

  // Resolve each feed item's bank_connection.account_id once so
  // the sandbox tests rules against the same `account_source_id`
  // value the production pipeline uses.
  const connIds = Array.from(new Set(items.map((it) => it.bankConnectionId)));
  const connRows = connIds.length === 0 ? [] : await db
    .select({ id: bankConnections.id, accountId: bankConnections.accountId })
    .from(bankConnections)
    .where(and(eq(bankConnections.tenantId, tenantId), inArray(bankConnections.id, connIds)));
  const accountIdByConn = new Map(connRows.map((r) => [r.id, r.accountId]));

  let totalMatched = 0;
  const firstMatches: BatchSampleHit[] = [];
  for (const item of items) {
    const ctx = contextFromFeedItem({
      description: item.description,
      originalDescription: item.originalDescription,
      amount: item.amount,
      feedDate: item.feedDate,
      bankConnectionAccountId: accountIdByConn.get(item.bankConnectionId) ?? item.bankConnectionId,
    });
    let matched = false;
    try {
      matched = evaluateCondition(rule.conditions, ctx);
    } catch {
      // Invalid rule body produces no matches — caller already
      // ran Zod on the rule, so this should be rare.
      continue;
    }
    if (!matched) continue;
    totalMatched++;
    if (firstMatches.length < 10) {
      const appliedActions = evaluateActions(rule.actions, ctx);
      firstMatches.push({
        bankFeedItemId: item.id,
        description: item.description,
        amount: item.amount,
        feedDate: item.feedDate,
        appliedActions,
      });
    }
  }

  return { totalScanned: items.length, totalMatched, firstMatches };
}

async function resolveContext(
  tenantId: string,
  input: { sampleFeedItemId?: string; sampleContext?: ConditionalRuleContext },
): Promise<ConditionalRuleContext> {
  if (input.sampleContext) return input.sampleContext;
  if (!input.sampleFeedItemId) {
    throw AppError.badRequest('Either sampleFeedItemId or sampleContext is required');
  }
  const item = await db.query.bankFeedItems.findFirst({
    where: and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, input.sampleFeedItemId)),
  });
  if (!item) throw AppError.notFound('Sample feed item not found');
  const conn = await db.query.bankConnections.findFirst({
    where: and(eq(bankConnections.tenantId, tenantId), eq(bankConnections.id, item.bankConnectionId)),
    columns: { accountId: true },
  });
  return contextFromFeedItem({
    description: item.description,
    originalDescription: item.originalDescription,
    amount: item.amount,
    feedDate: item.feedDate,
    bankConnectionAccountId: conn?.accountId ?? item.bankConnectionId,
  });
}

// Returns the most recent N feed items as a picker source for
// the sandbox dropdown. Strips the heavyweight columns the UI
// doesn't need.
export async function recentFeedItemsForPicker(
  tenantId: string,
  limit = 25,
): Promise<Array<{ id: string; description: string | null; amount: string; feedDate: string; bankConnectionId: string }>> {
  const rows = await db
    .select({
      id: bankFeedItems.id,
      description: bankFeedItems.description,
      amount: bankFeedItems.amount,
      feedDate: bankFeedItems.feedDate,
      bankConnectionId: bankFeedItems.bankConnectionId,
    })
    .from(bankFeedItems)
    .where(eq(bankFeedItems.tenantId, tenantId))
    .orderBy(desc(bankFeedItems.feedDate))
    .limit(Math.min(limit, 50));
  return rows;
}

// Bank-source account list — one row per active bank connection
// joined to its GL account, so the rule builder UI can render a
// dropdown for the `account_source_id` condition field. Returning
// the GL account uuid + the human label (account name + masked
// connection identifier) lets the author pick by familiar name
// while the persisted rule body stores the GL account uuid the
// engine actually compares against.
export async function bankSourceAccountsForPicker(
  tenantId: string,
): Promise<Array<{ accountId: string; accountName: string; connectionId: string; institutionName: string | null; mask: string | null }>> {
  const rows = await db
    .select({
      accountId: bankConnections.accountId,
      accountName: accounts.name,
      connectionId: bankConnections.id,
      institutionName: bankConnections.institutionName,
      mask: bankConnections.mask,
    })
    .from(bankConnections)
    .leftJoin(accounts, eq(accounts.id, bankConnections.accountId))
    .where(eq(bankConnections.tenantId, tenantId));
  return rows.map((r) => ({
    accountId: r.accountId,
    accountName: r.accountName ?? '(unknown account)',
    connectionId: r.connectionId,
    institutionName: r.institutionName,
    mask: r.mask,
  }));
}

// Reused export so callers don't have to import from two places.
export type { ConditionTrace } from './conditional-rules-engine.service.js';
// Touch references so unused-import lints are quiet — these
// types may be used by callers when constructing payloads.
export type _RuleType = ConditionalRule;
export type _ConnType = typeof bankConnections.$inferSelect;
