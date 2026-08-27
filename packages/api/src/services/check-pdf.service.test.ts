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

describe('toMailRows — standard mailing formatting', () => {
  it('splits a single-field blob so City, ST ZIP is its own row', async () => {
    const { _internal } = await import('./check-pdf.service.js');
    expect(_internal.toMailRows(['123 Main St, Springfield, MO 65807']))
      .toEqual(['123 Main St', 'Springfield, MO 65807']);
    expect(_internal.toMailRows(['1200 Vendor Avenue, Suite 400, Kansas City, MO 64105']))
      .toEqual(['1200 Vendor Avenue', 'Suite 400', 'Kansas City, MO 64105']);
  });
  it('leaves already-structured rows unchanged', async () => {
    const { _internal } = await import('./check-pdf.service.js');
    expect(_internal.toMailRows(['123 Main St', 'Springfield, MO 65807']))
      .toEqual(['123 Main St', 'Springfield, MO 65807']);
  });
  it('handles ZIP+4 and normalizes state case', async () => {
    const { _internal } = await import('./check-pdf.service.js');
    expect(_internal.toMailRows(['500 Oak Rd, Austin, tx 78701-1234']))
      .toEqual(['500 Oak Rd', 'Austin, TX 78701-1234']);
  });
  it('leaves an unparseable address as entered', async () => {
    const { _internal } = await import('./check-pdf.service.js');
    expect(_internal.toMailRows(['PO Box 12']))
      .toEqual(['PO Box 12']);
  });
});

describe('toMailRows — real prod address shapes (single comma)', () => {
  const cases: Array<[string, string[]]> = [
    ['PO Box 3290, Sioux City MO 51102-3290', ['PO Box 3290', 'Sioux City, MO 51102-3290']],
    ['PO Box 497, Monett MO 65708', ['PO Box 497', 'Monett, MO 65708']],
    ['28883 Network Place, Chicago IL 60673-1288', ['28883 Network Place', 'Chicago, IL 60673-1288']],
  ];
  it('splits "street, City ST ZIP" into street + City, ST ZIP', async () => {
    const { _internal } = await import('./check-pdf.service.js');
    for (const [input, expected] of cases) {
      expect(_internal.toMailRows([input])).toEqual(expected);
    }
  });
});

// ── Check signature printing ──────────────────────────────────────

// 1×1 transparent PNG (valid file — embedPng parses it fully).
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

/** Inflate each page content stream; return them in page order. */
function pageStreams(pdf: Buffer): string[] {
  const streams: string[] = [];
  let idx = 0;
  while (true) {
    const s = pdf.indexOf('stream', idx);
    if (s === -1) break;
    const dataStart = pdf.indexOf('\n', s) + 1;
    const e = pdf.indexOf('endstream', dataStart);
    if (e === -1) break;
    try {
      const text = zlib.inflateSync(pdf.subarray(dataStart, e)).toString('latin1');
      if (text.includes('Tj') || text.includes(' Do')) streams.push(text);
    } catch { /* font/image data — ignore */ }
    idx = e + 9;
  }
  return streams;
}

/** Decode every hex-string Tj operand in a content stream. */
function decodeTexts(stream: string): string[] {
  return [...stream.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)].map((m) => Buffer.from(m[1]!, 'hex').toString('latin1'));
}

function makeCheckData(overrides: Record<string, unknown> = {}) {
  return {
    checkNumber: 1001,
    date: '2026-08-12',
    payeeName: 'SIGNED PAYEE',
    amount: '100.00',
    amountInWords: 'One Hundred and 00/100',
    memo: '',
    company: { name: 'Sig Co', address: '482 Commerce Way, Springfield, MO 65807', line1: '482 Commerce Way', line2: '', cityStateZip: 'Springfield, MO 65807', phone: '' },
    payeeAddressLines: ['1200 Vendor Avenue', 'Kansas City, MO 64105'],
    bank: { name: 'First Bank', address: '100 Bank St, Springfield, MO 65807', routing: '081000032', account: '123456', fractional: '' },
    printCompanyInfo: true,
    printSignatureLine: true,
    printDateLine: true,
    printPayeeLine: true,
    printPayeeAddress: false,
    printAmountBox: true,
    printAmountWords: true,
    printMemoLine: true,
    printBankInfo: true,
    printMicrLine: false,
    printCheckNumber: true,
    printVoucherStub: false,
    offsetX: 0,
    offsetY: 0,
    applySignature: true,
    ...overrides,
  };
}

