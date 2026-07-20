// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import fs from 'fs';
import path from 'path';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { companies, contacts, transactions, journalLines, accounts } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';

interface InvoicePdfData {
  company: {
    businessName: string;
    addressLine1: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
    phone: string | null;
    email: string | null;
    logoUrl: string | null;
  };
  customer: {
    displayName: string;
    billingLine1: string | null;
    billingCity: string | null;
    billingState: string | null;
    billingZip: string | null;
    email: string | null;
  };
  invoice: {
    txnNumber: string | null;
    txnDate: string;
    dueDate: string | null;
    paymentTerms: string | null;
    subtotal: string;
    taxAmount: string;
    total: string;
    amountPaid: string;
    balanceDue: string;
    memo: string | null;
    invoiceStatus: string | null;
  };
  lines: Array<{
    description: string | null;
    quantity: string | null;
    unitPrice: string | null;
    amount: string;
    accountName: string;
  }>;
  accentColor: string;
  footerText: string;
  documentType: 'Invoice' | 'Sales Receipt';
}

async function gatherInvoiceData(tenantId: string, invoiceId: string): Promise<InvoicePdfData> {
  const txn = await db.query.transactions.findFirst({
    where: and(eq(transactions.tenantId, tenantId), eq(transactions.id, invoiceId)),
  });
  if (!txn || !['invoice', 'cash_sale'].includes(txn.txnType)) throw AppError.notFound('Invoice or cash sale not found');

  const company = await db.query.companies.findFirst({
    where: eq(companies.tenantId, tenantId),
  });
  if (!company) throw AppError.internal('Company not found');

  let customer = { displayName: 'Customer', billingLine1: null as string | null, billingCity: null as string | null, billingState: null as string | null, billingZip: null as string | null, email: null as string | null };
  if (txn.contactId) {
    const c = await db.query.contacts.findFirst({
      where: and(eq(contacts.tenantId, tenantId), eq(contacts.id, txn.contactId)),
    });
    if (c) customer = c;
  }

  const lines = await db.select().from(journalLines)
    // Void-reversal rows (rule 23) are GL artifacts — a voided invoice's
    // PDF should render the document as issued, not doubled lines.
    .where(and(
      eq(journalLines.tenantId, tenantId),
      eq(journalLines.transactionId, invoiceId),
      eq(journalLines.isVoidReversal, false),
    ))
    .orderBy(journalLines.lineOrder);

  // Get account names for revenue lines (credit side)
  const revenueLines = [];
  for (const line of lines) {
    if (parseFloat(line.credit) > 0) {
      const account = await db.query.accounts.findFirst({
        where: and(eq(accounts.tenantId, tenantId), eq(accounts.id, line.accountId)),
      });
      revenueLines.push({
        description: line.description,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        amount: line.credit,
        accountName: account?.name || 'Revenue',
      });
    }
  }

  return {
    company: {
      businessName: company.businessName,
      addressLine1: company.addressLine1,
      city: company.city,
      state: company.state,
      zip: company.zip,
      phone: company.phone,
      email: company.email,
      logoUrl: company.logoUrl,
    },
    customer,
    invoice: {
      txnNumber: txn.txnNumber,
      txnDate: txn.txnDate,
      dueDate: txn.dueDate,
      paymentTerms: txn.paymentTerms,
      subtotal: txn.subtotal || '0',
      taxAmount: txn.taxAmount || '0',
      total: txn.total || '0',
      amountPaid: txn.amountPaid || '0',
      balanceDue: txn.balanceDue || txn.total || '0',
      memo: txn.memo,
      invoiceStatus: txn.invoiceStatus,
    },
    lines: revenueLines,
    accentColor: '#2563EB',
    footerText: 'Thank you for your business!',
    documentType: txn.txnType === 'cash_sale' ? 'Sales Receipt' : 'Invoice',
  };
}

