// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// CPA engagement letters / reports (SSARS 21).
//
// Templates are SYSTEM-level: managed by the super-admin, shared across the
// appliance, no tenant scoping. This service holds the CRUD (audit-logged
// against the acting super-admin's tenant) plus the render-time variable
// resolver + HTML builder consumed by the report-pack generator.
//
// The variable CATALOG and all basis/title/date phrasing live in
// @kis-books/shared (letter-variables) so the editor and the resolver agree.

import { asc, eq, sql } from 'drizzle-orm';
import {
  basisOfAccountingPhrase,
  financialStatementTitles,
  formatLongDate,
  letterFontStack,
  periodDescription,
  renderLetterBody,
  REPORT_LETTER_TITLES,
  type CreateReportLetterInput,
  type UpdateReportLetterInput,
  type ReportLetterType,
  type TenantReportSettings,
} from '@kis-books/shared';
import { db } from '../db/index.js';
import { reportLetters } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import { getSettings } from './tenant-report-settings.service.js';

type LetterRow = typeof reportLetters.$inferSelect;

// ─── CRUD ───

/** All letters (active + inactive), ordered for the admin list. */
export async function listLetters(): Promise<LetterRow[]> {
  return db.select().from(reportLetters).orderBy(asc(reportLetters.sortOrder), asc(reportLetters.name));
}

/** Active letters only — for the report-pack builder's letter picker. */
export async function listActiveLetters(): Promise<LetterRow[]> {
  return db
    .select()
    .from(reportLetters)
    .where(eq(reportLetters.isActive, true))
    .orderBy(asc(reportLetters.sortOrder), asc(reportLetters.name));
}

export async function getLetter(id: string): Promise<LetterRow> {
  const row = await db.query.reportLetters.findFirst({ where: eq(reportLetters.id, id) });
  if (!row) throw AppError.notFound('Report letter not found');
  return row;
}

export async function createLetter(
  input: CreateReportLetterInput,
  tenantId: string,
  userId: string,
): Promise<LetterRow> {
  const [row] = await db.insert(reportLetters).values({
    name: input.name,
    letterType: input.letterType,
    title: input.title ?? null,
    fontFamily: input.fontFamily ?? null,
    bodyHtml: input.bodyHtml,
    isActive: input.isActive ?? true,
    isDefault: false,
    sortOrder: input.sortOrder ?? 0,
  }).returning();
  await auditLog(tenantId, 'create', 'report_letter', row!.id, null, row, userId);
  return row!;
}

export async function updateLetter(
  id: string,
  input: UpdateReportLetterInput,
  tenantId: string,
  userId: string,
): Promise<LetterRow> {
  const before = await getLetter(id);
  const [row] = await db.update(reportLetters)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.letterType !== undefined ? { letterType: input.letterType } : {}),
      ...(input.title !== undefined ? { title: input.title ?? null } : {}),
      ...(input.fontFamily !== undefined ? { fontFamily: input.fontFamily ?? null } : {}),
      ...(input.bodyHtml !== undefined ? { bodyHtml: input.bodyHtml } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      updatedAt: new Date(),
    })
    .where(eq(reportLetters.id, id))
    .returning();
  await auditLog(tenantId, 'update', 'report_letter', id, before, row, userId);
  return row!;
}

export async function deleteLetter(id: string, tenantId: string, userId: string): Promise<void> {
  const before = await getLetter(id);
  await db.delete(reportLetters).where(eq(reportLetters.id, id));
  await auditLog(tenantId, 'delete', 'report_letter', id, before, null, userId);
}

// ─── Render-time resolution ───

export interface LetterRenderContext {
  periodStart: string | null | undefined;
  periodEnd: string | null | undefined;
  /** As-of date for the framework's balance-sheet-equivalent. Defaults to periodEnd. */
  asOfDate?: string | null | undefined;
  /** 'accrual' | 'cash' from the pack, or a broader framework for preview. */
  basis: string;
  /** Signature / report date. Defaults to periodEnd. */
  reportDate?: string | null | undefined;
  /** Drives {{report_title}}. Defaults to the letter's stored type. */
  letterType?: ReportLetterType;
}

/** Combine city + state into "City, ST" (comma only when both present). */
function cityState(city: string, state: string): string {
  if (city && state) return `${city}, ${state}`;
  return city || state;
}

/**
 * Resolve the variable catalog to concrete RAW (un-escaped) string values for
 * a given tenant/company + pack context. Escaping happens in renderLetterBody
 * at substitution time. Firm identity comes from the tenant's report settings
 * (firmName/firmCity/firmState/accountantSignature) and falls back to the
 * company's businessName/city/state when unset.
 */
