// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// TB report family (Phase 12). Every builder returns the FULL
// respond()-ready object — title, date fields, data rows, and
// _exportColumns — so the /reports routes and the Report Pack
// renderers share one code path (the pack render map calls these
// directly, keeping pack output identical to single-report export).
//
// Date convention: reports arrive with an end_date (GenericReport /
// pack presets); the tax year is the fiscal year containing it
// (rule TB10). Basis is a first-class option (D12) and is printed in
// every title.

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import {
  accounts, activityUnits, attachments, companies, journalLines,
  tbGroupingAccounts, tbGroupings, tbNotes, tbTickmarkApplications,
  tbTickmarks, transactions,
} from '../../db/schema/index.js';
import { AppError } from '../../utils/errors.js';
import { computeWorkpaper, type TbBasis } from './balance-engine.service.js';
import { taxYearOf } from './tax-profile.service.js';
import { buildTaxDataset } from './exports.service.js';
import { runDiagnostics } from './diagnostics.service.js';
import { buildM1, buildM2 } from './m1.service.js';
import { listSignoffs } from './signoffs.service.js';
import { formatAjeNumber } from './aje.service.js';
import { formatRjeNumber, listTaxEntries } from './tax-entries.service.js';

const money = (n: number) => Math.round(n * 100) / 100;
type Col = { key: string; label: string; align?: 'left' | 'right' };
const num = (key: string, label: string): Col => ({ key, label, align: 'right' });

async function fiscalContext(tenantId: string, companyId: string, endDate: string) {
  const [company] = await db.select({ m: companies.fiscalYearStartMonth, name: companies.businessName })
    .from(companies)
    .where(and(eq(companies.tenantId, tenantId), eq(companies.id, companyId)))
    .limit(1);
  if (!company) throw AppError.notFound('Company not found');
  const fyMonth = company.m ?? 1;
  return { fyMonth, companyName: company.name, taxYear: taxYearOf(endDate, fyMonth) };
}

const basisSuffix = (basis: TbBasis) => basis === 'cash' ? ' (Cash Basis)' : ' (Accrual Basis)';

const FIVE_COLS: Col[] = [
  { key: 'account_number', label: '#' },
  { key: 'name', label: 'Account' },
  num('unadjusted', 'Unadjusted'),
  num('aje', 'AJE'),
  num('adjusted', 'Adjusted'),
  num('tax_rje', 'Tax RJE'),
  num('tax', 'Tax'),
];

type FiveColRow = Record<string, unknown>;

const toFiveCol = (r: { accountNumber: string | null; name: string; unadjusted: number; aje: number; adjusted: number; taxRje: number; tax: number }): FiveColRow => ({
  account_number: r.accountNumber ?? '',
  name: r.name,
  unadjusted: money(r.unadjusted),
  aje: money(r.aje),
  adjusted: money(r.adjusted),
  tax_rje: money(r.taxRje),
  tax: money(r.tax),
});

// ── 12.1 Standard five-column TB ────────────────────────────────────

export async function buildTbWorkpaperReport(tenantId: string, companyId: string, endDate: string, basis: TbBasis) {
  const { taxYear } = await fiscalContext(tenantId, companyId, endDate);
  const wp = await computeWorkpaper(tenantId, companyId, { periodEnd: endDate, basis, taxYear });
  const data: Array<Record<string, unknown>> = wp.rows.map((r) => toFiveCol(r));
  data.push({
    account_number: '', name: 'TOTALS (DR/CR)',
    unadjusted: `${wp.totals.unadjustedDr.toFixed(2)} / ${wp.totals.unadjustedCr.toFixed(2)}`,
    aje: `${wp.totals.ajeDr.toFixed(2)} / ${wp.totals.ajeCr.toFixed(2)}`,
    adjusted: `${wp.totals.adjustedDr.toFixed(2)} / ${wp.totals.adjustedCr.toFixed(2)}`,
    tax_rje: `${wp.totals.taxRjeDr.toFixed(2)} / ${wp.totals.taxRjeCr.toFixed(2)}`,
    tax: `${wp.totals.taxDr.toFixed(2)} / ${wp.totals.taxCr.toFixed(2)}`,
  });
  return {
    title: `Trial Balance Workpaper — TY${taxYear}${basisSuffix(basis)}`,
    startDate: wp.fyStart,
    endDate,
    glVersionStamp: wp.glVersionStamp,
    data,
    _exportColumns: FIVE_COLS,
  };
}

