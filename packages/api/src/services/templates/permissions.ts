// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Which permission a template needs (U-62 security review H1). The
 * templates router sits behind requireResource('recurring'); on top of that
 * every route that reads a draft, saves one or posts one needs the kind's
 * OWN permission, the one the kind's normal form needs:
 *
 *   check -> checks; expense, transfer, journal_entry -> transactions;
 *   deposit -> banking; daily_sales -> daily_sales;
 *   legacy -> the permission of its source transaction's type (invoice ->
 *   invoices, bill -> bills ...; an expense with a print status -> checks).
 *
 * An auto run has no request. It posts only while the template's owner (the
 * last editor, else the creator) still holds 'recurring' and the kind's
 * write permission; otherwise the date is skipped with reason PERMISSION.
 * A template without an owner (made by 0225 from a schedule that existed
 * before it, or adopted from an old archive) posts as it always did.
 */

import { and, eq } from 'drizzle-orm';
import { can, type EffectivePermissions, type ResourceKey } from '@kis-books/shared';
import type { DbOrTx } from '../../db/index.js';
import { transactions } from '../../db/schema/index.js';
import { getEffectivePermissionsForUser } from '../permission.service.js';

/** The permission of a template kind (draft kinds only). */
export function kindResource(kind: string): ResourceKey {
  switch (kind) {
    case 'check': return 'checks';
    case 'deposit': return 'banking';
    case 'daily_sales': return 'daily_sales';
    case 'expense':
    case 'transfer':
    case 'journal_entry':
    default:
      return 'transactions';
  }
}

/** The permission of the form that makes a transaction of this type. */
export function txnResource(txnType: string, printStatus: string | null | undefined): ResourceKey {
  switch (txnType) {
    case 'expense': return printStatus ? 'checks' : 'transactions';
    case 'deposit': return 'banking';
    case 'daily_sales': return 'daily_sales';
    case 'invoice':
    case 'credit_memo': return 'invoices';
    case 'customer_payment':
    case 'customer_refund':
    case 'returned_payment': return 'receive_payment';
    case 'bill': return 'bills';
    case 'vendor_credit': return 'vendor_credits';
    case 'bill_payment': return 'pay_bills';
    case 'aje': return 'trial_balance';
    case 'cash_sale':
    case 'transfer':
    case 'journal_entry':
    default:
      return 'transactions';
  }
}

/** The permission a template needs: its kind's, or for 'legacy' its source transaction's. */
export async function templateResource(
  exec: DbOrTx, tpl: { tenantId: string; kind: string; sourceTransactionId: string | null },
): Promise<ResourceKey> {
  if (tpl.kind !== 'legacy') return kindResource(tpl.kind);
  if (!tpl.sourceTransactionId) return 'transactions';
  const [src] = await exec.select({ txnType: transactions.txnType, printStatus: transactions.printStatus }).from(transactions)
    .where(and(eq(transactions.tenantId, tpl.tenantId), eq(transactions.id, tpl.sourceTransactionId))).limit(1);
  return src ? txnResource(src.txnType, src.printStatus) : 'transactions';
}

/** The template's owner: the last editor, else the creator; null for an ownerless (pre-0225) template. */
export function templateOwner(tpl: { createdBy: string | null; updatedBy: string | null }): string | null {
  return tpl.updatedBy ?? tpl.createdBy ?? null;
}

/** Per-run cache of owners' permissions (one lookup per user per run). */
export type OwnerPermissionCache = Map<string, Promise<EffectivePermissions | null>>;

/**
 * True when an auto run may post this template: no owner (pre-0225), or the
 * owner still holds 'recurring' and `resource` with write access.
 */
export async function ownerMayPost(
  tenantId: string, tpl: { createdBy: string | null; updatedBy: string | null }, resource: ResourceKey, cache?: OwnerPermissionCache,
): Promise<boolean> {
  const owner = templateOwner(tpl);
  if (!owner) return true;
  let perms = cache?.get(owner);
  if (!perms) {
    perms = getEffectivePermissionsForUser(tenantId, owner);
    cache?.set(owner, perms);
  }
  const p = await perms;
  return !!p && can(p, 'recurring', 'create') && can(p, resource, 'create');
}
