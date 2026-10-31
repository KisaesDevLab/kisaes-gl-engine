// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Form send history (U-126, invoice-sent-history-v1): one
 * document_send_events row per send (printed, email, pdf), kept across edits
 * of the form. Recipients are stored for the owner to see and never written
 * to a log or an audit row.
 */

import { eq, and, asc } from 'drizzle-orm';
import { type DbOrTx, type Tx } from '../db/index.js';
import { transactions, documentSendEvents } from '../db/schema/index.js';
import type { DocumentSendMethod } from '../db/schema/document-send-events.js';
import { auditLog } from '../middleware/audit.js';

/** A form's send history, oldest first (U-126). */
export async function listSendHistory(executor: DbOrTx, tenantId: string, txnId: string) {
  return executor.select({
    id: documentSendEvents.id,
    method: documentSendEvents.method,
    recipients: documentSendEvents.recipients,
    sentAt: documentSendEvents.sentAt,
    userId: documentSendEvents.userId,
  }).from(documentSendEvents)
    .where(and(eq(documentSendEvents.tenantId, tenantId), eq(documentSendEvents.transactionId, txnId)))
    .orderBy(asc(documentSendEvents.sentAt), asc(documentSendEvents.createdAt), asc(documentSendEvents.id));
}

/**
 * Records one send of a form (U-126) on the caller's transaction, after the
 * caller locked the row: a document_send_events row; for an invoice, a
 * draft becomes 'sent' and sent_at is set when empty. updatedAt moves only
 * when the status changes. The audit row carries the method and the number
 * of recipients, never the addresses.
 */
export async function recordSendEvent(
  tx: Tx, tenantId: string,
  row: { id: string; txnType: string; companyId: string | null; invoiceStatus: string | null; sentAt: Date | null },
  event: { method: DocumentSendMethod; recipients?: string[]; sentAt?: Date },
  userId?: string,
) {
  const sentAt = event.sentAt ?? new Date();
  const recipients = event.method === 'email' ? [...new Set(event.recipients ?? [])] : [];
  const [ev] = await tx.insert(documentSendEvents).values({
    tenantId, companyId: row.companyId, transactionId: row.id, method: event.method, recipients, sentAt, userId: userId ?? null,
  }).returning({ id: documentSendEvents.id });
  if (row.txnType === 'invoice') {
    const toSent = row.invoiceStatus === 'draft';
    if (toSent || !row.sentAt) {
      await tx.update(transactions).set({
        ...(toSent ? { invoiceStatus: 'sent', updatedAt: new Date() } : {}),
        ...(!row.sentAt ? { sentAt } : {}),
      }).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, row.id)));
    }
  }
  await auditLog(tenantId, 'update', row.txnType === 'invoice' ? 'invoice' : 'form', row.id,
    { invoiceStatus: row.invoiceStatus },
    { via: 'record_sent', method: event.method, recipientCount: recipients.length, sendEventId: ev!.id }, userId, tx);
  return ev!.id;
}

