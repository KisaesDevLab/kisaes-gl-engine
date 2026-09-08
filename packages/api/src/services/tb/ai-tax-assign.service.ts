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
  accountTaxAssignments, accounts, activityUnits, companyTaxProfiles, tenantFirmAssignments,
} from '../../db/schema/index.js';
import * as aiConfigService from '../ai-config.service.js';
import * as orchestrator from '../ai-orchestrator.service.js';
import { assertCategorizationEnabled } from '../ai-categorization.service.js';
import { executeJsonWithRetry } from '../ai-providers/index.js';
import { validateModelOutput } from '../ai-providers/json-utils.js';
import { AppError } from '../../utils/errors.js';
import { log } from '../../utils/logger.js';
import { computeWorkpaper, ZERO_UUID, type TbBasis, type TbWorkpaperRow } from './balance-engine.service.js';
import { listAvailableCodes } from './assignments.service.js';
import { loadResolveContext, resolveCodeFor, sliceCarries, type AssignmentRow, type ResolveContext } from './diagnostics.service.js';
import { isBalanceSheetType } from './activity-view.service.js';
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
  // Unit mapping mode: the unit this suggestion is for (null = the
  // account-level / default-unit row) and the type to validate against.
  activityUnitId: string | null;
  activityUnitType: string;
}

// Codes the model may pick from for a run: everything (account-level
// run) or common + the target unit's activity (per-unit run).
export function candidateCodes<T extends { activityType: string }>(codes: T[], unitType: string | null): T[] {
  if (!unitType) return codes;
  return codes.filter((c) => c.activityType === 'common' || c.activityType === unitType);
}

// Work items for a run. Per-unit run: P&L rows whose slice for that
// unit carries balance and has no exact unit row (strict — the
// account-level row does not count for a non-default unit). Otherwise:
// rows with no resolvable code for their first slice (original rule).
export function unassignedRows(
  rows: TbWorkpaperRow[],
  assignments: AssignmentRow[],
  ctx: ResolveContext,
  unit: { id: string; activityType: string } | null,
  excluded: Set<string>,
): TbWorkpaperRow[] {
  return rows.filter((r) => {
    if (r.isVirtualRe || excluded.has(r.accountId)) return false;
    if (unit && unit.id !== ctx.defaultUnitId) {
      if (isBalanceSheetType(r.accountType)) return false;
      const slice = r.units.find((u) => u.unitId === unit.id);
      if (!slice || !sliceCarries(slice)) return false;
      return !assignments.some((a) => a.accountId === r.accountId && a.activityUnitId === unit.id);
    }
    return !resolveCodeFor(assignments, r.accountId, r.units[0]?.unitId ?? ZERO_UUID, ctx, r.accountType);
  });
}

// Cross-client pattern signal (6C.3): how the firm mapped similarly-
// named accounts on other entities filing the same form. Few-shot
// context only — names + codes, never balances.
async function firmPatternExamples(tenantId: string, companyId: string, returnForm: string, activityTypes: string[] | null): Promise<string[]> {
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
      ...(activityTypes ? [inArray(accountTaxAssignments.seedActivityType, activityTypes)] : []),
    ))
    .limit(50);
  return rows.filter((r) => r.code).map((r) => `"${r.name}" → ${r.code}`);
}

// Per-call batch cap: one full-book request took 55-70s of model time
// (the whole code list + every account in one generation), which sat at
// the 60s provider timeout and past the tunnel's ~100s ceiling. The
// panel loops batches instead — each call analyzes at most BATCH
// accounts and reports how many are left.
const AI_SUGGEST_BATCH = 15;

