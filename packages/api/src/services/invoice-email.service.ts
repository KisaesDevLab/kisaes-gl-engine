// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Invoice email and the email Outbox (U-127, invoice-email-v1).
 *
 * POST /invoices/:id/email sends the invoice through the company's SMTP
 * server with the PDF the client made attached, and records an "email" send
 * event (U-126) only when the server accepted the message: a failed send
 * writes nothing (no event, no status change, no stored idempotency
 * outcome). The SMTP password is the stored one on a server and, in desktop
 * mode, the per-session secret (smtp-session-v1, utils/mail-transport.ts).
 *
 * POST /invoices/:id/email-later stores the message in form_email_queue (the
 * Outbox) for the owner to send later; the PDF is not stored, the client
 * makes it at send time (Q-P20q) and sends it with `outboxId`, which removes
 * the queued row in the same commit as the send event.
 *
 * Recipients, subjects and bodies are owner data: never logged, never in an
 * audit row (audit rows carry counts). Mail transports come from
 * createMailTransport, so tests replace nodemailer (vi.mock) and no network
 * is used.
 */

import { and, asc, eq } from 'drizzle-orm';
import { db, type Tx } from '../db/index.js';
import { companies, contacts, formEmailQueue, transactions } from '../db/schema/index.js';
import { INVOICE_EMAIL_PDF_MAX_BYTES } from '@kis-books/shared';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import { createMailTransport } from '../utils/mail-transport.js';
import { getSmtpSettings as getSystemSmtp } from './admin.service.js';
import { claimIdempotency, recordIdempotentEntity } from './idempotency.service.js';
import { recordSendEvent } from './document-send.service.js';
import * as ledger from './ledger.service.js';
import { getInvoice } from './invoice.service.js';

export interface InvoiceEmailMessage {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body: string;
}

export interface InvoiceEmailInput extends InvoiceEmailMessage {
  pdfFileName: string;
  pdfBase64: string;
  outboxId?: string;
}

/**
 * Bounded timeouts for this send on every install (a caller-set value wins
 * over the desktop defaults in createMailTransport, and on a server replaces
 * nodemailer's two-minute defaults): the request holds an open database
 * transaction (its idempotency claim) while the server answers.
 */
const SEND_TIMEOUTS = { connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 60_000 } as const;

const ADDRESS_RE = /[^\s<>"'@]+@[^\s<>"'@]+/g;

function notConfigured(message = 'Email is not set up for this company. Enter the mail server in Settings → Email.'): AppError {
  return AppError.badRequest(message, 'SMTP_NOT_CONFIGURED');
}

/** Decoded PDF bytes: strict base64, `%PDF-` magic, 1 byte to 10 MB. */
export function decodePdf(base64: string): Buffer {
  const clean = base64.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 !== 0) {
    throw AppError.badRequest('pdfBase64 is not valid base64', 'VALIDATION_ERROR');
  }
  const pdf = Buffer.from(clean, 'base64');
  if (pdf.length > INVOICE_EMAIL_PDF_MAX_BYTES) {
    throw AppError.badRequest('The PDF is larger than 10 MB', 'ATTACHMENT_TOO_LARGE', { maxBytes: INVOICE_EMAIL_PDF_MAX_BYTES });
  }
  if (pdf.length < 5 || pdf.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw AppError.badRequest('pdfBase64 is not a PDF document', 'VALIDATION_ERROR');
  }
  return pdf;
}

/**
 * The company's mail server (else the install's, on a server that has one),
 * as transport options and the From address. 400 SMTP_NOT_CONFIGURED when
 * neither names a host; in desktop mode createMailTransport also throws it
 * when the session password is missing.
 */
async function resolveSmtp(tenantId: string, companyId?: string) {
  const [company] = await db.select({
    host: companies.smtpHost, port: companies.smtpPort, user: companies.smtpUser, pass: companies.smtpPass,
    from: companies.smtpFrom, fromName: companies.smtpFromName, email: companies.email,
  }).from(companies)
    .where(companyId ? and(eq(companies.tenantId, tenantId), eq(companies.id, companyId)) : eq(companies.tenantId, tenantId))
    .limit(1);
  let smtp: { host: string; port: number; user: string; pass: string; from: string; fromName: string };
  if (company?.host) {
    smtp = {
      host: company.host, port: company.port || 587, user: company.user || '', pass: company.pass || '',
      from: company.from || company.email || '', fromName: company.fromName || '',
    };
  } else {
    const sys = await getSystemSmtp();
    if (!sys.smtpHost) throw notConfigured();
    smtp = { host: sys.smtpHost, port: sys.smtpPort, user: sys.smtpUser, pass: sys.smtpPass, from: sys.smtpFrom, fromName: sys.smtpFromName };
  }
  if (!smtp.from) throw notConfigured('Email has no From address for this company. Enter it in Settings → Email.');
  return {
    from: smtp.fromName ? { name: smtp.fromName, address: smtp.from } : smtp.from,
    options: {
      host: smtp.host,
      port: smtp.port,
      secure: smtp.port === 465,
      auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
      ...SEND_TIMEOUTS,
    },
  };
}

