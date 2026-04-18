// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import nodemailer from 'nodemailer';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { companies, contacts, transactions } from '../db/schema/index.js';
import { env } from '../config/env.js';
import * as pdfService from './pdf.service.js';
import { getSmtpSettings as getCompanySmtp } from './company.service.js';
import { getSmtpSettings as getSystemSmtp } from './admin.service.js';

async function createTransport(tenantId: string, companyId?: string) {
  // Try company-level SMTP first
  let smtp: { smtpHost: string; smtpPort: number; smtpUser: string; smtpPass: string; smtpFrom: string };

  if (companyId) {
    try {
      const companySmtp = await getCompanySmtp(tenantId, companyId);
      if (companySmtp.configured) {
        smtp = companySmtp;
      } else {
        // Fall back to system-level
        smtp = await getSystemSmtp();
      }
    } catch {
      smtp = await getSystemSmtp();
    }
  } else {
    smtp = await getSystemSmtp();
  }

  if (!smtp.smtpHost) {
    return {
      from: smtp.smtpFrom,
      transport: {
        sendMail: async (opts: { to: string; subject: string }) => {
          console.log(`[EMAIL STUB] To: ${opts.to}, Subject: ${opts.subject}`);
          return { messageId: 'stub-' + Date.now() };
        },
      },
    };
  }

  return {
    from: smtp.smtpFrom,
    transport: nodemailer.createTransport({
      host: smtp.smtpHost,
      port: smtp.smtpPort,
      secure: smtp.smtpPort === 465,
      auth: smtp.smtpUser ? { user: smtp.smtpUser, pass: smtp.smtpPass } : undefined,
    }),
  };
}

function renderTemplate(template: string, vars: Record<string, string>): string {
  let result = template;
  for (const [key, value] of Object.entries(vars)) {
    // Strip CR/LF from interpolated values — otherwise a user-supplied
    // displayName containing "\r\nBcc: attacker@..." could inject email
    // headers when the template is used for the Subject line or when a
    // downstream renderer treats newlines as header separators.
    const safe = value == null ? '' : String(value).replace(/[\r\n]/g, ' ');
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), safe);
  }
  return result;
}

/**
 * Build an email Subject line safely. Subjects accept ad-hoc template
 * literals in a few places; this helper strips CR/LF from every
 * interpolated segment so a user-editable field (txnNumber, displayName,
 * companyName) can never split the Subject header.
 */
function safeSubject(parts: TemplateStringsArray, ...values: Array<string | number | null | undefined>): string {
  let out = '';
  parts.forEach((p, i) => {
    out += p;
    if (i < values.length) {
      const v = values[i];
      const str = v == null ? '' : String(v);
      out += str.replace(/[\r\n]/g, ' ');
    }
  });
  return out;
}

async function getInvoiceEmailData(tenantId: string, invoiceId: string) {
  const txn = await db.query.transactions.findFirst({
    where: and(eq(transactions.tenantId, tenantId), eq(transactions.id, invoiceId)),
  });
  if (!txn) throw new Error('Invoice not found');

  const company = await db.query.companies.findFirst({
    where: eq(companies.tenantId, tenantId),
  });

  let customerEmail = '';
  let customerName = 'Customer';
  if (txn.contactId) {
    const contact = await db.query.contacts.findFirst({
      where: and(eq(contacts.tenantId, tenantId), eq(contacts.id, txn.contactId)),
    });
    if (contact) {
      customerEmail = contact.email || '';
      customerName = contact.displayName;
    }
  }

  return {
    txn,
    companyId: company?.id,
    companyName: company?.businessName || 'Company',
    customerEmail,
    customerName,
  };
}

// sendInvoice historically lived here but was superseded by
// invoice.service.sendInvoice, which is the one every call site now uses
// (routes/invoices.routes.ts, mcp/server.ts). Removed the duplicate so
// future maintenance doesn't drift on two implementations that look the
// same from the outside.

export async function sendPaymentReminder(tenantId: string, invoiceId: string) {
  const { txn, companyId, companyName, customerEmail, customerName } = await getInvoiceEmailData(tenantId, invoiceId);
  if (!customerEmail) return;

  const balanceDue = parseFloat(txn.balanceDue || txn.total || '0').toFixed(2);

  // Check for online payment link
  let paymentLinkLine = '';
  if (txn.publicToken) {
    const company = await db.query.companies.findFirst({
      where: eq(companies.tenantId, tenantId),
    });
    if (company?.onlinePaymentsEnabled) {
      const { env } = await import('../config/env.js');
      paymentLinkLine = `\nPay online: ${env.CORS_ORIGIN}/pay/${txn.publicToken}\n`;
    }
  }

  const { from, transport } = await createTransport(tenantId, companyId);
  await transport.sendMail({
    from,
    to: customerEmail,
    subject: safeSubject`Payment Reminder: Invoice ${txn.txnNumber || invoiceId.slice(0, 8)} from ${companyName}`,
    text: `Dear ${customerName},\n\nThis is a friendly reminder that invoice ${txn.txnNumber || invoiceId.slice(0, 8)} has a balance due of $${balanceDue}.\n${paymentLinkLine}\n${txn.dueDate ? `Due date: ${txn.dueDate}\n\n` : ''}Please remit payment at your earliest convenience.\n\nThank you,\n${companyName}`,
  });
}

export async function sendPaymentConfirmation(tenantId: string, paymentTxnId: string) {
  const payment = await db.query.transactions.findFirst({
    where: and(eq(transactions.tenantId, tenantId), eq(transactions.id, paymentTxnId)),
  });
  if (!payment || !payment.contactId) return;

  const contact = await db.query.contacts.findFirst({
    where: and(eq(contacts.tenantId, tenantId), eq(contacts.id, payment.contactId)),
  });
  if (!contact?.email) return;

  const company = await db.query.companies.findFirst({
    where: eq(companies.tenantId, tenantId),
  });

  const { from, transport } = await createTransport(tenantId, company?.id);
  await transport.sendMail({
    from,
    to: contact.email,
    subject: safeSubject`Payment Received - ${company?.businessName || 'Company'}`,
    text: `Dear ${contact.displayName},\n\nWe have received your payment of $${parseFloat(payment.total || '0').toFixed(2)} on ${payment.txnDate}.\n\nThank you!\n${company?.businessName || 'Company'}`,
  });
}
