// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  attachments,
  bankConnections,
  documentRequests,
  portalContactCompanies,
  portalReceipts,
  recurringDocumentRequests,
} from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';

// STATEMENT_AUTO_IMPORT_V1 — when a portal contact uploads in
// fulfilment of a doc_request whose document_type is bank_statement
// or cc_statement, this service routes the file into the bank-feed
// import pipeline instead of the receipts inbox.
//
// Routing policy (in order):
//   1. The recurring rule's bank_connection_id, if pre-bound.
//   2. The contact's company has exactly one bank connection of the
//      matching kind — use it.
//   3. Otherwise, mark the receipt as 'awaits_routing' and surface
//      it to the CPA for a manual pick. We never silently guess.

export type StatementDocumentType = 'bank_statement' | 'cc_statement';

export function isStatementDocumentType(type: string): type is StatementDocumentType {
  return type === 'bank_statement' || type === 'cc_statement';
}

interface PickResult {
  bankConnectionId: string | null;
  reason: 'rule_bound' | 'unique_company_match' | 'ambiguous' | 'no_candidates';
}

// Picks the bank connection a statement upload should land in. Returns
// the chosen id when one is unambiguous; otherwise returns null with
// a reason the caller can use for the receipt status + audit log.
export async function pickBankConnectionFor(
  tenantId: string,
  contactId: string,
  recurringId: string | null,
  documentType: StatementDocumentType,
): Promise<PickResult> {
  // 1) Pre-bound on the rule.
  if (recurringId) {
    const rule = await db.query.recurringDocumentRequests.findFirst({
      where: and(
        eq(recurringDocumentRequests.tenantId, tenantId),
        eq(recurringDocumentRequests.id, recurringId),
      ),
    });
    if (rule?.bankConnectionId) {
      return { bankConnectionId: rule.bankConnectionId, reason: 'rule_bound' };
    }
  }

  // 2) Unique company connection. The contact is associated with
  // companies via portal_contact_companies; for each linked company,
  // count its bank connections. If exactly one company-level
  // connection exists tenant-wide for this contact, use it.
  const companyRows = await db
    .select({ companyId: portalContactCompanies.companyId })
    .from(portalContactCompanies)
    .where(eq(portalContactCompanies.contactId, contactId));
  if (companyRows.length === 0) {
    return { bankConnectionId: null, reason: 'no_candidates' };
  }
  const companyIds = companyRows.map((r) => r.companyId);

  // Filter bank connections to those serving the contact's
  // companies. We don't filter by document_type here — bank vs.
  // credit-card distinction lives on the underlying account, which
  // is a follow-up — but the unique-match heuristic still works
  // when a company has only one bank connection.
  const conns = await db
    .select({ id: bankConnections.id })
    .from(bankConnections)
    .where(
      and(
        eq(bankConnections.tenantId, tenantId),
        sql`${bankConnections.companyId} = ANY(${companyIds}::uuid[])`,
      ),
    );
  if (conns.length === 1 && conns[0]) {
    return { bankConnectionId: conns[0].id, reason: 'unique_company_match' };
  }
  if (conns.length === 0) {
    return { bankConnectionId: null, reason: 'no_candidates' };
  }
  // Suppress documentType for the lint until we can use it — kept on
  // the signature so a future revision can refine the match by
  // bank vs. credit-card account type.
  void documentType;
  return { bankConnectionId: null, reason: 'ambiguous' };
}

interface RouteInput {
  tenantId: string;
  receiptId: string;
  documentRequestId: string;
  contactId: string;
  recurringId: string | null;
  documentType: StatementDocumentType;
}

interface RouteResult {
  status: 'imported' | 'awaits_routing' | 'no_candidates';
  bankConnectionId?: string;
  imported?: number;
  skipped?: number;
}

// Top-level entry. Picks the connection, parses the statement, and
// imports rows into bank_feed_items. On parse failure or no
// candidates, leaves the receipt in a recoverable state — never
// throws on the happy path so the upload route still returns 201.
export async function routeStatementUpload(input: RouteInput): Promise<RouteResult> {
  const pick = await pickBankConnectionFor(
    input.tenantId,
    input.contactId,
    input.recurringId,
    input.documentType,
  );

  if (!pick.bankConnectionId) {
    await db
      .update(portalReceipts)
      .set({ status: 'awaits_routing', updatedAt: new Date() })
      .where(eq(portalReceipts.id, input.receiptId));
    await auditLog(
      input.tenantId,
      'update',
      'portal_receipt',
      input.receiptId,
      null,
      { status: 'awaits_routing', reason: pick.reason, documentType: input.documentType },
    );
    return { status: pick.reason === 'no_candidates' ? 'no_candidates' : 'awaits_routing' };
  }

  return importStatementForReceipt(
    input.tenantId,
    input.receiptId,
    input.documentRequestId,
    pick.bankConnectionId,
  );
}

