// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Workpaper period-end scoping (migration 0208). Tickmark applications,
// TB notes and leadsheet sign-offs belong to the workpaper PERIOD END —
// the TB as-of date picked in the TB header (07/31 vs 08/31) — exactly
// like tb_row_attachments. tax_year is still stored, but is DERIVED from
// the period end under the company's fiscal calendar (rule TB10); the
// client never chooses it independently.
//
// Defaults (reads only): a caller that omits periodEnd gets the fiscal-
// year end of the taxYear it passed (or of the current tax year). Writes
// require an explicit periodEnd at the route layer. The web always sends
// periodEnd.

import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { companies } from '../../db/schema/index.js';
import { AppError } from '../../utils/errors.js';
import { fiscalYearEnd, taxYearOf } from './tax-profile.service.js';

const isRealIsoDate = (s: string) => {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

// YYYY-MM-DD that is also a real calendar date (rejects 2026-02-30).
export const periodEndSchema = z.string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'periodEnd must be YYYY-MM-DD')
  .refine(isRealIsoDate, 'periodEnd is not a valid date');

export interface PeriodScope {
  periodEnd: string;
  taxYear: number;
}

export async function companyFyStartMonth(tenantId: string, companyId: string): Promise<number> {
  const [c] = await db.select({ m: companies.fiscalYearStartMonth }).from(companies)
    .where(and(eq(companies.tenantId, tenantId), eq(companies.id, companyId)))
    .limit(1);
  if (!c) throw AppError.notFound('Company not found');
  return c.m ?? 1;
}

// Resolve { periodEnd, taxYear } for a request. periodEnd wins; else the
// FY end of taxYear; else the FY end of the current tax year.
export async function resolvePeriodScope(
  tenantId: string,
  companyId: string,
  input: { periodEnd?: string | null; taxYear?: number | null },
): Promise<PeriodScope> {
  const m = await companyFyStartMonth(tenantId, companyId);
  if (input.periodEnd) {
    if (!isRealIsoDate(input.periodEnd)) throw AppError.badRequest('periodEnd is not a valid date');
    return { periodEnd: input.periodEnd, taxYear: taxYearOf(input.periodEnd, m) };
  }
  const taxYear = input.taxYear ?? taxYearOf(new Date().toISOString().slice(0, 10), m);
  return { periodEnd: fiscalYearEnd(taxYear, m), taxYear };
}