// ── 12.1 Grouped TB / leadsheets (7.5 lands here too) ───────────────

export async function buildTbGroupedReport(tenantId: string, companyId: string, endDate: string, basis: TbBasis) {
  const { taxYear } = await fiscalContext(tenantId, companyId, endDate);
  const wp = await computeWorkpaper(tenantId, companyId, { periodEnd: endDate, basis, taxYear });
  const groupings = await db.select().from(tbGroupings)
    .where(and(eq(tbGroupings.tenantId, tenantId), eq(tbGroupings.companyId, companyId)))
    .orderBy(tbGroupings.sortOrder);
  const memberships = await db.select().from(tbGroupingAccounts)
    .where(and(eq(tbGroupingAccounts.tenantId, tenantId), eq(tbGroupingAccounts.companyId, companyId)));
  const byGrouping = new Map<string, Set<string>>();
  for (const m of memberships) {
    const set = byGrouping.get(m.groupingId) ?? new Set();
    set.add(m.accountId);
    byGrouping.set(m.groupingId, set);
  }
  const data: Array<Record<string, unknown>> = [];
  const used = new Set<string>();
  const pushSection = (label: string, rows: typeof wp.rows) => {
    if (rows.length === 0) return;
    data.push({ account_number: '---', name: label, unadjusted: '', aje: '', adjusted: '', tax_rje: '', tax: '' });
    const totals = { unadjusted: 0, aje: 0, adjusted: 0, tax_rje: 0, tax: 0 };
    for (const r of rows) {
      data.push(toFiveCol(r));
      totals.unadjusted += r.unadjusted; totals.aje += r.aje; totals.adjusted += r.adjusted;
      totals.tax_rje += r.taxRje; totals.tax += r.tax;
    }
    data.push({
      account_number: '', name: `Total ${label}`,
      unadjusted: money(totals.unadjusted), aje: money(totals.aje), adjusted: money(totals.adjusted),
      tax_rje: money(totals.tax_rje), tax: money(totals.tax),
    });
  };
  for (const g of groupings) {
    const members = byGrouping.get(g.id) ?? new Set();
    const rows = wp.rows.filter((r) => members.has(r.accountId));
    rows.forEach((r) => used.add(r.accountId));
    pushSection(`${g.leadsheetCode ? g.leadsheetCode + ' — ' : ''}${g.name}`, rows);
  }
  pushSection('Ungrouped', wp.rows.filter((r) => !used.has(r.accountId)));
  return {
    title: `Grouped Trial Balance — TY${taxYear}${basisSuffix(basis)}`,
    startDate: wp.fyStart,
    endDate,
    data,
    _exportColumns: FIVE_COLS,
  };
}

// ── Leadsheets report ───────────────────────────────────────────────
// One section per grouping: five-column member rows with their tickmark
// symbols, subtotals, and the preparer/reviewer sign-off line. Pass a
// groupingId to print a single leadsheet (the TB Leadsheets page's
// "PDF" button); null prints the whole book (TB Reports + report packs).

const LEADSHEET_COLS: Col[] = [...FIVE_COLS, { key: 'marks', label: 'Marks' }];

