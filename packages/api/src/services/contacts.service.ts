// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { eq, and, sql, count, or } from 'drizzle-orm';
import type { CreateContactInput, UpdateContactInput, ContactFilters } from '@kis-books/shared';
import { db } from '../db/index.js';
import { contacts } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';

export async function list(tenantId: string, filters: ContactFilters) {
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
      sql`(${contacts.displayName} ILIKE ${'%' + filters.search + '%'} OR ${contacts.email} ILIKE ${'%' + filters.search + '%'} OR ${contacts.companyName} ILIKE ${'%' + filters.search + '%'})`,
    );
  }

  const where = and(...conditions);

  const [data, total] = await Promise.all([
    db.select().from(contacts).where(where)
      .orderBy(contacts.displayName)
      .limit(filters.limit ?? 50)
      .offset(filters.offset ?? 0),
    db.select({ count: count() }).from(contacts).where(where),
  ]);

  return { data, total: total[0]?.count ?? 0 };
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

export async function create(tenantId: string, input: CreateContactInput, userId?: string) {
  // Normalize empty email to null
  const normalized = {
    ...input,
    email: input.email || null,
  };

  const [contact] = await db.insert(contacts).values({
    tenantId,
    ...normalized,
  }).returning();

  if (!contact) {
    throw AppError.internal('Failed to create contact');
  }

  await auditLog(tenantId, 'create', 'contact', contact.id, null, contact, userId);
  return contact;
}

export async function update(tenantId: string, id: string, input: UpdateContactInput, userId?: string) {
  const existing = await getById(tenantId, id);

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
    `"${c.displayName}","${c.contactType}","${c.companyName || ''}","${c.firstName || ''}","${c.lastName || ''}","${c.email || ''}","${c.phone || ''}","${c.isActive}"`,
  ).join('\n');

  return header + rows;
}

export async function merge(tenantId: string, sourceId: string, targetId: string, userId?: string) {
  const source = await getById(tenantId, sourceId);
  const target = await getById(tenantId, targetId);

  if (sourceId === targetId) {
    throw AppError.badRequest('Cannot merge a contact with itself');
  }

  // Re-point transactions will happen in Phase 4 when transactions table exists
  // For now, just deactivate the source
  await db
    .update(contacts)
    .set({ isActive: false, updatedAt: new Date() })
    .where(and(eq(contacts.tenantId, tenantId), eq(contacts.id, sourceId)));

  await auditLog(tenantId, 'update', 'contact', sourceId, source, { merged_into: targetId }, userId);
  return target;
}

export async function getTransactionHistory(tenantId: string, contactId: string, pagination: { limit?: number; offset?: number }) {
  // Transactions table doesn't exist yet (Phase 4), return empty
  await getById(tenantId, contactId);
  return { data: [], total: 0 };
}
