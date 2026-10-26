// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { sql } from 'drizzle-orm';
import type { Tx } from '../db/index.js';

/**
 * Contact merge (S8): moves drafts and templates from `sourceId` to
 * `targetId` on the merge's transaction. A template whose company and
 * fingerprint the target already has is merged into one row: samples
 * summed, the newer layout kept.
 */
export async function repointDocumentContact(tx: Tx, tenantId: string, sourceId: string, targetId: string): Promise<{ drafts: number; templates: number; templatesMerged: number }> {
  const drafts = await tx.execute(sql`UPDATE document_drafts SET suggested_contact_id = ${targetId}
    WHERE tenant_id = ${tenantId} AND suggested_contact_id = ${sourceId}`);
  // Collisions: keep the newer row, give it both sample counts, drop the other.
  const pairs = await tx.execute(sql`SELECT s.id AS sid, t.id AS tid, (s.updated_at > t.updated_at) AS source_newer
    FROM vendor_layout_templates s
    JOIN vendor_layout_templates t ON t.tenant_id = s.tenant_id AND t.company_id = s.company_id AND t.fingerprint = s.fingerprint AND t.contact_id = ${targetId}
    WHERE s.tenant_id = ${tenantId} AND s.contact_id = ${sourceId}
    FOR UPDATE OF s, t`);
  const rows = pairs.rows as Array<{ sid: string; tid: string; source_newer: boolean }>;
  for (const p of rows) {
    const keep = p.source_newer ? p.sid : p.tid;
    const drop = p.source_newer ? p.tid : p.sid;
    await tx.execute(sql`UPDATE vendor_layout_templates k
      SET samples = k.samples + d.samples
      FROM vendor_layout_templates d
      WHERE k.tenant_id = ${tenantId} AND k.id = ${keep} AND d.tenant_id = ${tenantId} AND d.id = ${drop}`);
    // Frees the (company, vendor, fingerprint) slot; a kept source row is
    // moved to the target with the others below.
    await tx.execute(sql`DELETE FROM vendor_layout_templates WHERE tenant_id = ${tenantId} AND id = ${drop}`);
  }
  const templates = await tx.execute(sql`UPDATE vendor_layout_templates SET contact_id = ${targetId}
    WHERE tenant_id = ${tenantId} AND contact_id = ${sourceId}`);
  return { drafts: drafts.rowCount ?? 0, templates: templates.rowCount ?? 0, templatesMerged: rows.length };
}