export async function suggestAssignments(
  tenantId: string,
  companyId: string,
  opts: { periodEnd: string; basis: TbBasis; excludeAccountIds?: string[]; activityUnitId?: string | null },
): Promise<{ suggestions: AiSuggestion[]; analyzedAccountIds: string[]; remaining: number }> {
  const config = await aiConfigService.getConfig();
  assertCategorizationEnabled(config);

  const available = await listAvailableCodes(tenantId, companyId);
  const ctx = await loadResolveContext(tenantId, companyId);
  // Per-unit run (unit mapping mode): only that unit's codes, only the
  // accounts lacking a row for that unit. The default unit is served by
  // the account-level row, so targeting it is an account-level run.
  let unit: { id: string; activityType: string; displayName: string } | null = null;
  if (opts.activityUnitId) {
    const [u] = await db.select().from(activityUnits)
      .where(and(eq(activityUnits.tenantId, tenantId), eq(activityUnits.companyId, companyId), eq(activityUnits.id, opts.activityUnitId)))
      .limit(1);
    if (!u || u.archivedAt) throw AppError.notFound('Activity unit not found');
    unit = { id: u.id, activityType: u.activityType, displayName: u.displayName };
  }
  const targetUnit = unit && unit.id !== ctx.defaultUnitId ? unit : null;
  const unitType = targetUnit?.activityType ?? (ctx.mode === 'unit' && ctx.defaultUnitId ? ctx.unitTypeById.get(ctx.defaultUnitId) ?? null : null);
  const wp = await computeWorkpaper(tenantId, companyId, { periodEnd: opts.periodEnd, basis: opts.basis });
  const assignments = await db.select().from(accountTaxAssignments)
    .where(and(eq(accountTaxAssignments.tenantId, tenantId), eq(accountTaxAssignments.companyId, companyId)));

  const excluded = new Set(opts.excludeAccountIds ?? []);
  const unassigned = unassignedRows(wp.rows, assignments, ctx, targetUnit, excluded);
  if (unassigned.length === 0) return { suggestions: [], analyzedAccountIds: [], remaining: 0 };
  const batch = unassigned.slice(0, AI_SUGGEST_BATCH);
  const remaining = unassigned.length - batch.length;

  // Stable context first (KV-cache reuse), untrusted names last.
  const codes = candidateCodes(available.seedCodes, unitType);
  const codeList = codes
    .map((c) => `${c.code} [${c.activityType}] — ${c.description}`)
    .join('\n');
  const examples = await firmPatternExamples(tenantId, companyId, available.returnForm, unitType ? ['common', unitType] : null);
  const accountList = batch
    .map((r) => `${r.accountId} | ${r.accountNumber ?? ''} ${r.name} | type=${r.accountType}`)
    .join('\n');
  const unitContext = targetUnit
    ? `\nActivity unit being mapped: "${targetUnit.displayName}" (${targetUnit.activityType.replace('_', ' ')}) — assign codes for this activity only.`
    : '';

  const systemPrompt = [
    `You assign U.S. tax-return line codes (form ${available.returnForm}) to general-ledger accounts for a CPA's trial balance workpaper.`,
    'Valid codes (code [activity] — description):',
    codeList,
    examples.length ? `\nHow this firm mapped similar accounts on other clients:\n${examples.join('\n')}` : '',
    unitContext,
    '\nRules: pick the single best code per account from the valid list only. Use DONOTMAP for accounts that should not flow to the return. confidence is 0-100.',
    'Reply with JSON only: {"suggestions":[{"accountId":"…","code":"…","activityType":"…","confidence":90}]}',
  ].filter(Boolean).join('\n');

  const rawConfig = await aiConfigService.getRawConfig();
  const job = await orchestrator.createJob(
    tenantId, 'categorize', 'tb_tax_assignment', companyId,
    { accounts: batch.length }, companyId,
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

    const byId = new Map(batch.map((r) => [r.accountId, r]));
    const codeMeta = new Map(codes.map((c) => [`${c.code}|${c.activityType}`, c]));
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
        activityUnitId: targetUnit?.id ?? null,
        activityUnitType: unitType ?? 'common',
      });
    }
    log.info({ component: 'tb', event: 'ai_assignment_suggested', companyId, requested: batch.length, returned: suggestions.length, remaining });
    return { suggestions, analyzedAccountIds: batch.map((r) => r.accountId), remaining };
  } catch (err) {
    if (!(err instanceof AppError)) await orchestrator.failJobTerminal(job.id, err instanceof Error ? err.message : 'unknown');
    // Provider failures (timeout/unavailable) surface as a clean 503
    // instead of an unhandled 500.
    if (err instanceof Error && /providers failed|timeout/i.test(err.message)) {
      throw new AppError(503, 'The AI provider timed out — try again in a moment', 'TB_AI_UNAVAILABLE');
    }
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
  const assignments = await db.select().from(accountTaxAssignments)
    .where(and(eq(accountTaxAssignments.tenantId, tenantId), eq(accountTaxAssignments.companyId, companyId)));
  const ctx = await loadResolveContext(tenantId, companyId);
  // Assignment fingerprint in the key so a remap invalidates the cached
  // advisory (the GL stamp alone doesn't move when codes change).
  const assignmentStamp = assignments.reduce((n, a) => Math.max(n, a.updatedAt.getTime()), 0);
  const cacheKey = `tb:aidiag:${tenantId}:${companyId}:${opts.periodEnd}:${opts.basis}:${wp.glVersionStamp}:${assignments.length}:${assignmentStamp}`;
  const hit = await tbCacheGet<{ warnings: AiDiagnostic[] }>(cacheKey);
  if (hit) return { ...hit, cached: true };

  const unitRows = await db.select({ id: activityUnits.id, name: activityUnits.displayName }).from(activityUnits)
    .where(and(eq(activityUnits.tenantId, tenantId), eq(activityUnits.companyId, companyId)));
  const unitName = new Map(unitRows.map((u) => [u.id, u.name]));
  // Effective code per row: the default bucket's code, plus per-unit
  // codes where slices resolve differently (unit rows are no longer
  // reported as UNASSIGNED).
  const codeLabel = (r: TbWorkpaperRow): string => {
    const label = (a: AssignmentRow | null) => a?.seedCode ?? (a?.firmCodeId ? 'FIRM' : 'UNASSIGNED');
    const base = label(resolveCodeFor(assignments, r.accountId, ctx.defaultUnitId ?? ZERO_UUID, ctx, r.accountType));
    const perUnit = r.units
      .filter((u) => u.unitId !== ctx.defaultUnitId && u.unitId !== ZERO_UUID && sliceCarries(u))
      .map((u) => `${unitName.get(u.unitId) ?? 'unit'}→${label(resolveCodeFor(assignments, r.accountId, u.unitId, ctx, r.accountType))}`);
    return perUnit.length ? `${base} units: ${perUnit.join(', ')}` : base;
  };

  // Prior-year comparative for tie-out variance context: the day
  // before the current fiscal-year start.
  const pyEnd = new Date(new Date(wp.fyStart + 'T00:00:00Z').getTime() - 86400000).toISOString().slice(0, 10);
  const py = await computeWorkpaper(tenantId, companyId, { periodEnd: pyEnd, basis: opts.basis });
  const pyByAccount = new Map(py.rows.map((r) => [r.accountId, r.adjusted]));

  const dataset = wp.rows.map((r) =>
    `${r.accountId} | ${r.accountNumber ?? ''} ${r.name} | ${r.accountType} | unadj=${r.unadjusted.toFixed(2)} aje=${r.aje.toFixed(2)} adj=${r.adjusted.toFixed(2)} rje=${r.taxRje.toFixed(2)} tax=${r.tax.toFixed(2)} | py_adj=${(pyByAccount.get(r.accountId) ?? 0).toFixed(2)} | code=${codeLabel(r)}`,
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
