// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { eq, and, sql, count, or, inArray, getTableColumns, asc, desc, type SQL } from 'drizzle-orm';
import type { CreateContactInput, UpdateContactInput, ContactFilters } from '@kis-books/shared';
import { db } from '../db/index.js';
import { contacts, accounts } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import * as priceLevels from './price-levels.service.js';
import { auditLog } from '../middleware/audit.js';
import { claimIdempotency, recordIdempotentEntity } from './idempotency.service.js';
import * as ledger from './ledger.service.js';
import { guardMergeTransactions } from './merge-lock.service.js';
import { repointDocumentContact } from './document-draft-contacts.js';
import { toCsvRow } from './export.service.js';
import { escapeLike } from '../utils/sql-like.js';

/** A contact's open balances (U-38, contact-balance-v1). Money as 4-place decimal strings. */
export interface ContactBalance {
  /** Accounts receivable: posted A/R activity of the contact (invoices less payments and credits), debit positive. */
  openBalance: string;
  /** Date of the oldest posted invoice with a balance due, or null. */
  oldestOpenDate: string | null;
  /** Accounts payable: posted A/P activity of the contact (bills less payments and credits), credit positive. */
  payableBalance: string;
  /** Date of the oldest posted, received bill with a balance due, or null. */
  oldestOpenBillDate: string | null;
}

const ZERO_BALANCE: ContactBalance = { openBalance: '0.0000', oldestOpenDate: null, payableBalance: '0.0000', oldestOpenBillDate: null };

/**
 * Open balances of contacts (U-38): the posted lines on the A/R and A/P
 * system accounts named for the contact (the line's contact, else the
 * transaction's), so payments, credits and journal entries count; plus the
 * oldest open invoice / bill date. Void and deleted transactions are out.
 * companyId: that company's rows and rows without a company.
 */
export async function getBalances(tenantId: string, contactIds: string[], companyId?: string): Promise<Map<string, ContactBalance>> {
  const ids = [...new Set(contactIds)];
  const out = new Map<string, ContactBalance>();
  if (ids.length === 0) return out;
  const idList = sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);
  const scope = companyId ? sql`AND (t.company_id = ${companyId} OR t.company_id IS NULL)` : sql``;
  const ledgerRows = await db.execute(sql`
    SELECT COALESCE(jl.contact_id, t.contact_id) AS contact_id,
      COALESCE(SUM(jl.debit - jl.credit) FILTER (WHERE a.system_tag = 'accounts_receivable'), 0)::numeric(19,4)::text AS ar,
      COALESCE(SUM(jl.credit - jl.debit) FILTER (WHERE a.system_tag = 'accounts_payable'), 0)::numeric(19,4)::text AS ap
    FROM journal_lines jl
    JOIN transactions t ON t.id = jl.transaction_id AND t.tenant_id = jl.tenant_id
    JOIN accounts a ON a.id = jl.account_id AND a.tenant_id = jl.tenant_id
    WHERE jl.tenant_id = ${tenantId} AND t.status = 'posted'
      AND a.system_tag IN ('accounts_receivable', 'accounts_payable')
      AND COALESCE(jl.contact_id, t.contact_id) IN (${idList}) ${scope}
    GROUP BY 1
  `);
  const oldestRows = await db.execute(sql`
    SELECT t.contact_id,
      MIN(t.txn_date) FILTER (WHERE t.txn_type = 'invoice')::text AS oldest_invoice,
      MIN(t.txn_date) FILTER (WHERE t.txn_type = 'bill' AND t.bill_received)::text AS oldest_bill
    FROM transactions t
    WHERE t.tenant_id = ${tenantId} AND t.status = 'posted' AND t.txn_type IN ('invoice', 'bill')
      AND t.balance_due > 0 AND t.contact_id IN (${idList}) ${scope}
    GROUP BY 1
  `);
  for (const id of ids) out.set(id, { ...ZERO_BALANCE });
  for (const r of ledgerRows.rows as Array<{ contact_id: string; ar: string; ap: string }>) {
    const b = out.get(r.contact_id);
    if (b) { b.openBalance = r.ar; b.payableBalance = r.ap; }
  }
  for (const r of oldestRows.rows as Array<{ contact_id: string; oldest_invoice: string | null; oldest_bill: string | null }>) {
    const b = out.get(r.contact_id);
    if (b) { b.oldestOpenDate = r.oldest_invoice; b.oldestOpenBillDate = r.oldest_bill; }
  }
  return out;
}

