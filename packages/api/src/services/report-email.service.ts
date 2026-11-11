// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

/**
 * Report email (U-207, reports-email-v1; ClientLedger P28): the client makes
 * the report file (PDF, Excel or CSV) and the engine sends it through the
 * company's mail server, as invoices and statements are sent (U-127). One
 * audit row `create` / `report_email` per send, with the file name, type,
 * size, recipients and company; never the subject, body or file.
 */

import { z } from 'zod';
import { INVOICE_EMAIL_PDF_MAX_BYTES } from '@kis-books/shared';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import { sendWithAttachment, type MailAttachment } from './invoice-email.service.js';

/** The largest attachment, decoded: 10 MB, as the invoice email. */
export const REPORT_EMAIL_MAX_BYTES = INVOICE_EMAIL_PDF_MAX_BYTES;

const CONTENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv; charset=utf-8',
};

export const reportEmailSchema = z.object({
  to: z.array(z.string().max(320)).min(1).max(50),
  cc: z.array(z.string().max(320)).max(50).default([]),
  bcc: z.array(z.string().max(320)).max(50).default([]),
  subject: z.string().max(500),
  body: z.string().max(20000),
  filename: z.string().min(1).max(200)
    .describe('Ends in .pdf, .xlsx or .csv; no path separators or control characters (else 400 VALIDATION_ERROR)'),
  fileBase64: z.string().min(1).optional().describe('The file, base64 (at most 10 MB decoded). Exactly one of fileBase64 and pdfBase64.'),
  pdfBase64: z.string().min(1).optional().describe('Alias of fileBase64 (the plan\'s name).'),
  reportKey: z.string().max(100).optional().describe('The report\'s catalog key, for the audit row only'),
});
export type ReportEmailInput = z.infer<typeof reportEmailSchema>;

const EMAIL = z.string().email();

/** 400 INVALID_RECIPIENT {field, index} for the first address that is not an email address. */
export function checkRecipients(input: Pick<ReportEmailInput, 'to' | 'cc' | 'bcc'>): void {
  for (const field of ['to', 'cc', 'bcc'] as const) {
    input[field].forEach((address, index) => {
      if (!EMAIL.safeParse(address.trim()).success) {
        throw AppError.badRequest(`The ${field} address ${index + 1} is not an email address`, 'INVALID_RECIPIENT', { field, index });
      }
    });
  }
}

/** The decoded, checked attachment: strict base64, at most 10 MB, contents matching the extension. */
export function decodeReportAttachment(filename: string, base64: string): MailAttachment {
  const name = filename.trim();
  // eslint-disable-next-line no-control-regex
  if (!name || /[\\/\u0000-\u001f\u007f]/.test(name)) {
    throw AppError.badRequest('filename must be a plain file name', 'VALIDATION_ERROR', { field: 'filename' });
  }
  const ext = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase() ?? '';
  const contentType = CONTENT_TYPES[ext];
  if (!contentType) {
    throw AppError.badRequest('The file must be a .pdf, .xlsx or .csv file', 'VALIDATION_ERROR', { field: 'filename' });
  }
  const clean = base64.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 !== 0) {
    throw AppError.badRequest('fileBase64 is not valid base64', 'VALIDATION_ERROR', { field: 'fileBase64' });
  }
  const content = Buffer.from(clean, 'base64');
  if (content.length > REPORT_EMAIL_MAX_BYTES) {
    throw AppError.badRequest('The file is larger than 10 MB', 'ATTACHMENT_TOO_LARGE', { maxBytes: REPORT_EMAIL_MAX_BYTES });
  }
  const bad = () => AppError.badRequest(`The file is not a ${ext.toUpperCase()} file`, 'VALIDATION_ERROR', { field: 'fileBase64' });
  if (content.length === 0) throw bad();
  if (ext === 'pdf' && (content.length < 5 || content.subarray(0, 5).toString('latin1') !== '%PDF-')) throw bad();
  // xlsx is a zip package: local file header PK\x03\x04.
  if (ext === 'xlsx' && (content.length < 4 || content.readUInt32LE(0) !== 0x04034b50)) throw bad();
  if (ext === 'csv') {
    if (content.includes(0)) throw bad();
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(content);
    } catch {
      throw bad();
    }
  }
  return { filename: name, content, contentType };
}

/** POST /reports/email: sends the file, writes the audit row (on the send's transaction). */
export async function sendReportEmail(
  tenantId: string, companyId: string | undefined, input: ReportEmailInput, userId?: string,
): Promise<{ sent: true; filename: string; recipientCount: number }> {
  if ((input.fileBase64 === undefined) === (input.pdfBase64 === undefined)) {
    throw AppError.badRequest('Send the file as fileBase64 (or pdfBase64), once', 'VALIDATION_ERROR', { field: 'fileBase64' });
  }
  checkRecipients(input);
  const attachment = decodeReportAttachment(input.filename, (input.fileBase64 ?? input.pdfBase64)!);
  const message = {
    to: input.to.map((a) => a.trim()), cc: input.cc.map((a) => a.trim()), bcc: input.bcc.map((a) => a.trim()),
    subject: input.subject, body: input.body,
  };
  let count = 0;
  await sendWithAttachment(tenantId, companyId, message, attachment, async (tx) => async (recipients) => {
    count = recipients.length;
    await auditLog(tenantId, 'create', 'report_email', null, null, {
      filename: attachment.filename,
      contentType: attachment.contentType.split(';')[0],
      bytes: attachment.content.length,
      recipients,
      reportKey: input.reportKey ?? null,
      companyId: companyId ?? null,
    }, userId, tx);
  });
  return { sent: true, filename: attachment.filename, recipientCount: count };
}
