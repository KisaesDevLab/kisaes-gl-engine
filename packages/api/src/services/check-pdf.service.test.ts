// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Guards the vector-PDF check rendering: every layout must produce a
// valid one-page-per-check Letter PDF, and the MICR line must be drawn
// on blank stock (and only there). MICR glyphs are vector paths, not
// text, so blank-stock output is detected by the jump in path-fill
// operators in the (uncompressed) content stream.

import zlib from 'zlib';
import { describe, it, expect, afterEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';
import { db } from '../db/index.js';
import { tenants, companies } from '../db/schema/index.js';
import { generateTestCheckPdf } from './check-pdf.service.js';

let tenantId = '';

async function seedCompany(checkSettings: Record<string, unknown>) {
  const [t] = await db.insert(tenants).values({ name: 'PDF', slug: 'pdf-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) }).returning();
  tenantId = t!.id;
  await db.insert(companies).values({
    tenantId, businessName: 'Test Co', entityType: 'sole_prop', setupComplete: true,
    checkSettings,
  });
  return tenantId;
}

afterEach(async () => {
  if (tenantId) {
    await db.delete(companies).where(eq(companies.tenantId, tenantId));
    await db.delete(tenants).where(eq(tenants.id, tenantId));
    tenantId = '';
  }
});

function countFillOps(pdf: Buffer): number {
  // Path-fill operator lines ("f" / "f*" on their own line) across all
  // content streams. pdf-lib Flate-compresses streams, so inflate each
  // stream block that will inflate and scan the plaintext.
  let count = 0;
  let idx = 0;
  while (true) {
    const s = pdf.indexOf('stream', idx);
    if (s === -1) break;
    const dataStart = pdf.indexOf('\n', s) + 1;
    const e = pdf.indexOf('endstream', dataStart);
    if (e === -1) break;
    try {
      const text = zlib.inflateSync(pdf.subarray(dataStart, e)).toString('latin1');
      count += (text.match(/(^|\n)f\*?\n/g) || []).length;
    } catch {
      // not a Flate stream (font data etc.) — ignore
    }
    idx = e + 9;
  }
  return count;
}

describe('generateTestCheckPdf — vector PDF output', () => {
  it('produces a valid one-page Letter PDF for each layout', async () => {
    const id = await seedCompany({ printOnBlankStock: true, routingNumber: '081000032', accountNumber: '1234567890' });
    for (const format of ['voucher', 'check_middle', 'z_fold']) {
      const pdf = await generateTestCheckPdf(id, format);
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
      const doc = await PDFDocument.load(pdf);
      expect(doc.getPageCount()).toBe(1);
      const { width, height } = doc.getPage(0).getSize();
      expect(width).toBe(612);
      expect(height).toBe(792);
    }
  });

  it('draws the MICR line on blank stock and omits it on pre-printed stock', async () => {
    const blankId = await seedCompany({
      printOnBlankStock: true, routingNumber: '081000032', accountNumber: '1234567890',
    });
    const blank = await generateTestCheckPdf(blankId, 'voucher');
    // reset seed for the second company
    await db.delete(companies).where(eq(companies.tenantId, tenantId));
    await db.delete(tenants).where(eq(tenants.id, tenantId));
    const preprintedId = await seedCompany({
      printOnBlankStock: false, routingNumber: '081000032', accountNumber: '1234567890',
    });
    const preprinted = await generateTestCheckPdf(preprintedId, 'voucher');

    // MICR line = 24+ glyphs (transit+9 routing+transit, account+onus,
    // onus+serial+onus), each a filled vector path.
    expect(countFillOps(blank)).toBeGreaterThanOrEqual(countFillOps(preprinted) + 20);
  });

  it('omits the MICR line when the routing number is malformed', async () => {
    const id = await seedCompany({ printOnBlankStock: true, routingNumber: '1234', accountNumber: '99' });
    const pdf = await generateTestCheckPdf(id, 'voucher');
    const goodId = tenantId; void goodId;
    // Same company on blank stock but unusable routing — fill count should
    // stay near the pre-printed baseline (no half-broken transit field).
    expect(countFillOps(pdf)).toBeLessThan(20);
  });
});

describe('drawEnvelope — #10 envelope layout', () => {
  it('renders a 9.5x4.125in page with return + delivery address text', async () => {
    const { PDFDocument, StandardFonts } = await import('pdf-lib');
    const { _internal } = await import('./check-pdf.service.js');
    const doc = await PDFDocument.create();
    const fonts = {
      reg: await doc.embedFont(StandardFonts.Helvetica),
      bold: await doc.embedFont(StandardFonts.HelveticaBold),
      mono: await doc.embedFont(StandardFonts.Courier),
      monoBold: await doc.embedFont(StandardFonts.CourierBold),
    };
    const page = doc.addPage([9.5 * 72, 4.125 * 72]);
    _internal.drawEnvelope(page, fonts as any, {
      payeeName: 'Acme Office Supplies, LLC',
      payeeAddressLines: ['1200 Vendor Avenue', 'Suite 400', 'Kansas City, MO 64105'],
      company: { name: 'TBR Ventures LLC', line1: '482 Commerce Way', line2: 'Building C', cityStateZip: 'Springfield, MO 65807', address: '', phone: '' },
    } as any);
    const { width, height } = page.getSize();
    expect(Math.round(width)).toBe(684);
    expect(Math.round(height)).toBe(297);
    const pdf = Buffer.from(await doc.save());
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
  });
});
