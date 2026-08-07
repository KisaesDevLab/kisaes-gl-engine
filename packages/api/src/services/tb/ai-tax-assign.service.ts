// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// AI tax-code assignment + AI diagnostics (Phase 6C). Uses the shared
// multi-provider AI layer under the 'categorization' function settings
// (same governance gates: global kill switch, provider, per-function
// toggle, company consent, budget via the orchestrator job).
//
// Contract guarantees (6C.2): the prompt carries ONLY code +
// description (+ account name/type/activity context) — no vendor
// crosswalk codes, no expected balances. Suggestions NEVER auto-commit;
// the review UI accepts them explicitly (6C.4). Rule-based diagnostics
// stay authoritative for export gating; AI warnings are advisory (6C.6).

import { z } from 'zod';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import {
  accountTaxAssignments, accounts, companyTaxProfiles, tenantFirmAssignments,
} from '../../db/schema/index.js';
import * as aiConfigService from '../ai-config.service.js';
import * as orchestrator from '../ai-orchestrator.service.js';
import { assertCategorizationEnabled } from '../ai-categorization.service.js';
import { executeJsonWithRetry } from '../ai-providers/index.js';
import { validateModelOutput } from '../ai-providers/json-utils.js';
import { AppError } from '../../utils/errors.js';
import { log } from '../../utils/logger.js';
import { computeWorkpaper, type TbBasis } from './balance-engine.service.js';
import { listAvailableCodes } from './assignments.service.js';
import { resolveCodeFor } from './diagnostics.service.js';
import { tbCacheGet, tbCacheSet } from './tb-redis.js';

const suggestionSchema = z.object({
  suggestions: z.array(z.object({
    accountId: z.string(),
    code: z.string(),
    activityType: z.string().optional(),
    confidence: z.number().min(0).max(100),
  })).max(500),
});

export interface AiSuggestion {
  accountId: string;
  accountName: string;
  accountNumber: string | null;
  code: string;
  activityType: string;
  description: string;
  confidence: number;
}

// Cross-client pattern signal (6C.3): how the firm mapped similarly-
// named accounts on other entities filing the same form. Few-shot
// context only — names + codes, never balances.
async function firmPatternExamples(tenantId: string, companyId: string, returnForm: string): Promise<string[]> {
  const [firm] = await db.select({ firmId: tenantFirmAssignments.firmId }).from(tenantFirmAssignments)
    .where(eq(tenantFirmAssignments.tenantId, tenantId)).limit(1);
  const tenantScope = firm
    ? db.select({ id: tenantFirmAssignments.tenantId }).from(tenantFirmAssignments)
      .where(eq(tenantFirmAssignments.firmId, firm.firmId))
    : null;

  const rows = await db.select({
    name: accounts.name,
    code: accountTaxAssignments.seedCode,
  }).from(accountTaxAssignments)
    .innerJoin(accounts, eq(accountTaxAssignments.accountId, accounts.id))
    .innerJoin(companyTaxProfiles, eq(accountTaxAssignments.companyId, companyTaxProfiles.companyId))
    .where(and(
      tenantScope
        ? inArray(accountTaxAssignments.tenantId, tenantScope)
        : eq(accountTaxAssignments.tenantId, tenantId),
      eq(companyTaxProfiles.returnForm, returnForm),
      sql`${accountTaxAssignments.companyId} <> ${companyId}`,
      sql`${accountTaxAssignments.seedCode} IS NOT NULL`,
    ))
    .limit(50);
  return rows.filter((r) => r.code).map((r) => `"${r.name}" → ${r.code}`);
}

