// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Check rendering as a true vector PDF via pdf-lib (no HTML/Puppeteer).
// Checks are dimension-critical documents: the MICR line must land in the
// bank's read band (ANSI X9.100-160-1) and browser print scaling/margins
// made the HTML path unreliable. Drawing at exact point coordinates and
// returning a print-ready PDF removes every scaling variable except the
// operator remembering to print at 100% ("Actual size").
//
// Layouts (page is always Letter, one check per page):
//   voucher      — check face on top 3.5", stub below (top-perf stock)
//   check_middle — stub / check face at 3.67" / stub (middle-check stock)
//   z_fold       — pressure-seal self-mailer, coupon in the middle panel
//
// The MICR line is drawn with vector E-13B glyphs — see check-micr.ts.

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { companies, contacts, transactions, billPaymentApplications, vendorCreditApplications } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { layoutMicrLine, drawMicrLine } from './check-micr.js';

// ── Data gathering (unchanged semantics from the HTML renderer) ───

interface BillPaymentStubLine {
  txnNumber: string | null;
  vendorInvoiceNumber: string | null;
  txnDate: string;
  description: string | null;
  originalAmount: string;
  paidAmount: string;
}

interface VendorCreditStubLine {
  txnNumber: string | null;
  txnDate: string;
  description: string | null;
  amount: string;
}

export interface CheckData {
  checkNumber: number | null;
  date: string;
  payeeName: string;
  amount: string;
  amountInWords: string;
  memo: string;
  company: { name: string; address: string; city: string; phone: string };
  bank: { name: string; address: string; routing: string; account: string; fractional: string };
  printCompanyInfo: boolean;
  printSignatureLine: boolean;
  printDateLine: boolean;
  printPayeeLine: boolean;
  printAmountBox: boolean;
  printAmountWords: boolean;
  printMemoLine: boolean;
  printBankInfo: boolean;
  printMicrLine: boolean;
  printCheckNumber: boolean;
  printVoucherStub: boolean;
  offsetX: number;
  offsetY: number;
  billPaymentBills?: BillPaymentStubLine[];
  billPaymentCredits?: VendorCreditStubLine[];
  billPaymentTotalBills?: string;
  billPaymentTotalCredits?: string;
}

