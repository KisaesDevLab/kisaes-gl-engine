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
  fsCompanyEntityKind, fsDayBefore, fsPriorMonthEnd, fsShiftYear,
  type FsCashFlowClass, type FsEquityRole, type FsReportSettings, type FsSourceData, type FsSourceAccount, type FsSourcePeriod,
} from '@kis-books/shared';
import { db } from '../../../db/index.js';
import { accounts, companies, fsCashFlowOverrides, tags } from '../../../db/schema/index.js';
import { AppError } from '../../../utils/errors.js';
import { computeWorkpaper, VIRTUAL_RE_ID, type TbWorkpaper } from '../balance-engine.service.js';
import { listGroupings } from '../groupings.service.js';
import { defaultEquityRole, getEquityRoles } from '../m1.service.js';

export async function loadFsSource(tenantId: string, companyId: string, settings: FsReportSettings): Promise<FsSourceData> {
  const [company] = await db.select({
    name: companies.businessName, entityType: companies.entityType,
  }).from(companies).where(and(eq(companies.tenantId, tenantId), eq(companies.id, companyId))).limit(1);
  if (!company) throw AppError.notFound('Company not found');

  const basis = settings.framework === 'cash' ? 'cash' : settings.bookBasis;
  const column: 'adjusted' | 'tax' = settings.framework === 'tax' ? 'tax' : 'adjusted';
  const wp = (periodEnd: string, tagId?: string | null) => computeWorkpaper(tenantId, companyId, { periodEnd, basis, tagId: tagId ?? null });

  const cyWp = await wp(settings.periodEnd);
  const fyStart = cyWp.fyStart;
  const mode = settings.columns.mode;
  const wantPy = mode === 'cy_py';
  const wantMonth = mode === 'month_ytd';

  const cyOpenDate = fsDayBefore(fyStart);
  const pyDate = fsShiftYear(settings.periodEnd, -1);
  const pyOpenDate = fsDayBefore(fsShiftYear(fyStart, -1));
  const priorMonthDate = fsPriorMonthEnd(settings.periodEnd);

  const [cyOpenWp, pyWp, pyOpenWp, pmWp] = await Promise.all([
    wp(cyOpenDate),
    wantPy ? wp(pyDate) : Promise.resolve(null),
    wantPy ? wp(pyOpenDate) : Promise.resolve(null),
    wantMonth ? wp(priorMonthDate) : Promise.resolve(null),
  ]);

  const toPeriod = (w: TbWorkpaper | null, col: 'adjusted' | 'tax'): FsSourcePeriod | undefined => {
    if (!w) return undefined;
    const balances: Record<string, number> = {};
    for (const r of w.rows) {
      const v = r[col];
      if (v !== 0) balances[r.accountId] = v;
    }
    return { date: w.periodEnd, fyStart: w.fyStart, balances, hasData: w.rows.length > 0 };
  };

  let tagged: FsSourceData['tagged'] = null;
  let tagName: string | null = null;
  if (settings.tagId) {
    const [tag] = await db.select({ name: tags.name }).from(tags)
      .where(and(eq(tags.tenantId, tenantId), eq(tags.id, settings.tagId))).limit(1);
    if (!tag) throw AppError.badRequest('Tag not found', 'TB_FS_TAG');
    tagName = tag.name;
    const [tCy, tPy, tPm] = await Promise.all([
      wp(settings.periodEnd, settings.tagId),
      wantPy ? wp(pyDate, settings.tagId) : Promise.resolve(null),
      wantMonth ? wp(priorMonthDate, settings.tagId) : Promise.resolve(null),
    ]);
    tagged = { cy: toPeriod(tCy, column), py: toPeriod(tPy, column), cyPriorMonth: toPeriod(tPm, column) };
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
    glVersionStamp: cyWp.glVersionStamp,
    periodEnd: settings.periodEnd,
    fyStart,
    accounts: list,
    groupings: groupings.map((g) => ({ id: g.id, code: g.leadsheetCode ?? null, name: g.name, sortOrder: g.sortOrder, accountIds: g.accountIds })),
    periods: {
      cy: toPeriod(cyWp, column),
      cyOpen: toPeriod(cyOpenWp, 'adjusted'),
      py: toPeriod(pyWp, column),
      pyOpen: toPeriod(pyOpenWp, 'adjusted'),
      cyPriorMonth: toPeriod(pmWp, column),
    },
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