export async function buildTbLeadsheetsReport(
  tenantId: string, companyId: string, endDate: string, basis: TbBasis, groupingId: string | null = null,
) {
  const { taxYear } = await fiscalContext(tenantId, companyId, endDate);
  const wp = await computeWorkpaper(tenantId, companyId, { periodEnd: endDate, basis, taxYear });
  let groupings = await db.select().from(tbGroupings)
    .where(and(eq(tbGroupings.tenantId, tenantId), eq(tbGroupings.companyId, companyId)))
    .orderBy(tbGroupings.sortOrder);
  if (groupingId) {
    groupings = groupings.filter((g) => g.id === groupingId);
    if (groupings.length === 0) throw AppError.notFound('Leadsheet grouping not found');
  }
  const memberships = await db.select().from(tbGroupingAccounts)
    .where(and(eq(tbGroupingAccounts.tenantId, tenantId), eq(tbGroupingAccounts.companyId, companyId)));
  const { signoffs } = await listSignoffs(tenantId, companyId, taxYear);
  const marks = await db.select({
    accountId: tbTickmarkApplications.accountId,
    symbol: tbTickmarks.symbol,
  }).from(tbTickmarkApplications)
    .innerJoin(tbTickmarks, eq(tbTickmarkApplications.tickmarkId, tbTickmarks.id))
    .where(and(
      eq(tbTickmarkApplications.tenantId, tenantId),
      eq(tbTickmarkApplications.companyId, companyId),
      eq(tbTickmarkApplications.taxYear, taxYear),
    ));
  const marksByAccount = new Map<string, Set<string>>();
  for (const m of marks) {
    const set = marksByAccount.get(m.accountId) ?? new Set();
    set.add(m.symbol);
    marksByAccount.set(m.accountId, set);
  }
  const sigLabel = (gId: string, role: string) => {
    const s = signoffs.find((x) => x.groupingId === gId && x.role === role);
    if (!s) return 'not signed';
    return `${String(s.signedAt).slice(0, 10)}${s.stale ? ' (STALE)' : ''}`;
  };

  const data: Array<Record<string, unknown>> = [];
  for (const g of groupings) {
    const members = new Set(memberships.filter((m) => m.groupingId === g.id).map((m) => m.accountId));
    const rows = wp.rows.filter((r) => members.has(r.accountId));
    if (rows.length === 0 && !groupingId) continue;
    const label = `${g.leadsheetCode ? g.leadsheetCode + ' — ' : ''}${g.name}`;
    data.push({ account_number: '---', name: label, unadjusted: '', aje: '', adjusted: '', tax_rje: '', tax: '', marks: '' });
    const totals = { unadjusted: 0, aje: 0, adjusted: 0, tax_rje: 0, tax: 0 };
    for (const r of rows) {
      data.push({
        ...toFiveCol(r),
        marks: [...(marksByAccount.get(r.accountId) ?? [])].join(' '),
      });
      totals.unadjusted += r.unadjusted; totals.aje += r.aje; totals.adjusted += r.adjusted;
      totals.tax_rje += r.taxRje; totals.tax += r.tax;
    }
    data.push({
      account_number: '', name: `Total ${label}`,
      unadjusted: money(totals.unadjusted), aje: money(totals.aje), adjusted: money(totals.adjusted),
      tax_rje: money(totals.tax_rje), tax: money(totals.tax), marks: '',
    });
    data.push({
      account_number: '', name: `Prepared: ${sigLabel(g.id, 'preparer')} · Reviewed: ${sigLabel(g.id, 'reviewer')}`,
      unadjusted: '', aje: '', adjusted: '', tax_rje: '', tax: '', marks: '',
    });
  }
  const single = groupingId ? groupings[0] : null;
  const singleLabel = single ? `${single.leadsheetCode ? single.leadsheetCode + ' — ' : ''}${single.name}` : null;
  return {
    title: singleLabel
      ? `Leadsheet ${singleLabel} — TY${taxYear}${basisSuffix(basis)}`
      : `Leadsheets — TY${taxYear}${basisSuffix(basis)}`,
    startDate: wp.fyStart,
    endDate,
    asOfDate: endDate,
    data,
    _exportColumns: LEADSHEET_COLS,
  };
}

// ── 12.2 Tax Return Order Report ────────────────────────────────────

