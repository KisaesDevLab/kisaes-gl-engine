// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { and, eq } from 'drizzle-orm';
import type {
  CreateFirmInput,
  Firm,
  UpdateFirmInput,
} from '@kis-books/shared';
import { db } from '../db/index.js';
import { firms, firmUsers } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';

// 3-tier rules plan, Phase 1 — firms CRUD service. Firm-level
// resource. Authoring is super-admin (creates) + firm_admin
// (updates); reads are open to any user with a `firm_users` row
// for the firm.

function mapRow(row: typeof firms.$inferSelect): Firm {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    isActive: row.isActive,
    superAdminManaged: row.superAdminManaged,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function create(input: CreateFirmInput, createdByUserId: string): Promise<Firm> {
  // Slug uniqueness — enforced at the DB level too (UNIQUE
  // constraint), but pre-check for a clean 409 instead of a raw
  // pg unique-violation error.
  const existing = await db.query.firms.findFirst({
    where: eq(firms.slug, input.slug),
  });
  if (existing) {
    throw AppError.conflict(
      `A firm with slug "${input.slug}" already exists`,
      'FIRM_SLUG_TAKEN',
    );
  }
  const [row] = await db.insert(firms).values({
    name: input.name,
    slug: input.slug,
    superAdminManaged: input.superAdminManaged ?? false,
    createdByUserId,
  }).returning();
  return mapRow(row!);
}

export async function getById(id: string): Promise<Firm> {
  const row = await db.query.firms.findFirst({ where: eq(firms.id, id) });
  if (!row) throw AppError.notFound('Firm not found');
  return mapRow(row);
}

// Returns firms the given user has any membership in (via
// firm_users), regardless of `firm_role`. Used by the firm-list
// page to render the user's firm switcher. Super-admins call
// `listAll` instead.
export async function listForUser(userId: string): Promise<Firm[]> {
  const rows = await db
    .select({ firm: firms })
    .from(firmUsers)
    .innerJoin(firms, eq(firms.id, firmUsers.firmId))
    .where(and(eq(firmUsers.userId, userId), eq(firmUsers.isActive, true)));
  return rows.map((r) => mapRow(r.firm));
}

export async function listAll(): Promise<Firm[]> {
  const rows = await db.select().from(firms).orderBy(firms.name);
  return rows.map(mapRow);
}

export async function update(id: string, input: UpdateFirmInput): Promise<Firm> {
  if (input.slug !== undefined) {
    const existing = await db.query.firms.findFirst({
      where: and(eq(firms.slug, input.slug)),
    });
    if (existing && existing.id !== id) {
      throw AppError.conflict(
        `A firm with slug "${input.slug}" already exists`,
        'FIRM_SLUG_TAKEN',
      );
    }
  }
  const set: Partial<typeof firms.$inferInsert> = { updatedAt: new Date() };
  if (input.name !== undefined) set.name = input.name;
  if (input.slug !== undefined) set.slug = input.slug;
  if (input.isActive !== undefined) set.isActive = input.isActive;
  if (input.superAdminManaged !== undefined) set.superAdminManaged = input.superAdminManaged;

  const [row] = await db.update(firms).set(set).where(eq(firms.id, id)).returning();
  if (!row) throw AppError.notFound('Firm not found');
  return mapRow(row);
}

// Hard delete — cascades to firm_users (FK ON DELETE CASCADE).
// tenant_firm_assignments has ON DELETE RESTRICT, so any active
// tenant assignments must be unassigned first; the route handler
// surfaces this as a 409.
export async function remove(id: string): Promise<void> {
  await db.delete(firms).where(eq(firms.id, id));
}
