// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Journal-entry templates — CRUD mirroring daily-sales.service's
// template half. No posting logic here: the Journal Entry form
// consumes a template as a pre-fill and posts through the normal
// ledger path, so balance enforcement and lock dates stay in one
// place (ledger.postTransaction).

import { and, eq } from 'drizzle-orm';
import type { CreateJeTemplateInput, UpdateJeTemplateInput, JeTemplateLineInput } from '@kis-books/shared';
import { db } from '../db/index.js';
import { jeTemplates, jeTemplateLines } from '../db/schema/index.js';
import { auditLog } from '../middleware/audit.js';
import { AppError } from '../utils/errors.js';

export async function getTemplate(tenantId: string, id: string) {
  const tpl = await db.query.jeTemplates.findFirst({
    where: and(eq(jeTemplates.tenantId, tenantId), eq(jeTemplates.id, id)),
  });
  if (!tpl) throw AppError.notFound('Journal template not found');
  const lines = await db.select().from(jeTemplateLines)
    .where(and(eq(jeTemplateLines.tenantId, tenantId), eq(jeTemplateLines.templateId, id)))
    .orderBy(jeTemplateLines.sortOrder);
  return { ...tpl, lines };
}

export async function listTemplates(tenantId: string) {
  return db.select().from(jeTemplates)
    .where(and(eq(jeTemplates.tenantId, tenantId), eq(jeTemplates.isActive, true)))
    .orderBy(jeTemplates.name);
}

export async function createTemplate(tenantId: string, input: CreateJeTemplateInput, userId?: string, companyId?: string) {
  const [tpl] = await db.insert(jeTemplates).values({
    tenantId,
    companyId: companyId ?? null,
    name: input.name,
    memo: input.memo ?? null,
    defaultTagId: input.defaultTagId ?? null,
  }).returning();
  await auditLog(tenantId, 'create', 'je_template', tpl!.id, null, tpl, userId);
  return getTemplate(tenantId, tpl!.id);
}

export async function updateTemplate(tenantId: string, id: string, input: UpdateJeTemplateInput, userId?: string) {
  const before = await getTemplate(tenantId, id);
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (input.name !== undefined) updates['name'] = input.name;
  if (input.memo !== undefined) updates['memo'] = input.memo;
  if (input.defaultTagId !== undefined) updates['defaultTagId'] = input.defaultTagId;
  if (input.isActive !== undefined) updates['isActive'] = input.isActive;
  await db.update(jeTemplates).set(updates)
    .where(and(eq(jeTemplates.tenantId, tenantId), eq(jeTemplates.id, id)));
  await auditLog(tenantId, 'update', 'je_template', id, before, updates, userId);
  return getTemplate(tenantId, id);
}

export async function deleteTemplate(tenantId: string, id: string, userId?: string) {
  // Soft-deactivate, matching daily-sales — keeps the audit trail and
  // any saved references intact.
  await getTemplate(tenantId, id); // tenant-scope + existence check
  await db.update(jeTemplates).set({ isActive: false, updatedAt: new Date() })
    .where(and(eq(jeTemplates.tenantId, tenantId), eq(jeTemplates.id, id)));
  await auditLog(tenantId, 'delete', 'je_template', id, null, null, userId);
}

// Upsert the template's line definitions: update by id, insert new,
// hard-delete removed lines (nothing references JE template lines —
// unlike daily-sales entry values — so no soft-remove needed).
export async function replaceTemplateLines(tenantId: string, templateId: string, lines: JeTemplateLineInput[], userId?: string) {
  await getTemplate(tenantId, templateId); // tenant-scope check
  const existing = await db.select({ id: jeTemplateLines.id }).from(jeTemplateLines)
    .where(and(eq(jeTemplateLines.tenantId, tenantId), eq(jeTemplateLines.templateId, templateId)));
  const incomingIds = new Set(lines.filter((l) => l.id).map((l) => l.id as string));

  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i]!;
    const row = {
      tenantId, templateId, label: l.label,
      accountId: l.accountId ?? null, normalSide: l.normalSide, sortOrder: l.sortOrder ?? i,
      isRequired: l.isRequired ?? false, isActive: l.isActive ?? true,
    };
    if (l.id) {
      await db.update(jeTemplateLines).set(row)
        .where(and(eq(jeTemplateLines.tenantId, tenantId), eq(jeTemplateLines.id, l.id)));
    } else {
      await db.insert(jeTemplateLines).values(row);
    }
  }
  for (const e of existing) {
    if (!incomingIds.has(e.id)) {
      await db.delete(jeTemplateLines)
        .where(and(eq(jeTemplateLines.tenantId, tenantId), eq(jeTemplateLines.id, e.id)));
    }
  }
  await auditLog(tenantId, 'update', 'je_template_lines', templateId, null, { count: lines.length }, userId);
  return getTemplate(tenantId, templateId);
}
