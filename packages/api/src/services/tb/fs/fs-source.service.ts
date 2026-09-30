// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Loads the engine input (FsSourceData) for one company + report settings
// from the TB balance engine. Every period is a computeWorkpaper call
// (Redis-cached by GL version stamp, rule TB1), so recomputing on each
// edit is cheap.
//
// Periods: cy (period end), cyOpen (day before FY start), and — when the
// columns need them — py / pyOpen (one year earlier) and cyPriorMonth.
// Framework 'tax' reads the Tax column for cy/py and the Adjusted (book)
// column for the openings (tax RJEs are current-year only, so beginning
// equity is book — surfaced as an info check by the engine).

import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  fsCompanyEntityKind, fsFiscalYearStart, fsPlanColumns, normalizeFsSettings,
  type FsCashFlowClass, type FsEquityRole, type FsReportSettings, type FsSourceData, type FsSourceAccount, type FsSourcePeriod,
} from '@kis-books/shared';
import { db } from '../../../db/index.js';
import { accounts, companies, fsCashFlowOverrides, tags } from '../../../db/schema/index.js';
import { AppError } from '../../../utils/errors.js';
import { computeWorkpaper, VIRTUAL_RE_ID, type TbWorkpaper } from '../balance-engine.service.js';
import { listGroupings } from '../groupings.service.js';
import { defaultEquityRole, getEquityRoles } from '../m1.service.js';

export async function loadFsSource(tenantId: string, companyId: string, rawSettings: FsReportSettings): Promise<FsSourceData> {
  const [company] = await db.select({
    name: companies.businessName, entityType: companies.entityType, fyStartMonth: companies.fiscalYearStartMonth,
  }).from(companies).where(and(eq(companies.tenantId, tenantId), eq(companies.id, companyId))).limit(1);
  if (!company) throw AppError.notFound('Company not found');
  const fyStartMonth = company.fyStartMonth ?? 1;
  const settings = normalizeFsSettings(rawSettings, fyStartMonth);

  const basis = settings.framework === 'cash' ? 'cash' : settings.bookBasis;
  const withTax = settings.framework === 'tax';
  const plan = fsPlanColumns(settings, fyStartMonth);

  // One workpaper per date the plan needs (Redis-cached by GL stamp);
  // the engine composes every range's P&L from these fiscal-YTD snapshots.
  const toPeriod = (w: TbWorkpaper): FsSourcePeriod => {
    const balances: Record<string, number> = {};
    const taxBalances: Record<string, number> = {};
    for (const r of w.rows) {
      if (r.adjusted !== 0) balances[r.accountId] = r.adjusted;
      if (withTax && r.tax !== 0) taxBalances[r.accountId] = r.tax;
    }
    return { date: w.periodEnd, fyStart: w.fyStart, balances, ...(withTax ? { taxBalances } : {}), hasData: w.rows.length > 0 };
  };
  const load = async (tagId: string | null) => {
    const out: Record<string, FsSourcePeriod> = {};
    const wps = await Promise.all(plan.workpaperDates.map((d) => computeWorkpaper(tenantId, companyId, { periodEnd: d, basis, tagId })));
    wps.forEach((w, i) => { out[plan.workpaperDates[i]!] = toPeriod(w); });
    return { out, stamp: wps[0]?.glVersionStamp ?? 0 };
  };
  const { out: workpapers, stamp } = await load(null);

  let tagged: FsSourceData['tagged'] = null;
  let tagName: string | null = null;
  if (settings.tagId) {
    const [tag] = await db.select({ name: tags.name }).from(tags)
      .where(and(eq(tags.tenantId, tenantId), eq(tags.id, settings.tagId))).limit(1);
    if (!tag) throw AppError.badRequest('Tag not found', 'TB_FS_TAG');
    tagName = tag.name;
    tagged = (await load(settings.tagId)).out;
  }

  // Accounts seen in any period (+ every company account for claims).
  const acctRows = await db.select({
    id: accounts.id, number: accounts.accountNumber, name: accounts.name, accountType: accounts.accountType,
    detailType: accounts.detailType, systemTag: accounts.systemTag,
  }).from(accounts).where(and(
    eq(accounts.tenantId, tenantId),
    sql`(${accounts.companyId} = ${companyId} OR ${accounts.companyId} IS NULL)`,
  ));
  const list: FsSourceAccount[] = acctRows.map((a) => ({
    id: a.id, number: a.number ?? null, name: a.name, accountType: a.accountType, detailType: a.detailType ?? null,
    systemTag: a.systemTag ?? null, isVirtual: false,
  }));

  const [systemRe] = await db.select({ id: accounts.id }).from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), eq(accounts.systemTag, 'retained_earnings'),
      sql`(${accounts.companyId} = ${companyId} OR ${accounts.companyId} IS NULL)`))
    .orderBy(sql`${accounts.companyId} NULLS LAST`).limit(1);
  const reAccountId = systemRe?.id ?? VIRTUAL_RE_ID;
  if (!systemRe) {
    list.push({ id: VIRTUAL_RE_ID, number: null, name: 'Retained earnings', accountType: 'equity', detailType: 'retained_earnings', systemTag: 'retained_earnings', isVirtual: true });
  }

  const { groupings } = await listGroupings(tenantId, companyId);

  const overrides = await getEquityRoles(tenantId, companyId);
  const equityRoles: Record<string, FsEquityRole> = {};
  for (const a of list) {
    if (a.accountType !== 'equity') continue;
    equityRoles[a.id] = overrides[a.id] ?? defaultEquityRole(a.name, a.detailType);
  }

  const cfRows = await db.select().from(fsCashFlowOverrides)
    .where(and(eq(fsCashFlowOverrides.tenantId, tenantId), eq(fsCashFlowOverrides.companyId, companyId)));

  return {
    companyName: company.name,
    entityKind: fsCompanyEntityKind(company.entityType),
    framework: settings.framework,
    basis,
    glVersionStamp: stamp,
    periodEnd: settings.periodEnd,
    fyStart: fsFiscalYearStart(settings.periodEnd, fyStartMonth),
    fyStartMonth,
    accounts: list,
    groupings: groupings.map((g) => ({ id: g.id, code: g.leadsheetCode ?? null, name: g.name, sortOrder: g.sortOrder, accountIds: g.accountIds })),
    workpapers,
    tagged,
    tagName,
    reAccountId,
    equityRoles,
    cashFlowOverrides: cfRows.map((r) => ({ accountId: r.accountId, groupingId: r.groupingId, classification: r.classification as FsCashFlowClass })),
  };
}

// Company accounts + groupings for editor pickers (schedule editor, CF panel).
export async function listFsAccounts(tenantId: string, companyId: string, ids?: string[]) {
  const conds = [eq(accounts.tenantId, tenantId), sql`(${accounts.companyId} = ${companyId} OR ${accounts.companyId} IS NULL)`];
  if (ids?.length) conds.push(inArray(accounts.id, ids));
  return db.select({ id: accounts.id, number: accounts.accountNumber, name: accounts.name, accountType: accounts.accountType })
    .from(accounts).where(and(...conds));
}