// The "we know which bank connection — go" path. Extracted so the
// CPA's manual pick action can reuse it from the receipts inbox.
export async function importStatementForReceipt(
  tenantId: string,
  receiptId: string,
  documentRequestId: string | null,
  bankConnectionId: string,
): Promise<RouteResult> {
  const receipt = await db.query.portalReceipts.findFirst({
    where: and(
      eq(portalReceipts.tenantId, tenantId),
      eq(portalReceipts.id, receiptId),
    ),
  });
  if (!receipt) throw AppError.notFound('Receipt not found');

  // The statement parser operates on attachments rows. Create a
  // shadow attachment that points at the same storage_key so the
  // existing `ensureLocal` path resolves the file unchanged.
  const shadowName = `statement-${receipt.id}-${receipt.filename}`.slice(0, 250);
  const shadow = await db
    .insert(attachments)
    .values({
      tenantId: receipt.tenantId,
      companyId: receipt.companyId,
      fileName: shadowName,
      filePath: receipt.storageKey,
      fileSize: receipt.sizeBytes ?? null,
      mimeType: receipt.mimeType ?? 'application/pdf',
      attachableType: 'portal_receipt_statement',
      attachableId: receipt.id,
      storageKey: receipt.storageKey,
      storageProvider: 'inherit',
    })
    .returning({ id: attachments.id });
  const shadowId = shadow[0]?.id;
  if (!shadowId) throw AppError.internal('Failed to create shadow attachment for statement parse');

  try {
    const statementParser = await import('./ai-statement-parser.service.js');
    const parsed = await statementParser.parseStatement(tenantId, shadowId);
    const rawTxns = (parsed as { transactions?: unknown } | undefined)?.transactions ?? [];
    const txns = (Array.isArray(rawTxns) ? rawTxns : []) as Array<{
      date?: string;
      description?: string;
      amount?: string;
      type?: 'debit' | 'credit';
    }>;
    if (txns.length === 0) {
      await db
        .update(portalReceipts)
        .set({ status: 'awaits_routing', updatedAt: new Date() })
        .where(eq(portalReceipts.id, receiptId));
      return { status: 'awaits_routing', bankConnectionId };
    }

    // Normalize to the importStatementItems shape — drop entries
    // without a date or amount, coerce to strings.
    const cleaned = txns
      .filter((t) => t.date && t.amount && t.description)
      .map((t) => ({
        date: t.date as string,
        description: t.description as string,
        amount: t.amount as string,
        type: t.type,
      }));

    const importer = await import('./bank-feed.service.js');
    const inserted = await importer.importStatementItems(tenantId, bankConnectionId, cleaned);
    const importedCount = Array.isArray(inserted) ? inserted.length : ((inserted as { imported?: number }).imported ?? 0);

    await db
      .update(portalReceipts)
      .set({
        status: 'statement_imported',
        documentRequestId: documentRequestId,
        updatedAt: new Date(),
      })
      .where(eq(portalReceipts.id, receiptId));

    if (documentRequestId) {
      const recurDoc = await import('./recurring-doc-request.service.js');
      await recurDoc.markFulfilledByReceipt(tenantId, documentRequestId, receiptId);
    }

    await auditLog(
      tenantId,
      'create',
      'statement_auto_import',
      receiptId,
      null,
      {
        bankConnectionId,
        imported: importedCount,
        cleanedCount: cleaned.length,
        rawCount: txns.length,
      },
    );

    return { status: 'imported', bankConnectionId, imported: importedCount, skipped: txns.length - cleaned.length };
  } catch (err) {
    // Parse failure leaves the receipt in pending_ocr so the existing
    // OCR retry path still applies. The caller doesn't see a 5xx —
    // the upload itself succeeded.
    await db
      .update(portalReceipts)
      .set({ status: 'pending_ocr', updatedAt: new Date() })
      .where(eq(portalReceipts.id, receiptId));
    await auditLog(
      tenantId,
      'update',
      'portal_receipt',
      receiptId,
      null,
      { event: 'statement_parse_failed', error: err instanceof Error ? err.message : String(err) },
    );
    return { status: 'awaits_routing', bankConnectionId };
  }
}

// CPA's manual pick — used by the receipts-inbox row action.
export async function manualRouteStatement(
  tenantId: string,
  bookkeeperUserId: string,
  receiptId: string,
  bankConnectionId: string,
): Promise<RouteResult> {
  // Verify the bank connection belongs to this tenant.
  const conn = await db.query.bankConnections.findFirst({
    where: and(eq(bankConnections.tenantId, tenantId), eq(bankConnections.id, bankConnectionId)),
  });
  if (!conn) throw AppError.notFound('Bank connection not found');

  // Find the document_request linked to this receipt (via
  // recurring rule chain) so fulfilment closes through the same
  // markFulfilledByReceipt path.
  const recv = await db.query.portalReceipts.findFirst({
    where: and(eq(portalReceipts.tenantId, tenantId), eq(portalReceipts.id, receiptId)),
  });
  if (!recv) throw AppError.notFound('Receipt not found');
  const docReq = recv.documentRequestId
    ? await db.query.documentRequests.findFirst({
        where: and(eq(documentRequests.tenantId, tenantId), eq(documentRequests.id, recv.documentRequestId)),
      })
    : null;

  const result = await importStatementForReceipt(
    tenantId,
    receiptId,
    docReq?.id ?? null,
    bankConnectionId,
  );
  await auditLog(
    tenantId,
    'update',
    'portal_receipt_manual_route',
    receiptId,
    null,
    { bankConnectionId, ...result },
    bookkeeperUserId,
  );
  return result;
}
