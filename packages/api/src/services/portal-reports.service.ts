// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  reportTemplates,
  reportInstances,
  reportComments,
  reportAiSummaries,
  kpiDefinitions,
  companies,
  portalContactCompanies,
} from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import { getProviderForTenant } from './storage/storage-provider.factory.js';
import { htmlToPdf, reportHtmlTemplate } from './portal-pdf.service.js';
import {
  gatherTriad,
  computeStockKpis,
  evaluateAst,
  formatKpiValue,
  type AstNode,
} from './portal-report-evaluator.service.js';
import { resolveBlock } from './portal-report-blocks.service.js';

// VIBE_MYBOOKS_PRACTICE_BUILD_PLAN Phase 16 + 17 — Report Builder.

// 16.2 — stock KPI library. Defined here as a static catalog rather
// than per-tenant rows; tenants can add custom KPIs via the
// kpi_definitions table (16.3) which the runtime evaluator consults
// after the stock catalog.
export const STOCK_KPI_CATALOG = [
  // Liquidity
  { key: 'current_ratio', name: 'Current Ratio', category: 'liquidity', format: 'ratio',
    formula: { op: 'div', a: { type: 'category', value: 'current_asset' }, b: { type: 'category', value: 'current_liability' } } },
  { key: 'quick_ratio', name: 'Quick Ratio', category: 'liquidity', format: 'ratio',
    formula: { op: 'div', a: { type: 'category_sum', value: ['cash', 'accounts_receivable'] }, b: { type: 'category', value: 'current_liability' } } },
  { key: 'cash_runway_months', name: 'Cash Runway (months)', category: 'liquidity', format: 'days',
    formula: { op: 'div', a: { type: 'category', value: 'cash' }, b: { type: 'avg_monthly_burn' } } },
  { key: 'days_cash_on_hand', name: 'Days Cash on Hand', category: 'liquidity', format: 'days',
    formula: { op: 'div', a: { type: 'category', value: 'cash' }, b: { type: 'avg_daily_expense' } } },
  { key: 'bank_balance', name: 'Bank Balance (period end)', category: 'liquidity', format: 'currency',
    formula: { type: 'bank_balance' } },
  { key: 'cash_balance', name: 'Cash on Hand (period end)', category: 'liquidity', format: 'currency',
    formula: { type: 'cash_balance' } },
  // Profitability
  { key: 'gross_margin_pct', name: 'Gross Margin %', category: 'profitability', format: 'percent',
    formula: { op: 'div', a: { op: 'sub', a: { type: 'revenue' }, b: { type: 'cogs' } }, b: { type: 'revenue' } } },
  { key: 'operating_margin_pct', name: 'Operating Margin %', category: 'profitability', format: 'percent',
    formula: { op: 'div', a: { type: 'operating_income' }, b: { type: 'revenue' } } },
  { key: 'net_margin_pct', name: 'Net Margin %', category: 'profitability', format: 'percent',
    formula: { op: 'div', a: { type: 'net_income' }, b: { type: 'revenue' } } },
  { key: 'ebitda', name: 'EBITDA', category: 'profitability', format: 'currency',
    formula: { type: 'ebitda' } },
  // Efficiency
  { key: 'ar_days', name: 'A/R Days', category: 'efficiency', format: 'days',
    formula: { op: 'mul', a: { op: 'div', a: { type: 'ar_balance' }, b: { type: 'revenue' } }, b: { type: 'period_days' } } },
  { key: 'ap_days', name: 'A/P Days', category: 'efficiency', format: 'days',
    formula: { op: 'mul', a: { op: 'div', a: { type: 'ap_balance' }, b: { type: 'cogs' } }, b: { type: 'period_days' } } },
  { key: 'cash_conversion_cycle', name: 'Cash Conversion Cycle', category: 'efficiency', format: 'days',
    formula: { op: 'sub', a: { op: 'add', a: { kpi: 'ar_days' }, b: { kpi: 'inventory_days' } }, b: { kpi: 'ap_days' } } },
  { key: 'inventory_days', name: 'Inventory Days', category: 'efficiency', format: 'days',
    formula: { op: 'mul', a: { op: 'div', a: { type: 'inventory_balance' }, b: { type: 'cogs' } }, b: { type: 'period_days' } } },
  // Growth
  { key: 'revenue_mom', name: 'Revenue MoM %', category: 'growth', format: 'percent',
    formula: { op: 'pct_change', current: { type: 'revenue' }, prior: { type: 'revenue', period: 'prior_month' } } },
  { key: 'revenue_yoy', name: 'Revenue YoY %', category: 'growth', format: 'percent',
    formula: { op: 'pct_change', current: { type: 'revenue' }, prior: { type: 'revenue', period: 'prior_year' } } },
  { key: 'expense_yoy', name: 'Expense YoY %', category: 'growth', format: 'percent',
    formula: { op: 'pct_change', current: { type: 'expense' }, prior: { type: 'expense', period: 'prior_year' } } },
] as const;