/**
 * Maps a mail failure to the two codes of the contract. Session problems
 * (no password, a password given for another server) are
 * SMTP_NOT_CONFIGURED; everything the server refused, including a rejected
 * login, is SMTP_SEND_FAILED with `details.reason`. Offline (503
 * OFFLINE_UNAVAILABLE) passes through. Logs the error code only, with any
 * address masked; never the recipients, subject or body.
 */
function mailError(err: unknown): AppError {
  if (err instanceof AppError) {
    if (err.code === 'SMTP_NOT_CONFIGURED') return err;
    if (err.code === 'SMTP_HOST_MISMATCH') {
      return notConfigured('The email password for this session was given for a different mail server. Enter it again in Settings → Email.');
    }
    return err;
  }
  const code = (err as { code?: string })?.code;
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[invoice-email] send failed${code ? ` (${code})` : ''}:`, message.replace(ADDRESS_RE, '[address]').slice(0, 300));
  if (code === 'EAUTH' || message.includes('535')) {
    return AppError.badRequest(
      'The mail server rejected the email username or password. Check Settings → Email.',
      'SMTP_SEND_FAILED', { reason: 'auth' },
    );
  }
  return AppError.badRequest('The mail server did not accept the email. Check Settings → Email, or send it later.', 'SMTP_SEND_FAILED', { reason: 'send' });
}

function oneLine(s: string): string {
  return s.replace(/[\r\n]+/g, ' ').trim();
}

/** The invoice row for a send, under a row lock, or the reason it can't be sent. */
async function lockInvoice(tx: Tx, tenantId: string, invoiceId: string, companyId?: string) {
  const [row] = await tx.select().from(transactions)
    .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, invoiceId)))
    .for('update').limit(1);
  if (!row || row.status === 'deleted' || ledger.inOtherCompany(row, companyId)) throw AppError.notFound('Transaction not found');
  if (row.txnType !== 'invoice') throw AppError.badRequest('Not an invoice');
  return row;
}

function outboxGone(): AppError {
  return new AppError(404, 'That message is no longer in the Outbox', 'OUTBOX_ITEM_NOT_FOUND');
}

function voidRefusal(): AppError {
  return AppError.badRequest('A void invoice can’t be sent', 'INVOICE_VOID');
}

/**
 * POST /invoices/:id/email. Order: validate the PDF and the mail server,
 * open the database transaction and claim the Idempotency-Key (a second
 * request with the key gets 409 IDEMPOTENCY_IN_PROGRESS meanwhile), check
 * the invoice and the Outbox row (locked, so two "Send all" runs can't send
 * one message twice), send, then lock the invoice and record the send
 * event (to + cc + bcc), delete the Outbox row and commit. The invoice row
 * is not locked during the send, so edits are not held up by a slow server.
 * If the commit itself fails after the server accepted the message, the
 * email went out without a record; a retry sends it again.
 */
export async function emailInvoice(
  tenantId: string, invoiceId: string, input: InvoiceEmailInput, userId?: string, companyId?: string,
) {
  const pdf = decodePdf(input.pdfBase64);
  const smtp = await resolveSmtp(tenantId, companyId);
  let transport: ReturnType<typeof createMailTransport>;
  try {
    transport = createMailTransport(smtp.options);
  } catch (err) {
    throw mailError(err);
  }
  const recipients = [...new Set([...input.to, ...input.cc, ...input.bcc].map((a) => a.trim()))];

  await db.transaction(async (tx) => {
    await claimIdempotency(tx);
    const [pre] = await tx.select({
      id: transactions.id, txnType: transactions.txnType, status: transactions.status, companyId: transactions.companyId,
    }).from(transactions).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, invoiceId))).limit(1);
    if (!pre || pre.status === 'deleted' || ledger.inOtherCompany(pre, companyId)) throw AppError.notFound('Transaction not found');
    if (pre.txnType !== 'invoice') throw AppError.badRequest('Not an invoice');
    if (pre.status === 'void') throw voidRefusal();
    if (input.outboxId) {
      const [queued] = await tx.select({ id: formEmailQueue.id }).from(formEmailQueue)
        .where(and(
          eq(formEmailQueue.tenantId, tenantId), eq(formEmailQueue.id, input.outboxId), eq(formEmailQueue.transactionId, invoiceId),
          ...(companyId ? [eq(formEmailQueue.companyId, companyId)] : []),
        )).for('update').limit(1);
      if (!queued) throw outboxGone();
    }
    await recordIdempotentEntity(tx, 'transaction', invoiceId);

    try {
      await transport.sendMail({
        from: smtp.from,
        to: input.to,
        ...(input.cc.length ? { cc: input.cc } : {}),
        ...(input.bcc.length ? { bcc: input.bcc } : {}),
        subject: oneLine(input.subject),
        text: input.body,
        attachments: [{ filename: input.pdfFileName.trim(), content: pdf, contentType: 'application/pdf' }],
      });
    } catch (err) {
      throw mailError(err);
    }

    // Sent: record it even if the invoice was voided meanwhile (it went out).
    const row = await lockInvoice(tx, tenantId, invoiceId, companyId);
    await recordSendEvent(tx, tenantId, row, { method: 'email', recipients }, userId);
    if (input.outboxId) {
      await tx.delete(formEmailQueue).where(and(eq(formEmailQueue.tenantId, tenantId), eq(formEmailQueue.id, input.outboxId)));
      await auditLog(tenantId, 'delete', 'form_email_queue', input.outboxId, null,
        { via: 'sent', transactionId: invoiceId }, userId, tx);
    }
  });
  return getInvoice(tenantId, invoiceId, companyId);
}

const itemColumns = {
  id: formEmailQueue.id,
  transactionId: formEmailQueue.transactionId,
  txnNumber: transactions.txnNumber,
  txnType: transactions.txnType,
  txnStatus: transactions.status,
  contactName: contacts.displayName,
  to: formEmailQueue.toAddresses,
  cc: formEmailQueue.ccAddresses,
  bcc: formEmailQueue.bccAddresses,
  subject: formEmailQueue.subject,
  body: formEmailQueue.body,
  userId: formEmailQueue.userId,
  createdAt: formEmailQueue.createdAt,
};

function queueQuery(tenantId: string, companyId?: string, id?: string) {
  return db.select(itemColumns).from(formEmailQueue)
    .leftJoin(transactions, and(eq(transactions.tenantId, formEmailQueue.tenantId), eq(transactions.id, formEmailQueue.transactionId)))
    .leftJoin(contacts, and(eq(contacts.tenantId, formEmailQueue.tenantId), eq(contacts.id, transactions.contactId)))
    .where(and(
      eq(formEmailQueue.tenantId, tenantId),
      ...(companyId ? [eq(formEmailQueue.companyId, companyId)] : []),
      ...(id ? [eq(formEmailQueue.id, id)] : []),
    ));
}

/** GET /forms/email-queue: the company's Outbox, oldest first. */
export async function listEmailQueue(tenantId: string, companyId?: string) {
  return queueQuery(tenantId, companyId).orderBy(asc(formEmailQueue.createdAt), asc(formEmailQueue.id));
}

/** One Outbox message of the company (404 otherwise). */
export async function getEmailQueueItem(tenantId: string, id: string, companyId?: string) {
  const [item] = await queueQuery(tenantId, companyId, id).limit(1);
  if (!item) throw outboxGone();
  return item;
}

/**
 * POST /invoices/:id/email-later: stores the message in the Outbox. The
 * invoice must be of this company and not void. The audit row carries the
 * recipient count only.
 */
export async function queueInvoiceEmail(
  tenantId: string, invoiceId: string, input: InvoiceEmailMessage, userId?: string, companyId?: string,
) {
  const id = await db.transaction(async (tx) => {
    await claimIdempotency(tx);
    const row = await lockInvoice(tx, tenantId, invoiceId, companyId);
    if (row.status === 'void') throw voidRefusal();
    const [item] = await tx.insert(formEmailQueue).values({
      tenantId,
      companyId: row.companyId ?? companyId ?? null,
      transactionId: invoiceId,
      toAddresses: input.to.map((a) => a.trim()),
      ccAddresses: input.cc.map((a) => a.trim()),
      bccAddresses: input.bcc.map((a) => a.trim()),
      subject: oneLine(input.subject),
      body: input.body,
      userId: userId ?? null,
    }).returning({ id: formEmailQueue.id });
    await recordIdempotentEntity(tx, 'form_email_queue', item!.id);
    await auditLog(tenantId, 'create', 'form_email_queue', item!.id, null, {
      via: 'email_later', transactionId: invoiceId, recipientCount: input.to.length + input.cc.length + input.bcc.length,
    }, userId, tx);
    return item!.id;
  });
  return getEmailQueueItem(tenantId, id, companyId);
}

/** DELETE /forms/email-queue/:id: removes one Outbox message of the company (404 otherwise). */
export async function deleteEmailQueueItem(tenantId: string, id: string, userId?: string, companyId?: string) {
  await db.transaction(async (tx) => {
    const [gone] = await tx.delete(formEmailQueue).where(and(
      eq(formEmailQueue.tenantId, tenantId), eq(formEmailQueue.id, id),
      ...(companyId ? [eq(formEmailQueue.companyId, companyId)] : []),
    )).returning({ transactionId: formEmailQueue.transactionId });
    if (!gone) throw outboxGone();
    await auditLog(tenantId, 'delete', 'form_email_queue', id, null, { via: 'removed', transactionId: gone.transactionId }, userId, tx);
  });
}
