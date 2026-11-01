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
 * U-144 (sales-doc-email-v1): the same send and Outbox for credit memos and
 * sales receipts (emailSalesDocument, queueSalesDocumentEmail); their Outbox
 * rows have kind credit_memo / sales_receipt. No migration: the queue and
 * the send events already key on any transaction id.
 *
 * Recipients, subjects and bodies are owner data: never logged, never in an
 * audit row (audit rows carry counts). Mail transports come from
 * createMailTransport, so tests replace nodemailer (vi.mock) and no network
 * is used.
 */

import { and, asc, eq } from 'drizzle-orm';
import { db, type Tx } from '../db/index.js';
import { contacts, formEmailQueue, transactions, customerStatements, customerStatementEmailQueue } from '../db/schema/index.js';
import { INVOICE_EMAIL_PDF_MAX_BYTES } from '@kis-books/shared';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import { createMailTransport } from '../utils/mail-transport.js';
import { getSmtpSettings as getSystemSmtp } from './admin.service.js';
import { getSmtpTransportSettings } from './company.service.js';
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
  // The company's settings as every mail path reads them (review nit 7).
  const company = await getSmtpTransportSettings(tenantId, companyId).catch((e: unknown) => {
    if (e instanceof AppError && e.statusCode === 404) return null;
    throw e;
  });
  let smtp: { host: string; port: number; user: string; pass: string; from: string; fromName: string };
  if (company?.configured) {
    smtp = {
      host: company.smtpHost, port: company.smtpPort, user: company.smtpUser, pass: company.smtpPass,
      from: company.smtpFrom, fromName: company.smtpFromName,
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

/**
 * The sales documents that can be emailed with a client-made PDF (U-127;
 * U-144 sales-doc-email-v1 adds credit memos and sales receipts). An
 * invoice keeps its U-127 answers (another type 400, void 400 INVOICE_VOID);
 * a credit memo or sales receipt answers as its own routes do (an unknown
 * id or another type 404, void 400 DOCUMENT_VOID).
 */
export type EmailableTxnType = 'invoice' | 'credit_memo' | 'cash_sale';

const DOC_NAMES: Record<EmailableTxnType, string> = {
  invoice: 'invoice', credit_memo: 'credit memo', cash_sale: 'sales receipt',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function docNotFound(txnType: EmailableTxnType): AppError {
  if (txnType === 'invoice') return AppError.notFound('Transaction not found');
  return AppError.notFound(txnType === 'credit_memo' ? 'Credit memo not found' : 'Sales receipt not found');
}

function assertDocType(row: { txnType: string }, txnType: EmailableTxnType): void {
  if (row.txnType === txnType) return;
  if (txnType === 'invoice') throw AppError.badRequest('Not an invoice');
  throw docNotFound(txnType);
}

/** The document row for a send, under a row lock, or the reason it can't be sent. */
async function lockDocument(tx: Tx, tenantId: string, txnType: EmailableTxnType, id: string, companyId?: string) {
  const [row] = await tx.select().from(transactions)
    .where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, id)))
    .for('update').limit(1);
  if (!row || row.status === 'deleted' || ledger.inOtherCompany(row, companyId)) throw docNotFound(txnType);
  assertDocType(row, txnType);
  return row;
}

function outboxGone(): AppError {
  return new AppError(404, 'That message is no longer in the Outbox', 'OUTBOX_ITEM_NOT_FOUND');
}

function voidRefusal(txnType: EmailableTxnType = 'invoice'): AppError {
  if (txnType === 'invoice') return AppError.badRequest('A void invoice can’t be sent', 'INVOICE_VOID');
  return AppError.badRequest(`A void ${DOC_NAMES[txnType]} can’t be sent`, 'DOCUMENT_VOID');
}

/** A credit memo or sales receipt id that is not a uuid is 404, as on their other routes. */
function assertId(txnType: EmailableTxnType, id: string): void {
  if (txnType !== 'invoice' && !UUID_RE.test(id)) throw docNotFound(txnType);
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
  await emailSalesDocument(tenantId, 'invoice', invoiceId, input, userId, companyId);
  return getInvoice(tenantId, invoiceId, companyId);
}