export async function buildTbReturnOrderReport(tenantId: string, companyId: string, endDate: string, basis: TbBasis) {
  const { fyMonth, taxYear } = await fiscalContext(tenantId, companyId, endDate);
  void fyMonth;
  const dataset = await buildTaxDataset(tenantId, companyId, { taxYear, basis, software: 'generic' });
  const units = await db.select().from(activityUnits).where(eq(activityUnits.companyId, companyId));
  const unitNames = new Map(units.map((u) => [u.id, u.displayName]));
  const data: Array<Record<string, unknown>> = [];
  for (const line of dataset.lines) {
    data.push({ code: line.code, description: line.description, account: '', unit: '', amount: money(line.amount) });
    for (const a of line.accounts) {
      data.push({
        code: '', description: '',
        account: `${a.accountNumber ? a.accountNumber + ' ' : ''}${a.name}`,
        unit: unitNames.get(a.unitId) ?? '',
        amount: money(a.amount),
      });
    }
  }
  return {
    title: `Tax Return Order Report — TY${taxYear}${basisSuffix(basis)}`,
    startDate: null,
    endDate,
    asOfDate: endDate,
    data,
    _exportColumns: [
      { key: 'code', label: 'Code' },
      { key: 'description', label: 'Return line' },
      { key: 'account', label: 'Account' },
      { key: 'unit', label: 'Activity' },
      num('amount', 'Amount'),
    ],
  };
}

// ── 12.3 Tax-Basis P&L ─────────────────────────────────────────────

export async function buildTbTaxBasisPl(tenantId: string, companyId: string, endDate: string, basis: TbBasis, activityUnitId?: string | null) {
  const { taxYear } = await fiscalContext(tenantId, companyId, endDate);
  const wp = await computeWorkpaper(tenantId, companyId, { periodEnd: endDate, basis, taxYear });
  const rows = wp.rows.filter((r) => r.accountType === 'revenue' || r.accountType === 'expense');
  const pick = (r: typeof rows[number]) => {
    if (!activityUnitId) return { adjusted: r.adjusted, tax: r.tax };
    const u = r.units.find((x) => x.unitId === activityUnitId);
    return u ? { adjusted: u.adjusted, tax: u.tax } : null;
  };
  const data: Array<Record<string, unknown>> = [];
  let bookNet = 0;
  let taxNet = 0;
  for (const section of ['revenue', 'expense'] as const) {
    const sectionRows = rows.filter((r) => r.accountType === section);
    const picked = sectionRows.map((r) => ({ r, v: pick(r) })).filter((x): x is { r: typeof rows[number]; v: { adjusted: number; tax: number } } => !!x.v);
    if (picked.length === 0) continue;
    data.push({ account_number: '---', name: section === 'revenue' ? 'Revenue' : 'Expenses', book: '', tax_rje: '', tax: '' });
    let secBook = 0;
    let secTax = 0;
    for (const { r, v } of picked) {
      const book = section === 'revenue' ? -v.adjusted : v.adjusted;
      const tax = section === 'revenue' ? -v.tax : v.tax;
      secBook += book; secTax += tax;
      data.push({
        account_number: r.accountNumber ?? '', name: r.name,
        book: money(book), tax_rje: money(tax - book), tax: money(tax),
      });
    }
    data.push({ account_number: '', name: `Total ${section === 'revenue' ? 'Revenue' : 'Expenses'}`, book: money(secBook), tax_rje: money(secTax - secBook), tax: money(secTax) });
    bookNet += section === 'revenue' ? secBook : -secBook;
    taxNet += section === 'revenue' ? secTax : -secTax;
  }
  data.push({ account_number: '', name: 'NET INCOME/(LOSS)', book: money(bookNet), tax_rje: money(taxNet - bookNet), tax: money(taxNet) });
  return {
    title: `Tax-Basis P&L — TY${taxYear}${basisSuffix(basis)}${activityUnitId ? ' — activity view' : ''}`,
    startDate: wp.fyStart,
    endDate,
    data,
    _exportColumns: [
      { key: 'account_number', label: '#' },
      { key: 'name', label: 'Account' },
      num('book', 'Book'),
      num('tax_rje', 'Tax Adj.'),
      num('tax', 'Tax Basis'),
    ],
  };
}