// 16.11 — stock report templates. Three preset layouts loaded by
// importStockTemplates(tenantId) on first access. Defined as
// layout-block JSON; the renderer consumes this on instance create.
export const STOCK_TEMPLATES = [
  {
    name: 'Executive Summary One-Pager',
    description: 'A single-page snapshot for monthly client meetings.',
    layout: [
      { type: 'kpi-row', kpis: ['gross_margin_pct', 'net_margin_pct', 'cash_runway_months', 'ar_days'] },
      { type: 'chart', report: 'pl_vs_prior_year' },
      { type: 'block', name: 'top_customers', topN: 5 },
      { type: 'block', name: 'top_vendors', topN: 5 },
      { type: 'ai_summary', tone: 'executive', length: 'short' },
      { type: 'text', placeholder: 'Bookkeeper notes' },
    ],
  },
  {
    name: 'Monthly KPI Dashboard',
    description: 'Detailed KPI dashboard with trend graphs.',
    layout: [
      { type: 'kpi-row', kpis: ['current_ratio', 'quick_ratio', 'days_cash_on_hand', 'cash_runway_months'] },
      { type: 'kpi-row', kpis: ['gross_margin_pct', 'operating_margin_pct', 'net_margin_pct', 'ebitda'] },
      { type: 'chart', report: 'revenue_trend_12m' },
      { type: 'chart', report: 'expense_trend_12m' },
    ],
  },
  {
    name: 'Quarterly Advisory Pack',
    description: 'Long-form advisory packet — ideal for board reviews.',
    layout: [
      { type: 'kpi-row', kpis: ['revenue_yoy', 'expense_yoy', 'gross_margin_pct', 'net_margin_pct'] },
      { type: 'chart', report: 'pl_vs_prior_year' },
      { type: 'block', name: 'ar_aging' },
      { type: 'block', name: 'ap_aging' },
      { type: 'report', key: 'profit_loss' },
      { type: 'report', key: 'balance_sheet' },
      { type: 'ai_summary', tone: 'formal', length: 'long' },
    ],
  },
] as const;

// ── Templates CRUD ───────────────────────────────────────────────

export interface CreateTemplateInput {
  name: string;
  description?: string;
  layout?: unknown[];
  theme?: Record<string, unknown>;
  defaultPeriod?: string;
  isPracticeTemplate?: boolean;
}

export async function listTemplates(tenantId: string) {
  return db
    .select()
    .from(reportTemplates)
    .where(eq(reportTemplates.tenantId, tenantId))
    .orderBy(reportTemplates.name);
}

export async function createTemplate(
  tenantId: string,
  bookkeeperUserId: string,
  input: CreateTemplateInput,
): Promise<{ id: string }> {
  if (!input.name?.trim()) throw AppError.badRequest('Name required');
  const inserted = await db
    .insert(reportTemplates)
    .values({
      tenantId,
      name: input.name.trim(),
      description: input.description ?? null,
      layoutJsonb: (input.layout ?? []) as never,
      themeJsonb: (input.theme ?? {}) as never,
      defaultPeriod: input.defaultPeriod ?? 'this_month',
      isPracticeTemplate: input.isPracticeTemplate ?? true,
      createdBy: bookkeeperUserId,
    })
    .returning({ id: reportTemplates.id });
  const row = inserted[0];
  if (!row) throw AppError.badRequest('Insert failed');
  await auditLog(tenantId, 'create', 'report_template', row.id, null, input, bookkeeperUserId);
  return { id: row.id };
}

export async function updateTemplate(
  tenantId: string,
  id: string,
  bookkeeperUserId: string,
  input: Partial<CreateTemplateInput>,
): Promise<void> {
  const before = await db.query.reportTemplates.findFirst({
    where: and(eq(reportTemplates.tenantId, tenantId), eq(reportTemplates.id, id)),
  });
  if (!before) throw AppError.notFound('Template not found');
  const patch: {
    name?: string;
    description?: string | null;
    layoutJsonb?: unknown[];
    themeJsonb?: Record<string, unknown>;
    defaultPeriod?: string;
    updatedAt: Date;
  } = { updatedAt: new Date() };
  if (input.name !== undefined) patch.name = input.name.trim();
  if (input.description !== undefined) patch.description = input.description;
  if (input.layout !== undefined) patch.layoutJsonb = input.layout;
  if (input.theme !== undefined) patch.themeJsonb = input.theme;
  if (input.defaultPeriod !== undefined) patch.defaultPeriod = input.defaultPeriod;
  await db.update(reportTemplates).set(patch as never).where(eq(reportTemplates.id, id));
  await auditLog(tenantId, 'update', 'report_template', id, before, patch, bookkeeperUserId);
}

export async function deleteTemplate(
  tenantId: string,
  id: string,
  bookkeeperUserId: string,
): Promise<void> {
  const before = await db.query.reportTemplates.findFirst({
    where: and(eq(reportTemplates.tenantId, tenantId), eq(reportTemplates.id, id)),
  });
  if (!before) throw AppError.notFound('Template not found');
  // Detach instances rather than cascade-delete — published reports
  // outlive their template (FK is ON DELETE SET NULL).
  await db.delete(reportTemplates).where(eq(reportTemplates.id, id));
  await auditLog(tenantId, 'delete', 'report_template', id, before, null, bookkeeperUserId);
}

