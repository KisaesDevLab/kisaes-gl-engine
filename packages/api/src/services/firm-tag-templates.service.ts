// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { and, eq } from 'drizzle-orm';
import type {
  CreateFirmTagTemplateInput,
  FirmTagTemplate,
  TenantFirmTagBinding,
  TenantFirmTagBindingWithTenant,
  UpdateFirmTagTemplateInput,
  UpsertTagBindingInput,
} from '@kis-books/shared';
import { db } from '../db/index.js';
import {
  firmTagTemplates,
  tags,
  tenantFirmAssignments,
  tenantFirmTagBindings,
  tenants,
} from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';

// 3-tier rules plan, Phase 7 — firm tag template CRUD + the
// per-tenant binding upsert. Lookups by template_key are cheap
// thanks to the (firm_id, template_key) unique index; the
// resolver in rule-symbol-resolution.service.ts hits this on
// every global_firm fire and depends on the index for speed.

function mapTemplate(row: typeof firmTagTemplates.$inferSelect): FirmTagTemplate {
  return {
    id: row.id,
    firmId: row.firmId,
    templateKey: row.templateKey,
    displayName: row.displayName,
    description: row.description,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function mapBinding(row: typeof tenantFirmTagBindings.$inferSelect): TenantFirmTagBinding {
  return {
    id: row.id,
    firmId: row.firmId,
    tenantId: row.tenantId,
    templateKey: row.templateKey,
    tagId: row.tagId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

// ─── Templates ───────────────────────────────────────────────

export async function listTemplates(firmId: string): Promise<FirmTagTemplate[]> {
  const rows = await db
    .select()
    .from(firmTagTemplates)
    .where(eq(firmTagTemplates.firmId, firmId))
    .orderBy(firmTagTemplates.templateKey);
  return rows.map(mapTemplate);
}

export async function getTemplate(firmId: string, id: string): Promise<FirmTagTemplate> {
  const row = await db.query.firmTagTemplates.findFirst({
    where: and(eq(firmTagTemplates.firmId, firmId), eq(firmTagTemplates.id, id)),
  });
  if (!row) throw AppError.notFound('Tag template not found');
  return mapTemplate(row);
}

// Look up a template by (firmId, templateKey). Used by the
// resolver. Returns null when missing.
export async function getTemplateByKey(
  firmId: string,
  templateKey: string,
): Promise<FirmTagTemplate | null> {
  const row = await db.query.firmTagTemplates.findFirst({
    where: and(
      eq(firmTagTemplates.firmId, firmId),
      eq(firmTagTemplates.templateKey, templateKey),
    ),
  });
  return row ? mapTemplate(row) : null;
}

export async function createTemplate(
  firmId: string,
  input: CreateFirmTagTemplateInput,
): Promise<FirmTagTemplate> {
  const existing = await getTemplateByKey(firmId, input.templateKey);
  if (existing) {
    throw AppError.conflict(
      `A template with key "${input.templateKey}" already exists in this firm`,
      'TEMPLATE_KEY_TAKEN',
    );
  }
  const [row] = await db.insert(firmTagTemplates).values({
    firmId,
    templateKey: input.templateKey,
    displayName: input.displayName,
    description: input.description ?? null,
  }).returning();
  return mapTemplate(row!);
}

export async function updateTemplate(
  firmId: string,
  id: string,
  input: UpdateFirmTagTemplateInput,
): Promise<FirmTagTemplate> {
  // template_key is intentionally NOT updatable — see schema.
  const set: Partial<typeof firmTagTemplates.$inferInsert> = { updatedAt: new Date() };
  if (input.displayName !== undefined) set.displayName = input.displayName;
  if (input.description !== undefined) set.description = input.description;
  const [row] = await db
    .update(firmTagTemplates)
    .set(set)
    .where(and(eq(firmTagTemplates.firmId, firmId), eq(firmTagTemplates.id, id)))
    .returning();
  if (!row) throw AppError.notFound('Tag template not found');
  return mapTemplate(row);
}

export async function deleteTemplate(firmId: string, id: string): Promise<void> {
  // Cascade-delete the bindings rows pointing at this template
  // BEFORE deleting the template itself. We don't have a CASCADE
  // FK on (firm_id, template_key) — bindings reference template
  // by the firm-internal handle, not the row id — so the cleanup
  // happens in code. Wrapped in a transaction so the partial-
  // failure window doesn't leave dangling bindings.
  const tpl = await getTemplate(firmId, id);
  await db.transaction(async (tx) => {
    await tx
      .delete(tenantFirmTagBindings)
      .where(
        and(
          eq(tenantFirmTagBindings.firmId, firmId),
          eq(tenantFirmTagBindings.templateKey, tpl.templateKey),
        ),
      );
    await tx.delete(firmTagTemplates).where(eq(firmTagTemplates.id, id));
  });
}

// ─── Bindings ────────────────────────────────────────────────

// Upsert a binding for (firm, tenant, template_key). Validates
// that the firm manages the tenant AND that the tag belongs to
// that tenant before writing. Idempotent on the (firm, tenant,
// template_key) unique index.
export async function upsertBinding(
  firmId: string,
  templateId: string,
  input: UpsertTagBindingInput,
): Promise<TenantFirmTagBinding> {
  const tpl = await getTemplate(firmId, templateId);

  const assignment = await db.query.tenantFirmAssignments.findFirst({
    where: and(
      eq(tenantFirmAssignments.firmId, firmId),
      eq(tenantFirmAssignments.tenantId, input.tenantId),
      eq(tenantFirmAssignments.isActive, true),
    ),
  });
  if (!assignment) {
    throw AppError.badRequest(
      'Target tenant is not managed by this firm',
      'TENANT_NOT_MANAGED',
    );
  }
  // Verify the tag belongs to the target tenant — the only
  // safety net for the loose tag_id reference (no FK at the DB
  // layer, see schema comment).
  const tag = await db.query.tags.findFirst({
    where: and(eq(tags.id, input.tagId), eq(tags.tenantId, input.tenantId)),
  });
  if (!tag) {
    throw AppError.badRequest(
      'Tag not found in the target tenant',
      'TAG_NOT_IN_TENANT',
    );
  }

  // ON CONFLICT update so the same template_key can be re-bound
  // without a delete+insert dance.
  const existing = await db.query.tenantFirmTagBindings.findFirst({
    where: and(
      eq(tenantFirmTagBindings.firmId, firmId),
      eq(tenantFirmTagBindings.tenantId, input.tenantId),
      eq(tenantFirmTagBindings.templateKey, tpl.templateKey),
    ),
  });
  if (existing) {
    const [row] = await db
      .update(tenantFirmTagBindings)
      .set({ tagId: input.tagId, updatedAt: new Date() })
      .where(eq(tenantFirmTagBindings.id, existing.id))
      .returning();
    return mapBinding(row!);
  }
  const [row] = await db.insert(tenantFirmTagBindings).values({
    firmId,
    tenantId: input.tenantId,
    templateKey: tpl.templateKey,
    tagId: input.tagId,
  }).returning();
  return mapBinding(row!);
}

export async function listBindings(
  firmId: string,
  templateId: string,
): Promise<TenantFirmTagBindingWithTenant[]> {
  const tpl = await getTemplate(firmId, templateId);
  const rows = await db
    .select({
      id: tenantFirmTagBindings.id,
      firmId: tenantFirmTagBindings.firmId,
      tenantId: tenantFirmTagBindings.tenantId,
      templateKey: tenantFirmTagBindings.templateKey,
      tagId: tenantFirmTagBindings.tagId,
      createdAt: tenantFirmTagBindings.createdAt,
      updatedAt: tenantFirmTagBindings.updatedAt,
      tenantName: tenants.name,
      tenantSlug: tenants.slug,
      tagName: tags.name,
    })
    .from(tenantFirmTagBindings)
    .innerJoin(tenants, eq(tenants.id, tenantFirmTagBindings.tenantId))
    .leftJoin(tags, eq(tags.id, tenantFirmTagBindings.tagId))
    .where(
      and(
        eq(tenantFirmTagBindings.firmId, firmId),
        eq(tenantFirmTagBindings.templateKey, tpl.templateKey),
      ),
    )
    .orderBy(tenants.name);
  return rows.map((r) => ({
    id: r.id,
    firmId: r.firmId,
    tenantId: r.tenantId,
    templateKey: r.templateKey,
    tagId: r.tagId,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    tenantName: r.tenantName,
    tenantSlug: r.tenantSlug,
    tagName: r.tagName,
  }));
}

export async function deleteBinding(
  firmId: string,
  templateId: string,
  tenantId: string,
): Promise<void> {
  const tpl = await getTemplate(firmId, templateId);
  await db
    .delete(tenantFirmTagBindings)
    .where(
      and(
        eq(tenantFirmTagBindings.firmId, firmId),
        eq(tenantFirmTagBindings.tenantId, tenantId),
        eq(tenantFirmTagBindings.templateKey, tpl.templateKey),
      ),
    );
}

// ─── Resolver helper ─────────────────────────────────────────

// Looks up the tenant-local tag uuid for a given (firm,
// template_key, tenant). Returns null when no binding exists —
// the symbol resolver drops the set_tag action silently in
// that case.
export async function resolveTagFromTemplate(
  firmId: string,
  templateKey: string,
  tenantId: string,
): Promise<string | null> {
  const row = await db.query.tenantFirmTagBindings.findFirst({
    where: and(
      eq(tenantFirmTagBindings.firmId, firmId),
      eq(tenantFirmTagBindings.tenantId, tenantId),
      eq(tenantFirmTagBindings.templateKey, templateKey),
    ),
  });
  return row?.tagId ?? null;
}
