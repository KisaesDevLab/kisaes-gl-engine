// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Monthly AI usage caps, checked before any provider call:
 *   - the dollar cap `ai_config.monthly_budget_limit` (float estimate, as
 *     before);
 *   - the integer token cap `ai_config.monthly_token_limit` (U-29).
 *
 * One function so every entry point applies both: ai-orchestrator.createJob,
 * chat.service.sendMessage, the portal report summary, and in desktop mode
 * executeWithFallback / completeVisionWithFallback themselves (so a caller
 * that bypasses createJob cannot bypass the cap). Caps are per tenant;
 * `tenantId === null` (desktop callers without a tenant) checks the sum
 * over every tenant, which is never more permissive.
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { AppError } from '../utils/errors.js';
import * as aiConfigService from './ai-config.service.js';

function monthStart(): string {
  const d = new Date();
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export async function assertWithinUsageCaps(tenantId: string | null): Promise<void> {
  const config = await aiConfigService.getConfig();
  if (config.monthlyBudgetLimit == null && config.monthlyTokenLimit == null) return;
  const since = monthStart();
  const scope = tenantId === null ? sql`` : sql`AND tenant_id = ${tenantId}`;
  const rows = await db.execute(sql`
    SELECT COALESCE(SUM(estimated_cost::numeric), 0) AS cost,
           COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)), 0)::bigint AS tokens
    FROM ai_usage_log
    WHERE created_at >= ${since} ${scope}
  `);
  const row = (rows.rows[0] ?? {}) as { cost?: string | number; tokens?: string | number };
  if (config.monthlyBudgetLimit != null) {
    const currentCost = parseFloat(String(row.cost ?? '0'));
    if (currentCost >= config.monthlyBudgetLimit) {
      throw AppError.badRequest('Monthly AI budget exceeded. Contact your administrator to increase the limit.');
    }
  }
  if (config.monthlyTokenLimit != null) {
    const usedTokens = Number(row.tokens ?? 0);
    if (usedTokens >= config.monthlyTokenLimit) {
      throw AppError.badRequest(
        'Monthly AI token limit reached. Raise the limit in the AI settings to continue.',
        'ai_token_limit_exceeded',
      );
    }
  }
}