export async function suggestAssignments(
  tenantId: string,
  companyId: string,
  opts: { periodEnd: string; basis: TbBasis },
): Promise<{ suggestions: AiSuggestion[] }> {
  const config = await aiConfigService.getConfig();
  assertCategorizationEnabled(config);

  const available = await listAvailableCodes(tenantId, companyId);
  const wp = await computeWorkpaper(tenantId, companyId, { periodEnd: opts.periodEnd, basis: opts.basis });
  const assignments = await db.select().from(accountTaxAssignments)
    .where(and(eq(accountTaxAssignments.tenantId, tenantId), eq(accountTaxAssignments.companyId, companyId)));

  const unassigned = wp.rows.filter((r) => !r.isVirtualRe &&
    !resolveCodeFor(assignments, r.accountId, r.units[0]?.unitId ?? '00000000-0000-0000-0000-000000000000'));
  if (unassigned.length === 0) return { suggestions: [] };

  // Stable context first (KV-cache reuse), untrusted names last.
  const codeList = available.seedCodes
    .map((c) => `${c.code} [${c.activityType}] — ${c.description}`)
    .join('\n');
  const examples = await firmPatternExamples(tenantId, companyId, available.returnForm);
  const accountList = unassigned
    .map((r) => `${r.accountId} | ${r.accountNumber ?? ''} ${r.name} | type=${r.accountType}`)
    .join('\n');

  const systemPrompt = [
    `You assign U.S. tax-return line codes (form ${available.returnForm}) to general-ledger accounts for a CPA's trial balance workpaper.`,
    'Valid codes (code [activity] — description):',
    codeList,
    examples.length ? `\nHow this firm mapped similar accounts on other clients:\n${examples.join('\n')}` : '',
    '\nRules: pick the single best code per account from the valid list only. Use DONOTMAP for accounts that should not flow to the return. confidence is 0-100.',
    'Reply with JSON only: {"suggestions":[{"accountId":"…","code":"…","activityType":"…","confidence":90}]}',
  ].filter(Boolean).join('\n');

  const rawConfig = await aiConfigService.getRawConfig();
  const job = await orchestrator.createJob(
    tenantId, 'categorize', 'tb_tax_assignment', companyId,
    { accounts: unassigned.length }, companyId,
  );
  const params = aiConfigService.resolveTaskParams(config, 'categorization', { maxTokens: 4096, temperature: 0.1 });
  const exec = aiConfigService.resolveTaskExec(config, 'categorization');

  try {
    const result = await executeJsonWithRetry(
      {
        systemPrompt,
        userPrompt: `Accounts to map (id | number name | type):\n${accountList}`,
        responseFormat: 'json',
        maxTokens: params.maxTokens,
        temperature: params.temperature,
      },
      rawConfig,
      exec.fallbackChain,
      config.categorizationProvider || undefined,
      config.categorizationModel || undefined,
      exec.timeoutMs ? { timeoutMs: exec.timeoutMs } : undefined,
    );
    if (result.parseError || !result.parsed) {
      await orchestrator.failJobTerminal(job.id, result.parseError ?? 'no output');
      throw AppError.unprocessableEntity('AI returned an unusable response — try again', 'TB_AI_PARSE');
    }
    const parsed = validateModelOutput(suggestionSchema, result.parsed, 'tb tax assignment');
    await orchestrator.completeJob(job.id, result, { count: parsed.suggestions.length }, 1);

    const byId = new Map(unassigned.map((r) => [r.accountId, r]));
    const codeMeta = new Map(available.seedCodes.map((c) => [`${c.code}|${c.activityType}`, c]));
    const suggestions: AiSuggestion[] = [];
    for (const s of parsed.suggestions) {
      const row = byId.get(s.accountId);
      if (!row) continue; // hallucinated id — drop
      const meta = [...codeMeta.entries()].find(([k]) => k.startsWith(`${s.code}|`) && (!s.activityType || k === `${s.code}|${s.activityType}`));
      if (!meta) continue; // code not in the valid list — drop
      suggestions.push({
        accountId: s.accountId,
        accountName: row.name,
        accountNumber: row.accountNumber,
        code: s.code,
        activityType: meta[1].activityType,
        description: meta[1].description,
        confidence: Math.round(s.confidence),
      });
    }
    log.info({ component: 'tb', event: 'ai_assignment_suggested', companyId, requested: unassigned.length, returned: suggestions.length });
    return { suggestions };
  } catch (err) {
    if (!(err instanceof AppError)) await orchestrator.failJobTerminal(job.id, err instanceof Error ? err.message : 'unknown');
    throw err;
  }
}

// ── AI diagnostics (6C.5) — advisory warnings over the dataset ──────

const aiDiagnosticsSchema = z.object({
  warnings: z.array(z.object({
    accountId: z.string().optional(),
    title: z.string(),
    detail: z.string(),
    severity: z.enum(['info', 'warning']),
  })).max(100),
});

export type AiDiagnostic = z.infer<typeof aiDiagnosticsSchema>['warnings'][number];

