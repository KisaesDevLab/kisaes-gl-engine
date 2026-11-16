// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// Per-company 1099 reporting thresholds (U-215, capability
// 1099-thresholds-v1, ClientLedger P29, Q-PR6i).
//
// An Admin may set the company's own threshold for any 1099 box; a box
// without one uses the year table (boxThreshold, U-212). Amounts are decimal
// strings in and out, stored numeric(19,4), compared in Decimal; never a
// float on the way in or out.
//
// Every threshold check of the 1099 Summary, 1099 Preparation and the 1099
// Center goes through threshold1099Resolver, so they can't disagree:
// - per box: the company's amount for the box, else boxThreshold;
// - the general threshold (1099 Preparation over_threshold, the Center's
//   "over threshold" tile, vendor status and threshold scan): the company's
//   NEC-1 amount, else general1099Threshold.
// Which company: the report's company. A tenant-wide caller (the 1099 Center,
// a consolidated report; companyId null) uses the overrides of the tenant's
// only company; a tenant with several companies uses the year table there.

import { and, eq, count } from 'drizzle-orm';
import { db } from '../db/index.js';
import { companies, company1099Thresholds } from '../db/schema/index.js';
import { auditLog } from '../middleware/audit.js';
import { AppError } from '../utils/errors.js';
import { FORM_1099_BOXES, boxThreshold, general1099Threshold, type FormBox } from './portal-1099.boxes.js';
import { dec, exactStr } from './report-exact.js';

/** Non-negative decimal: digits, optional point and at most 4 places; no sign, exponent or grouping. */
export const THRESHOLD_AMOUNT_RE = /^\d{1,15}(\.\d{1,4})?$/;

export type ThresholdOverrides = Partial<Record<FormBox, string>>;

async function loadOverrides(tenantId: string, companyId: string): Promise<ThresholdOverrides> {
  const rows = await db.select({ formBox: company1099Thresholds.formBox, amount: company1099Thresholds.amount })
    .from(company1099Thresholds)
    .where(and(eq(company1099Thresholds.tenantId, tenantId), eq(company1099Thresholds.companyId, companyId)));
  const out: ThresholdOverrides = {};
  for (const r of rows) {
    if (FORM_1099_BOXES.some((b) => b.value === r.formBox)) out[r.formBox as FormBox] = exactStr(r.amount);
  }
  return out;
}

/** The company whose overrides apply: the given one, else the tenant's only company, else none. */
async function effectiveCompany(tenantId: string, companyId: string | null): Promise<string | null> {
  if (companyId) return companyId;
  const [n] = await db.select({ c: count() }).from(companies).where(eq(companies.tenantId, tenantId));
  if (Number(n?.c ?? 0) !== 1) return null;
  const [only] = await db.select({ id: companies.id }).from(companies).where(eq(companies.tenantId, tenantId)).limit(1);
  return only?.id ?? null;
}

export interface Threshold1099Resolver {
  /** The box's threshold for payments made in `year` (decimal string). */
  box(box: FormBox, year: number): string;
  /** The general (6041 / 6041A) threshold for `year`: the NEC-1 override, else the year table. */
  general(year: number): string;
}

export function resolverFrom(overrides: ThresholdOverrides): Threshold1099Resolver {
  return {
    box: (box, year) => overrides[box] ?? boxThreshold(box, year),
    general: (year) => overrides['NEC-1'] ?? general1099Threshold(year),
  };
}

/** Thresholds for the company of a report or 1099 Center call (see the file header for null). */
export async function threshold1099Resolver(tenantId: string, companyId: string | null): Promise<Threshold1099Resolver> {
  const target = await effectiveCompany(tenantId, companyId);
  return resolverFrom(target ? await loadOverrides(tenantId, target) : {});
}

export interface Company1099ThresholdsView {
  year: number;
  boxes: Array<{
    box: FormBox;
    form: string;
    boxNumber: string;
    label: string;
    /** The company's own amount, or null (the year table applies). */
    amount: string | null;
    /** The year table amount for `year`. */
    defaultExact: string;
    /** What reports use for `year`: amount, else defaultExact. */
    effectiveExact: string;
  }>;
}

export async function getCompany1099Thresholds(tenantId: string, companyId: string, year: number): Promise<Company1099ThresholdsView> {
  const overrides = await loadOverrides(tenantId, companyId);
  return {
    year,
    boxes: FORM_1099_BOXES.map((b) => {
      const defaultExact = exactStr(boxThreshold(b.value, year));
      const amount = overrides[b.value] ?? null;
      return { box: b.value, form: b.form, boxNumber: b.box, label: b.label, amount, defaultExact, effectiveExact: amount ?? defaultExact };
    }),
  };
}

/**
 * Sets (decimal string) or clears (null) the company's amount for each box
 * named in `thresholds`; boxes left out keep theirs. One transaction; one
 * audit row update company_1099_thresholds {box: amount | null} before and
 * after, for the boxes that changed.
 */
export async function putCompany1099Thresholds(
  tenantId: string,
  companyId: string,
  thresholds: Partial<Record<FormBox, string | null>>,
  userId: string | undefined,
): Promise<void> {
  for (const [box, amount] of Object.entries(thresholds)) {
    if (!FORM_1099_BOXES.some((b) => b.value === box)) {
      throw AppError.badRequest(`Unknown 1099 box ${box}`, 'VALIDATION_ERROR', { box });
    }
    if (amount !== null && amount !== undefined && !THRESHOLD_AMOUNT_RE.test(amount)) {
      throw AppError.badRequest('A 1099 threshold is an amount of 0 or more, like 600 or 600.00.', 'VALIDATION_ERROR', { box });
    }
  }
  await db.transaction(async (tx) => {
    // Serialise writers of this company's thresholds on the company row.
    const [company] = await tx.select({ id: companies.id }).from(companies)
      .where(and(eq(companies.tenantId, tenantId), eq(companies.id, companyId))).for('update').limit(1);
    if (!company) throw AppError.notFound('Company not found');
    const rows = await tx.select({ formBox: company1099Thresholds.formBox, amount: company1099Thresholds.amount })
      .from(company1099Thresholds)
      .where(and(eq(company1099Thresholds.tenantId, tenantId), eq(company1099Thresholds.companyId, companyId)));
    const current = new Map(rows.map((r) => [r.formBox, exactStr(r.amount)]));
    const before: Record<string, string | null> = {};
    const after: Record<string, string | null> = {};
    for (const [box, amount] of Object.entries(thresholds)) {
      if (amount === undefined) continue;
      const was = current.get(box) ?? null;
      const next = amount === null ? null : exactStr(dec(amount));
      if (was === next) continue;
      before[box] = was;
      after[box] = next;
      if (next === null) {
        await tx.delete(company1099Thresholds).where(and(
          eq(company1099Thresholds.tenantId, tenantId), eq(company1099Thresholds.companyId, companyId), eq(company1099Thresholds.formBox, box),
        ));
      } else {
        await tx.insert(company1099Thresholds)
          .values({ tenantId, companyId, formBox: box, amount: next, updatedBy: userId ?? null, updatedAt: new Date() })
          .onConflictDoUpdate({
            target: [company1099Thresholds.companyId, company1099Thresholds.formBox],
            set: { amount: next, updatedBy: userId ?? null, updatedAt: new Date() },
          });
      }
    }
    if (Object.keys(after).length > 0) {
      await auditLog(tenantId, 'update', 'company_1099_thresholds', companyId, before, after, userId, tx);
    }
  });
}
