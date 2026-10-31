// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { eq, and, isNull, ne, asc, desc, inArray, sql } from 'drizzle-orm';
import { db, type DbOrTx, type Tx } from '../db/index.js';
import { invoiceTemplates, transactions } from '../db/schema/index.js';
import { DEFAULT_LAYOUT_COLUMNS, type InvoiceLayoutColumns } from '../db/schema/templates.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import * as ledger from './ledger.service.js';

type TemplateRow = typeof invoiceTemplates.$inferSelect;

/** The name of a company's first layout (U-130). */
export const STANDARD_LAYOUT_NAME = 'Standard';

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

/** Other defaults of the same company (or of the legacy tenant-wide rows) — not of other companies (U-130). */
function sameScopeDefaults(tenantId: string, companyId: string | null | undefined) {
  return and(
    eq(invoiceTemplates.tenantId, tenantId),
    companyId ? eq(invoiceTemplates.companyId, companyId) : isNull(invoiceTemplates.companyId),
    eq(invoiceTemplates.isDefault, true),
  );
}

export async function create(tenantId: string, input: {
  name: string; logoUrl?: string; accentColor?: string;
  showShipTo?: boolean; showPoNumber?: boolean; showTerms?: boolean;
  footerText?: string; isDefault?: boolean;
}, userId?: string) {
  // If setting as default, unset the other defaults of its scope (tenant-wide rows).
  if (input.isDefault) {
    await db.update(invoiceTemplates)
      .set({ isDefault: false })
      .where(sameScopeDefaults(tenantId, null));
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

  if (input.isDefault && before) {
    await db.update(invoiceTemplates)
      .set({ isDefault: false })
      .where(and(sameScopeDefaults(tenantId, before.companyId), ne(invoiceTemplates.id, id)));
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
  return db.transaction(async (tx) => {
    await lockCompanyLayouts(tx, tenantId, companyId);
    return ensureCompanyDefault(tx, tenantId, companyId, userId);
  });
}

/** Serializes layout writes of one company (names, the default, deletes). */
async function lockCompanyLayouts(tx: Tx, tenantId: string, companyId: string) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`invoice-layouts:${tenantId}:${companyId}`}, 0))`);
}

/**
 * The company's default layout, under the company lock. A company with
 * layouts but none default (not reachable through the API) has its newest
 * made default; a company with none gets a copy of the template it read
 * until then (the legacy tenant-wide one, or the built-in defaults), named
 * 'Standard' when that one was the seeded 'Default'.
 */
async function ensureCompanyDefault(tx: Tx, tenantId: string, companyId: string, userId?: string): Promise<TemplateRow> {
  const rows = await tx.select().from(invoiceTemplates)
    .where(and(eq(invoiceTemplates.tenantId, tenantId), eq(invoiceTemplates.companyId, companyId)))
    .orderBy(desc(invoiceTemplates.updatedAt), asc(invoiceTemplates.id));
  const current = rows.find((r) => r.isDefault);
  if (current) return current;
  if (rows[0]) {
    const [promoted] = await tx.update(invoiceTemplates).set({ isDefault: true, updatedAt: new Date() })
      .where(and(eq(invoiceTemplates.tenantId, tenantId), eq(invoiceTemplates.id, rows[0].id))).returning();
    await auditLog(tenantId, 'update', 'invoice_template', rows[0].id, rows[0], promoted, userId, tx);
    return promoted!;
  }
  const [legacy] = await tx.select().from(invoiceTemplates)
    .where(and(eq(invoiceTemplates.tenantId, tenantId), isNull(invoiceTemplates.companyId)))
    .orderBy(desc(invoiceTemplates.isDefault), asc(invoiceTemplates.createdAt), asc(invoiceTemplates.id))
    .limit(1);
  const [created] = await tx.insert(invoiceTemplates).values({
    tenantId,
    companyId,
    name: !legacy || legacy.name === 'Default' ? STANDARD_LAYOUT_NAME : legacy.name,
    logoUrl: legacy?.logoUrl ?? null,
    accentColor: legacy?.accentColor ?? '#2563EB',
    showShipTo: legacy?.showShipTo ?? false,
    showPoNumber: legacy?.showPoNumber ?? false,
    showTerms: legacy?.showTerms ?? true,
    footerText: legacy?.footerText ?? DEFAULT_FOOTER,
    footerOverrides: legacy?.footerOverrides ?? {},
    lineColumns: legacy?.lineColumns ?? DEFAULT_LAYOUT_COLUMNS,
    isDefault: true,
  }).returning();
  if (!created) throw AppError.internal('Failed to create the company invoice template');
  await auditLog(tenantId, 'create', 'invoice_template', created.id, null, created, userId, tx);
  return created;
}

export async function seedDefault(tenantId: string) {
  const existing = await list(tenantId);
  if (existing.length > 0) return;

  await create(tenantId, {
    name: STANDARD_LAYOUT_NAME,
    accentColor: '#2563EB',
    showTerms: true,
    footerText: 'Thank you for your business!',
    isDefault: true,
  });
}

// ─── Invoice layouts (U-130, invoice-layouts-v1) ────────────────────
//
// Each invoice_templates row of a company is one of its invoice print
// layouts; exactly one is the default (uq_invoice_templates_company_default).
// GET/PUT /company/invoice-template keep reading and writing the default.
// Every write takes the company lock, so names, the default and archiving
// don't race. Layouts are archived, never deleted (owner 2026-10-31). Invoices name theirs in transactions.invoice_layout_id
// (NULL = the company default).

export interface InvoiceLayoutInput {
  name?: string;
  accentColor?: string;
  logoUrl?: string | null;
  showShipTo?: boolean;
  showPoNumber?: boolean;
  showTerms?: boolean;
  footerText?: string | null;
  footerOverrides?: Record<string, string | null | undefined>;
  columns?: Partial<InvoiceLayoutColumns>;
  /** Update only: archive (true) or unarchive (false); the default can't be archived. */
  isArchived?: boolean;
}

/** The columns a layout prints: its stored ones over today's form. */
export function layoutColumns(row: { lineColumns?: Partial<InvoiceLayoutColumns> | null } | null | undefined): InvoiceLayoutColumns {
  return { ...DEFAULT_LAYOUT_COLUMNS, ...(row?.lineColumns ?? {}) };
}

/** A layout as the API returns it. */
export function layoutView(row: TemplateRow, invoiceCount?: number) {
  return {
    id: row.id,
    name: row.name,
    isDefault: row.isDefault === true,
    isArchived: row.isArchived === true,
    accentColor: row.accentColor ?? '#2563EB',
    logoUrl: row.logoUrl,
    showShipTo: row.showShipTo ?? false,
    showPoNumber: row.showPoNumber ?? false,
    showTerms: row.showTerms ?? true,
    footerText: row.footerText,
    footerOverrides: row.footerOverrides ?? {},
    columns: layoutColumns(row),
    resolvedFooters: resolvedFooters(row),
    ...(invoiceCount !== undefined ? { invoiceCount } : {}),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function notFound(): AppError {
  return new AppError(404, 'Invoice layout not found', 'INVOICE_LAYOUT_NOT_FOUND');
}

/** A layout of this company (legacy tenant-wide rows are not layouts). */
async function loadLayout(executor: DbOrTx, tenantId: string, companyId: string, id: string): Promise<TemplateRow> {
  const [row] = await executor.select().from(invoiceTemplates)
    .where(and(eq(invoiceTemplates.tenantId, tenantId), eq(invoiceTemplates.companyId, companyId), eq(invoiceTemplates.id, id)))
    .limit(1);
  if (!row) throw notFound();
  return row;
}

async function assertNameFree(tx: Tx, tenantId: string, companyId: string, name: string, exceptId?: string) {
  const rows = await tx.select({ id: invoiceTemplates.id }).from(invoiceTemplates)
    .where(and(eq(invoiceTemplates.tenantId, tenantId), eq(invoiceTemplates.companyId, companyId),
      sql`lower(${invoiceTemplates.name}) = lower(${name})`));
  if (rows.some((r) => r.id !== exceptId)) {
    throw AppError.conflict('An invoice layout with this name already exists', 'INVOICE_LAYOUT_NAME_IN_USE');
  }
}

async function invoiceCounts(executor: DbOrTx, tenantId: string, ids?: string[]): Promise<Map<string, number>> {
  const rows = await executor.select({ id: transactions.layoutId, n: sql<number>`count(*)::int` }).from(transactions)
    .where(and(eq(transactions.tenantId, tenantId), sql`${transactions.layoutId} IS NOT NULL`,
      ne(transactions.status, 'deleted'),
      ...(ids ? [inArray(transactions.layoutId, ids)] : [])))
    .groupBy(transactions.layoutId);
  return new Map(rows.map((r) => [r.id!, r.n]));
}

/** The company's layouts, default first, then by name; each with invoiceCount. Archived ones only with includeArchived. */
export async function listLayouts(tenantId: string, companyId: string, userId?: string, opts: { includeArchived?: boolean } = {}) {
  await getOrCreateCompanyDefault(tenantId, companyId, userId);
  const rows = await db.select().from(invoiceTemplates)
    .where(and(eq(invoiceTemplates.tenantId, tenantId), eq(invoiceTemplates.companyId, companyId),
      ...(opts.includeArchived ? [] : [eq(invoiceTemplates.isArchived, false)])))
    .orderBy(desc(invoiceTemplates.isDefault), asc(sql`lower(${invoiceTemplates.name})`), asc(invoiceTemplates.id));
  const counts = rows.length ? await invoiceCounts(db, tenantId, rows.map((r) => r.id)) : new Map<string, number>();
  return rows.map((r) => layoutView(r, counts.get(r.id) ?? 0));
}

export async function getLayout(tenantId: string, companyId: string, id: string) {
  const row = await loadLayout(db, tenantId, companyId, id);
  const counts = await invoiceCounts(db, tenantId, [id]);
  return layoutView(row, counts.get(id) ?? 0);
}

function footerOverridesOf(input: InvoiceLayoutInput['footerOverrides']): Record<string, string | null> | undefined {
  if (input === undefined) return undefined;
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as Record<string, string | null>;
}

/**
 * A new layout of the company, never the default (POST .../:id/default).
 * Omitted options copy the company's default layout; columns sent are laid
 * over the default layout's.
 */
export async function createLayout(tenantId: string, companyId: string, input: InvoiceLayoutInput & { name: string }, userId?: string) {
  const row = await db.transaction(async (tx) => {
    await lockCompanyLayouts(tx, tenantId, companyId);
    const base = await ensureCompanyDefault(tx, tenantId, companyId, userId);
    await assertNameFree(tx, tenantId, companyId, input.name);
    const [created] = await tx.insert(invoiceTemplates).values({
      tenantId,
      companyId,
      name: input.name,
      logoUrl: input.logoUrl !== undefined ? input.logoUrl : base.logoUrl,
      accentColor: input.accentColor ?? base.accentColor,
      showShipTo: input.showShipTo ?? base.showShipTo,
      showPoNumber: input.showPoNumber ?? base.showPoNumber,
      showTerms: input.showTerms ?? base.showTerms,
      footerText: input.footerText !== undefined ? input.footerText : base.footerText,
      footerOverrides: footerOverridesOf(input.footerOverrides) ?? base.footerOverrides ?? {},
      lineColumns: { ...layoutColumns(base), ...(input.columns ?? {}) },
      isDefault: false,
    }).returning();
    if (!created) throw AppError.internal('Failed to create the invoice layout');
    await auditLog(tenantId, 'create', 'invoice_template', created.id, null, created, userId, tx);
    return created;
  });
  return layoutView(row, 0);
}

/** Edits a layout; expectedUpdatedAt mismatch is 409 STALE. Columns sent are laid over the stored ones; a footerOverrides map replaces. */
export async function updateLayout(
  tenantId: string, companyId: string, id: string, input: InvoiceLayoutInput & { expectedUpdatedAt?: string }, userId?: string,
) {
  const row = await db.transaction(async (tx) => {
    await lockCompanyLayouts(tx, tenantId, companyId);
    const before = await loadLayout(tx, tenantId, companyId, id);
    ledger.assertNotStale(before, input.expectedUpdatedAt, 'This invoice layout');
    if (input.name !== undefined && input.name.toLowerCase() !== before.name.toLowerCase()) {
      await assertNameFree(tx, tenantId, companyId, input.name, id);
    }
    if (input.isArchived === true && before.isDefault) {
      throw AppError.conflict('The default layout can’t be archived. Make another layout the default first.', 'INVOICE_LAYOUT_IS_DEFAULT');
    }
    const overrides = footerOverridesOf(input.footerOverrides);
    const [updated] = await tx.update(invoiceTemplates).set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.accentColor !== undefined ? { accentColor: input.accentColor } : {}),
      ...(input.logoUrl !== undefined ? { logoUrl: input.logoUrl } : {}),
      ...(input.showShipTo !== undefined ? { showShipTo: input.showShipTo } : {}),
      ...(input.showPoNumber !== undefined ? { showPoNumber: input.showPoNumber } : {}),
      ...(input.showTerms !== undefined ? { showTerms: input.showTerms } : {}),
      ...(input.footerText !== undefined ? { footerText: input.footerText } : {}),
      ...(overrides !== undefined ? { footerOverrides: overrides } : {}),
      ...(input.columns !== undefined ? { lineColumns: { ...layoutColumns(before), ...input.columns } } : {}),
      ...(input.isArchived !== undefined ? { isArchived: input.isArchived } : {}),
      updatedAt: new Date(),
    }).where(and(eq(invoiceTemplates.tenantId, tenantId), eq(invoiceTemplates.id, id))).returning();
    await auditLog(tenantId, 'update', 'invoice_template', id, before, updated, userId, tx);
    return updated!;
  });
  return getLayout(tenantId, companyId, row.id);
}

/** Makes a layout the company default; invoices without their own layout print with it. */
export async function setDefaultLayout(tenantId: string, companyId: string, id: string, userId?: string) {
  await db.transaction(async (tx) => {
    await lockCompanyLayouts(tx, tenantId, companyId);
    const target = await loadLayout(tx, tenantId, companyId, id);
    if (target.isDefault) return;
    if (target.isArchived) {
      throw AppError.conflict('An archived layout can’t be the default. Unarchive it first.', 'INVOICE_LAYOUT_ARCHIVED');
    }
    const previous = await ensureCompanyDefault(tx, tenantId, companyId, userId);
    const now = new Date();
    // Unset, then set, so the one-default index never sees two.
    await tx.update(invoiceTemplates).set({ isDefault: false, updatedAt: now })
      .where(and(sameScopeDefaults(tenantId, companyId), ne(invoiceTemplates.id, id)));
    await tx.update(invoiceTemplates).set({ isDefault: true, updatedAt: now })
      .where(and(eq(invoiceTemplates.tenantId, tenantId), eq(invoiceTemplates.id, id)));
    await auditLog(tenantId, 'update', 'invoice_template', id, { isDefault: false, previousDefaultId: previous.id }, { isDefault: true }, userId, tx);
  });
  return getLayout(tenantId, companyId, id);
}

/**
 * An invoice's layoutId as sent (U-130): undefined keeps, null is the
 * company default, an id must be a layout of the company (400
 * INVOICE_LAYOUT_NOT_FOUND) that is not archived (400
 * INVOICE_LAYOUT_ARCHIVED) — unless it is `keepId`, the layout the invoice
 * (or client) already has, which keeps working after it is archived.
 */
export async function assertInvoiceLayout(
  executor: DbOrTx, tenantId: string, layoutId: string | null | undefined, companyId: string | null | undefined, keepId?: string | null,
) {
  if (layoutId === undefined || layoutId === null) return;
  const [row] = await executor.select({ id: invoiceTemplates.id, companyId: invoiceTemplates.companyId, isArchived: invoiceTemplates.isArchived })
    .from(invoiceTemplates)
    .where(and(eq(invoiceTemplates.tenantId, tenantId), eq(invoiceTemplates.id, layoutId))).limit(1);
  if (!row || (row.companyId ?? null) !== (companyId ?? null)) {
    throw AppError.badRequest('That invoice layout does not exist in this company', 'INVOICE_LAYOUT_NOT_FOUND', { layoutId });
  }
  if (row.isArchived && layoutId !== keepId) {
    throw AppError.badRequest('That invoice layout is archived. Unarchive it or choose another layout.', 'INVOICE_LAYOUT_ARCHIVED', { layoutId });
  }
}

/**
 * The layout a client's new invoice starts on (U-130): the client's
 * defaultInvoiceLayoutId while it is an unarchived layout of the company,
 * else null (the company default).
 */
export async function clientDefaultLayoutId(
  executor: DbOrTx, tenantId: string, client: { defaultInvoiceLayoutId?: string | null } | null | undefined, companyId: string | null | undefined,
): Promise<string | null> {
  const id = client?.defaultInvoiceLayoutId;
  if (!id) return null;
  const [row] = await executor.select({ companyId: invoiceTemplates.companyId, isArchived: invoiceTemplates.isArchived }).from(invoiceTemplates)
    .where(and(eq(invoiceTemplates.tenantId, tenantId), eq(invoiceTemplates.id, id))).limit(1);
  return row && !row.isArchived && (row.companyId ?? null) === (companyId ?? null) ? id : null;
}

/** The layout an invoice prints with: its own (when still a layout of its company), else the company default. */
export async function layoutForInvoice(tenantId: string, txn: { layoutId?: string | null; companyId: string | null }) {
  if (txn.layoutId) {
    const [row] = await db.select().from(invoiceTemplates)
      .where(and(eq(invoiceTemplates.tenantId, tenantId), eq(invoiceTemplates.id, txn.layoutId))).limit(1);
    if (row && (row.companyId ?? null) === (txn.companyId ?? null)) return row;
  }
  return getDefault(tenantId, txn.companyId ?? undefined);
}