async function gatherCheckData(tenantId: string, checkId: string): Promise<CheckData> {
  const txn = await db.query.transactions.findFirst({
    where: and(eq(transactions.tenantId, tenantId), eq(transactions.id, checkId)),
  });
  if (!txn) throw AppError.notFound('Check not found');

  const company = await db.query.companies.findFirst({ where: eq(companies.tenantId, tenantId) });
  if (!company) throw AppError.internal('Company not found');

  const settings = (company.checkSettings as Record<string, any>) || {};
  const { numberToWords } = await import('@kis-books/shared');

  let payeeName = txn.payeeNameOnCheck || '';
  let billPaymentBills: BillPaymentStubLine[] | undefined;
  let billPaymentCredits: VendorCreditStubLine[] | undefined;
  let billPaymentTotalBills: string | undefined;
  let billPaymentTotalCredits: string | undefined;

  if (txn.txnType === 'bill_payment') {
    if (!payeeName && txn.contactId) {
      const vendor = await db.query.contacts.findFirst({
        where: and(eq(contacts.tenantId, tenantId), eq(contacts.id, txn.contactId)),
      });
      if (vendor) payeeName = vendor.displayName;
    }

    const billRows = await db.select({
      txnNumber: transactions.txnNumber,
      vendorInvoiceNumber: transactions.vendorInvoiceNumber,
      txnDate: transactions.txnDate,
      memo: transactions.memo,
      total: transactions.total,
      paidAmount: billPaymentApplications.amount,
    }).from(billPaymentApplications)
      .leftJoin(transactions, eq(billPaymentApplications.billId, transactions.id))
      .where(and(
        eq(billPaymentApplications.tenantId, tenantId),
        eq(billPaymentApplications.paymentId, checkId),
      ));

    billPaymentBills = billRows.map((r) => ({
      txnNumber: r.txnNumber,
      vendorInvoiceNumber: r.vendorInvoiceNumber,
      txnDate: r.txnDate || '',
      description: r.memo,
      originalAmount: parseFloat(r.total || '0').toFixed(2),
      paidAmount: parseFloat(r.paidAmount || '0').toFixed(2),
    }));

    const creditRows = await db.select({
      txnNumber: transactions.txnNumber,
      txnDate: transactions.txnDate,
      memo: transactions.memo,
      amount: vendorCreditApplications.amount,
    }).from(vendorCreditApplications)
      .leftJoin(transactions, eq(vendorCreditApplications.creditId, transactions.id))
      .where(and(
        eq(vendorCreditApplications.tenantId, tenantId),
        eq(vendorCreditApplications.paymentId, checkId),
      ));

    billPaymentCredits = creditRows.map((r) => ({
      txnNumber: r.txnNumber,
      txnDate: r.txnDate || '',
      description: r.memo,
      amount: parseFloat(r.amount || '0').toFixed(2),
    }));

    const totalBills = billPaymentBills.reduce((s, b) => s + parseFloat(b.paidAmount), 0);
    const totalCredits = billPaymentCredits.reduce((s, c) => s + parseFloat(c.amount), 0);
    billPaymentTotalBills = totalBills.toFixed(2);
    billPaymentTotalCredits = totalCredits.toFixed(2);
  }

  return {
    checkNumber: txn.checkNumber,
    date: txn.txnDate,
    payeeName,
    amount: parseFloat(txn.total || '0').toFixed(2),
    amountInWords: numberToWords(parseFloat(txn.total || '0')),
    memo: txn.printedMemo || txn.memo || '',
    company: {
      name: company.businessName,
      address: [company.addressLine1, [company.city, company.state, company.zip].filter(Boolean).join(', ')].filter(Boolean).join(', '),
      city: [company.city, company.state, company.zip].filter(Boolean).join(', '),
      phone: company.phone || '',
    },
    bank: {
      name: settings['bankName'] || '',
      address: settings['bankAddress'] || '',
      routing: settings['routingNumber'] || '',
      account: settings['accountNumber'] || '',
      fractional: settings['fractionalRouting'] || '',
    },
    printCompanyInfo: settings['printCompanyInfo'] !== false,
    printSignatureLine: settings['printSignatureLine'] !== false,
    printDateLine: settings['printDateLine'] !== false,
    printPayeeLine: settings['printPayeeLine'] !== false,
    printAmountBox: settings['printAmountBox'] !== false,
    printAmountWords: settings['printAmountWords'] !== false,
    printMemoLine: settings['printMemoLine'] !== false,
    printBankInfo: !!settings['printOnBlankStock'] && settings['printBankInfo'] !== false,
    printMicrLine: !!settings['printOnBlankStock'] && settings['printMicrLine'] !== false,
    printCheckNumber: settings['printCheckNumber'] !== false,
    printVoucherStub: settings['printVoucherStub'] !== false,
    offsetX: settings['alignmentOffsetX'] || 0,
    offsetY: settings['alignmentOffsetY'] || 0,
    billPaymentBills,
    billPaymentCredits,
    billPaymentTotalBills,
    billPaymentTotalCredits,
  };
}

// ── Drawing primitives ────────────────────────────────────────────

const PAGE_W = 612; // 8.5in
const PAGE_H = 792; // 11in
const IN = 72;

const BLACK = rgb(0, 0, 0);
const GRAY = rgb(0.4, 0.4, 0.4);
const LIGHT = rgb(0.86, 0.86, 0.86);

interface Fonts { reg: PDFFont; bold: PDFFont; mono: PDFFont; monoBold: PDFFont }

interface Ctx {
  page: PDFPage;
  fonts: Fonts;
  /** printer alignment offsets, points */
  dx: number;
  dy: number;
}

// Standard PDF fonts encode WinAnsi only. Strip anything unencodable so
// an exotic character in a payee name can't 500 the whole print batch.
function sanitize(s: string | null | undefined): string {
  if (!s) return '';
  return [...s.replace(/[\r\n\t]+/g, ' ')]
    .map((ch) => {
      const c = ch.codePointAt(0)!;
      if (c >= 0x20 && c <= 0x7e) return ch;
      if (c >= 0xa0 && c <= 0xff) return ch;
      const map: Record<string, string> = { '–': '-', '—': '-', '‘': "'", '’': "'", '“': '"', '”': '"', '…': '...' };
      return map[ch] ?? '?';
    })
    .join('');
}