// ── 12.4 Flux Analysis ─────────────────────────────────────────────

export async function buildTbFluxReport(
  tenantId: string, companyId: string, endDate: string, basis: TbBasis,
  compareEndDate?: string | null, thresholdAmount = 0, thresholdPct = 0,
) {
  const { fyMonth, taxYear } = await fiscalContext(tenantId, companyId, endDate);
  const wp = await computeWorkpaper(tenantId, companyId, { periodEnd: endDate, basis, taxYear });
  const priorEnd = compareEndDate
    ?? new Date(new Date(wp.fyStart + 'T00:00:00Z').getTime() - 86400000).toISOString().slice(0, 10);
  const prior = await computeWorkpaper(tenantId, companyId, { periodEnd: priorEnd, basis, taxYear: taxYearOf(priorEnd, fyMonth) });
  const priorBy = new Map(prior.rows.map((r) => [r.accountId, r.adjusted]));
  const ids = new Set([...wp.rows.map((r) => r.accountId), ...prior.rows.map((r) => r.accountId)]);
  const data: Array<Record<string, unknown>> = [];
  for (const id of ids) {
    const cur = wp.rows.find((r) => r.accountId === id);
    const prev = prior.rows.find((r) => r.accountId === id);
    const current = cur?.adjusted ?? 0;
    const priorV = priorBy.get(id) ?? 0;
    const varAmt = money(current - priorV);
    const varPct = priorV !== 0 ? money(((current - priorV) / Math.abs(priorV)) * 100) : (current !== 0 ? 100 : 0);
    const significant = Math.abs(varAmt) >= thresholdAmount && Math.abs(varPct) >= thresholdPct;
    if (thresholdAmount > 0 || thresholdPct > 0 ? !significant : false) continue;
    data.push({
      account_number: (cur ?? prev)?.accountNumber ?? '',
      name: (cur ?? prev)?.name ?? '',
      current: money(current),
      prior: money(priorV),
      variance: varAmt,
      variance_pct: `${varPct.toFixed(1)}%`,
      flag: significant && (thresholdAmount > 0 || thresholdPct > 0) ? '●' : (Math.abs(varAmt) >= 0.005 ? '' : ''),
    });
  }
  data.sort((a, b) => String(a['account_number']).localeCompare(String(b['account_number'])));
  return {
    title: `Flux Analysis — ${endDate} vs ${priorEnd}${basisSuffix(basis)}`,
    startDate: priorEnd,
    endDate,
    data,
    _exportColumns: [
      { key: 'account_number', label: '#' },
      { key: 'name', label: 'Account' },
      num('current', 'Current'),
      num('prior', 'Comparative'),
      num('variance', 'Variance $'),
      { key: 'variance_pct', label: 'Variance %', align: 'right' },
      { key: 'flag', label: '' },
    ],
  };
}

// ── 12.1/12.5 AJE listing & Bookkeeper Letter ──────────────────────

async function ajeRows(tenantId: string, companyId: string, endDate: string) {
  const { fyMonth, taxYear } = await fiscalContext(tenantId, companyId, endDate);
  const fyStart = fyMonth === 1 ? `${taxYear}-01-01` : `${taxYear - 1}-${String(fyMonth).padStart(2, '0')}-01`;
  const ajes = await db.select().from(transactions)
    .where(and(
      eq(transactions.tenantId, tenantId),
      eq(transactions.companyId, companyId),
      eq(transactions.txnType, 'aje'),
      eq(transactions.status, 'posted'),
      sql`${transactions.txnDate} >= ${fyStart}`,
      sql`${transactions.txnDate} <= ${endDate}`,
    ))
    .orderBy(transactions.ajeNumber);
  const ids = ajes.map((a) => a.id);
  const lines = ids.length
    ? await db.select({
      transactionId: journalLines.transactionId,
      accountId: journalLines.accountId,
      debit: journalLines.debit,
      credit: journalLines.credit,
      description: journalLines.description,
      accountNumber: accounts.accountNumber,
      accountName: accounts.name,
    }).from(journalLines)
      .innerJoin(accounts, eq(journalLines.accountId, accounts.id))
      .where(and(
        eq(journalLines.tenantId, tenantId),
        sql`${journalLines.transactionId} IN ${ids}`,
        eq(journalLines.isVoidReversal, false),
      ))
      .orderBy(journalLines.lineOrder)
    : [];
  const attachRows = ids.length
    ? await db.select({ attachableId: attachments.attachableId, fileName: attachments.fileName }).from(attachments)
      .where(and(eq(attachments.tenantId, tenantId), sql`${attachments.attachableId} IN ${ids}`))
    : [];
  return { ajes, lines, attachRows, taxYear };
}

