// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { categorizationHistory, accounts, conditionalRules } from '../db/schema/index.js';

// Phase 5b §5.7 — auto-suggest. Scans the categorization
// learning layer for high-confidence patterns the bookkeeper
// could codify as a conditional rule. Run on-demand when the
// Rules page mounts (5-min staleTime in the hook); cheap enough
// at the small bookkeeper-tenant scale and avoids introducing
// a background job.
//
// Detection thresholds (plan §D2): timesConfirmed >= 5 AND
// override_rate < 10%, AND no existing conditional rule already
// matches the same payee pattern.

const MIN_TIMES_CONFIRMED = 5;
const MAX_OVERRIDE_RATE = 0.10;

export interface RuleSuggestion {
  payeePattern: string;
  accountId: string;
  accountName: string;
  timesConfirmed: number;
  overrideRate: number;
  // Pre-built rule body the UI can POST as-is to create the
  // rule (or send through the builder modal as a starting point).
  proposedRule: {
    name: string;
    conditions: {
      type: 'leaf';
      field: 'descriptor';
      operator: 'contains';
      value: string;
    };
    actions: Array<{ type: 'set_account'; accountId: string }>;
  };
}

export async function detectSuggestions(tenantId: string): Promise<RuleSuggestion[]> {
  // Pull learning rows above the confidence threshold. The
  // override-rate gate is computed in the WHERE clause so we
  // don't need to filter twice.
  const rows = await db
    .select({
      payeePattern: categorizationHistory.payeePattern,
      accountId: categorizationHistory.accountId,
      timesConfirmed: categorizationHistory.timesConfirmed,
      timesOverridden: categorizationHistory.timesOverridden,
      accountName: accounts.name,
    })
    .from(categorizationHistory)
    .leftJoin(accounts, eq(accounts.id, categorizationHistory.accountId))
    .where(
      and(
        eq(categorizationHistory.tenantId, tenantId),
        sql`${categorizationHistory.timesConfirmed} >= ${MIN_TIMES_CONFIRMED}`,
      ),
    )
    .limit(200);

  const suggestions: RuleSuggestion[] = [];
  for (const r of rows) {
    const confirmed = r.timesConfirmed ?? 0;
    const overridden = r.timesOverridden ?? 0;
    const total = confirmed + overridden;
    const overrideRate = total === 0 ? 0 : overridden / total;
    if (overrideRate > MAX_OVERRIDE_RATE) continue;
    if (!r.payeePattern || !r.accountId) continue;

    suggestions.push({
      payeePattern: r.payeePattern,
      accountId: r.accountId,
      accountName: r.accountName ?? '(unknown account)',
      timesConfirmed: confirmed,
      overrideRate,
      proposedRule: {
        name: `Auto: ${r.payeePattern} → ${r.accountName ?? r.accountId.slice(0, 8)}`,
        conditions: {
          type: 'leaf',
          field: 'descriptor',
          operator: 'contains',
          value: r.payeePattern,
        },
        actions: [{ type: 'set_account', accountId: r.accountId }],
      },
    });
  }

  if (suggestions.length === 0) return [];

  // Drop any suggestion that overlaps an existing conditional
  // rule's descriptor-contains pattern. Naive comparison: load
  // existing rules' top-level conditions and check whether any
  // of them is a leaf with the same `value`. Doesn't catch
  // grouped/nested rules, but those are rare and the worst case
  // is a duplicate suggestion — not a correctness bug.
  const existing = await db
    .select({ conditions: conditionalRules.conditions })
    .from(conditionalRules)
    .where(eq(conditionalRules.tenantId, tenantId));
  const existingPatterns = new Set<string>();
  for (const e of existing) {
    const cond = e.conditions as { type?: string; field?: string; operator?: string; value?: unknown };
    if (cond?.type === 'leaf' && cond.field === 'descriptor' && cond.operator === 'contains') {
      existingPatterns.add(String(cond.value ?? '').toLowerCase());
    }
  }

  return suggestions.filter((s) => !existingPatterns.has(s.payeePattern.toLowerCase()));
}