function fmtMoney(amount: string): string {
  const n = parseFloat(amount || '0');
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

interface TextOpts {
  font?: PDFFont;
  size?: number;
  color?: ReturnType<typeof rgb>;
  align?: 'left' | 'right' | 'center';
  /** truncate with ellipsis to fit */
  maxWidth?: number;
}

function drawText(ctx: Ctx, s: string, x: number, y: number, opts: TextOpts = {}): number {
  const font = opts.font ?? ctx.fonts.reg;
  const size = opts.size ?? 7.5;
  let text = sanitize(s);
  if (!text) return 0;
  if (opts.maxWidth) {
    while (text.length > 1 && font.widthOfTextAtSize(text, size) > opts.maxWidth) {
      text = text.slice(0, -1);
    }
  }
  const w = font.widthOfTextAtSize(text, size);
  let tx = x;
  if (opts.align === 'right') tx = x - w;
  else if (opts.align === 'center') tx = x - w / 2;
  ctx.page.drawText(text, { x: tx + ctx.dx, y: y + ctx.dy, size, font, color: opts.color ?? BLACK });
  return w;
}

function drawLine(ctx: Ctx, x1: number, y1: number, x2: number, y2: number, thickness = 0.75, color = BLACK, dash?: number[]): void {
  ctx.page.drawLine({
    start: { x: x1 + ctx.dx, y: y1 + ctx.dy },
    end: { x: x2 + ctx.dx, y: y2 + ctx.dy },
    thickness,
    color,
    ...(dash ? { dashArray: dash } : {}),
  });
}

function drawBox(ctx: Ctx, x: number, y: number, w: number, h: number, thickness = 1): void {
  ctx.page.drawRectangle({
    x: x + ctx.dx, y: y + ctx.dy, width: w, height: h,
    borderWidth: thickness, borderColor: BLACK, color: undefined,
  });
}

// ── Check face ────────────────────────────────────────────────────

/**
 * Draw the check face. faceTopY = PDF y of the face's top edge,
 * faceBottomY = PDF y of its bottom edge (the tear line the bank sees as
 * the document's aligning edge). compact = z_fold coupon proportions.
 *
 * The bottom 5/8" of the face is kept clear of everything except the
 * MICR line (ANSI X9.100-160-1 clear band).
 */
function drawCheckFace(ctx: Ctx, c: CheckData, faceTopY: number, faceBottomY: number, compact: boolean): void {
  const L = compact ? 21.6 : 18; // left margin (0.3in / 0.25in)
  const R = PAGE_W - (compact ? 21.6 : 18);

  // Company block
  if (c.printCompanyInfo) {
    let y = faceTopY - (compact ? 7.2 : 18) - (compact ? 7.5 : 8.25);
    drawText(ctx, c.company.name, L, y, { font: ctx.fonts.bold, size: compact ? 7.5 : 8.25, maxWidth: 260 });
    if (c.company.address) { y -= compact ? 8 : 8.75; drawText(ctx, c.company.address, L, y, { size: compact ? 6.5 : 6.75, maxWidth: 280 }); }
    if (c.company.phone) { y -= compact ? 8 : 8.75; drawText(ctx, c.company.phone, L, y, { size: compact ? 6.5 : 6.75 }); }
  }

  // Check number + fractional routing (top right)
  const nrX = PAGE_W - 36;
  if (c.printCheckNumber && c.checkNumber != null) {
    drawText(ctx, `No. ${c.checkNumber}`, nrX, faceTopY - (compact ? 7.2 : 18) - 7.5, { font: ctx.fonts.bold, size: 7.5, align: 'right' });
  }
  if (c.printBankInfo && c.bank.fractional) {
    drawText(ctx, c.bank.fractional, nrX, faceTopY - (compact ? 7.2 : 18) - 17.5, { size: 6, color: GRAY, align: 'right' });
  }

  // Date
  {
    const dateY = faceTopY - (compact ? 0.5 : 0.9) * IN - 8.25;
    const lineX1 = nrX - 100;
    if (c.printDateLine) {
      drawText(ctx, 'DATE', lineX1 - 6, dateY, { size: 6, color: GRAY, align: 'right' });
      drawLine(ctx, lineX1, dateY - 2.5, nrX, dateY - 2.5);
    }
    drawText(ctx, c.date, (lineX1 + nrX) / 2, dateY, { size: compact ? 7.5 : 8.25, align: 'center' });
  }

  // Payee
  {
    const topIn = compact ? 0.85 : 1.3;
    const labelY = faceTopY - topIn * IN - 6;
    const nameY = labelY - (compact ? 10 : 12);
    const ulY = nameY - 3;
    const ulX2 = PAGE_W - 1.6 * IN;
    if (c.printPayeeLine) {
      drawText(ctx, 'PAY TO THE ORDER OF', L, labelY, { size: compact ? 5.25 : 6, color: GRAY });
      drawLine(ctx, L, ulY, ulX2, ulY);
    }
    drawText(ctx, c.payeeName, L, nameY, { font: ctx.fonts.bold, size: 9, maxWidth: ulX2 - L - 6 });
  }

  // Amount box
  {
    const boxW = 1.2 * IN;
    const boxH = compact ? 18 : 20;
    const boxX = PAGE_W - (compact ? 0.3 : 0.25) * IN - boxW;
    const boxTop = faceTopY - (compact ? 0.82 : 1.3) * IN;
    if (c.printAmountBox) drawBox(ctx, boxX, boxTop - boxH, boxW, boxH, 1.5);
    drawText(ctx, `$${fmtMoney(c.amount)}`, boxX + boxW / 2, boxTop - boxH + (boxH - 10.5) / 2 + 2, {
      font: ctx.fonts.monoBold, size: 10.5, align: 'center', maxWidth: boxW - 6,
    });
  }

  // Amount in words with asterisk fill (fraud protection)
  if (c.printAmountWords) {
    const ulY = faceTopY - (compact ? 1.3 : 1.85) * IN - 13;
    const textY = ulY + 3;
    const x2 = PAGE_W - 0.5 * IN;
    drawLine(ctx, L, ulY, x2, ulY);
    const size = compact ? 7 : 7.5;
    const wordsW = drawText(ctx, c.amountInWords, L, textY, { size, maxWidth: x2 - L - 60 });
    const dollarsW = ctx.fonts.bold.widthOfTextAtSize('DOLLARS', size);
    drawText(ctx, 'DOLLARS', x2, textY, { font: ctx.fonts.bold, size, align: 'right' });
    // fill the gap with asterisks so the line can't be altered
    const gapX1 = L + wordsW + 6;
    const gapX2 = x2 - dollarsW - 6;
    if (gapX2 > gapX1) {
      const starW = ctx.fonts.reg.widthOfTextAtSize('*', size);
      const count = Math.floor((gapX2 - gapX1) / starW);
      if (count > 0) drawText(ctx, '*'.repeat(count), gapX1, textY, { size, color: GRAY });
    }
  }

  // Bank name/address (blank stock)
  if (c.printBankInfo && (c.bank.name || c.bank.address)) {
    let y = faceTopY - (compact ? 1.68 : 2.3) * IN - 6;
    if (c.bank.name) { drawText(ctx, c.bank.name, L, y, { size: compact ? 5.6 : 6, color: rgb(0.27, 0.27, 0.27) }); y -= 7; }
    if (c.bank.address) drawText(ctx, c.bank.address, L, y, { size: compact ? 5.6 : 6, color: rgb(0.27, 0.27, 0.27) });
  }

  // Memo + signature. Their rules sit at 0.65" from the bottom edge —
  // just above the 5/8" MICR clear band, which must stay empty.
  {
    const ruleY = faceBottomY + 0.65 * IN;
    if (c.printMemoLine) {
      drawText(ctx, 'MEMO', L, ruleY + 11, { size: 6, color: GRAY });
      drawLine(ctx, L, ruleY, L + 3 * IN, ruleY);
    }
    if (c.memo) drawText(ctx, c.memo, L + (c.printMemoLine ? 26 : 0), ruleY + 2.5, { size: 6.75, maxWidth: 3 * IN - 30 });
    if (c.printSignatureLine) {
      drawLine(ctx, R - (compact ? 2.4 : 2.5) * IN, ruleY, R, ruleY);
      drawText(ctx, 'AUTHORIZED SIGNATURE', R, ruleY - 8, { size: 5.25, color: GRAY, align: 'right' });
    }
  }

  // MICR line (blank stock only)
  if (c.printMicrLine) {
    const placed = layoutMicrLine({
      routingNumber: c.bank.routing,
      accountNumber: c.bank.account,
      checkNumber: c.checkNumber,
    });
    drawMicrLine(ctx.page, placed, {
      checkRightEdgeX: PAGE_W,
      checkBottomY: faceBottomY,
      offsetX: ctx.dx,
      offsetY: ctx.dy,
    });
  }
}

// ── Voucher stub ──────────────────────────────────────────────────

/** Draw the stub content inside the panel [stubTopY .. stubBottomY]. */
function drawStub(ctx: Ctx, c: CheckData, stubTopY: number, stubBottomY: number): void {
  const L = 21.6;
  const R = PAGE_W - 21.6;
  let y = stubTopY - 28;
  const isBillPayment = !!(c.billPaymentBills && c.billPaymentBills.length > 0);
  const checkNo = c.checkNumber != null ? String(c.checkNumber) : '____';

  if (!isBillPayment) {
    drawText(ctx, `Check #${checkNo}`, L, y, { font: ctx.fonts.bold, size: 7 });
    drawText(ctx, `Date: ${c.date}`, (L + R) / 2, y, { size: 7, align: 'center' });
    drawText(ctx, `Amount: $${fmtMoney(c.amount)}`, R, y, { size: 7, align: 'right' });
    y -= 13;
    drawText(ctx, `Pay to: ${c.payeeName}`, L, y, { size: 7, maxWidth: R - L });
    if (c.memo) { y -= 11; drawText(ctx, `Memo: ${c.memo}`, L, y, { size: 7, maxWidth: R - L }); }
    return;
  }

  // Bill-payment voucher: itemized bills and credits
  drawText(ctx, 'BILL PAYMENT VOUCHER', L, y, { font: ctx.fonts.bold, size: 7 });
  drawText(ctx, `Check #${checkNo}`, (L + R) / 2, y, { font: ctx.fonts.bold, size: 7, align: 'center' });
  drawText(ctx, `Date: ${c.date}`, R, y, { size: 7, align: 'right' });
  y -= 12;
  drawText(ctx, `Pay to: ${c.payeeName}`, L, y, { size: 7, maxWidth: R - L });
  y -= 13;

  // Column x positions
  const colBill = L, colInv = L + 100, colDate = L + 205, colOrig = R - 90, colPaid = R;
  drawText(ctx, 'Bill #', colBill, y, { font: ctx.fonts.bold, size: 6.4 });
  drawText(ctx, 'Vendor Inv #', colInv, y, { font: ctx.fonts.bold, size: 6.4 });
  drawText(ctx, 'Date', colDate, y, { font: ctx.fonts.bold, size: 6.4 });
  drawText(ctx, 'Original', colOrig, y, { font: ctx.fonts.bold, size: 6.4, align: 'right' });
  drawText(ctx, 'Paid', colPaid, y, { font: ctx.fonts.bold, size: 6.4, align: 'right' });
  y -= 3;
  drawLine(ctx, L, y, R, y, 0.5, GRAY);
  y -= 9;

  const bills = c.billPaymentBills!;
  const credits = c.billPaymentCredits || [];
  // Reserve space: totals block (~34pt) + credits section if present
  const totalsReserve = 40 + (credits.length > 0 ? 22 + credits.length * 9.5 : 0);
  const availableRows = Math.max(1, Math.floor((y - stubBottomY - totalsReserve) / 9.5));
  const shown = bills.length > availableRows ? bills.slice(0, Math.max(1, availableRows - 1)) : bills;

  for (const b of shown) {
    drawText(ctx, b.txnNumber || '', colBill, y, { size: 6.4, maxWidth: 95 });
    drawText(ctx, b.vendorInvoiceNumber || '', colInv, y, { size: 6.4, maxWidth: 100 });
    drawText(ctx, b.txnDate, colDate, y, { size: 6.4 });
    drawText(ctx, `$${fmtMoney(b.originalAmount)}`, colOrig, y, { font: ctx.fonts.mono, size: 6.4, align: 'right' });
    drawText(ctx, `$${fmtMoney(b.paidAmount)}`, colPaid, y, { font: ctx.fonts.mono, size: 6.4, align: 'right' });
    y -= 9.5;
  }
  if (shown.length < bills.length) {
    drawText(ctx, `+ ${bills.length - shown.length} more bills (see bill payment record)`, colBill, y, { size: 6.4, color: GRAY });
    y -= 9.5;
  }

  if (credits.length > 0) {
    y -= 4;
    drawText(ctx, 'Credits Applied:', L, y, { font: ctx.fonts.bold, size: 6.4 });
    y -= 9.5;
    for (const cr of credits) {
      drawText(ctx, cr.txnNumber || '', colBill, y, { size: 6.4, maxWidth: 95 });
      drawText(ctx, cr.txnDate, colInv, y, { size: 6.4 });
      drawText(ctx, cr.description || '', colDate, y, { size: 6.4, maxWidth: colOrig - colDate - 60 });
      drawText(ctx, `($${fmtMoney(cr.amount)})`, colPaid, y, { font: ctx.fonts.mono, size: 6.4, align: 'right' });
      y -= 9.5;
    }
  }

  // Totals
  y -= 3;
  drawLine(ctx, R - 170, y, R, y, 0.75);
  y -= 10;
  drawText(ctx, 'Total Bills:', R - 90, y, { size: 6.75, align: 'right' });
  drawText(ctx, `$${fmtMoney(c.billPaymentTotalBills || '0')}`, R, y, { font: ctx.fonts.mono, size: 6.75, align: 'right' });
  if (c.billPaymentTotalCredits && parseFloat(c.billPaymentTotalCredits) > 0) {
    y -= 10;
    drawText(ctx, 'Credits:', R - 90, y, { size: 6.75, align: 'right' });
    drawText(ctx, `($${fmtMoney(c.billPaymentTotalCredits)})`, R, y, { font: ctx.fonts.mono, size: 6.75, align: 'right' });
  }
  y -= 11;
  drawText(ctx, 'Check Total:', R - 90, y, { font: ctx.fonts.bold, size: 7, align: 'right' });
  drawText(ctx, `$${fmtMoney(c.amount)}`, R, y, { font: ctx.fonts.monoBold, size: 7, align: 'right' });
}

// ── Page assembly per layout ──────────────────────────────────────

function drawCheckPage(page: PDFPage, fonts: Fonts, c: CheckData, format: string): void {
  // Alignment offsets arrive in CSS px (96/in) from the settings UI.
  const dx = (Number.isFinite(c.offsetX) ? Number(c.offsetX) : 0) * 0.75;
  const dy = -(Number.isFinite(c.offsetY) ? Number(c.offsetY) : 0) * 0.75;
  const ctx: Ctx = { page, fonts, dx, dy };

  if (format === 'z_fold') {
    // Z-fold pressure-seal: folds at 3.667"/7.333", check coupon between
    // the tear perfs at 4.0625" and 6.8335" (2.771" tall face).
    const fold1 = PAGE_H - 3.667 * IN;
    const fold2 = PAGE_H - 7.333 * IN;
    drawLine(ctx, 0.15 * IN, fold1, PAGE_W - 0.15 * IN, fold1, 0.5, LIGHT, [3, 3]);
    drawLine(ctx, 0.15 * IN, fold2, PAGE_W - 0.15 * IN, fold2, 0.5, LIGHT, [3, 3]);

    const couponTop = PAGE_H - 4.0625 * IN;
    const couponBottom = PAGE_H - (4.0625 + 2.771) * IN;
    if (c.printVoucherStub) {
      drawStub(ctx, c, PAGE_H - 0.3 * IN, fold1 + 10);
      drawStub(ctx, c, PAGE_H - 7.5 * IN, 0.3 * IN);
    }
    drawCheckFace(ctx, c, couponTop, couponBottom, true);
    return;
  }

  if (format === 'check_middle') {
    const faceTop = PAGE_H - 3.67 * IN;
    const faceBottom = PAGE_H - 7.17 * IN;
    if (c.printVoucherStub) {
      drawStub(ctx, c, PAGE_H - 0.3 * IN, faceTop + 6);
      drawLine(ctx, 0, PAGE_H - 3.5 * IN, PAGE_W, PAGE_H - 3.5 * IN, 0.75, LIGHT, [4, 3]);
      drawLine(ctx, 0, faceBottom, PAGE_W, faceBottom, 0.75, LIGHT, [4, 3]);
      drawStub(ctx, c, faceBottom - 12, 0.3 * IN);
    }
    drawCheckFace(ctx, c, faceTop, faceBottom, false);
    return;
  }

  // voucher (default): check face on top 3.5", stub below the perf
  const faceBottom = PAGE_H - 3.5 * IN;
  drawCheckFace(ctx, c, PAGE_H, faceBottom, false);
  if (c.printVoucherStub) {
    drawLine(ctx, 0, faceBottom, PAGE_W, faceBottom, 0.75, LIGHT, [4, 3]);
    drawStub(ctx, c, faceBottom - 12, 0.3 * IN);
  }
}

async function renderChecksPdf(checks: CheckData[], format: string): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle('Checks');
  doc.setProducer('Vibe MyBooks');
  const fonts: Fonts = {
    reg: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    mono: await doc.embedFont(StandardFonts.Courier),
    monoBold: await doc.embedFont(StandardFonts.CourierBold),
  };
  for (const c of checks) {
    const page = doc.addPage([PAGE_W, PAGE_H]);
    drawCheckPage(page, fonts, c, format);
  }
  return Buffer.from(await doc.save());
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Render checks as a print-ready PDF.
 *
 * startingCheckNumber: checks still in the print queue have no number
 * assigned yet (numbers are recorded by POST /checks/print AFTER the
 * operator confirms the print succeeded). Passing the starting number
 * here lets the render show the exact numbers /print will assign
 * (startingNumber + index, same checkIds order) — without it, blank
 * stock would print numberless checks with no MICR serial.
 */
export async function generateCheckPdf(
  tenantId: string,
  checkIds: string[],
  format: string = 'voucher',
  startingCheckNumber?: number | null,
): Promise<Buffer> {
  const checks: CheckData[] = [];
  for (let i = 0; i < checkIds.length; i++) {
    const c = await gatherCheckData(tenantId, checkIds[i]!);
    if (c.checkNumber == null && startingCheckNumber != null) {
      c.checkNumber = startingCheckNumber + i;
    }
    checks.push(c);
  }
  return renderChecksPdf(checks, format);
}

/** Alignment test page: sample data over the tenant's real settings. */
export async function generateTestCheckPdf(tenantId: string, format: string = 'voucher'): Promise<Buffer> {
  const company = await db.query.companies.findFirst({ where: eq(companies.tenantId, tenantId) });
  if (!company) throw AppError.internal('Company not found');
  const settings = (company.checkSettings as Record<string, any>) || {};

  const testCheck: CheckData = {
    checkNumber: 1001,
    date: new Date().toISOString().split('T')[0]!,
    payeeName: 'SAMPLE PAYEE NAME',
    amount: '1234.56',
    amountInWords: 'One Thousand Two Hundred Thirty-Four and 56/100',
    memo: 'Test check — alignment verification',
    company: {
      name: company.businessName,
      address: [company.addressLine1, [company.city, company.state, company.zip].filter(Boolean).join(', ')].filter(Boolean).join(', '),
      city: [company.city, company.state, company.zip].filter(Boolean).join(', '),
      phone: company.phone || '',
    },
    bank: {
      name: settings['bankName'] || 'SAMPLE BANK',
      address: settings['bankAddress'] || '123 Bank St',
      routing: settings['routingNumber'] || '000000000',
      account: settings['accountNumber'] || '0000000000',
      fractional: settings['fractionalRouting'] || '',
    },
    printCompanyInfo: settings['printCompanyInfo'] !== false,
    printSignatureLine: settings['printSignatureLine'] !== false,
    printDateLine: settings['printDateLine'] !== false,
    printPayeeLine: settings['printPayeeLine'] !== false,
    printAmountBox: settings['printAmountBox'] !== false,
    printAmountWords: settings['printAmountWords'] !== false,
    printMemoLine: settings['printMemoLine'] !== false,
    printBankInfo: !!settings['printOnBlankStock'] && settings['printBankInfo'] !== false,
    printMicrLine: !!settings['printOnBlankStock'] && settings['printMicrLine'] !== false,
    printCheckNumber: settings['printCheckNumber'] !== false,
    printVoucherStub: settings['printVoucherStub'] !== false,
    offsetX: settings['alignmentOffsetX'] || 0,
    offsetY: settings['alignmentOffsetY'] || 0,
  };

  return renderChecksPdf([testCheck], format);
}

/** Exported for tests. */
export const _internal = { renderChecksPdf, drawCheckPage };