export async function buildTbAjeListing(tenantId: string, companyId: string, endDate: string, clientFacing: boolean) {
  const { ajes, lines, attachRows, taxYear } = await ajeRows(tenantId, companyId, endDate);
  const data: Array<Record<string, unknown>> = [];
  for (const aje of ajes) {
    const label = aje.ajeNumber ? formatAjeNumber(aje.ajeNumber) : 'AJE';
    const attach = attachRows.filter((a) => a.attachableId === aje.id);
    data.push({
      number: label, date: aje.txnDate, account: aje.memo ?? '',
      debit: '', credit: '',
      ...(clientFacing ? {} : { attachments: attach.map((a) => a.fileName).join(', ') }),
    });
    for (const l of lines.filter((x) => x.transactionId === aje.id)) {
      data.push({
        number: '', date: '',
        account: `${l.accountNumber ? l.accountNumber + ' ' : ''}${l.accountName}${l.description ? ' — ' + l.description : ''}`,
        debit: Number(l.debit) > 0 ? money(Number(l.debit)) : '',
        credit: Number(l.credit) > 0 ? money(Number(l.credit)) : '',
        ...(clientFacing ? {} : { attachments: '' }),
      });
    }
  }
  const cols: Col[] = [
    { key: 'number', label: '#' },
    { key: 'date', label: 'Date' },
    { key: 'account', label: clientFacing ? 'Adjustment' : 'Account / memo' },
    num('debit', 'Debit'),
    num('credit', 'Credit'),
  ];
  if (!clientFacing) cols.push({ key: 'attachments', label: 'Attachments' });
  return {
    title: clientFacing
      ? `Adjusting Entries — Tax Year ${taxYear}`
      : `AJE Listing — TY${taxYear}`,
    startDate: null,
    endDate,
    asOfDate: endDate,
    data,
    _exportColumns: cols,
  };
}

// ── Tax RJE listing ────────────────────────────────────────────────

export async function buildTbRjeListing(tenantId: string, companyId: string, endDate: string) {
  const { taxYear } = await fiscalContext(tenantId, companyId, endDate);
  const { entries } = await listTaxEntries(tenantId, companyId, taxYear);
  const accountRows = await db.select({ id: accounts.id, accountNumber: accounts.accountNumber, name: accounts.name })
    .from(accounts).where(eq(accounts.tenantId, tenantId));
  const acctBy = new Map(accountRows.map((a) => [a.id, a]));
  const data: Array<Record<string, unknown>> = [];
  for (const e of entries) {
    data.push({ number: formatRjeNumber(e.entryNumber), memo: e.memo ?? '', account: '', m1: e.isM1 ? 'M-1' : '', debit: '', credit: '' });
    for (const l of e.lines) {
      const a = acctBy.get(l.accountId);
      data.push({
        number: '', memo: '',
        account: `${a?.accountNumber ? a.accountNumber + ' ' : ''}${a?.name ?? ''}`,
        m1: '',
        debit: Number(l.debit) > 0 ? money(Number(l.debit)) : '',
        credit: Number(l.credit) > 0 ? money(Number(l.credit)) : '',
      });
    }
  }
  return {
    title: `Tax RJE Listing — TY${taxYear} (tax basis only — never posted to the books)`,
    startDate: null,
    endDate,
    asOfDate: endDate,
    data,
    _exportColumns: [
      { key: 'number', label: '#' },
      { key: 'memo', label: 'Memo' },
      { key: 'account', label: 'Account' },
      { key: 'm1', label: 'M-1' },
      num('debit', 'Debit'),
      num('credit', 'Credit'),
    ],
  };
}

