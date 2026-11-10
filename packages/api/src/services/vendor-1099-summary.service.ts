// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// 1099 Summary by box (U-205, reports-exact-v1).
//
// One source with the 1099 Center: the per-box totals come from
// portal-1099.service ytdTotalsByBoxExact, the same account -> (form, box)
// mapping query the filing export uses, narrowed to the report's company.
// Amounts are decimal strings summed in Decimal; the threshold check is a
// Decimal comparison per box (royalties at $10, everything else at $600).

import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { contacts } from '../db/schema/index.js';
import { ytdTotalsByBoxExact } from './portal-1099.service.js';
import { BOX_THRESHOLDS, FORM_1099_BOXES, type FormBox } from './portal-1099.boxes.js';
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

export async function buildVendor1099SummaryByBox(
  tenantId: string,
  year: number,
  companyId: string | null,
): Promise<Vendor1099Summary> {
  // Same filter as the 1099 Center: a (vendor, box) bucket counts when positive.
  const buckets = (await ytdTotalsByBoxExact(tenantId, year, companyId)).filter((b) => dec(b.total).gt(0));
  const contactIds = [...new Set(buckets.map((b) => b.contactId))];
  const people = contactIds.length > 0
    ? await db.select({
        id: contacts.id, displayName: contacts.displayName, taxId: contacts.taxId, is1099Eligible: contacts.is1099Eligible,
      }).from(contacts).where(and(eq(contacts.tenantId, tenantId), inArray(contacts.id, contactIds)))
    : [];
  const byId = new Map(people.map((p) => [p.id, p]));

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
      is1099Eligible: !!p?.is1099Eligible,
      boxes,
      totalExact: exactStr(dsum(entries.map(([, v]) => v))),
      meetsThreshold: entries.some(([box, v]) => dec(v).gte(dec(BOX_THRESHOLDS[box]))),
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
      box: b.value, form: b.form, boxNumber: b.box, label: b.label, thresholdExact: exactStr(BOX_THRESHOLDS[b.value]),
    })),
    rows,
    totalsExact,
  };
}
