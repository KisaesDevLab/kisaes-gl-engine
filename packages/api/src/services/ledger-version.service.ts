// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// "Has the ledger changed?" as a single number.
//
// `gl_version_stamps` is maintained by PostgreSQL triggers on journal_lines
// (all DML) and on the balance-relevant columns of transactions — see
// migration 0144. Because the triggers live in the database, the counter moves
// for EVERY write, including the ones no browser can see: the bank sync in the
// worker, another user's posting, a restore, raw-SQL admin paths.
//
// It was built to make Trial Balance's computed-balance cache exact (rule TB6).
// It generalises: reading it is a two-row indexed lookup, which is orders of
// magnitude cheaper than re-running a transaction list, so a client can ask
// "did anything change?" often and only refetch when the answer is yes.

import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { glVersionStamps } from '../db/schema/index.js';

/**
 * The zero-uuid bucket accumulates NULL-company mutations tenant-wide. A
 * company's effective stamp is its own counter PLUS that sentinel, or writes
 * to NULL-company rows would be invisible — and this codebase has plenty of
 * them.
 */
export const ZERO_COMPANY_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * Monotonic change counter for one company. Only its movement is meaningful;
 * the absolute value means nothing and must not be persisted as an identity.
 */
export async function getLedgerVersion(
  tenantId: string,
  companyId: string | null | undefined,
): Promise<number> {
  const buckets = companyId && companyId !== ZERO_COMPANY_UUID
    ? [companyId, ZERO_COMPANY_UUID]
    : [ZERO_COMPANY_UUID];

  const rows = await db
    .select({ counter: glVersionStamps.counter })
    .from(glVersionStamps)
    .where(and(
      eq(glVersionStamps.tenantId, tenantId),
      inArray(glVersionStamps.companyId, buckets),
    ));

  // Summing is safe as a change detector: counters only ever increase, so any
  // bump in either bucket moves the total.
  return rows.reduce((acc, r) => acc + Number(r.counter), 0);
}