// ── Tax-code summary ───────────────────────────────────────────────

export async function buildTbCodeSummary(tenantId: string, companyId: string, endDate: string, basis: TbBasis) {
  const { taxYear } = await fiscalContext(tenantId, companyId, endDate);
  const dataset = await buildTaxDataset(tenantId, companyId, { taxYear, basis, software: 'generic' });
  return {
    title: `Tax Code Summary — TY${taxYear}${basisSuffix(basis)}`,
    startDate: null,
    endDate,
    asOfDate: endDate,
    data: dataset.lines.map((l) => ({
      code: l.code, description: l.description,
      accounts: l.accounts.length, amount: money(l.amount),
    })),
    _exportColumns: [
      { key: 'code', label: 'Code' },
      { key: 'description', label: 'Return line' },
      num('accounts', 'Accounts'),
      num('amount', 'Amount'),
    ],
  };
}

// ── M-1 / M-2 as reports ───────────────────────────────────────────

export async function buildTbM1Report(tenantId: string, companyId: string, endDate: string, basis: TbBasis) {
  const { taxYear } = await fiscalContext(tenantId, companyId, endDate);
  const m1 = await buildM1(tenantId, companyId, { taxYear, basis });
  const data: Array<Record<string, unknown>> = [
    { item: 'Net income per books', amount: m1.bookIncome },
    { item: '--- Additions', amount: '' },
    ...m1.lines.filter((l) => l.category === 'income_on_return_not_books' || l.category === 'expenses_on_books_not_return')
      .map((l) => ({ item: `  ${l.name}${l.flagged ? '' : ' (unflagged)'}`, amount: l.amount })),
    { item: 'Total additions', amount: m1.additions },
    { item: '--- Subtractions', amount: '' },
    ...m1.lines.filter((l) => l.category === 'income_on_books_not_return' || l.category === 'deductions_on_return_not_books')
      .map((l) => ({ item: `  ${l.name}${l.flagged ? '' : ' (unflagged)'}`, amount: l.amount })),
    { item: 'Total subtractions', amount: m1.subtractions },
    { item: 'Income per return', amount: m1.taxIncome },
  ];
  return {
    title: `Schedule M-1 Preview — TY${taxYear}${basisSuffix(basis)}${m1.reconciles ? '' : ' — DOES NOT RECONCILE'}`,
    startDate: null,
    endDate,
    asOfDate: endDate,
    data,
    _exportColumns: [{ key: 'item', label: 'Item' }, num('amount', 'Amount')],
  };
}

export async function buildTbM2Report(tenantId: string, companyId: string, endDate: string, basis: TbBasis) {
  const { taxYear } = await fiscalContext(tenantId, companyId, endDate);
  const m2 = await buildM2(tenantId, companyId, { taxYear, basis });
  const data: Array<Record<string, unknown>> = [
    { item: 'Beginning equity', amount: m2.beginning },
    { item: '+ Net income per books', amount: m2.bookIncome },
    { item: '− Distributions', amount: -m2.distributions },
    { item: '+ Contributions', amount: m2.contributions },
    { item: '± Other equity changes', amount: m2.other },
    { item: '= Computed ending equity', amount: m2.computedEnding },
    { item: 'GL ending equity (incl. current income)', amount: m2.glEndingEquity },
    { item: 'Unreconciled difference', amount: m2.unreconciled },
    { item: '--- Equity accounts', amount: '' },
    ...m2.accounts.map((a) => ({ item: `  ${a.name} [${a.role}]`, amount: a.ending })),
  ];
  return {
    title: `Schedule M-2 Rollforward — TY${taxYear}${basisSuffix(basis)}${m2.reconciles ? '' : ' — UNRECONCILED'}`,
    startDate: null,
    endDate,
    asOfDate: endDate,
    data,
    _exportColumns: [{ key: 'item', label: 'Item' }, num('amount', 'Amount')],
  };
}

