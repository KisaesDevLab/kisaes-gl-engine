// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Email and email-later for credit memos and sales receipts (U-144,
 * sales-doc-email-v1): the invoice routes' contract (U-127) on each
 * document's own router, so each keeps its own permission (credit memos
 * under `invoices`, sales receipts under `transactions`) and company
 * scope. The send logic is the invoice one (services/invoice-email.service.ts).
 * Idempotency-Key on both routes under sales-doc-email-v1. The large JSON
 * body for the PDF is parsed by invoiceEmailJson (invoices.routes.ts).
 */

import type { Router, Request } from 'express';
import { z } from 'zod';
import { emailInvoiceSchema, invoiceEmailMessageSchema } from '@kis-books/shared';
import { validate } from '../middleware/validate.js';
import { idempotent } from '../middleware/idempotent.js';
import { describe } from '../middleware/describe.js';
import * as invoiceEmail from '../services/invoice-email.service.js';
import { emailRules, outboxItemDoc } from './invoices.routes.js';

export interface SalesDocEmailConfig {
  txnType: 'credit_memo' | 'cash_sale';
  /** The document in the route path, e.g. "credit-memos". */
  path: string;
  /** The response key, e.g. "creditMemo". */
  key: string;
  /** e.g. "credit memo". */
  name: string;
  /** e.g. "CreditMemoRecord" (its fields are described on GET /:id). */
  recordName: string;
  /** e.g. "CreditMemo-1042.pdf". */
  fileExample: string;
  /** Reads the document back as GET /:id returns it. */
  read: (req: Request) => Promise<unknown>;
}

const idParams = z.object({ id: z.string().uuid() });
const docRules = (c: SalesDocEmailConfig) => emailRules
  .replace('400 INVOICE_VOID', `400 DOCUMENT_VOID (a void ${c.name})`)
  .replace('404 (another company).', `404 (unknown id, another type or another company).`);

/** Adds POST /:id/email and POST /:id/email-later to the document's router. */
export function mountSalesDocEmail(router: Router, c: SalesDocEmailConfig): void {
  router.post('/:id/email', idempotent({
    successStatus: 200,
    replay: async (req) => ({ [c.key]: await c.read(req) }),
  }), validate(emailInvoiceSchema), describe({
    summary: `Email a ${c.name} through the company mail server (sales-doc-email-v1)`,
    description: `As POST /invoices/:id/email (U-127): sends {to, cc, bcc, subject, body} with the PDF the client made attached (pdfBase64: `
      + `application/pdf starting %PDF-, at most 10 MB decoded, else 400 ATTACHMENT_TOO_LARGE / VALIDATION_ERROR; pdfFileName e.g. ${c.fileExample}). `
      + 'Only when the server accepts it, an "email" send event (recipients = to + cc + bcc) is recorded; a failed send records nothing. '
      + 'outboxId (optional): the Outbox message being sent; it is removed in the same commit, and 404 OUTBOX_ITEM_NOT_FOUND (nothing sent) '
      + `when it is gone. Response 200 {${c.key}: ${c.recordName}} with its sendHistory. Idempotency-Key: a retry with the key replays `
      + 'and sends nothing more. The closing date does not apply to sending. ' + docRules(c),
    body: emailInvoiceSchema,
    params: idParams,
  }), async (req, res) => {
    await invoiceEmail.emailSalesDocument(req.tenantId, c.txnType, req.params['id']!, req.body, req.userId, req.companyId);
    res.json({ [c.key]: await c.read(req) });
  });

  router.post('/:id/email-later', idempotent({
    successStatus: 201,
    replay: async (req, entity) => ({ item: await invoiceEmail.getEmailQueueItem(req.tenantId, entity!.id, req.companyId) }),
  }), validate(invoiceEmailMessageSchema), describe({
    summary: `Put a ${c.name} email in the Outbox (sales-doc-email-v1)`,
    description: `Stores {to, cc, bcc, subject, body} with the company; nothing is sent until the client sends it with POST /${c.path}/:id/email `
      + `and outboxId. No PDF is stored: the client makes it when it sends. Response 201 {item} (as GET /forms/email-queue; kind `
      + `${c.txnType === 'credit_memo' ? 'credit_memo' : 'sales_receipt'}). Void: 400 DOCUMENT_VOID; unknown id, another type or another `
      + 'company: 404. ' + emailRules.split(' Errors:')[0],
    body: invoiceEmailMessageSchema,
    params: idParams,
    response: z.object({ item: outboxItemDoc }),
  }), async (req, res) => {
    const item = await invoiceEmail.queueSalesDocumentEmail(req.tenantId, c.txnType, req.params['id']!, req.body, req.userId, req.companyId);
    res.status(201).json({ item });
  });
}