function fmt(val: string | null | undefined): string {
  return parseFloat(val || '0').toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function esc(text: string | null | undefined): string {
  if (!text) return '';
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderInvoiceHtml(data: InvoicePdfData): string {
  const { company: co, customer: cu, invoice: inv, lines, accentColor, footerText, documentType } = data;

  const lineRows = lines.map((l) => `
    <tr>
      <td style="padding:8px;border-bottom:1px solid #e5e7eb">${esc(l.description || l.accountName)}</td>
      <td style="padding:8px;border-bottom:1px solid #e5e7eb;text-align:center">${esc(l.quantity || '1')}</td>
      <td style="padding:8px;border-bottom:1px solid #e5e7eb;text-align:right">$${fmt(l.unitPrice)}</td>
      <td style="padding:8px;border-bottom:1px solid #e5e7eb;text-align:right">$${fmt(l.amount)}</td>
    </tr>
  `).join('');

  // Layout designed for #9 double-window envelope:
  // Upper window: ~0.5" from left, ~0.5" from top, 3.5"×1" — company return address
  // Lower window: ~0.5" from left, ~2.125" from top, 3.5"×1" — recipient address
  // Page margins: 0.5" all sides (set in generateInvoicePdf)

  // Accent color is an internal-only string ('#2563EB'). It still goes through
  // the same escape to keep the CSS context safe even if future code lets a
  // tenant customize it — a hostile value like `red}body{...}` would otherwise
  // escape the rule.
  const accentSafe = esc(accentColor);
  const termsLabel = inv.paymentTerms ? inv.paymentTerms.replace(/_/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()) : '';

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;margin:0;padding:0;color:#111827;font-size:13px;line-height:1.4}
  .page{padding:0.5in}

  /* Return address block — positioned for upper envelope window */
  .return-address{height:0.875in;width:3.5in;padding:0;font-size:11px;line-height:1.35}
  .return-address .company-name{font-weight:700;font-size:13px;color:${accentSafe}}

  /* Spacer between address blocks to align with lower window */
  .address-spacer{height:0.25in}

  /* Recipient address block — positioned for lower envelope window */
  .recipient-address{height:0.875in;width:3.5in;padding:0;font-size:12px;line-height:1.35}

  /* Invoice title and details — floated right at top */
  .invoice-header{float:right;text-align:right;margin-top:0}
  .invoice-header h2{font-size:26px;margin:0 0 6px;color:${accentSafe};text-transform:uppercase;letter-spacing:1px}
  .invoice-header .detail{font-size:12px;color:#374151;margin:2px 0}

  .clear{clear:both}

  /* Content below the address area */
  .content{margin-top:0.3in}

  table{width:100%;border-collapse:collapse;margin-bottom:16px}
  thead th{background:${accentSafe};color:white;padding:8px;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:0.5px}
  tbody td{padding:7px 8px;border-bottom:1px solid #e5e7eb;font-size:12px}

  .totals{width:280px;margin-left:auto}
  .totals tr td{padding:3px 8px;font-size:12px}
  .totals .total{font-size:16px;font-weight:bold;border-top:2px solid ${accentSafe}}

  .footer{margin-top:30px;text-align:center;color:#6b7280;font-size:11px;border-top:1px solid #e5e7eb;padding-top:15px}
  .notes{margin-top:16px;padding:10px;background:#f9fafb;border-radius:6px;font-size:11px}

  .remit-stub{margin-top:24px;border-top:2px dashed #d1d5db;padding-top:16px}
  .remit-stub h3{font-size:11px;text-transform:uppercase;color:#6b7280;margin:0 0 8px;letter-spacing:0.5px}
  .remit-table{width:100%;font-size:12px}
  .remit-table td{padding:3px 0}

  @media print{body{padding:0}.page{padding:0.5in}}
</style></head>
<body>
<div class="page">
  <!-- Invoice title block — top right. Every user-controllable field is
       routed through esc() — the document is rendered by Puppeteer with
       --no-sandbox and network access, so stored XSS here would let a
       malicious invoice-data value exfiltrate the document during render. -->
  <div class="invoice-header">
    <h2>${esc(documentType)}</h2>
    ${inv.txnNumber ? `<div class="detail"><strong>${esc(documentType)} #${esc(inv.txnNumber)}</strong></div>` : ''}
    <div class="detail">Date: ${esc(inv.txnDate)}</div>
    ${inv.dueDate ? `<div class="detail">Due Date: ${esc(inv.dueDate)}</div>` : ''}
    ${inv.paymentTerms ? `<div class="detail">Terms: ${esc(termsLabel)}</div>` : ''}
  </div>

  <!-- Return address — upper envelope window -->
  <div class="return-address">
    <div class="company-name">${esc(co.businessName)}</div>
    ${co.addressLine1 ? `<div>${esc(co.addressLine1)}</div>` : ''}
    ${co.city ? `<div>${esc([co.city, co.state, co.zip].filter(Boolean).join(', '))}</div>` : ''}
    ${co.phone ? `<div>${esc(co.phone)}</div>` : ''}
  </div>

  <div class="address-spacer"></div>

  <!-- Recipient address — lower envelope window -->
  <div class="recipient-address">
    <div><strong>${esc(cu.displayName)}</strong></div>
    ${cu.billingLine1 ? `<div>${esc(cu.billingLine1)}</div>` : ''}
    ${cu.billingCity ? `<div>${esc([cu.billingCity, cu.billingState, cu.billingZip].filter(Boolean).join(', '))}</div>` : ''}
  </div>

  <div class="clear"></div>

  <!-- Line items -->
  <div class="content">
    <table>
      <thead>
        <tr>
          <th>Description</th>
          <th style="text-align:center;width:60px">Qty</th>
          <th style="text-align:right;width:90px">Rate</th>
          <th style="text-align:right;width:90px">Amount</th>
        </tr>
      </thead>
      <tbody>${lineRows}</tbody>
    </table>

    <table class="totals">
      <tr><td>Subtotal</td><td style="text-align:right">$${fmt(inv.subtotal)}</td></tr>
      ${parseFloat(inv.taxAmount) > 0 ? `<tr><td>Tax</td><td style="text-align:right">$${fmt(inv.taxAmount)}</td></tr>` : ''}
      <tr class="total"><td>Total Due</td><td style="text-align:right">$${fmt(inv.total)}</td></tr>
      ${parseFloat(inv.amountPaid) > 0 ? `<tr><td>Amount Paid</td><td style="text-align:right">($${fmt(inv.amountPaid)})</td></tr>` : ''}
      ${parseFloat(inv.amountPaid) > 0 ? `<tr style="font-weight:bold"><td>Balance Due</td><td style="text-align:right">$${fmt(inv.balanceDue)}</td></tr>` : ''}
    </table>

    ${inv.memo ? `<div class="notes"><strong>Notes:</strong> ${esc(inv.memo)}</div>` : ''}

    <!-- Payment remittance stub -->
    <div class="remit-stub">
      <h3>Please detach and return with payment</h3>
      <table class="remit-table">
        <tr>
          <td style="width:50%">
            <strong>${esc(co.businessName)}</strong><br>
            ${inv.txnNumber ? `${esc(documentType)} #${esc(inv.txnNumber)}` : ''}
          </td>
          <td style="text-align:right">
            <strong>Amount Due: $${fmt(parseFloat(inv.amountPaid) > 0 ? inv.balanceDue : inv.total)}</strong><br>
            ${inv.dueDate ? `Due: ${esc(inv.dueDate)}` : ''}
          </td>
        </tr>
        <tr>
          <td>Customer: ${esc(cu.displayName)}</td>
          <td style="text-align:right">Amount Enclosed: _______________</td>
        </tr>
      </table>
    </div>

    <div class="footer">${esc(footerText)}</div>
  </div>
</div>
</body>
</html>`;
}

export async function generateInvoicePdf(tenantId: string, invoiceId: string): Promise<Buffer> {
  const data = await gatherInvoiceData(tenantId, invoiceId);
  const html = renderInvoiceHtml(data);
  return htmlToPdfBuffer(html, {
    format: 'Letter',
    margin: { top: '0.5in', bottom: '0.5in', left: '0.5in', right: '0.5in' },
  });
}

export async function getInvoiceHtml(tenantId: string, invoiceId: string): Promise<string> {
  const data = await gatherInvoiceData(tenantId, invoiceId);
  return renderInvoiceHtml(data);
}

// ─── Shared Puppeteer helper ──────────────────────────────────────
//
// Centralizes Chromium launch and `page.pdf()` so every PDF in the app
// goes through the same code path.
//
// IMPORTANT: errors are NOT caught here. The previous version had a
// `try/catch` that returned the raw HTML as a Buffer when Puppeteer
// failed — combined with `Content-Type: application/pdf` in the routes
// this produced files that PDF readers display as garbage. Silent data
// corruption is worse than a 500. If Chromium isn't reachable, let the
// error propagate to the global error handler so the user sees an
// actionable failure.

interface PdfOptions {
  format?: 'Letter' | 'A4';
  margin?: { top: string; bottom: string; left: string; right: string };
}

async function htmlToPdfBuffer(html: string, opts: PdfOptions = {}): Promise<Buffer> {
  const puppeteer = await import('puppeteer');
  const browser = await puppeteer.default.launch({
    headless: true,
    // --no-sandbox / --disable-setuid-sandbox are required when running
    // Chromium as root inside a container. The image installs Chromium
    // from apk; PUPPETEER_EXECUTABLE_PATH (set in the Dockerfile) tells
    // puppeteer where it lives. We also pass it explicitly so dev
    // environments without the env var still work.
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    executablePath: process.env['PUPPETEER_EXECUTABLE_PATH'] || undefined,
  });
  try {
    const page = await browser.newPage();
    // Defense-in-depth for stored XSS in user-supplied invoice data (memo,
    // billing address, txn number, etc.). Even though every interpolation in
    // the HTML generator routes through esc(), a future edit might miss one.
    // Disabling JS + blocking all non-data network requests means even a
    // successful injection cannot exfiltrate anything during rendering.
    await page.setJavaScriptEnabled(false);
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const url = req.url();
      // Allow the inline HTML we injected (about:blank / data:) and refuse
      // everything else. Puppeteer issues file:// lookups for some fonts —
      // we aren't using remote fonts, so blanket-deny network protocols.
      if (url.startsWith('data:') || url.startsWith('about:') || url.startsWith('file:')) {
        req.continue();
      } else {
        req.abort();
      }
    });
    await page.setContent(html, { waitUntil: 'load' });
    const pdfBuffer = await page.pdf({
      format: opts.format || 'Letter',
      margin: opts.margin || { top: '0.5in', bottom: '0.5in', left: '0.5in', right: '0.5in' },
      printBackground: true,
    });
    return Buffer.from(pdfBuffer);
  } finally {
    // Ensure the browser is always closed even if pdf() throws, so we
    // don't leak Chromium processes inside the container.
    await browser.close();
  }
}
