// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { invoiceTemplates } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';

export async function list(tenantId: string) {
  return db.select().from(invoiceTemplates).where(eq(invoiceTemplates.tenantId, tenantId));
}

export async function getDefault(tenantId: string) {
  const template = await db.query.invoiceTemplates.findFirst({
    where: and(eq(invoiceTemplates.tenantId, tenantId), eq(invoiceTemplates.isDefault, true)),
  });
  return template || null;
}

export async function create(tenantId: string, input: {
  name: string; logoUrl?: string; accentColor?: string;
  showShipTo?: boolean; showPoNumber?: boolean; showTerms?: boolean;
  footerText?: string; isDefault?: boolean;
}) {
  // If setting as default, unset other defaults
  if (input.isDefault) {
    await db.update(invoiceTemplates)
      .set({ isDefault: false })
      .where(eq(invoiceTemplates.tenantId, tenantId));
  }

  const [template] = await db.insert(invoiceTemplates).values({
    tenantId,
    ...input,
  }).returning();

  return template;
}

export async function update(tenantId: string, id: string, input: {
  name?: string; logoUrl?: string | null; accentColor?: string;
  showShipTo?: boolean; showPoNumber?: boolean; showTerms?: boolean;
  footerText?: string | null; isDefault?: boolean;
}) {
  if (input.isDefault) {
    await db.update(invoiceTemplates)
      .set({ isDefault: false })
      .where(eq(invoiceTemplates.tenantId, tenantId));
  }

  const [updated] = await db.update(invoiceTemplates)
    .set({ ...input, updatedAt: new Date() })
    .where(and(eq(invoiceTemplates.tenantId, tenantId), eq(invoiceTemplates.id, id)))
    .returning();

  if (!updated) throw AppError.notFound('Invoice template not found');
  return updated;
}

export async function remove(tenantId: string, id: string) {
  await db.delete(invoiceTemplates)
    .where(and(eq(invoiceTemplates.tenantId, tenantId), eq(invoiceTemplates.id, id)));
}

export async function seedDefault(tenantId: string) {
  const existing = await list(tenantId);
  if (existing.length > 0) return;

  await create(tenantId, {
    name: 'Default',
    accentColor: '#2563EB',
    showTerms: true,
    footerText: 'Thank you for your business!',
    isDefault: true,
  });
}