export async function list(tenantId: string, filters: ContactFilters, companyId?: string) {
  const conditions = [eq(contacts.tenantId, tenantId)];

  if (filters.contactType) {
    // 'both' contacts should appear in customer and vendor lists too
    if (filters.contactType === 'customer') {
      conditions.push(or(eq(contacts.contactType, 'customer'), eq(contacts.contactType, 'both'))!);
    } else if (filters.contactType === 'vendor') {
      conditions.push(or(eq(contacts.contactType, 'vendor'), eq(contacts.contactType, 'both'))!);
    } else {
      conditions.push(eq(contacts.contactType, filters.contactType));
    }
  }
  if (filters.isActive !== undefined) {
    conditions.push(eq(contacts.isActive, filters.isActive));
  }
  if (filters.search) {
    conditions.push(
      sql`(${contacts.displayName} ILIKE ${'%' + escapeLike(filters.search) + '%'} OR ${contacts.email} ILIKE ${'%' + escapeLike(filters.search) + '%'} OR ${contacts.companyName} ILIKE ${'%' + escapeLike(filters.search) + '%'})`,
    );
  }

  const where = and(...conditions);

  // Whitelisted column sort; the display name + id tiebreak keeps pages
  // deterministic. Unknown keys never reach here (zod), but the default
  // branch keeps the old name order regardless.
  const dir = filters.sortDir === 'asc' ? asc : desc;
  const orderBy: SQL[] = (() => {
    switch (filters.sortBy) {
      case 'type': return [dir(contacts.contactType)];
      case 'email': return [sql`${contacts.email} ${filters.sortDir === 'asc' ? sql`ASC` : sql`DESC`} NULLS LAST`];
      case 'phone': return [sql`${contacts.phone} ${filters.sortDir === 'asc' ? sql`ASC` : sql`DESC`} NULLS LAST`];
      case 'status': return [dir(contacts.isActive)];
      case 'name': return [dir(contacts.displayName)];
      default: return [asc(contacts.displayName)];
    }
  })();

  // The list shows (and edits in place) each vendor's default expense
  // category, so the account's name and number ride along — the row
  // otherwise carries only the id.
  const [data, total] = await Promise.all([
    db.select({
      ...getTableColumns(contacts),
      defaultExpenseAccountName: accounts.name,
      defaultExpenseAccountNumber: accounts.accountNumber,
    }).from(contacts)
      .leftJoin(accounts, and(eq(accounts.id, contacts.defaultExpenseAccountId), eq(accounts.tenantId, contacts.tenantId)))
      .where(where)
      .orderBy(...orderBy, asc(contacts.displayName), asc(contacts.id))
      .limit(filters.limit ?? 50)
      .offset(filters.offset ?? 0),
    db.select({ count: count() }).from(contacts).where(where),
  ]);

  // Open balances (U-38) for the page's contacts.
  const balances = await getBalances(tenantId, data.map((c) => c.id), companyId);
  return { data: data.map((c) => ({ ...c, ...(balances.get(c.id) ?? ZERO_BALANCE) })), total: total[0]?.count ?? 0 };
}

export async function getById(tenantId: string, id: string) {
  const contact = await db.query.contacts.findFirst({
    where: and(eq(contacts.tenantId, tenantId), eq(contacts.id, id)),
  });
  if (!contact) {
    throw AppError.notFound('Contact not found');
  }
  return contact;
}

/** getById plus the contact's open balances (U-38, GET /contacts/:id). */
export async function getWithBalance(tenantId: string, id: string, companyId?: string) {
  const contact = await getById(tenantId, id);
  const balance = (await getBalances(tenantId, [id], companyId)).get(id) ?? ZERO_BALANCE;
  return { ...contact, ...balance };
}

export async function create(tenantId: string, input: CreateContactInput, userId?: string, companyId?: string) {
  // Normalize empty email to null
  const normalized = {
    ...input,
    email: input.email || null,
  };

  // The insert, its audit row and an Idempotency-Key (U-18) commit together.
  return await db.transaction(async (tx) => {
    await claimIdempotency(tx);
    // A price level (U-40): active, of the tenant and of the company.
    if (input.priceLevelId) await priceLevels.assertAssignable(tx, tenantId, input.priceLevelId, companyId);
    const [contact] = await tx.insert(contacts).values({
      tenantId,
      ...normalized,
    }).returning();

    if (!contact) {
      throw AppError.internal('Failed to create contact');
    }
    await recordIdempotentEntity(tx, 'contact', contact.id);

    await auditLog(tenantId, 'create', 'contact', contact.id, null, contact, userId, tx);
    return contact;
  });
}

