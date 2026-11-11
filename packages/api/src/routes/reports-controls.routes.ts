// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

/**
 * Controls reports and report email on the /reports router (ClientLedger P28):
 *   GET  /closing-date-exceptions   U-204, closing-exceptions-v1
 *   POST /email                     U-207, reports-email-v1
 * Both run behind the reports router's authenticate, companyContext,
 * reports-read permission and report limiter.
 */

import type { Router } from 'express';
import { z } from 'zod';
import { describe } from '../middleware/describe.js';
import { requirePermission } from '../middleware/permission.js';
import { idempotent } from '../middleware/idempotent.js';
import { validate } from '../middleware/validate.js';
import { buildClosingDateExceptions, CLOSING_EXCEPTIONS_MAX_ROWS } from '../services/closing-date-exceptions.service.js';
import { reportEmailSchema, sendReportEmail } from '../services/report-email.service.js';
import { date } from './reports-exact.routes.js';
import { AppError } from '../utils/errors.js';

const exceptionsQuery = z.object({
  start_date: z.string().optional().describe('YYYY-MM-DD: changes made on or after this day (the day of the change, not the transaction date)'),
  end_date: z.string().optional().describe('YYYY-MM-DD: changes made on or before this day'),
  limit: z.string().optional().describe(`Rows returned, 1..${CLOSING_EXCEPTIONS_MAX_ROWS} (default 5000); total and truncated tell the rest`),
});

export function registerControlReportRoutes(router: Router): void {
  router.get('/closing-date-exceptions', requirePermission('audit_log', 'read'), describe({
    summary: 'Closing Date Exceptions (closing-exceptions-v1)',
    description: 'Response {data[], total, truncated, closingDate (now), timeline[] {at, closingDate}}. Every create, update, void or '
      + 'delete of a transaction of the company whose date before or after the change was on or before the closing date in effect when '
      + 'the change was made, plus every closing_date_override row (Q-P28q). The timeline is the closing-date changes in the audit trail '
      + 'plus the current setting; changes made before any closing date was set are not listed. Rows, oldest change first: {auditId, at, '
      + 'userId, userName, action (create|update|void|delete|override), transactionId, txnType, txnNumber, txnDateBefore, txnDateAfter, '
      + 'closingDate (in effect at the time), method (password|confirmed|null: the override that allowed it, if any), amountBeforeExact, '
      + 'amountAfterExact (decimal strings, at least 4 places; null on a create (before), a void or delete (after), and on override-only rows)}. '
      + 'Before and after come from the audit images: a change\'s after state is the next change\'s before-image, else the live '
      + 'transaction. Needs reports and audit_log read.',
    query: exceptionsQuery,
  }), async (req, res) => {
    const startDate = date(req, 'start_date');
    const endDate = date(req, 'end_date');
    if (startDate && endDate && startDate > endDate) {
      throw AppError.badRequest('start_date is after end_date', 'INVALID_PARAM', { param: 'start_date' });
    }
    const rawLimit = req.query['limit'];
    let limit: number | undefined;
    if (rawLimit !== undefined) {
      limit = Number(rawLimit);
      if (!Number.isInteger(limit) || limit < 1 || limit > CLOSING_EXCEPTIONS_MAX_ROWS) {
        throw AppError.badRequest(`limit must be 1..${CLOSING_EXCEPTIONS_MAX_ROWS}`, 'INVALID_PARAM', { param: 'limit' });
      }
    }
    const result = await buildClosingDateExceptions(req.tenantId, req.companyId, { startDate, endDate, limit });
    res.json({ ...result, meta: { from: startDate ?? null, to: endDate ?? null } });
  });

  router.post('/email', idempotent({ successStatus: 200 }), validate(reportEmailSchema), describe({
    summary: 'Email a report file (reports-email-v1)',
    description: 'Response {sent: true, filename, recipientCount}. Sends the client-made report file (filename ending .pdf, .xlsx or .csv; '
      + 'fileBase64, or pdfBase64 as an alias; at most 10 MB decoded, else 400 ATTACHMENT_TOO_LARGE; contents must match the type, else 400 '
      + 'VALIDATION_ERROR) through the company mail server as invoices are sent: 400 SMTP_NOT_CONFIGURED, 400 SMTP_SEND_FAILED {reason}, 503 '
      + 'OFFLINE_UNAVAILABLE. A recipient that is not an email address is 400 INVALID_RECIPIENT {field, index}. Takes Idempotency-Key '
      + '(a replay sends nothing). Writes one audit row create/report_email {filename, contentType, bytes, recipients, reportKey, companyId}. '
      + 'Subject, body and file are never logged or stored.',
    body: reportEmailSchema,
  }), async (req, res) => {
    res.json(await sendReportEmail(req.tenantId, req.companyId, req.body, req.userId));
  });
}