/**
 * POST /invoices|credit-memos|sales-receipts/:id/email (U-127; U-144
 * sales-doc-email-v1): the send of emailInvoice for any emailable sales
 * document. Returns nothing; each route reads its document back.
 */
export async function emailSalesDocument(
  tenantId: string, txnType: EmailableTxnType, docId: string, input: InvoiceEmailInput, userId?: string, companyId?: string,
): Promise<void> {
  assertId(txnType, docId);
  const invoiceId = docId;
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
    if (!pre || pre.status === 'deleted' || ledger.inOtherCompany(pre, companyId)) throw docNotFound(txnType);
    assertDocType(pre, txnType);
    if (pre.status === 'void') throw voidRefusal(txnType);
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

    // Sent: record it even if the document was voided meanwhile (it went out).
    const row = await lockDocument(tx, tenantId, txnType, invoiceId, companyId);
    await recordSendEvent(tx, tenantId, row, { method: 'email', recipients }, userId);
    if (input.outboxId) {
      await tx.delete(formEmailQueue).where(and(eq(formEmailQueue.tenantId, tenantId), eq(formEmailQueue.id, input.outboxId)));
      await auditLog(tenantId, 'delete', 'form_email_queue', input.outboxId, null,
        { via: 'sent', transactionId: invoiceId }, userId, tx);
    }
  });
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

/** Statement Outbox rows (U-140) in the forms Outbox shape. */
function statementQueueQuery(tenantId: string, companyId?: string, id?: string) {
  return db.select({
    id: customerStatementEmailQueue.id,
    customerStatementId: customerStatementEmailQueue.customerStatementId,
    txnNumber: customerStatements.number,
    contactName: contacts.displayName,
    to: customerStatementEmailQueue.toAddresses,
    cc: customerStatementEmailQueue.ccAddresses,
    bcc: customerStatementEmailQueue.bccAddresses,
    subject: customerStatementEmailQueue.subject,
    body: customerStatementEmailQueue.body,
    userId: customerStatementEmailQueue.userId,
    createdAt: customerStatementEmailQueue.createdAt,
  }).from(customerStatementEmailQueue)
    .leftJoin(customerStatements, and(eq(customerStatements.tenantId, customerStatementEmailQueue.tenantId), eq(customerStatements.id, customerStatementEmailQueue.customerStatementId)))
    .leftJoin(contacts, and(eq(contacts.tenantId, customerStatementEmailQueue.tenantId), eq(contacts.id, customerStatements.contactId)))
    .where(and(
      eq(customerStatementEmailQueue.tenantId, tenantId),
      ...(companyId ? [eq(customerStatementEmailQueue.companyId, companyId)] : []),
      ...(id ? [eq(customerStatementEmailQueue.id, id)] : []),
    ));
}

type QueueRow = Awaited<ReturnType<typeof queueQuery>>[number];
type StatementQueueRow = Awaited<ReturnType<typeof statementQueueQuery>>[number];
/**
 * What an Outbox row sends (U-140; U-144): `transaction` (an invoice, as
 * before), `credit_memo`, `sales_receipt` (txnType cash_sale) or
 * `customer_statement`. The client sends a row with the matching
 * POST /invoices|credit-memos|sales-receipts|customer-statements/:id/email.
 */
export type OutboxKind = 'transaction' | 'credit_memo' | 'sales_receipt' | 'customer_statement';
export const OUTBOX_KINDS = ['transaction', 'credit_memo', 'sales_receipt', 'customer_statement'] as const;

/** An Outbox row (U-127; U-140 adds kind and customerStatementId; U-144 the credit_memo and sales_receipt kinds). */
export type OutboxItem = Omit<QueueRow, 'transactionId'> & {
  transactionId: string | null; kind: OutboxKind; customerStatementId: string | null;
};
function formKind(txnType: string | null): OutboxKind {
  if (txnType === 'credit_memo') return 'credit_memo';
  if (txnType === 'cash_sale') return 'sales_receipt';
  return 'transaction';
}
const fromForm = (r: QueueRow): OutboxItem => ({ ...r, kind: formKind(r.txnType), customerStatementId: null });
const fromStatement = (r: StatementQueueRow): OutboxItem => ({
  id: r.id, transactionId: null, txnNumber: r.txnNumber ?? null, txnType: 'customer_statement', txnStatus: null,
  contactName: r.contactName ?? null, to: r.to, cc: r.cc, bcc: r.bcc, subject: r.subject, body: r.body, userId: r.userId,
  createdAt: r.createdAt, kind: 'customer_statement', customerStatementId: r.customerStatementId,
});