describe('renderChecksPdf — signature image', () => {
  const signature = { bytes: TINY_PNG, mime: 'image/png', maxAmount: null };

  it('paints the image on signed pages and skips over-cap pages in the same batch', async () => {
    const { _internal } = await import('./check-pdf.service.js');
    const pdf = await _internal.renderChecksPdf([
      makeCheckData({ applySignature: true }) as any,
      makeCheckData({ applySignature: false, payeeName: 'OVER CAP PAYEE' }) as any,
    ], 'voucher', signature as any);
    const doc = await PDFDocument.load(pdf);
    expect(doc.getPageCount()).toBe(2);
    const streams = pageStreams(pdf);
    expect(streams).toHaveLength(2);
    expect(streams[0]).toMatch(/ Do\b/);      // XObject painted
    expect(streams[1]).not.toMatch(/ Do\b/);  // over-cap page unsigned
  });

  it('draws the rule and caption AFTER the image so the line prints on top', async () => {
    const { _internal } = await import('./check-pdf.service.js');
    const pdf = await _internal.renderChecksPdf([makeCheckData() as any], 'voucher', signature as any);
    const stream = pageStreams(pdf)[0]!;
    const doIdx = stream.search(/ Do\b/);
    expect(doIdx).toBeGreaterThan(-1);
    const captionHex = Buffer.from('AUTHORIZED SIGNATURE', 'latin1').toString('hex').toUpperCase();
    const capIdx = stream.toUpperCase().indexOf(captionHex);
    expect(capIdx).toBeGreaterThan(doIdx);
  });

  it('draws the signature line on a signed check even when printSignatureLine is off', async () => {
    const { _internal } = await import('./check-pdf.service.js');
    const pdf = await _internal.renderChecksPdf(
      [makeCheckData({ printSignatureLine: false }) as any], 'voucher', signature as any);
    expect(decodeTexts(pageStreams(pdf)[0]!)).toContain('AUTHORIZED SIGNATURE');
    // And without a signature, the toggle still controls the caption.
    const off = await _internal.renderChecksPdf(
      [makeCheckData({ printSignatureLine: false, applySignature: false }) as any], 'voucher');
    expect(decodeTexts(pageStreams(off)[0]!)).not.toContain('AUTHORIZED SIGNATURE');
  });

  it('renders a valid signed page on all three layouts', async () => {
    const { _internal } = await import('./check-pdf.service.js');
    for (const format of ['voucher', 'check_middle', 'z_fold']) {
      const pdf = await _internal.renderChecksPdf([makeCheckData() as any], format, signature as any);
      const doc = await PDFDocument.load(pdf);
      expect(doc.getPageCount()).toBe(1);
      expect(pageStreams(pdf)[0]).toMatch(/ Do\b/);
    }
  });
});

describe('compact (z_fold) face — structured address rows', () => {
  it('prints company and bank City, ST ZIP on their own rows', async () => {
    const { _internal } = await import('./check-pdf.service.js');
    const pdf = await _internal.renderChecksPdf([makeCheckData() as any], 'z_fold');
    const texts = decodeTexts(pageStreams(pdf)[0]!);
    // Company block: structured rows, not the one-line join.
    expect(texts).toContain('482 Commerce Way');
    expect(texts).toContain('Springfield, MO 65807');
    expect(texts).not.toContain('482 Commerce Way, Springfield, MO 65807');
    // Bank block: toMailRows split of the stored one-line address.
    expect(texts).toContain('100 Bank St');
    expect(texts).not.toContain('100 Bank St, Springfield, MO 65807');
  });
});

// The bill-payment voucher stub itemizes every bill, so repeating the derived
// "these are the bill numbers" memo above the table would spend a row saying
// the same thing twice. A memo the payer actually typed does carry new
// information and is worth the row.
describe('bill-payment stub memo', () => {
  const billPaymentCheck = (memo: string) => makeCheckData({
    memo,
    printVoucherStub: true,
    applySignature: false,
    billPaymentBills: [
      { txnNumber: 'BILL-1000', vendorInvoiceNumber: 'INV-2026-0401', txnDate: '2026-07-15', description: null, originalAmount: '50.00', paidAmount: '50.00' },
      { txnNumber: 'BILL-1001', vendorInvoiceNumber: 'INV-2026-0402', txnDate: '2026-07-15', description: null, originalAmount: '50.00', paidAmount: '50.00' },
    ],
    billPaymentCredits: [],
    billPaymentTotalBills: '100.00',
    billPaymentTotalCredits: '0.00',
  });

  it('omits a memo that only restates the bill numbers in the table', async () => {
    const { _internal } = await import('./check-pdf.service.js');
    const pdf = await _internal.renderChecksPdf([billPaymentCheck('INV-2026-0401, INV-2026-0402') as any], 'voucher');
    const texts = decodeTexts(pageStreams(pdf)[0]!);
    expect(texts.some((t) => t.startsWith('Memo: '))).toBe(false);
    // Still printed on the check face itself.
    expect(texts).toContain('INV-2026-0401, INV-2026-0402');
  });

  it('omits it too when the derived list was trimmed with a +N more tail', async () => {
    const { _internal } = await import('./check-pdf.service.js');
    const pdf = await _internal.renderChecksPdf([billPaymentCheck('INV-2026-0401 +1 more') as any], 'voucher');
    const texts = decodeTexts(pageStreams(pdf)[0]!);
    expect(texts.some((t) => t.startsWith('Memo: '))).toBe(false);
  });

  it('prints a memo the payer typed', async () => {
    const { _internal } = await import('./check-pdf.service.js');
    const pdf = await _internal.renderChecksPdf([billPaymentCheck('Acct 55-2291') as any], 'voucher');
    const texts = decodeTexts(pageStreams(pdf)[0]!);
    expect(texts).toContain('Memo: Acct 55-2291');
  });
});
