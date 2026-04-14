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
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, 'g'), value);
  }
  return result;
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

export async function sendInvoice(tenantId: string, invoiceId: string) {
  const { txn, companyId, companyName, customerEmail, customerName } = await getInvoiceEmailData(tenantId, invoiceId);
  if (!customerEmail) {
    console.log(`[EMAIL] No email for customer, skipping send for invoice ${invoiceId}`);
    return;
  }

  const pdfBuffer = await pdfService.generateInvoicePdf(tenantId, invoiceId);
  const total = parseFloat(txn.total || '0').toFixed(2);

  // Check for online payment link
  let paymentLinkSection = '';
  if (txn.publicToken) {
    const company = await db.query.companies.findFirst({
      where: eq(companies.tenantId, tenantId),
    });
    if (company?.onlinePaymentsEnabled) {
      const { env } = await import('../config/env.js');
      const paymentLink = `${env.CORS_ORIGIN}/pay/${txn.publicToken}`;
      paymentLinkSection = `\nPay this invoice online: ${paymentLink}\n`;
    }
  }

  const subject = renderTemplate('Invoice {{invoice_number}} from {{company_name}}', {
    invoice_number: txn.txnNumber || invoiceId.slice(0, 8),
    company_name: companyName,
  });

  const body = renderTemplate(
    'Dear {{customer_name}},\n\nPlease find attached invoice {{invoice_number}} for ${{amount_due}}.\n{{payment_link_section}}\n' + (txn.dueDate ? 'Due date: {{due_date}}\n\n' : '') + 'Thank you for your business!\n\n{{company_name}}',
    {
      customer_name: customerName,
      invoice_number: txn.txnNumber || invoiceId.slice(0, 8),
      amount_due: total,
      payment_link_section: paymentLinkSection,
      due_date: txn.dueDate || '',
      company_name: companyName,
    },
  );

  const { from, transport } = await createTransport(tenantId, companyId);
  await transport.sendMail({
    from,
    to: customerEmail,
    subject,
    text: body,
    attachments: [{
      filename: `invoice-${txn.txnNumber || invoiceId.slice(0, 8)}.pdf`,
      content: pdfBuffer,
      contentType: 'application/pdf',
    }],
  });
}

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
    subject: `Payment Reminder: Invoice ${txn.txnNumber || invoiceId.slice(0, 8)} from ${companyName}`,
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
    subject: `Payment Received - ${company?.businessName || 'Company'}`,
    text: `Dear ${contact.displayName},\n\nWe have received your payment of $${parseFloat(payment.total || '0').toFixed(2)} on ${payment.txnDate}.\n\nThank you!\n${company?.businessName || 'Company'}`,
  });
}
