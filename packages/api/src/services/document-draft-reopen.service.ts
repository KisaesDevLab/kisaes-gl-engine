// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

/**
 * Reopens document drafts when the entry they were entered as, or attached
 * to, is deleted (U-180, document-drafts-reopen-v1).
 *
 * A draft that was converted (POST /document-drafts/:id/convert), attached
 * (POST /document-drafts/:id/attach) or attached by a bank feed accept
 * (feed-accept-draft-v1) points at its entry through converted_transaction_id.
 * When that entry is deleted (ledger.deleteTransactionInTx: DELETE
 * /transactions/:id, bank feed Undo, a journal entry's reversal, an inventory
 * adjustment delete, any other caller), the document would otherwise stay
 * "entered" on an entry nobody sees, and a converted draft can't be
 * discarded: the receipt would be lost from the review queue. So, in the
 * deleting database transaction:
 *   - every converted draft of the entry is locked (id order), set back to
 *     status `ready` with converted_transaction_id / type / at / by cleared
 *     and a new updatedAt (its kind and reading are kept);
 *   - its own file (attachment_id), when it is still filed on the deleted
 *     entry, moves back onto a draft key: the key it was relinked from
 *     (attachments.source_draft_key, U-183; for a file relinked before
 *     migration 0270, the relink's audit row), else the draft's id;
 *   - with it, every other file on the entry that a relink took off that
 *     same key (source_draft_key, U-183): the convert's or attach's other
 *     files of the key. Files filed on the entry by hand (no
 *     source_draft_key) or from another key stay where they are; files moved
 *     back have source_draft_key cleared;
 *   - one audit row per file moved and one per draft (`reopened: true`).
 * A draft whose file was deleted after it was entered (attachment_id null)
 * is reopened without a file, and the other files of its key stay on the
 * entry (the key is known only through the own file).
 *
 * A void keeps the entry, so it leaves its drafts converted (attaching to a
 * void entry is 409 TRANSACTION_NOT_POSTED, so nothing new links to it).
 *
 * This module imports only the database and the audit helper: the ledger
 * calls it, and document-draft.service imports the ledger.
 */

import { and, asc, eq, ne, sql } from 'drizzle-orm';
import type { Tx } from '../db/index.js';
import { attachments, documentDrafts } from '../db/schema/index.js';
import { auditLog } from '../middleware/audit.js';

/** The next updated_at of a draft: now, but at least one millisecond after the stored value (document-draft.service). */
const NEXT_UPDATED_AT = sql`date_trunc('milliseconds', greatest(clock_timestamp(), ${documentDrafts.updatedAt} + interval '1 millisecond'))`;

/**
 * The draft key a file was relinked from onto `txnId`: the before-image of
 * its newest relink audit row, else null.
 */
async function originalDraftKey(tx: Tx, tenantId: string, attachmentId: string, txnId: string): Promise<string | null> {
  // auditLog() stores a JSON text, so the column holds a JSON string scalar; read either form.
  const doc = (col: string) => sql.raw(`(CASE WHEN jsonb_typeof(${col}) = 'string' THEN (${col} #>> '{}')::jsonb ELSE ${col} END)`);
  const r = await tx.execute(sql`SELECT b->>'attachableId' AS key
    FROM (SELECT id, ${doc('before_data')} AS b, ${doc('after_data')} AS a FROM audit_log
      WHERE tenant_id = ${tenantId} AND entity_type = 'attachment' AND entity_id = ${attachmentId} AND action = 'update') x
    WHERE b->>'attachableType' = 'draft' AND a->>'attachableId' = ${txnId}
    ORDER BY id DESC
    LIMIT 1`);
  const key = (r.rows[0] as { key: string | null } | undefined)?.key ?? null;
  return key && key.length > 0 ? key : null;
}

/**
 * Reopens every converted draft of `txnId` (see the header), on the
 * caller's transaction. Returns the reopened draft ids, sorted.
 */
export async function reopenDraftsOfDeletedTransaction(
  tx: Tx, tenantId: string, txnId: string, userId?: string,
): Promise<string[]> {
  const drafts = await tx.select().from(documentDrafts)
    .where(and(
      eq(documentDrafts.tenantId, tenantId),
      eq(documentDrafts.convertedTransactionId, txnId),
      eq(documentDrafts.status, 'converted'),
    ))
    .orderBy(asc(documentDrafts.id))
    .for('update');
  const reopened: string[] = [];
  for (const before of drafts) {
    let fileMoved = false;
    if (before.attachmentId) {
      const [file] = await tx.select({
        id: attachments.id, attachableType: attachments.attachableType, attachableId: attachments.attachableId,
        sourceDraftKey: attachments.sourceDraftKey,
      })
        .from(attachments)
        .where(and(eq(attachments.tenantId, tenantId), eq(attachments.id, before.attachmentId)))
        .for('update');
      if (file && file.attachableType !== 'draft' && file.attachableId === txnId) {
        const key = file.sourceDraftKey ?? (await originalDraftKey(tx, tenantId, file.id, txnId)) ?? before.id;
        // The own file, then (U-183) every other file on the entry the same
        // relink took off that key, in id order (the relink's lock order).
        const others = file.sourceDraftKey === null ? [] : await tx.select({ id: attachments.id })
          .from(attachments)
          .where(and(
            eq(attachments.tenantId, tenantId),
            eq(attachments.attachableType, file.attachableType),
            eq(attachments.attachableId, txnId),
            eq(attachments.sourceDraftKey, key),
            ne(attachments.id, file.id),
          ))
          .orderBy(asc(attachments.id))
          .for('update');
        for (const id of [file.id, ...others.map((o) => o.id)]) {
          await tx.update(attachments).set({ attachableType: 'draft', attachableId: key, sourceDraftKey: null })
            .where(and(eq(attachments.tenantId, tenantId), eq(attachments.id, id)));
          await auditLog(tenantId, 'update', 'attachment', id,
            { attachableType: file.attachableType, attachableId: txnId },
            { attachableType: 'draft', attachableId: key, reopenedDraftId: before.id },
            userId, tx);
        }
        fileMoved = true;
      }
    }
    const [after] = await tx.update(documentDrafts).set({
      status: 'ready',
      convertedTransactionId: null,
      convertedType: null,
      convertedAt: null,
      convertedBy: null,
      updatedAt: NEXT_UPDATED_AT as unknown as Date,
    }).where(eq(documentDrafts.id, before.id)).returning();
    await auditLog(tenantId, 'update', 'document_draft', before.id,
      { id: before.id, status: before.status, convertedTransactionId: before.convertedTransactionId, convertedType: before.convertedType },
      { id: after!.id, status: after!.status, convertedTransactionId: null, convertedType: null,
        reopened: true, deletedTransactionId: txnId, fileMoved },
      userId, tx);
    reopened.push(before.id);
  }
  return reopened;
}
