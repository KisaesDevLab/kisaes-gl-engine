// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { inArray, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users } from '../db/schema/index.js';
import { auditLog } from '../middleware/audit.js';

// One audit_log row per staff-facing email, so "who got what" is answerable
// from the database (there is no email log table). Recorded AFTER the send,
// listing only the recipients the SMTP server accepted.
//
// Privacy contract: user ids only — never email addresses, bodies or
// filenames. The subject is stored because it is exactly what landed in the
// recipients' inboxes and is the thing a person will search for.
//
// Best-effort by contract: never throws. A failed audit insert must not
// fail (or retry) the send it describes.

export type StaffEmailKind =
  | 'doc_request_submission'
  | 'client_suggestions'
  | 'bill_capture_upload'
  | 'portal_bill_pay'
  | 'portal_bank_repair'
  | 'bank_connect_invite_connected'
  | 'bank_connect_invite_repaired'
  | 'firm_invite'
  | 'firm_invite_accepted'
  | 'plaid_connection_error'
  | 'team_invite'
  | 'team_access_granted'
  | 'account_created';

export interface StaffEmailRecord {
  tenantId: string;
  kind: StaffEmailKind;
  subject: string;
  /** Recipients the send succeeded for, when the caller knows their ids. */
  recipientUserIds?: string[];
  /** Recipients known only by address; resolved to user ids, never stored. */
  recipientEmails?: string[];
  sourceEntityType?: string | null;
  sourceEntityId?: string | null;
  /** The user whose action caused the email, when there is one. */
  actorUserId?: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function recordStaffEmail(rec: StaffEmailRecord): Promise<void> {
  try {
    const givenIds = [...new Set((rec.recipientUserIds ?? []).filter(Boolean))];
    const ids = new Set(givenIds);
    const emails = [...new Set((rec.recipientEmails ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean))];
    if (emails.length > 0) {
      const rows = await db.select({ id: users.id, email: users.email }).from(users)
        .where(inArray(sql`lower(${users.email})`, emails));
      for (const r of rows) ids.add(r.id);
    }
    // An address with no user row (e.g. an accountant invited before they
    // have an account) still counts as a recipient; it just has no id.
    const recipientCount = givenIds.length + emails.length;
    if (recipientCount === 0) return;
    const sourceEntityId = rec.sourceEntityId ?? null;
    await auditLog(
      rec.tenantId,
      'create',
      'staff_email',
      sourceEntityId && UUID_RE.test(sourceEntityId) ? sourceEntityId : null,
      null,
      {
        kind: rec.kind,
        subject: rec.subject,
        recipientUserIds: [...ids],
        recipientCount,
        tenantId: rec.tenantId,
        sourceEntityType: rec.sourceEntityType ?? null,
        sourceEntityId,
      },
      rec.actorUserId,
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(JSON.stringify({
      ts: new Date().toISOString(), level: 'warn', component: 'staff-email-audit', event: 'record_failed',
      tenantId: rec.tenantId, kind: rec.kind, error: err instanceof Error ? err.message : String(err),
    }));
  }
}