// ── 12.6 Workpaper index ───────────────────────────────────────────

export async function buildTbWorkpaperIndex(tenantId: string, companyId: string, endDate: string) {
  const { taxYear } = await fiscalContext(tenantId, companyId, endDate);
  const groupings = await db.select().from(tbGroupings)
    .where(and(eq(tbGroupings.tenantId, tenantId), eq(tbGroupings.companyId, companyId)))
    .orderBy(tbGroupings.sortOrder);
  const memberships = await db.select().from(tbGroupingAccounts)
    .where(and(eq(tbGroupingAccounts.tenantId, tenantId), eq(tbGroupingAccounts.companyId, companyId)));
  const { signoffs } = await listSignoffs(tenantId, companyId, taxYear);
  const marks = await db.select({ id: tbTickmarkApplications.id, accountId: tbTickmarkApplications.accountId })
    .from(tbTickmarkApplications)
    .where(and(eq(tbTickmarkApplications.tenantId, tenantId), eq(tbTickmarkApplications.companyId, companyId), eq(tbTickmarkApplications.taxYear, taxYear)));
  const notes = await db.select({ id: tbNotes.id, accountId: tbNotes.accountId, resolvedAt: tbNotes.resolvedAt })
    .from(tbNotes)
    .where(and(eq(tbNotes.tenantId, tenantId), eq(tbNotes.companyId, companyId), eq(tbNotes.taxYear, taxYear)));
  const data = groupings.map((g) => {
    const accts = new Set(memberships.filter((m) => m.groupingId === g.id).map((m) => m.accountId));
    const sig = (role: string) => {
      const s = signoffs.find((x) => x.groupingId === g.id && x.role === role);
      if (!s) return '—';
      return `${String(s.signedAt).slice(0, 10)}${s.stale ? ' (stale)' : ''}`;
    };
    return {
      code: g.leadsheetCode ?? '',
      grouping: g.name,
      accounts: accts.size,
      tickmarks: marks.filter((m) => accts.has(m.accountId)).length,
      notes: notes.filter((n) => n.accountId && accts.has(n.accountId)).length,
      open_notes: notes.filter((n) => n.accountId && accts.has(n.accountId) && !n.resolvedAt).length,
      preparer: sig('preparer'),
      reviewer: sig('reviewer'),
    };
  });
  return {
    title: `Workpaper Index — TY${taxYear}`,
    startDate: null,
    endDate,
    asOfDate: endDate,
    data,
    _exportColumns: [
      { key: 'code', label: 'WP' },
      { key: 'grouping', label: 'Grouping' },
      num('accounts', 'Accounts'),
      num('tickmarks', 'Tickmarks'),
      num('notes', 'Notes'),
      num('open_notes', 'Open'),
      { key: 'preparer', label: 'Preparer' },
      { key: 'reviewer', label: 'Reviewer' },
    ],
  };
}

// ── 12.7 Diagnostics report ────────────────────────────────────────

export async function buildTbDiagnosticsReport(tenantId: string, companyId: string, endDate: string, basis: TbBasis) {
  const { taxYear } = await fiscalContext(tenantId, companyId, endDate);
  const diag = await runDiagnostics(tenantId, companyId, { periodEnd: endDate, basis, taxYear });
  return {
    title: `TB Diagnostics — TY${taxYear}${basisSuffix(basis)} — ${diag.errorCount} errors / ${diag.warningCount} warnings`,
    startDate: null,
    endDate,
    asOfDate: endDate,
    data: diag.diagnostics.map((d) => ({
      severity: d.severity,
      kind: d.kind.replace(/_/g, ' '),
      account: d.accountName ?? '',
      message: d.message,
    })),
    _exportColumns: [
      { key: 'severity', label: 'Severity' },
      { key: 'kind', label: 'Check' },
      { key: 'account', label: 'Account' },
      { key: 'message', label: 'Finding' },
    ],
  };
}