export async function update(tenantId: string, id: string, input: UpdateContactInput, userId?: string, companyId?: string) {
  const existing = await getById(tenantId, id);
  if (input.priceLevelId && input.priceLevelId !== existing.priceLevelId) {
    await priceLevels.assertAssignable(db, tenantId, input.priceLevelId, companyId);
  }

  const normalized = {
    ...input,
    email: input.email === '' ? null : input.email,
    updatedAt: new Date(),
  };

  const [updated] = await db
    .update(contacts)
    .set(normalized)
    .where(and(eq(contacts.tenantId, tenantId), eq(contacts.id, id)))
    .returning();

  if (!updated) {
    throw AppError.internal('Failed to update contact');
  }

  await auditLog(tenantId, 'update', 'contact', id, existing, updated, userId);
  return updated;
}

/** Set the customer/vendor/both type on many contacts at once (tenant-scoped).
 *  Returns the number actually updated. */
export async function bulkUpdateType(
  tenantId: string,
  ids: string[],
  contactType: 'customer' | 'vendor' | 'both',
  userId?: string,
): Promise<{ updated: number }> {
  if (ids.length === 0) return { updated: 0 };
  const rows = await db
    .update(contacts)
    .set({ contactType, updatedAt: new Date() })
    .where(and(eq(contacts.tenantId, tenantId), inArray(contacts.id, ids)))
    .returning({ id: contacts.id });
  // One audit entry for the batch — the individual ids are in the metadata.
  await auditLog(tenantId, 'update', 'contact', 'bulk', null, { contactType, ids: rows.map((r) => r.id) }, userId);
  return { updated: rows.length };
}

export async function deactivate(tenantId: string, id: string, userId?: string) {
  const existing = await getById(tenantId, id);

  const [updated] = await db
    .update(contacts)
    .set({ isActive: false, updatedAt: new Date() })
    .where(and(eq(contacts.tenantId, tenantId), eq(contacts.id, id)))
    .returning();

  await auditLog(tenantId, 'update', 'contact', id, existing, updated, userId);
  return updated;
}

export async function importFromCsv(
  tenantId: string,
  csvData: Array<{ displayName: string; contactType?: string; email?: string; phone?: string; companyName?: string }>,
  contactType: string = 'customer',
  userId?: string,
) {
  // Hard cap on import size. Without this, a caller can submit 50k+ rows in
  // a single JSON body (Express allows up to 10MB) and the serial insert
  // loop below holds a DB connection + memory proportional to the batch.
  const MAX_IMPORT_ROWS = 10_000;
  if (!Array.isArray(csvData)) {
    throw AppError.badRequest('contacts must be an array');
  }
  if (csvData.length > MAX_IMPORT_ROWS) {
    throw AppError.badRequest(`Import is limited to ${MAX_IMPORT_ROWS} rows per request`);
  }

  const results: Array<typeof contacts.$inferSelect> = [];

  for (const row of csvData) {
    const [contact] = await db.insert(contacts).values({
      tenantId,
      contactType: (row.contactType || contactType) as 'customer' | 'vendor' | 'both',
      displayName: row.displayName,
      email: row.email || null,
      phone: row.phone || null,
      companyName: row.companyName || null,
    }).returning();

    if (contact) results.push(contact);
  }

  if (userId) {
    await auditLog(tenantId, 'create', 'contact', null, null, { imported: results.length }, userId);
  }

  return results;
}

export async function exportToCsv(tenantId: string, contactType?: string): Promise<string> {
  const conditions = [eq(contacts.tenantId, tenantId)];
  if (contactType) {
    conditions.push(eq(contacts.contactType, contactType));
  }

  const data = await db.select().from(contacts).where(and(...conditions)).orderBy(contacts.displayName);

  const header = 'Display Name,Type,Company,First Name,Last Name,Email,Phone,Active\n';
  const rows = data.map((c) =>
    toCsvRow([c.displayName, c.contactType, c.companyName || '', c.firstName || '', c.lastName || '', c.email || '', c.phone || '', String(c.isActive)]),
  ).join('\n');

  return header + rows;
}

