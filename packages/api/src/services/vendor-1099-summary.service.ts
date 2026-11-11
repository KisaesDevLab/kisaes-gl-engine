// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// 1099 Summary by box (U-205, reports-exact-v1).
//
// One source with the 1099 Center: the per-box totals come from
// portal-1099.service ytdTotalsByBoxExact, the same account -> (form, box)
// mapping query the filing export uses, narrowed to the report's company.
// Amounts are decimal strings summed in Decimal; the threshold check is a
// Decimal comparison per box at the report year's threshold (boxThreshold,
// U-212: royalties $10, attorney proceeds $600, the rest $600 through 2025
// and $2,000 from 2026).
//
// U-209 (ClientLedger P28 QA-8): the rows are the vendors the 1099 Center
// files for (exportFiling): marked 1099-eligible and not excluded on their
// 1099 profile. Payments to any other vendor from a mapped account are
// not 1099 amounts and are left out (before: every vendor paid from a
// mapped account was listed, with is1099Eligible false).

import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { contacts, vendor1099Profile } from '../db/schema/index.js';
import { ytdTotalsByBoxExact } from './portal-1099.service.js';
import { FORM_1099_BOXES, boxThreshold, type FormBox } from './portal-1099.boxes.js';
import { dec, dsum, exactStr } from './report-exact.js';

export interface Vendor1099SummaryRow {
  contactId: string;
  name: string;
  /** Last four digits of the vendor's tax id, or null when none is on file. Never the full number. */
  tinLast4: string | null;
  is1099Eligible: boolean;
  /** Box code (e.g. 'NEC-1', 'MISC-1') -> exact amount; only boxes with a positive amount. */
  boxes: Partial<Record<FormBox, string>>;
  totalExact: string;
  /** True when any box reaches its reporting threshold. */
  meetsThreshold: boolean;
}

export interface Vendor1099Summary {
  title: string;
  year: string;
  boxCatalog: Array<{ box: FormBox; form: string; boxNumber: string; label: string; thresholdExact: string }>;
  rows: Vendor1099SummaryRow[];
  /** Per box and `total`, the Decimal sum of the rows. */
  totalsExact: Partial<Record<FormBox | 'total', string>>;
}

export function tinLast4(taxId: string | null | undefined): string | null {
  const digits = (taxId ?? '').replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
}

/**
 * The (vendor, box) buckets of the vendors the 1099 Center files for: a
 * positive bucket (as the 1099 Center) of a vendor marked 1099-eligible and
 * not excluded on its 1099 profile (as exportFiling). Shared by the 1099
 * Summary and 1099 Preparation's reportable amounts (U-209) so the two
 * cannot disagree.
 */
export async function reportable1099Buckets(tenantId: string, year: number, companyId: string | null) {
  const all = (await ytdTotalsByBoxExact(tenantId, year, companyId)).filter((b) => dec(b.total).gt(0));
  const contactIds = [...new Set(all.map((b) => b.contactId))];
  if (contactIds.length === 0) return { buckets: all, people: new Map<string, never>() };
  const [people, excluded] = await Promise.all([
    db.select({
      id: contacts.id, displayName: contacts.displayName, taxId: contacts.taxId, is1099Eligible: contacts.is1099Eligible,
    }).from(contacts).where(and(eq(contacts.tenantId, tenantId), inArray(contacts.id, contactIds))),
    db.select({ contactId: vendor1099Profile.contactId, exclusionReason: vendor1099Profile.exclusionReason })
      .from(vendor1099Profile)
      .where(and(eq(vendor1099Profile.tenantId, tenantId), inArray(vendor1099Profile.contactId, contactIds))),
  ]);
  const excludedIds = new Set(excluded.filter((p) => !!p.exclusionReason).map((p) => p.contactId));
  const eligible = new Map(people.filter((p) => p.is1099Eligible && !excludedIds.has(p.id)).map((p) => [p.id, p]));
  return { buckets: all.filter((b) => eligible.has(b.contactId)), people: eligible };
}

export async function buildVendor1099SummaryByBox(
  tenantId: string,
  year: number,
  companyId: string | null,
): Promise<Vendor1099Summary> {
  const { buckets, people: byId } = await reportable1099Buckets(tenantId, year, companyId);

  const perVendor = new Map<string, Partial<Record<FormBox, string>>>();
  for (const b of buckets) {
    const boxes = perVendor.get(b.contactId) ?? {};
    boxes[b.formBox] = exactStr(dec(boxes[b.formBox]).plus(dec(b.total)));
    perVendor.set(b.contactId, boxes);
  }

  const rows: Vendor1099SummaryRow[] = [...perVendor.entries()].map(([contactId, boxes]) => {
    const p = byId.get(contactId);
    const entries = Object.entries(boxes) as Array<[FormBox, string]>;
    return {
      contactId,
      name: p?.displayName ?? '',
      tinLast4: tinLast4(p?.taxId),
      // Always true since U-209 (only eligible vendors are listed); kept for the contract.
      is1099Eligible: true,
      boxes,
      totalExact: exactStr(dsum(entries.map(([, v]) => v))),
      meetsThreshold: entries.some(([box, v]) => dec(v).gte(dec(boxThreshold(box, year)))),
    };
  }).sort((a, b) => a.name.localeCompare(b.name) || a.contactId.localeCompare(b.contactId));

  const totalsExact: Partial<Record<FormBox | 'total', string>> = {};
  for (const { value } of FORM_1099_BOXES) {
    const vals = rows.map((r) => r.boxes[value]).filter((v): v is string => v !== undefined);
    if (vals.length > 0) totalsExact[value] = exactStr(dsum(vals));
  }
  totalsExact.total = exactStr(dsum(rows.map((r) => r.totalExact)));

  return {
    title: '1099 Summary',
    year: String(year),
    boxCatalog: FORM_1099_BOXES.map((b) => ({
      box: b.value, form: b.form, boxNumber: b.box, label: b.label, thresholdExact: exactStr(boxThreshold(b.value, year)),
    })),
    rows,
    totalsExact,
  };
}
