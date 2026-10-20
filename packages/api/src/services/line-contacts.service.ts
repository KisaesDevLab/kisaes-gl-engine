// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { and, eq, inArray } from 'drizzle-orm';
import { db, type DbOrTx } from '../db/index.js';
import { contacts } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';

/**
 * Contacts named by a request (line customers, a payee to evaluate rules
 * for) must be this tenant's and — inside a company scope — either
 * tenant-wide (company_id NULL) or that company's, the same scope rule
 * ledger.assertAccountsInScope applies to accounts. 400 VALIDATION_ERROR
 * otherwise, with `message`.
 */
export async function assertContactsInScope(
  executor: DbOrTx,
  tenantId: string,
  companyId: string | null | undefined,
  contactIds: string[],
  message: string,
): Promise<void> {
  const ids = [...new Set(contactIds.filter((v) => !!v))];
  if (ids.length === 0) return;
  const rows = await executor.select({ id: contacts.id, companyId: contacts.companyId }).from(contacts)
    .where(and(eq(contacts.tenantId, tenantId), inArray(contacts.id, ids)));
  if (rows.length !== ids.length) throw AppError.badRequest(message, 'VALIDATION_ERROR');
  if (companyId && rows.some((r) => r.companyId !== null && r.companyId !== companyId)) {
    throw AppError.badRequest(message, 'VALIDATION_ERROR');
  }
}

/**
 * Per-line customer and billable rules for check and expense lines
 * (U-49, U-50):
 *   - a billable line needs a line customer (contactId);
 *   - every line contactId must be in scope (assertContactsInScope), so a
 *     caller can't attach another tenant's or company's contact to its lines.
 * Both refusals are 400 VALIDATION_ERROR. Pass the posting's transaction as
 * `executor` so the check and the write see the same snapshot.
 */
export async function assertLineContacts(
  tenantId: string,
  lines: Array<{ contactId?: string | null; isBillable?: boolean }>,
  executor: DbOrTx = db,
  companyId?: string | null,
): Promise<void> {
  assertBillableLinesHaveContact(lines);
  await assertContactsInScope(
    executor, tenantId, companyId,
    lines.map((l) => l.contactId).filter((v): v is string => !!v),
    'One or more line customers do not belong to this company',
  );
}

/** The in-memory half of assertLineContacts (no database access). */
export function assertBillableLinesHaveContact(lines: Array<{ contactId?: string | null; isBillable?: boolean }>): void {
  lines.forEach((l, i) => {
    if (l.isBillable === true && !l.contactId) {
      throw AppError.badRequest(`Line ${i + 1} is billable but has no customer`, 'VALIDATION_ERROR');
    }
  });
}