export async function importStockTemplates(
  tenantId: string,
  bookkeeperUserId: string,
): Promise<{ created: number }> {
  let created = 0;
  for (const t of STOCK_TEMPLATES) {
    const existing = await db.query.reportTemplates.findFirst({
      where: and(eq(reportTemplates.tenantId, tenantId), eq(reportTemplates.name, t.name)),
    });
    if (existing) continue;
    await db.insert(reportTemplates).values({
      tenantId,
      name: t.name,
      description: t.description,
      layoutJsonb: t.layout as never,
      isPracticeTemplate: true,
      createdBy: bookkeeperUserId,
    });
    created++;
  }
  return { created };
}

// ── Instances ────────────────────────────────────────────────────

export interface CreateInstanceInput {
  templateId?: string | null;
  companyId: string;
  periodStart: string;
  periodEnd: string;
}

function validatePeriod(start: string, end: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    throw AppError.badRequest('Period must be YYYY-MM-DD', 'BAD_PERIOD');
  }
  if (start > end) {
    throw AppError.badRequest('Period start must be on or before period end', 'BAD_PERIOD');
  }
}

export async function createInstance(
  tenantId: string,
  bookkeeperUserId: string,
  input: CreateInstanceInput,
): Promise<{ id: string }> {
  validatePeriod(input.periodStart, input.periodEnd);
  const co = await db.query.companies.findFirst({
    where: and(eq(companies.tenantId, tenantId), eq(companies.id, input.companyId)),
  });
  if (!co) throw AppError.notFound('Company not found');

  let layoutSnapshot: unknown[] = [];
  if (input.templateId) {
    const tpl = await db.query.reportTemplates.findFirst({
      where: and(eq(reportTemplates.tenantId, tenantId), eq(reportTemplates.id, input.templateId)),
    });
    if (!tpl) throw AppError.notFound('Template not found');
    layoutSnapshot = Array.isArray(tpl.layoutJsonb) ? (tpl.layoutJsonb as unknown[]) : [];
  }

  const inserted = await db
    .insert(reportInstances)
    .values({
      tenantId,
      templateId: input.templateId ?? null,
      companyId: input.companyId,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      status: 'draft',
      layoutSnapshotJsonb: layoutSnapshot as never,
      createdBy: bookkeeperUserId,
    })
    .returning({ id: reportInstances.id });
  const row = inserted[0];
  if (!row) throw AppError.badRequest('Insert failed');
  await auditLog(tenantId, 'create', 'report_instance', row.id, null, input, bookkeeperUserId);

  // Auto-populate the data snapshot if the layout has any KPI rows.
  // Best-effort — don't fail the create if compute throws (e.g. brand
  // new tenant with no posted txns).
  if (layoutSnapshot.length > 0) {
    try {
      await computeInstancePlaceholder(tenantId, row.id, bookkeeperUserId);
    } catch {
      // swallow — caller can still hit Recompute manually
    }
  }
  return { id: row.id };
}

export interface UpdateInstanceInput {
  periodStart?: string;
  periodEnd?: string;
  templateId?: string | null;
}

export async function updateInstance(
  tenantId: string,
  id: string,
  bookkeeperUserId: string,
  input: UpdateInstanceInput,
): Promise<void> {
  const before = await getInstance(tenantId, id);
  // Don't allow editing published reports — those are the legal record
  // shared with the client. Bookkeeper must duplicate for revisions.
  if (before.status === 'published') {
    throw AppError.badRequest(
      'Published reports cannot be edited. Use Duplicate to start a new version.',
      'PUBLISHED_LOCKED',
    );
  }
  const nextStart = input.periodStart ?? before.periodStart;
  const nextEnd = input.periodEnd ?? before.periodEnd;
  validatePeriod(nextStart, nextEnd);

  const patch: Partial<typeof before> = {};
  if (input.periodStart !== undefined) patch.periodStart = input.periodStart;
  if (input.periodEnd !== undefined) patch.periodEnd = input.periodEnd;
  let templateChanged = false;
  if (input.templateId !== undefined && input.templateId !== before.templateId) {
    templateChanged = true;
    if (input.templateId) {
      const tpl = await db.query.reportTemplates.findFirst({
        where: and(eq(reportTemplates.tenantId, tenantId), eq(reportTemplates.id, input.templateId)),
      });
      if (!tpl) throw AppError.notFound('Template not found');
      // Re-snapshot the layout so a subsequent template edit doesn't
      // retroactively reshape this draft instance.
      patch.templateId = input.templateId;
      patch.layoutSnapshotJsonb = Array.isArray(tpl.layoutJsonb)
        ? (tpl.layoutJsonb as unknown[])
        : [];
    } else {
      patch.templateId = null;
      patch.layoutSnapshotJsonb = [];
    }
    // Clear stale data — the prior snapshot's KPI keys may no longer
    // match the new layout. Manual overrides in kpi_overrides also
    // wiped, since they referenced the old template's KPIs.
    patch.dataSnapshotJsonb = {};
  }

  if (Object.keys(patch).length === 0) return;
  await db.update(reportInstances).set(patch).where(eq(reportInstances.id, id));
  await auditLog(tenantId, 'update', 'report_instance', id, before, patch, bookkeeperUserId);

  // If period or template changed, recompute against the new context
  // so the Preview shows fresh numbers immediately.
  if (templateChanged || input.periodStart !== undefined || input.periodEnd !== undefined) {
    try {
      await computeInstancePlaceholder(tenantId, id, bookkeeperUserId);
    } catch {
      // swallow — Preview's Recompute button is still available
    }
  }
}