/** GET /forms/email-queue: the company's Outbox (forms and statements), oldest first. */
export async function listEmailQueue(tenantId: string, companyId?: string): Promise<OutboxItem[]> {
  const forms = (await queueQuery(tenantId, companyId)).map(fromForm);
  const statements = (await statementQueueQuery(tenantId, companyId)).map(fromStatement);
  return [...forms, ...statements].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
}

/** One Outbox message of the company (404 otherwise). */
export async function getEmailQueueItem(tenantId: string, id: string, companyId?: string): Promise<OutboxItem> {
  const [item] = await queueQuery(tenantId, companyId, id).limit(1);
  if (item) return fromForm(item);
  const [st] = await statementQueueQuery(tenantId, companyId, id).limit(1);
  if (!st) throw outboxGone();
  return fromStatement(st);
}

/**
 * POST /invoices/:id/email-later: stores the message in the Outbox. The
 * invoice must be of this company and not void. The audit row carries the
 * recipient count only.
 */
export async function queueInvoiceEmail(
  tenantId: string, invoiceId: string, input: InvoiceEmailMessage, userId?: string, companyId?: string,
) {
  return queueSalesDocumentEmail(tenantId, 'invoice', invoiceId, input, userId, companyId);
}

/**
 * POST /invoices|credit-memos|sales-receipts/:id/email-later (U-127; U-144):
 * the Outbox row of any emailable sales document (kind from its type).
 */
export async function queueSalesDocumentEmail(
  tenantId: string, txnType: EmailableTxnType, invoiceId: string, input: InvoiceEmailMessage, userId?: string, companyId?: string,
) {
  assertId(txnType, invoiceId);
  const id = await db.transaction(async (tx) => {
    await claimIdempotency(tx);
    const row = await lockDocument(tx, tenantId, txnType, invoiceId, companyId);
    if (row.status === 'void') throw voidRefusal(txnType);
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

/** DELETE /forms/email-queue/:id: removes one Outbox message (form or statement) of the company (404 otherwise). */
export async function deleteEmailQueueItem(tenantId: string, id: string, userId?: string, companyId?: string) {
  await db.transaction(async (tx) => {
    const [gone] = await tx.delete(formEmailQueue).where(and(
      eq(formEmailQueue.tenantId, tenantId), eq(formEmailQueue.id, id),
      ...(companyId ? [eq(formEmailQueue.companyId, companyId)] : []),
    )).returning({ transactionId: formEmailQueue.transactionId });
    if (gone) {
      await auditLog(tenantId, 'delete', 'form_email_queue', id, null, { via: 'removed', transactionId: gone.transactionId }, userId, tx);
      return;
    }
    const [st] = await tx.delete(customerStatementEmailQueue).where(and(
      eq(customerStatementEmailQueue.tenantId, tenantId), eq(customerStatementEmailQueue.id, id),
      ...(companyId ? [eq(customerStatementEmailQueue.companyId, companyId)] : []),
    )).returning({ customerStatementId: customerStatementEmailQueue.customerStatementId });
    if (!st) throw outboxGone();
    await auditLog(tenantId, 'delete', 'customer_statement_email_queue', id, null, { via: 'removed', customerStatementId: st.customerStatementId }, userId, tx);
  });
}

/**
 * Sends one email with a client-made PDF (U-127 rules) for a document that
 * is not an invoice (U-140 statements): PDF and mail server checked first,
 * then in one database transaction: the Idempotency-Key claim,  * (locks and checks the document, returns the recorder), the send, the
 * record. Recipients, subject and body are never logged.
 */
export async function sendFormEmail(
  tenantId: string, companyId: string | undefined, input: InvoiceEmailInput,
  prepare: (tx: Tx) => Promise<(recipients: string[]) => Promise<void>>,
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
    const record = await prepare(tx);
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
    await record(recipients);
  });
}