export async function resolveLetterVariables(
  tenantId: string,
  companyId: string,
  ctx: LetterRenderContext,
): Promise<Record<string, string>> {
  const companyRow = await db.execute(
    sql`SELECT business_name, city, state FROM companies WHERE id = ${companyId} AND tenant_id = ${tenantId}`,
  );
  const company = (companyRow.rows as Array<{ business_name?: string; city?: string; state?: string }>)[0] ?? {};
  const settings = (await getSettings(tenantId)) as TenantReportSettings;

  const clientName = company.business_name ?? '';
  const firmName = (settings.firmName && settings.firmName.trim()) || clientName;
  const firmCity = (settings.firmCity && settings.firmCity.trim()) || (company.city ?? '');
  const firmState = (settings.firmState && settings.firmState.trim()) || (company.state ?? '');
  const accountantSignature =
    (settings.accountantSignature && settings.accountantSignature.trim()) ||
    (settings.reportFooter && settings.reportFooter.trim()) ||
    firmName;

  const asOf = ctx.asOfDate || ctx.periodEnd || '';
  const reportDate = ctx.reportDate || ctx.periodEnd || '';
  const reportTitle = ctx.letterType ? REPORT_LETTER_TITLES[ctx.letterType] : '';

  return {
    client_name: clientName,
    firm_name: firmName,
    firm_city: firmCity,
    firm_state: firmState,
    firm_city_state: cityState(firmCity, firmState),
    accountant_signature: accountantSignature,
    period_start_date: formatLongDate(ctx.periodStart),
    period_end_date: formatLongDate(ctx.periodEnd),
    as_of_date: formatLongDate(asOf),
    period_description: periodDescription(ctx.periodStart, ctx.periodEnd),
    basis_of_accounting: basisOfAccountingPhrase(ctx.basis),
    financial_statement_titles: financialStatementTitles(ctx.basis),
    letter_date: formatLongDate(reportDate),
    report_date: formatLongDate(reportDate),
    report_title: reportTitle,
  };
}

/**
 * Resolve a letter to its final substituted body HTML (no page chrome).
 * Returns the printed title, substituted body, and the resolved font stack.
 * The title prefers the letter's own `title` override; a blank/null override
 * falls back to the standard SSARS title for the type (then the letter name).
 */
export async function resolveLetterContent(
  letter: LetterRow,
  tenantId: string,
  companyId: string,
  ctx: Omit<LetterRenderContext, 'letterType'>,
): Promise<{ title: string; bodyHtml: string; fontStack: string }> {
  const letterType = letter.letterType as ReportLetterType;
  const values = await resolveLetterVariables(tenantId, companyId, { ...ctx, letterType });
  const bodyHtml = renderLetterBody(letter.bodyHtml, values);
  const override = letter.title && letter.title.trim();
  const title = override || REPORT_LETTER_TITLES[letterType] || letter.name;
  return { title, bodyHtml, fontStack: letterFontStack(letter.fontFamily) };
}

/** Escape text for the letter page wrapper (title/footer). */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Build a full standalone HTML page for a resolved letter, styled like a
 * business letter (title heading + body). Rendered to PDF via the same
 * Puppeteer HTML→PDF path as every other report-pack section.
 */
export function buildLetterPageHtml(opts: {
  title: string;
  bodyHtml: string;
  companyName: string;
  footer?: string;
  /** CSS font-family stack for the whole letter. Defaults to the standard stack. */
  fontStack?: string;
}): string {
  const footerBlock = opts.footer && opts.footer.trim()
    ? `<div class="footer">${esc(opts.footer).replace(/\n/g, '<br>')}</div>`
    : '';
  // A blank title (super-admin cleared it) omits the heading entirely rather
  // than printing an empty <h1>.
  const titleBlock = opts.title && opts.title.trim() ? `<h1>${esc(opts.title)}</h1>` : '';
  const fontStack = opts.fontStack || letterFontStack(null);
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body{font-family:${fontStack};margin:0;color:#111;font-size:13px;line-height:1.6}
    .page{padding:8px 0}
    .company{font-size:12px;color:#666;margin-bottom:4px}
    h1{font-size:20px;font-weight:700;margin:0 0 20px}
    .body p{margin:0 0 14px}
    .footer{margin-top:28px;padding-top:10px;border-top:1px solid #ddd;font-size:11px;color:#666}
  </style></head><body>
    <div class="page">
      <div class="company">${esc(opts.companyName)}</div>
      ${titleBlock}
      <div class="body">${opts.bodyHtml}</div>
      ${footerBlock}
    </div>
  </body></html>`;
}
