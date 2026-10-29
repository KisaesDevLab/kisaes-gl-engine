// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { eq, and, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { invoiceTemplates } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';

export async function list(tenantId: string) {
  return db.select().from(invoiceTemplates).where(eq(invoiceTemplates.tenantId, tenantId));
}

/**
 * The default template. With a company (U-111): that company's default
 * template, else the legacy tenant-wide one (company_id NULL), else null.
 * Without one: the tenant's first default, as before.
 */
export async function getDefault(tenantId: string, companyId?: string) {
  if (companyId) {
    const own = await db.query.invoiceTemplates.findFirst({
      where: and(eq(invoiceTemplates.tenantId, tenantId), eq(invoiceTemplates.companyId, companyId), eq(invoiceTemplates.isDefault, true)),
    });
    if (own) return own;
    const legacy = await db.query.invoiceTemplates.findFirst({
      where: and(eq(invoiceTemplates.tenantId, tenantId), isNull(invoiceTemplates.companyId), eq(invoiceTemplates.isDefault, true)),
    });
    return legacy || null;
  }
  const template = await db.query.invoiceTemplates.findFirst({
    where: and(eq(invoiceTemplates.tenantId, tenantId), eq(invoiceTemplates.isDefault, true)),
  });
  return template || null;
}

/** Form types with their own footer override (U-111). */
export const FOOTER_TYPES = ['invoice', 'cash_sale', 'credit_memo', 'statement'] as const;
export type FooterType = (typeof FOOTER_TYPES)[number];
export const DEFAULT_FOOTER = 'Thank you for your business!';

/** The footer a form of `type` prints: its non-blank override, else the template footer, else the default. */
export function resolveFooter(
  template: { footerText?: string | null; footerOverrides?: Record<string, string | null> | null } | null,
  type: FooterType,
): string {
  const override = template?.footerOverrides?.[type];
  if (typeof override === 'string' && override.trim() !== '') return override;
  return template?.footerText || DEFAULT_FOOTER;
}

export function resolvedFooters(
  template: { footerText?: string | null; footerOverrides?: Record<string, string | null> | null } | null,
): Record<FooterType, string> {
  return Object.fromEntries(FOOTER_TYPES.map((t) => [t, resolveFooter(template, t)])) as Record<FooterType, string>;
}

export async function create(tenantId: string, input: {
  name: string; logoUrl?: string; accentColor?: string;
  showShipTo?: boolean; showPoNumber?: boolean; showTerms?: boolean;
  footerText?: string; isDefault?: boolean;
}, userId?: string) {
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

  if (template) {
    await auditLog(tenantId, 'create', 'invoice_template', template.id, null, template, userId);
  }
  return template;
}

export async function update(tenantId: string, id: string, input: {
  name?: string; logoUrl?: string | null; accentColor?: string;
  showShipTo?: boolean; showPoNumber?: boolean; showTerms?: boolean;
  footerText?: string | null; isDefault?: boolean;
  footerOverrides?: Record<string, string | null>;
}, userId?: string) {
  const before = await db.query.invoiceTemplates.findFirst({
    where: and(eq(invoiceTemplates.tenantId, tenantId), eq(invoiceTemplates.id, id)),
  });

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
  await auditLog(tenantId, 'update', 'invoice_template', updated.id, before ?? null, updated, userId);
  return updated;
}

export async function remove(tenantId: string, id: string, userId?: string) {
  const before = await db.query.invoiceTemplates.findFirst({
    where: and(eq(invoiceTemplates.tenantId, tenantId), eq(invoiceTemplates.id, id)),
  });
  await db.delete(invoiceTemplates)
    .where(and(eq(invoiceTemplates.tenantId, tenantId), eq(invoiceTemplates.id, id)));
  if (before) {
    await auditLog(tenantId, 'delete', 'invoice_template', id, before, null, userId);
  }
}

/**
 * The company's own default template (U-111), created on first write as a
 * copy of the template it read until then (the legacy tenant-wide one, or
 * the built-in defaults). Other companies keep reading theirs.
 */
export async function getOrCreateCompanyDefault(tenantId: string, companyId: string, userId?: string) {
  const own = await db.query.invoiceTemplates.findFirst({
    where: and(eq(invoiceTemplates.tenantId, tenantId), eq(invoiceTemplates.companyId, companyId), eq(invoiceTemplates.isDefault, true)),
  });
  if (own) return own;
  const base = await getDefault(tenantId, companyId);
  const [created] = await db.insert(invoiceTemplates).values({
    tenantId,
    companyId,
    name: base?.name ?? 'Default',
    logoUrl: base?.logoUrl ?? null,
    accentColor: base?.accentColor ?? '#2563EB',
    showShipTo: base?.showShipTo ?? false,
    showPoNumber: base?.showPoNumber ?? false,
    showTerms: base?.showTerms ?? true,
    footerText: base?.footerText ?? DEFAULT_FOOTER,
    footerOverrides: base?.footerOverrides ?? {},
    isDefault: true,
  }).returning();
  if (!created) throw AppError.internal('Failed to create the company invoice template');
  await auditLog(tenantId, 'create', 'invoice_template', created.id, null, created, userId);
  return created;
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