export async function merge(tenantId: string, sourceId: string, targetId: string, userId?: string) {
  const source = await getById(tenantId, sourceId);
  const target = await getById(tenantId, targetId);

  if (sourceId === targetId) {
    throw AppError.badRequest('Cannot merge a contact with itself');
  }

  // Move everything that names the duplicate onto the kept contact, then
  // deactivate the duplicate — one DB transaction, so a merge is never half
  // done. This used to only deactivate the source, which hid it while its
  // transactions (and its 1099 total) stayed split across two contacts.
  //
  // The transactions and journal lines it repoints may be dated in a closed
  // period (U-47): guardMergeTransactions applies the closing date first and
  // refuses (423 / 403, nothing changed) without the closing-date password.
  // The audit row is written in the same transaction and lists the ids.
  const moved: Record<string, number> = {};
  await db.transaction(async (tx) => {
    const affected = await guardMergeTransactions(tx, tenantId, sql`
      SELECT id FROM transactions WHERE tenant_id = ${tenantId} AND contact_id = ${sourceId}
      UNION
      SELECT transaction_id FROM journal_lines WHERE tenant_id = ${tenantId} AND contact_id = ${sourceId}
    `, { kind: 'contact_merge', sourceId, targetId, userId });
    const repoint = async (label: string, statement: SQL) => {
      const r = await tx.execute(statement);
      moved[label] = r.rowCount ?? 0;
    };
    await repoint('transactions', sql`UPDATE transactions SET contact_id = ${targetId} WHERE tenant_id = ${tenantId} AND contact_id = ${sourceId}`);
    await repoint('journalLines', sql`UPDATE journal_lines SET contact_id = ${targetId} WHERE tenant_id = ${tenantId} AND contact_id = ${sourceId}`);
    await repoint('feedSuggested', sql`UPDATE bank_feed_items SET suggested_contact_id = ${targetId} WHERE tenant_id = ${tenantId} AND suggested_contact_id = ${sourceId}`);
    await repoint('feedAssigned', sql`UPDATE bank_feed_items SET assigned_contact_id = ${targetId} WHERE tenant_id = ${tenantId} AND assigned_contact_id = ${sourceId}`);
    await repoint('classification', sql`UPDATE transaction_classification_state SET suggested_vendor_id = ${targetId} WHERE tenant_id = ${tenantId} AND suggested_vendor_id = ${sourceId}`);
    await repoint('history', sql`UPDATE categorization_history SET contact_id = ${targetId} WHERE tenant_id = ${tenantId} AND contact_id = ${sourceId}`);
    await repoint('bankRules', sql`UPDATE bank_rules SET assign_contact_id = ${targetId} WHERE tenant_id = ${tenantId} AND assign_contact_id = ${sourceId}`);
    await repoint('billCaptures', sql`UPDATE bill_captures SET suggested_contact_id = ${targetId} WHERE tenant_id = ${tenantId} AND suggested_contact_id = ${sourceId}`);
    await repoint('clientSuggested', sql`UPDATE client_category_suggestions SET suggested_contact_id = ${targetId} WHERE tenant_id = ${tenantId} AND suggested_contact_id = ${sourceId}`);
    await repoint('clientResolved', sql`UPDATE client_category_suggestions SET resolved_contact_id = ${targetId} WHERE tenant_id = ${tenantId} AND resolved_contact_id = ${sourceId}`);
    // Document drafts and vendor layouts (U-92); a layout the kept vendor
    // already has for the same fingerprint is merged into one row.
    const docs = await repointDocumentContact(tx, tenantId, sourceId, targetId);
    moved['documentDrafts'] = docs.drafts;
    moved['vendorLayouts'] = docs.templates + docs.templatesMerged;
    await tx
      .update(contacts)
      .set({ isActive: false, updatedAt: new Date() })
      .where(and(eq(contacts.tenantId, tenantId), eq(contacts.id, sourceId)));
    await auditLog(tenantId, 'update', 'contact', sourceId, source, {
      merged_into: targetId,
      moved,
      transactions: affected.transactions,
      closedPeriodOverride: affected.closedPeriodOverride,
    }, userId, tx);
  });
  return target;
}

export async function getTransactionHistory(tenantId: string, contactId: string, pagination: { limit?: number; offset?: number }, companyId?: string) {
  await getById(tenantId, contactId); // 404 on unknown contact
  // Delegate to the ledger list so filtering/sorting/displayTotal semantics
  // stay identical to the Transactions page filtered by this payee.
  return ledger.listTransactions(tenantId, {
    contactId,
    sortBy: 'date',
    sortDir: 'desc',
    limit: pagination.limit,
    offset: pagination.offset,
  }, companyId);
}