export async function aiDiagnostics(
  tenantId: string,
  companyId: string,
  opts: { periodEnd: string; basis: TbBasis },
): Promise<{ warnings: AiDiagnostic[]; cached: boolean }> {
  const config = await aiConfigService.getConfig();
  assertCategorizationEnabled(config);

  const wp = await computeWorkpaper(tenantId, companyId, { periodEnd: opts.periodEnd, basis: opts.basis });
  const cacheKey = `tb:aidiag:${tenantId}:${companyId}:${opts.periodEnd}:${opts.basis}:${wp.glVersionStamp}`;
  const hit = await tbCacheGet<{ warnings: AiDiagnostic[] }>(cacheKey);
  if (hit) return { ...hit, cached: true };

  const assignments = await db.select().from(accountTaxAssignments)
    .where(and(eq(accountTaxAssignments.tenantId, tenantId), eq(accountTaxAssignments.companyId, companyId)));
  const codeByAccount = new Map(assignments.filter((a) => !a.activityUnitId).map((a) => [a.accountId, a.seedCode]));

  // Prior-year comparative for tie-out variance context: the day
  // before the current fiscal-year start.
  const pyEnd = new Date(new Date(wp.fyStart + 'T00:00:00Z').getTime() - 86400000).toISOString().slice(0, 10);
  const py = await computeWorkpaper(tenantId, companyId, { periodEnd: pyEnd, basis: opts.basis });
  const pyByAccount = new Map(py.rows.map((r) => [r.accountId, r.adjusted]));

  const dataset = wp.rows.map((r) =>
    `${r.accountId} | ${r.accountNumber ?? ''} ${r.name} | ${r.accountType} | unadj=${r.unadjusted.toFixed(2)} aje=${r.aje.toFixed(2)} adj=${r.adjusted.toFixed(2)} rje=${r.taxRje.toFixed(2)} tax=${r.tax.toFixed(2)} | py_adj=${(pyByAccount.get(r.accountId) ?? 0).toFixed(2)} | code=${codeByAccount.get(r.accountId) ?? 'UNASSIGNED'}`,
  ).join('\n');

  const systemPrompt = [
    'You are reviewing a CPA trial-balance workpaper (five columns: unadjusted, AJE, adjusted, tax RJE, tax) before tax preparation.',
    'Flag likely issues: abnormal balance signs for the account type, common tax-mapping mistakes, large unexplained prior-year variances, suspicious unassigned accounts.',
    'Be selective — only warn where a competent reviewer would pause. severity "warning" for probable errors, "info" for worth-a-look.',
    'Reply with JSON only: {"warnings":[{"accountId":"…","title":"…","detail":"…","severity":"warning"}]}',
  ].join('\n');

  const rawConfig = await aiConfigService.getRawConfig();
  const job = await orchestrator.createJob(tenantId, 'categorize', 'tb_ai_diagnostics', companyId, { rows: wp.rows.length }, companyId);
  const params = aiConfigService.resolveTaskParams(config, 'categorization', { maxTokens: 3072, temperature: 0.2 });
  const exec = aiConfigService.resolveTaskExec(config, 'categorization');
  try {
    const result = await executeJsonWithRetry(
      {
        systemPrompt,
        userPrompt: `Workpaper rows (id | number name | type | columns | prior-year adjusted | assigned code):\n${dataset}`,
        responseFormat: 'json',
        maxTokens: params.maxTokens,
        temperature: params.temperature,
      },
      rawConfig,
      exec.fallbackChain,
      config.categorizationProvider || undefined,
      config.categorizationModel || undefined,
      exec.timeoutMs ? { timeoutMs: exec.timeoutMs } : undefined,
    );
    if (result.parseError || !result.parsed) {
      await orchestrator.failJobTerminal(job.id, result.parseError ?? 'no output');
      throw AppError.unprocessableEntity('AI returned an unusable response — try again', 'TB_AI_PARSE');
    }
    const parsed = validateModelOutput(aiDiagnosticsSchema, result.parsed, 'tb ai diagnostics');
    await orchestrator.completeJob(job.id, result, { count: parsed.warnings.length }, 1);
    // Drop hallucinated account ids but keep dataset-level warnings.
    const validIds = new Set(wp.rows.map((r) => r.accountId));
    const warnings = parsed.warnings.filter((w) => !w.accountId || validIds.has(w.accountId));
    await tbCacheSet(cacheKey, { warnings });
    return { warnings, cached: false };
  } catch (err) {
    if (!(err instanceof AppError)) await orchestrator.failJobTerminal(job.id, err instanceof Error ? err.message : 'unknown');
    throw err;
  }
}