export async function deleteInstance(
  tenantId: string,
  id: string,
  bookkeeperUserId: string,
  force: boolean = false,
): Promise<void> {
  const before = await getInstance(tenantId, id);
  // Soft guard: published reports archive instead of delete unless
  // the bookkeeper explicitly forces (separate confirmation in the UI).
  if (before.status === 'published' && !force) {
    throw AppError.badRequest(
      'Published reports cannot be deleted without confirmation. Archive instead, or pass force=true.',
      'PUBLISHED_LOCKED',
    );
  }
  await db.delete(reportInstances).where(eq(reportInstances.id, id));
  await auditLog(tenantId, 'delete', 'report_instance', id, before, null, bookkeeperUserId);
}

export async function listInstances(tenantId: string, companyId?: string) {
  const filters: ReturnType<typeof eq>[] = [eq(reportInstances.tenantId, tenantId)];
  if (companyId) filters.push(eq(reportInstances.companyId, companyId));
  return db
    .select()
    .from(reportInstances)
    .where(and(...filters))
    .orderBy(desc(reportInstances.createdAt));
}

export async function getInstance(tenantId: string, id: string) {
  const inst = await db.query.reportInstances.findFirst({
    where: and(eq(reportInstances.tenantId, tenantId), eq(reportInstances.id, id)),
  });
  if (!inst) throw AppError.notFound('Instance not found');
  return inst;
}

// 17.1 — generate (snapshot data). The actual KPI evaluator is a
// separate concern — this endpoint stores whatever data the caller
// has computed (or an empty object). Phase 17 wires PDF rendering.
export async function generateInstance(
  tenantId: string,
  id: string,
  bookkeeperUserId: string,
  data: Record<string, unknown>,
): Promise<void> {
  const before = await getInstance(tenantId, id);
  await db
    .update(reportInstances)
    .set({ dataSnapshotJsonb: data as never })
    .where(eq(reportInstances.id, id));
  await auditLog(tenantId, 'update', 'report_instance_data', id, before, { keys: Object.keys(data) }, bookkeeperUserId);
}

