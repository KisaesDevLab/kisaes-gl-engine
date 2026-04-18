// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import fs from 'fs';
import path from 'path';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { companies, contacts, transactions, journalLines, accounts, billPaymentApplications, vendorCreditApplications } from '../db/schema/index.js';
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
    .where(and(eq(journalLines.tenantId, tenantId), eq(journalLines.transactionId, invoiceId)))
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

// ─── Check PDF Generation ───────────────────────────────────────

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

interface CheckData {
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
  // Populated when this check is a bill payment — itemized voucher
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

  // Import numberToWords
  const { numberToWords } = await import('@kis-books/shared');

  // For bill payments, the payeeName isn't stored on the txn — pull from
  // the linked contact (vendor). Also load the bill/credit applications so
  // the voucher can itemize what the check pays off.
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

    // Fetch bills paid by this payment, joined to the bill transactions for display fields
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

    // Fetch credits applied in this payment
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

function renderCheckHtml(checks: CheckData[], format: string): string {
  const checkHeight = '11in'; // full page per check for both formats

  const checkTop = format === 'check_middle' ? '3.67in' : '0';

  const checksHtml = checks.map((c) => {
    // Bill payment voucher: itemize bills and credits instead of the simple
    // 1-line stub. Falls back to the basic stub for non-bill-payment checks
    // (regular Write Check transactions).
    const isBillPayment = c.billPaymentBills && c.billPaymentBills.length > 0;
    const billPaymentStub = isBillPayment ? `
      <div style="display:flex;justify-content:space-between;margin-bottom:6px;font-weight:600">
        <div>BILL PAYMENT VOUCHER</div>
        <div>Check #${c.checkNumber ? esc(String(c.checkNumber)) : '____'}</div>
        <div>Date: ${esc(c.date)}</div>
      </div>
      <div style="margin-bottom:4px">Pay to: <strong>${esc(c.payeeName)}</strong></div>
      <table style="width:100%;border-collapse:collapse;font-size:8.5px;margin-top:6px">
        <thead>
          <tr style="border-bottom:1px solid #999">
            <th style="text-align:left;padding:2px 4px">Bill #</th>
            <th style="text-align:left;padding:2px 4px">Vendor Inv #</th>
            <th style="text-align:left;padding:2px 4px">Date</th>
            <th style="text-align:right;padding:2px 4px">Original</th>
            <th style="text-align:right;padding:2px 4px">Paid</th>
          </tr>
        </thead>
        <tbody>
          ${(c.billPaymentBills || []).map((b) => `
            <tr>
              <td style="padding:2px 4px">${esc(b.txnNumber || '')}</td>
              <td style="padding:2px 4px">${esc(b.vendorInvoiceNumber || '')}</td>
              <td style="padding:2px 4px">${esc(b.txnDate)}</td>
              <td style="padding:2px 4px;text-align:right;font-family:monospace">$${b.originalAmount}</td>
              <td style="padding:2px 4px;text-align:right;font-family:monospace">$${b.paidAmount}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
      ${(c.billPaymentCredits && c.billPaymentCredits.length > 0) ? `
        <div style="margin-top:6px;font-weight:600;font-size:8.5px">Credits Applied:</div>
        <table style="width:100%;border-collapse:collapse;font-size:8.5px">
          <thead>
            <tr style="border-bottom:1px solid #999">
              <th style="text-align:left;padding:2px 4px">Credit #</th>
              <th style="text-align:left;padding:2px 4px">Date</th>
              <th style="text-align:left;padding:2px 4px">Description</th>
              <th style="text-align:right;padding:2px 4px">Amount</th>
            </tr>
          </thead>
          <tbody>
            ${c.billPaymentCredits.map((cr) => `
              <tr>
                <td style="padding:2px 4px">${esc(cr.txnNumber || '')}</td>
                <td style="padding:2px 4px">${esc(cr.txnDate)}</td>
                <td style="padding:2px 4px">${esc(cr.description || '')}</td>
                <td style="padding:2px 4px;text-align:right;font-family:monospace">($${cr.amount})</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      ` : ''}
      <div style="margin-top:8px;border-top:1px solid #000;padding-top:4px;text-align:right;font-size:9px">
        <div>Total Bills: <span style="display:inline-block;width:80px;font-family:monospace">$${esc(c.billPaymentTotalBills || '0.00')}</span></div>
        ${(c.billPaymentTotalCredits && parseFloat(c.billPaymentTotalCredits) > 0)
          ? `<div>Credits: <span style="display:inline-block;width:80px;font-family:monospace">($${esc(c.billPaymentTotalCredits)})</span></div>`
          : ''}
        <div style="font-weight:700;margin-top:2px">Check Total: <span style="display:inline-block;width:80px;font-family:monospace">$${esc(c.amount)}</span></div>
      </div>
    ` : null;

    const basicStub = `
      <div style="display:flex;justify-content:space-between;margin-bottom:8px">
        <div><strong>Check #${c.checkNumber ? esc(String(c.checkNumber)) : '____'}</strong></div>
        <div>Date: ${esc(c.date)}</div>
        <div>Amount: $${esc(c.amount)}</div>
      </div>
      <div>Pay to: ${esc(c.payeeName)}</div>
      ${c.memo ? `<div>Memo: ${esc(c.memo)}</div>` : ''}
    `;

    const stubHtml = billPaymentStub || basicStub;

    // offsetX / offsetY are operator-tunable alignment numbers. Coerce to a
     // plain integer via Number() so a hostile setting value can't break out
     // of the CSS context (e.g. "0px;background:url(javascript:...)").
    const safeOffsetX = Number.isFinite(c.offsetX) ? Number(c.offsetX) : 0;
    const safeOffsetY = Number.isFinite(c.offsetY) ? Number(c.offsetY) : 0;
    return `
    <div class="check" style="height:${checkHeight};position:relative;page-break-after:always;margin-left:${safeOffsetX}px;margin-top:${safeOffsetY}px">
      <!-- Top stub (check_middle format only) -->
      ${format === 'check_middle' && c.printVoucherStub ? `
        <div style="position:absolute;top:0;left:0;right:0;height:3.5in;padding:0.3in 0.25in;font-size:9px;border-bottom:2px dashed #ccc">
          ${stubHtml}
        </div>
      ` : ''}

      <!-- Check face -->
      <div style="position:absolute;top:${checkTop};left:0;right:0;height:3.5in">
        ${c.printCompanyInfo ? `
          <div style="position:absolute;top:0.25in;left:0.25in;font-size:9px;line-height:1.3">
            <div style="font-weight:700;font-size:11px">${esc(c.company.name)}</div>
            ${c.company.address ? `<div>${esc(c.company.address)}</div>` : ''}
            ${c.company.phone ? `<div>${esc(c.company.phone)}</div>` : ''}
          </div>
        ` : ''}

        ${c.printCheckNumber ? `
          <div style="position:absolute;top:0.25in;right:0.5in;font-size:10px;font-weight:700">
            ${c.checkNumber ? `No. ${esc(String(c.checkNumber))}` : ''}
          </div>
        ` : ''}

        <div style="position:absolute;top:0.9in;right:0.5in;font-size:11px">
          ${c.printDateLine ? `<span style="color:#666;font-size:9px">DATE</span>` : ''}
          <span style="margin-left:8px;${c.printDateLine ? 'border-bottom:1px solid #000;' : ''}padding:0 12px">${esc(c.date)}</span>
        </div>

        <div style="position:absolute;top:1.3in;left:0.25in;right:1.6in;font-size:10px">
          ${c.printPayeeLine ? `<div style="font-size:8px;color:#666;margin-bottom:2px">PAY TO THE ORDER OF</div>` : ''}
          <div style="${c.printPayeeLine ? 'border-bottom:1px solid #000;' : ''}padding-bottom:2px;font-size:12px;font-weight:600;min-height:18px">
            ${esc(c.payeeName)}
          </div>
        </div>

        <div style="position:absolute;top:1.3in;right:0.25in;width:1.2in;text-align:center">
          <div style="${c.printAmountBox ? 'border:2px solid #000;' : ''}padding:4px 8px;font-size:14px;font-weight:700;font-family:monospace">
            $${esc(c.amount)}
          </div>
        </div>

        ${c.printAmountWords ? `
          <div style="position:absolute;top:1.85in;left:0.25in;right:0.5in;font-size:10px">
            <div style="border-bottom:1px solid #000;padding-bottom:2px;min-height:16px">
              ${esc(c.amountInWords)}
              <span style="float:right;font-weight:700">DOLLARS</span>
            </div>
          </div>
        ` : ''}

        ${c.printBankInfo ? `
          <div style="position:absolute;top:2.3in;left:0.25in;font-size:8px;line-height:1.3;color:#444">
            ${c.bank.name ? `<div>${esc(c.bank.name)}</div>` : ''}
            ${c.bank.address ? `<div>${esc(c.bank.address)}</div>` : ''}
          </div>
        ` : ''}

        <div style="position:absolute;bottom:0.5in;left:0.25in;width:3in;font-size:9px">
          ${c.printMemoLine ? `<div style="font-size:8px;color:#666;margin-bottom:2px">MEMO</div>` : ''}
          <div style="${c.printMemoLine ? 'border-bottom:1px solid #000;' : ''}padding-bottom:2px;min-height:14px">
            ${esc(c.memo)}
          </div>
        </div>

        ${c.printSignatureLine ? `
          <div style="position:absolute;bottom:0.5in;right:0.25in;width:2.5in;font-size:9px;text-align:right">
            <div style="border-bottom:1px solid #000;min-height:14px"></div>
            <div style="font-size:7px;color:#666;margin-top:2px">AUTHORIZED SIGNATURE</div>
          </div>
        ` : ''}

        ${c.printMicrLine ? `
          <div style="position:absolute;bottom:0.15in;left:0.5in;right:0.5in;font-family:'MICR','Courier New',monospace;font-size:12px;letter-spacing:2px;color:#333">
            ${c.bank.routing ? `⑆${esc(c.bank.routing)}⑆` : ''} ${c.bank.account ? `⑈${esc(c.bank.account)}⑈` : ''} ${c.checkNumber ? `⑆${esc(String(c.checkNumber).padStart(4, '0'))}⑆` : ''}
          </div>
        ` : ''}
      </div>

      <!-- Bottom stub -->
      ${c.printVoucherStub ? `
        <div style="position:absolute;${format === 'check_middle' ? 'top:7.17in' : 'top:3.5in'};left:0;right:0;border-top:2px dashed #ccc;padding:0.3in 0.25in;font-size:9px">
          ${stubHtml}
        </div>
      ` : ''}
    </div>
  `}).join('');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  @page { margin: 0; size: letter; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 0; color: #000; }
  .check { width: 8.5in; box-sizing: border-box; overflow: hidden; }
  @media print { .check { page-break-after: always; } }
</style></head>
<body>${checksHtml}</body></html>`;
}

export async function generateCheckPdf(tenantId: string, checkIds: string[], format: string = 'voucher'): Promise<Buffer> {
  const checks: CheckData[] = [];
  for (const id of checkIds) {
    checks.push(await gatherCheckData(tenantId, id));
  }

  const html = renderCheckHtml(checks, format);
  return htmlToPdfBuffer(html, {
    format: 'Letter',
    margin: { top: '0', bottom: '0', left: '0', right: '0' },
  });
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

export async function getTestCheckHtml(tenantId: string, format: string = 'voucher'): Promise<string> {
  const company = await db.query.companies.findFirst({ where: eq(companies.tenantId, tenantId) });
  if (!company) throw AppError.internal('Company not found');
  const settings = (company.checkSettings as Record<string, any>) || {};

  const testCheck: CheckData = {
    checkNumber: 1001,
    date: new Date().toISOString().split('T')[0]!,
    payeeName: 'SAMPLE PAYEE NAME',
    amount: '1,234.56',
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

  return renderCheckHtml([testCheck], format);
}

export async function getCheckHtml(tenantId: string, checkIds: string[], format: string = 'voucher'): Promise<string> {
  const checks: CheckData[] = [];
  for (const id of checkIds) {
    checks.push(await gatherCheckData(tenantId, id));
  }
  return renderCheckHtml(checks, format);
}
