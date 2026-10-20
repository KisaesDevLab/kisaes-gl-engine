// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { and, eq, inArray } from 'drizzle-orm';
import { db, type DbOrTx } from '../db/index.js';
import { contacts } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';

/**
 * Per-line customer and billable rules for check and expense lines
 * (U-49, U-50):
 *   - a billable line needs a line customer (contactId);
 *   - every line contactId must be a contact of this tenant, so a caller
 *     can't attach another tenant's contact to its lines.
 * Both refusals are 400 VALIDATION_ERROR.
 */
export async function assertLineContacts(
  tenantId: string,
  lines: Array<{ contactId?: string | null; isBillable?: boolean }>,
  executor: DbOrTx = db,
): Promise<void> {
  lines.forEach((l, i) => {
    if (l.isBillable === true && !l.contactId) {
      throw AppError.badRequest(`Line ${i + 1} is billable but has no customer`, 'VALIDATION_ERROR');
    }
  });
  const ids = [...new Set(lines.map((l) => l.contactId).filter((v): v is string => !!v))];
  if (ids.length === 0) return;
  const rows = await executor.select({ id: contacts.id }).from(contacts)
    .where(and(eq(contacts.tenantId, tenantId), inArray(contacts.id, ids)));
  if (rows.length !== ids.length) {
    throw AppError.badRequest('One or more line customers do not belong to this company', 'VALIDATION_ERROR');
  }
}