// Compute a real data snapshot from the company's books. Walks the
// layout to collect every KPI key, runs the stock evaluator against
// the period, and writes the formatted strings into
// dataSnapshotJsonb.kpis. Manual KPI overrides + ai_summary +
// per-block text overrides set previously are preserved.
export async function computeInstancePlaceholder(
  tenantId: string,
  id: string,
  bookkeeperUserId: string,
): Promise<{ keys: string[]; metricsAvailable: boolean; error: string | null }> {
  const before = await getInstance(tenantId, id);
  if (before.status === 'published') {
    throw AppError.badRequest(
      'Published reports cannot be recomputed. Use Duplicate to start a new version.',
      'PUBLISHED_LOCKED',
    );
  }
  const layout = Array.isArray(before.layoutSnapshotJsonb)
    ? (before.layoutSnapshotJsonb as Array<Record<string, unknown>>)
    : [];

  // Gather requested KPI keys from every kpi-row block.
  const requested = new Set<string>();
  for (const block of layout) {
    if (block['type'] === 'kpi-row') {
      const keys = (block['kpis'] as string[]) ?? [];
      keys.forEach((k) => requested.add(k));
    }
  }

  let computed: Record<string, string> = {};
  let metricsAvailable = true;
  let evalError: string | null = null;
  // Triad is shared between the KPI evaluator and the block resolver
  // so prior-period metrics aren't re-fetched.
  let triad: Awaited<ReturnType<typeof gatherTriad>> | null = null;
  if (requested.size > 0) {
    try {
      triad = await gatherTriad(
        tenantId,
        before.companyId,
        before.periodStart,
        before.periodEnd,
      );
      // Resolve stock first (with prior-period support for YoY/MoM).
      const stockKeys = [...requested].filter((k) =>
        STOCK_KPI_CATALOG.some((s) => s.key === k),
      );
      const stockOut = computeStockKpis(triad, stockKeys);
      computed = { ...stockOut };

      // Resolve custom KPIs by AST evaluation against this tenant.
      const customKeys = [...requested].filter((k) => !computed[k]);
      if (customKeys.length > 0) {
        const customDefs = await db
          .select()
          .from(kpiDefinitions)
          .where(eq(kpiDefinitions.tenantId, tenantId));
        const m = triad.current;
        // Pre-resolve stock numerics so kpi-ref nodes work.
        const resolvedKpis: Record<string, number> = {};
        resolvedKpis['gross_margin_pct'] = m.revenue === 0 ? NaN : m.grossProfit / m.revenue;
        resolvedKpis['operating_margin_pct'] = m.revenue === 0 ? NaN : m.operatingIncome / m.revenue;
        resolvedKpis['net_margin_pct'] = m.revenue === 0 ? NaN : m.netIncome / m.revenue;
        resolvedKpis['current_ratio'] = m.currentLiabilities === 0 ? NaN : m.currentAssets / m.currentLiabilities;
        resolvedKpis['ar_days'] = m.revenue === 0 ? NaN : (m.accountsReceivable / m.revenue) * m.periodDays;
        resolvedKpis['ap_days'] = m.cogs > 0
          ? (m.accountsPayable / m.cogs) * m.periodDays
          : NaN;
        resolvedKpis['inventory_days'] = m.cogs > 0
          ? (m.inventory / m.cogs) * m.periodDays
          : NaN;

        for (const k of customKeys) {
          const def = customDefs.find((d) => d.key === k);
          if (!def) {
            computed[k] = '—';
            continue;
          }
          const raw = evaluateAst(def.formulaJsonb as AstNode, {
            current: m,
            priorMonth: triad.priorMonth,
            priorYear: triad.priorYear,
            resolvedKpis,
          });
          computed[k] = formatKpiValue(raw, def.format as 'currency' | 'percent' | 'ratio' | 'days');
          resolvedKpis[k] = raw;
        }
      }
    } catch (err) {
      metricsAvailable = false;
      evalError = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error('[report-evaluator] gatherTriad/computeKpis failed', err);
      for (const k of requested) computed[k] = '—';
    }
  }

  // Resolve data blocks (top_customers, ar_aging, etc.) so the
  // renderer paints real content instead of just block names. Each
  // resolution is best-effort — a failed block doesn't fail the
  // whole compute.
  const blockResults: Record<string, unknown> = {};
  for (const block of layout) {
    const t = block['type'];
    if (t === 'block' || t === 'chart' || t === 'report') {
      const blockId =
        (block['id'] as string | undefined) ??
        (block['name'] as string | undefined) ??
        (block['report'] as string | undefined) ??
        (block['key'] as string | undefined) ??
        'unknown';
      try {
        const payload = await resolveBlock(block, {
          tenantId,
          companyId: before.companyId,
          startDate: before.periodStart,
          endDate: before.periodEnd,
          triad: triad ?? undefined,
        });
        blockResults[blockId] = payload;
      } catch (err) {
        blockResults[blockId] = {
          type: String(t ?? ''),
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
  }

  // Preserve manual overrides + non-KPI bits the bookkeeper edited.
  const existingData =
    typeof before.dataSnapshotJsonb === 'object' && before.dataSnapshotJsonb
      ? (before.dataSnapshotJsonb as Record<string, unknown>)
      : {};
  const overrides = (existingData['kpi_overrides'] as Record<string, string> | undefined) ?? {};

  const kpis: Record<string, string> = { ...computed };
  for (const [k, v] of Object.entries(overrides)) {
    if (requested.has(k)) kpis[k] = v;
  }

  // Friendly display names (stock + custom). Renderers use these so
  // the portal shows "Gross Margin %" instead of "gross_margin_pct".
  const kpiNames: Record<string, string> = {};
  for (const k of requested) {
    const stock = STOCK_KPI_CATALOG.find((s) => s.key === k);
    if (stock) kpiNames[k] = stock.name;
  }
  const customKeysToName = [...requested].filter((k) => !kpiNames[k]);
  if (customKeysToName.length > 0) {
    const defs = await db
      .select({ key: kpiDefinitions.key, name: kpiDefinitions.name })
      .from(kpiDefinitions)
      .where(eq(kpiDefinitions.tenantId, tenantId));
    for (const d of defs) {
      if (requested.has(d.key)) kpiNames[d.key] = d.name;
    }
  }

  const data: Record<string, unknown> = {
    ...existingData,
    kpis,
    kpi_names: kpiNames,
    blocks: blockResults,
  };
  if (!('ai_summary' in data)) {
    data['ai_summary'] = '';
  }

  await db
    .update(reportInstances)
    .set({ dataSnapshotJsonb: data as never })
    .where(eq(reportInstances.id, id));
  await auditLog(
    tenantId,
    'update',
    'report_instance_data_compute',
    id,
    null,
    { keys: [...requested], metricsAvailable, error: evalError },
    bookkeeperUserId,
  );
  return { keys: [...requested], metricsAvailable, error: evalError };
}

// Partial-update for inline edits: KPI overrides, AI summary, and
// per-block text overrides. Each call merges into the existing
// snapshot so the bookkeeper can edit one tile without losing the rest.
export interface PatchSnapshotInput {
  kpiOverrides?: Record<string, string>;
  aiSummary?: string;
  textOverrides?: Record<string, string>; // keyed by block index
}

export async function patchSnapshot(
  tenantId: string,
  id: string,
  bookkeeperUserId: string,
  input: PatchSnapshotInput,
): Promise<{ data: Record<string, unknown> }> {
  const before = await getInstance(tenantId, id);
  if (before.status === 'published') {
    throw AppError.badRequest(
      'Published reports cannot be edited. Archive and re-publish.',
      'PUBLISHED_LOCKED',
    );
  }
  const existing =
    typeof before.dataSnapshotJsonb === 'object' && before.dataSnapshotJsonb
      ? { ...(before.dataSnapshotJsonb as Record<string, unknown>) }
      : {};
  const kpis = { ...((existing['kpis'] as Record<string, string> | undefined) ?? {}) };
  const overrides = { ...((existing['kpi_overrides'] as Record<string, string> | undefined) ?? {}) };
  const textOverrides = { ...((existing['text_overrides'] as Record<string, string> | undefined) ?? {}) };

  if (input.kpiOverrides) {
    for (const [k, v] of Object.entries(input.kpiOverrides)) {
      overrides[k] = v;
      kpis[k] = v; // surface immediately so the renderer reflects the override
    }
  }
  if (input.textOverrides) {
    for (const [k, v] of Object.entries(input.textOverrides)) {
      textOverrides[k] = v;
    }
  }
  if (input.aiSummary !== undefined) {
    existing['ai_summary'] = input.aiSummary;
  }

  existing['kpis'] = kpis;
  existing['kpi_overrides'] = overrides;
  existing['text_overrides'] = textOverrides;

  await db
    .update(reportInstances)
    .set({ dataSnapshotJsonb: existing as never })
    .where(eq(reportInstances.id, id));
  await auditLog(
    tenantId,
    'update',
    'report_instance_data_patch',
    id,
    null,
    {
      kpiKeys: Object.keys(input.kpiOverrides ?? {}),
      aiSummaryEdited: input.aiSummary !== undefined,
      textBlocksEdited: Object.keys(input.textOverrides ?? {}),
    },
    bookkeeperUserId,
  );
  return { data: existing };
}

export interface SetStatusResult {
  ok: true;
  pdfRendered: boolean;
  pdfError: string | null;
  version: number;
}

export async function setStatus(
  tenantId: string,
  id: string,
  bookkeeperUserId: string,
  status: 'draft' | 'review' | 'published' | 'archived',
): Promise<SetStatusResult> {
  const before = await getInstance(tenantId, id);
  const patch: {
    status: typeof status;
    publishedAt?: Date;
    pdfUrl?: string | null;
    version?: number;
  } = { status };
  let pdfRendered = false;
  let pdfError: string | null = null;
  let nextVersion = before.version;

  // Refuse the no-op transition that would otherwise re-stamp publishedAt.
  if (before.status === status) {
    return { ok: true, pdfRendered: false, pdfError: null, version: before.version };
  }

  if (status === 'published') {
    patch.publishedAt = new Date();
    // If this is a republish (archived → published), bump the version
    // so the new artifact is distinct from the prior one.
    if (before.publishedAt) {
      nextVersion = before.version + 1;
      patch.version = nextVersion;
    }
    // Render PDF every publish (first or re-publish). The artifact
    // freezes the *current* layoutSnapshot + dataSnapshot, so the
    // bookkeeper's edits land in the file the client downloads.
    try {
      const co = await db.query.companies.findFirst({
        where: eq(companies.id, before.companyId),
      });
      const tpl = before.templateId
        ? await db.query.reportTemplates.findFirst({
            where: eq(reportTemplates.id, before.templateId),
          })
        : null;
      const theme =
        tpl && typeof tpl.themeJsonb === 'object' && tpl.themeJsonb
          ? (tpl.themeJsonb as Record<string, unknown>)
          : {};
      const html = reportHtmlTemplate({
        companyName: co?.businessName ?? '—',
        templateName: tpl?.name ?? 'Report',
        periodStart: before.periodStart,
        periodEnd: before.periodEnd,
        layout: Array.isArray(before.layoutSnapshotJsonb)
          ? (before.layoutSnapshotJsonb as unknown[])
          : [],
        data:
          typeof before.dataSnapshotJsonb === 'object' && before.dataSnapshotJsonb
            ? (before.dataSnapshotJsonb as Record<string, unknown>)
            : {},
        publishedAt: patch.publishedAt!,
        theme,
      });
      const pdfBuf = await htmlToPdf(html);
      const provider = await getProviderForTenant(tenantId);
      const key = `reports/${tenantId}/${id}-v${nextVersion}.pdf`;
      await provider.upload(key, pdfBuf, {
        fileName: `report-${nextVersion}.pdf`,
        mimeType: 'application/pdf',
        sizeBytes: pdfBuf.length,
      });
      patch.pdfUrl = key;
      pdfRendered = true;
    } catch (err) {
      pdfError = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error('[report-publish] PDF render failed', err);
      // Don't block publish — bookkeeper sees the warning in the
      // response and can hit Publish again.
    }
  }
  await db.update(reportInstances).set(patch).where(eq(reportInstances.id, id));
  await auditLog(
    tenantId,
    'update',
    'report_instance_status',
    id,
    before,
    { ...patch, pdfRendered, pdfError },
    bookkeeperUserId,
  );
  return { ok: true, pdfRendered, pdfError, version: nextVersion };
}

// 17.2 comments — tenant-scoped via the parent instance lookup so a
// caller with a guessed instanceId from another tenant gets 404.
export async function addComment(
  tenantId: string,
  instanceId: string,
  authorId: string,
  body: string,
  blockRef?: string,
): Promise<{ id: string }> {
  await getInstance(tenantId, instanceId);
  const inserted = await db
    .insert(reportComments)
    .values({
      instanceId,
      authorId,
      body: body.trim(),
      blockRef: blockRef ?? null,
    })
    .returning({ id: reportComments.id });
  const row = inserted[0];
  if (!row) throw AppError.badRequest('Insert failed');
  return { id: row.id };
}

export async function listComments(tenantId: string, instanceId: string) {
  await getInstance(tenantId, instanceId);
  return db
    .select()
    .from(reportComments)
    .where(eq(reportComments.instanceId, instanceId))
    .orderBy(reportComments.createdAt);
}

// 17.4 — portal financials. Returns published instances visible to
// the contact (financials_access=true on their company link).
export async function listPublishedForContact(args: {
  tenantId: string;
  contactId: string;
  companyId: string;
}) {
  const link = await db
    .select()
    .from(portalContactCompanies)
    .where(
      and(
        eq(portalContactCompanies.contactId, args.contactId),
        eq(portalContactCompanies.companyId, args.companyId),
      ),
    )
    .limit(1);
  if (link.length === 0) {
    throw AppError.forbidden('Contact is not linked to this company');
  }
  if (!link[0]?.financialsAccess) {
    throw AppError.forbidden('Financial reports are not enabled for your account');
  }

  return db
    .select({
      id: reportInstances.id,
      periodStart: reportInstances.periodStart,
      periodEnd: reportInstances.periodEnd,
      publishedAt: reportInstances.publishedAt,
      version: reportInstances.version,
      pdfUrl: reportInstances.pdfUrl,
      // The portal-side renderer reads the data snapshot directly
      // (Double model — no transaction-level detail). Including the
      // snapshot in the list response is OK because the data is
      // already filtered to the published period.
      data: reportInstances.dataSnapshotJsonb,
      layout: reportInstances.layoutSnapshotJsonb,
    })
    .from(reportInstances)
    .where(
      and(
        eq(reportInstances.tenantId, args.tenantId),
        eq(reportInstances.companyId, args.companyId),
        eq(reportInstances.status, 'published'),
      ),
    )
    .orderBy(desc(reportInstances.publishedAt));
}

// 16.8 — AI summary CRUD. Upsert-by-(instance, blockRef) so repeated
// regenerations replace the prior row instead of accumulating.
// Tenant-scoped via the parent instance lookup.
export async function saveAiSummary(
  tenantId: string,
  instanceId: string,
  text: string,
  modelUsed?: string,
  blockRef?: string,
): Promise<{ id: string }> {
  await getInstance(tenantId, instanceId);
  const ref = blockRef ?? null;
  // Find existing for the same (instance, blockRef) and overwrite.
  const existing = await db
    .select({ id: reportAiSummaries.id })
    .from(reportAiSummaries)
    .where(
      and(
        eq(reportAiSummaries.instanceId, instanceId),
        ref === null
          ? sql`${reportAiSummaries.blockRef} IS NULL`
          : eq(reportAiSummaries.blockRef, ref),
      ),
    )
    .limit(1);
  if (existing.length > 0 && existing[0]) {
    await db
      .update(reportAiSummaries)
      .set({
        generatedText: text,
        modelUsed: modelUsed ?? null,
        generatedAt: new Date(),
      })
      .where(eq(reportAiSummaries.id, existing[0].id));
    return { id: existing[0].id };
  }
  const inserted = await db
    .insert(reportAiSummaries)
    .values({
      instanceId,
      blockRef: ref,
      generatedText: text,
      modelUsed: modelUsed ?? null,
    })
    .returning({ id: reportAiSummaries.id });
  const row = inserted[0];
  if (!row) throw AppError.badRequest('Insert failed');
  return { id: row.id };
}

// Duplicate an instance — used for "I want a new version after
// publishing." Copies layout, data snapshot, template ref, and bumps
// version. New instance starts in draft so the bookkeeper can edit
// it freely without affecting the published artifact.
export async function duplicateInstance(
  tenantId: string,
  id: string,
  bookkeeperUserId: string,
): Promise<{ id: string; version: number }> {
  const before = await getInstance(tenantId, id);
  const inserted = await db
    .insert(reportInstances)
    .values({
      tenantId,
      templateId: before.templateId,
      companyId: before.companyId,
      periodStart: before.periodStart,
      periodEnd: before.periodEnd,
      status: 'draft',
      layoutSnapshotJsonb: (before.layoutSnapshotJsonb ?? []) as never,
      dataSnapshotJsonb: (before.dataSnapshotJsonb ?? {}) as never,
      version: before.version + 1,
      createdBy: bookkeeperUserId,
    })
    .returning({ id: reportInstances.id });
  const row = inserted[0];
  if (!row) throw AppError.badRequest('Insert failed');
  await auditLog(
    tenantId,
    'create',
    'report_instance',
    row.id,
    null,
    { duplicateOf: id, version: before.version + 1 },
    bookkeeperUserId,
  );
  return { id: row.id, version: before.version + 1 };
}

// Resolve a published instance's PDF from storage. Returns the
// buffer + filename; caller streams to the client. Tenant-scoped
// via getInstance + ownership check (the contact/staff caller must
// already have proven access to the instance).
export async function downloadInstancePdf(
  tenantId: string,
  id: string,
): Promise<{ buffer: Buffer; filename: string } | null> {
  const inst = await getInstance(tenantId, id);
  if (!inst.pdfUrl) return null;
  const provider = await getProviderForTenant(tenantId);
  const buffer = await provider.download(inst.pdfUrl);
  const filename = `report-v${inst.version}-${inst.periodEnd}.pdf`;
  return { buffer, filename };
}

// 16.3 — custom KPI CRUD against the kpi_definitions table. Custom
// KPIs share the same shape as stock entries so the layout editor
// + evaluator + renderers treat them uniformly.

export interface CustomKpiInput {
  key: string;
  name: string;
  category?: string;
  format: 'currency' | 'percent' | 'ratio' | 'days';
  formula: unknown; // AST shape — validated at evaluation time
  threshold?: unknown;
}

const KEY_RE = /^[a-z][a-z0-9_]{0,79}$/;

export async function listCustomKpis(tenantId: string) {
  return db
    .select()
    .from(kpiDefinitions)
    .where(eq(kpiDefinitions.tenantId, tenantId))
    .orderBy(kpiDefinitions.name);
}

export async function createCustomKpi(
  tenantId: string,
  bookkeeperUserId: string,
  input: CustomKpiInput,
): Promise<{ id: string }> {
  if (!input.key || !KEY_RE.test(input.key)) {
    throw AppError.badRequest(
      'Key must start with a letter and contain only lowercase letters, numbers, underscores (max 80)',
      'BAD_KEY',
    );
  }
  if (STOCK_KPI_CATALOG.some((k) => k.key === input.key)) {
    throw AppError.conflict(
      `Key "${input.key}" collides with a stock KPI. Pick a different key.`,
      'STOCK_KEY_COLLISION',
    );
  }
  if (!input.name?.trim()) throw AppError.badRequest('Name required');
  // Reject duplicate key within tenant.
  const existing = await db
    .select({ id: kpiDefinitions.id })
    .from(kpiDefinitions)
    .where(and(eq(kpiDefinitions.tenantId, tenantId), eq(kpiDefinitions.key, input.key)))
    .limit(1);
  if (existing.length > 0) {
    throw AppError.conflict(`A custom KPI with key "${input.key}" already exists`, 'DUP_KEY');
  }
  const inserted = await db
    .insert(kpiDefinitions)
    .values({
      tenantId,
      key: input.key,
      name: input.name.trim(),
      category: input.category?.trim() || 'custom',
      format: input.format,
      formulaJsonb: input.formula as never,
      thresholdJsonb: (input.threshold ?? null) as never,
    })
    .returning({ id: kpiDefinitions.id });
  const row = inserted[0];
  if (!row) throw AppError.badRequest('Insert failed');
  await auditLog(tenantId, 'create', 'kpi_definition', row.id, null, input, bookkeeperUserId);
  return { id: row.id };
}

export async function updateCustomKpi(
  tenantId: string,
  id: string,
  bookkeeperUserId: string,
  input: Partial<CustomKpiInput>,
): Promise<void> {
  const before = await db.query.kpiDefinitions.findFirst({
    where: and(eq(kpiDefinitions.tenantId, tenantId), eq(kpiDefinitions.id, id)),
  });
  if (!before) throw AppError.notFound('Custom KPI not found');
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (input.name !== undefined) patch['name'] = input.name.trim();
  if (input.category !== undefined) patch['category'] = input.category.trim() || 'custom';
  if (input.format !== undefined) patch['format'] = input.format;
  if (input.formula !== undefined) patch['formulaJsonb'] = input.formula;
  if (input.threshold !== undefined) patch['thresholdJsonb'] = input.threshold;
  // Key changes are explicitly rejected — the layout snapshots that
  // reference this KPI would break silently.
  if (input.key !== undefined && input.key !== before.key) {
    throw AppError.badRequest(
      'KPI key cannot be renamed once saved. Delete and recreate to change the key.',
      'KEY_LOCKED',
    );
  }
  await db.update(kpiDefinitions).set(patch as never).where(eq(kpiDefinitions.id, id));
  await auditLog(tenantId, 'update', 'kpi_definition', id, before, patch, bookkeeperUserId);
}

export async function deleteCustomKpi(
  tenantId: string,
  id: string,
  bookkeeperUserId: string,
): Promise<void> {
  const before = await db.query.kpiDefinitions.findFirst({
    where: and(eq(kpiDefinitions.tenantId, tenantId), eq(kpiDefinitions.id, id)),
  });
  if (!before) throw AppError.notFound('Custom KPI not found');
  await db.delete(kpiDefinitions).where(eq(kpiDefinitions.id, id));
  await auditLog(tenantId, 'delete', 'kpi_definition', id, before, null, bookkeeperUserId);
}

// Unified catalog: stock + custom. Used by the formula builder, the
// layout editor (KPI picker), and the runtime evaluator.
export interface CatalogEntry {
  key: string;
  name: string;
  category: string;
  format: 'currency' | 'percent' | 'ratio' | 'days';
  formula: unknown;
  source: 'stock' | 'custom';
  id?: string; // present only for custom (so the editor can update/delete)
}

export async function getCatalog(tenantId: string): Promise<CatalogEntry[]> {
  const stock: CatalogEntry[] = STOCK_KPI_CATALOG.map((k) => ({
    key: k.key,
    name: k.name,
    category: k.category,
    format: k.format as 'currency' | 'percent' | 'ratio' | 'days',
    formula: k.formula,
    source: 'stock' as const,
  }));
  const custom = await listCustomKpis(tenantId);
  const customEntries: CatalogEntry[] = custom.map((c) => ({
    id: c.id,
    key: c.key,
    name: c.name,
    category: c.category,
    format: c.format as 'currency' | 'percent' | 'ratio' | 'days',
    formula: c.formulaJsonb,
    source: 'custom' as const,
  }));
  return [...stock, ...customEntries];
}
