// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Firm-owned financial-statement library: letterhead, accountant's-report
// letters (seeded lazily from the global super-admin report_letters),
// style presets (two built-ins materialized lazily) and portable layout
// templates. Every mutation is audit-logged; letter HTML is sanitized.

import { and, asc, eq, ne } from 'drizzle-orm';
import {
  FS_BUILTIN_STYLES, fsStyleSchema, fsTemplateLayoutSchema, sanitizeFsLetterHtml,
  type FsLayoutTemplateInput, type FsLetterheadInput, type FsLetterInput, type FsStyle, type FsStylePresetInput,
} from '@kis-books/shared';
import { db } from '../../../db/index.js';
import { fsFirmProfiles, fsLayoutTemplates, fsReportLetters, fsStylePresets, reportLetters } from '../../../db/schema/index.js';
import { AppError } from '../../../utils/errors.js';
import { auditLog } from '../../../middleware/audit.js';
import { ownerValues, ownerWhere, resolveFsOwner, type FsOwner } from './fs-owner.js';

type ProfileRow = typeof fsFirmProfiles.$inferSelect;

const redactLogo = (p: ProfileRow | null | undefined) => (p ? { ...p, logoDataUri: p.logoDataUri ? '[logo]' : null } : null);

// ─── Lazy seeding ──────────────────────────────────────────────────

export async function ensureLetterLibrary(owner: FsOwner): Promise<void> {
  const existing = await db.select({ src: fsReportLetters.sourceReportLetterId }).from(fsReportLetters)
    .where(ownerWhere(fsReportLetters, owner));
  const have = new Set(existing.map((e) => e.src).filter(Boolean));
  const globals = await db.select().from(reportLetters).where(eq(reportLetters.isActive, true))
    .orderBy(asc(reportLetters.sortOrder), asc(reportLetters.name));
  const missing = globals.filter((g) => !have.has(g.id));
  if (!missing.length) return;
  const anyDefault = existing.length > 0;
  await db.insert(fsReportLetters).values(missing.map((g, i) => ({
    ...ownerValues(owner),
    name: g.name,
    letterType: g.letterType === 'preparation' ? 'preparation' : 'compilation',
    title: g.title,
    bodyHtml: sanitizeFsLetterHtml(g.bodyHtml),
    isActive: true,
    isDefault: !anyDefault && g.isDefault && g.letterType === 'compilation',
    sourceReportLetterId: g.id,
    sortOrder: g.sortOrder ?? i,
  }))).onConflictDoNothing();
}

export async function ensureBuiltinPresets(owner: FsOwner): Promise<void> {
  const existing = await db.select({ key: fsStylePresets.builtinKey }).from(fsStylePresets)
    .where(ownerWhere(fsStylePresets, owner));
  const have = new Set(existing.map((e) => e.key).filter(Boolean));
  const missing = FS_BUILTIN_STYLES.filter((b) => !have.has(b.key));
  if (!missing.length) return;
  const anyRows = existing.length > 0;
  await db.insert(fsStylePresets).values(missing.map((b, i) => ({
    ...ownerValues(owner),
    name: b.name,
    styleJson: b.style,
    builtinKey: b.key,
    isDefault: !anyRows && i === 0,
    sortOrder: i,
  }))).onConflictDoNothing();
}

// ─── Read ──────────────────────────────────────────────────────────

export async function getLibrary(tenantId: string) {
  const owner = await resolveFsOwner(tenantId);
  await ensureLetterLibrary(owner);
  await ensureBuiltinPresets(owner);
  const [profile] = await db.select().from(fsFirmProfiles).where(ownerWhere(fsFirmProfiles, owner)).limit(1);
  const letters = await db.select().from(fsReportLetters).where(ownerWhere(fsReportLetters, owner))
    .orderBy(asc(fsReportLetters.sortOrder), asc(fsReportLetters.name));
  const presets = await db.select().from(fsStylePresets).where(ownerWhere(fsStylePresets, owner))
    .orderBy(asc(fsStylePresets.sortOrder), asc(fsStylePresets.name));
  const templates = await db.select().from(fsLayoutTemplates).where(ownerWhere(fsLayoutTemplates, owner))
    .orderBy(asc(fsLayoutTemplates.sortOrder), asc(fsLayoutTemplates.name));
  return { ownedByFirm: owner.firmId !== null, letterhead: profile ?? null, letters, presets, templates };
}

export async function getLetterhead(tenantId: string): Promise<ProfileRow | null> {
  const owner = await resolveFsOwner(tenantId);
  const [profile] = await db.select().from(fsFirmProfiles).where(ownerWhere(fsFirmProfiles, owner)).limit(1);
  return profile ?? null;
}

async function ownedLetter(tenantId: string, id: string) {
  const owner = await resolveFsOwner(tenantId);
  const [row] = await db.select().from(fsReportLetters)
    .where(and(eq(fsReportLetters.id, id), ownerWhere(fsReportLetters, owner))).limit(1);
  if (!row) throw AppError.notFound('Letter not found');
  return { owner, row };
}

async function ownedPreset(tenantId: string, id: string) {
  const owner = await resolveFsOwner(tenantId);
  const [row] = await db.select().from(fsStylePresets)
    .where(and(eq(fsStylePresets.id, id), ownerWhere(fsStylePresets, owner))).limit(1);
  if (!row) throw AppError.notFound('Style preset not found');
  return { owner, row };
}

async function ownedTemplate(tenantId: string, id: string) {
  const owner = await resolveFsOwner(tenantId);
  const [row] = await db.select().from(fsLayoutTemplates)
    .where(and(eq(fsLayoutTemplates.id, id), ownerWhere(fsLayoutTemplates, owner))).limit(1);
  if (!row) throw AppError.notFound('Layout template not found');
  return { owner, row };
}

export async function getLetter(tenantId: string, id: string) {
  return (await ownedLetter(tenantId, id)).row;
}

export async function getDefaultLetter(tenantId: string) {
  const owner = await resolveFsOwner(tenantId);
  await ensureLetterLibrary(owner);
  const rows = await db.select().from(fsReportLetters)
    .where(and(ownerWhere(fsReportLetters, owner), eq(fsReportLetters.isActive, true)))
    .orderBy(asc(fsReportLetters.sortOrder), asc(fsReportLetters.name));
  return rows.find((r) => r.isDefault) ?? rows.find((r) => r.letterType === 'compilation') ?? rows[0] ?? null;
}

export async function getPreset(tenantId: string, id: string) {
  return (await ownedPreset(tenantId, id)).row;
}

export async function getDefaultStyle(tenantId: string): Promise<{ id: string | null; style: FsStyle }> {
  const owner = await resolveFsOwner(tenantId);
  await ensureBuiltinPresets(owner);
  const rows = await db.select().from(fsStylePresets).where(ownerWhere(fsStylePresets, owner))
    .orderBy(asc(fsStylePresets.sortOrder));
  const row = rows.find((r) => r.isDefault) ?? rows[0];
  const parsed = row ? fsStyleSchema.safeParse(row.styleJson) : null;
  return parsed?.success ? { id: row!.id, style: parsed.data } : { id: null, style: FS_BUILTIN_STYLES[0]!.style };
}

export async function getTemplate(tenantId: string, id: string) {
  return (await ownedTemplate(tenantId, id)).row;
}

// ─── Letterhead ────────────────────────────────────────────────────

export async function upsertLetterhead(tenantId: string, input: FsLetterheadInput, userId?: string) {
  const owner = await resolveFsOwner(tenantId);
  const [before] = await db.select().from(fsFirmProfiles).where(ownerWhere(fsFirmProfiles, owner)).limit(1);
  const values = {
    ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
    ...(input.addressLine1 !== undefined ? { addressLine1: input.addressLine1 } : {}),
    ...(input.addressLine2 !== undefined ? { addressLine2: input.addressLine2 } : {}),
    ...(input.city !== undefined ? { city: input.city } : {}),
    ...(input.state !== undefined ? { state: input.state } : {}),
    ...(input.postalCode !== undefined ? { postalCode: input.postalCode } : {}),
    ...(input.phone !== undefined ? { phone: input.phone } : {}),
    ...(input.email !== undefined ? { email: input.email } : {}),
    ...(input.website !== undefined ? { website: input.website } : {}),
    ...(input.logoDataUri !== undefined ? { logoDataUri: input.logoDataUri } : {}),
    ...(input.accountantSignature !== undefined ? { accountantSignature: input.accountantSignature } : {}),
    ...(input.letterheadAlign !== undefined ? { letterheadAlign: input.letterheadAlign } : {}),
    ...(input.letterheadContent !== undefined ? { letterheadContent: input.letterheadContent } : {}),
    ...(input.logoSize !== undefined ? { logoSize: input.logoSize } : {}),
    updatedBy: userId ?? null,
    updatedAt: new Date(),
  };
  let after: ProfileRow | undefined;
  if (before) {
    [after] = await db.update(fsFirmProfiles).set(values).where(eq(fsFirmProfiles.id, before.id)).returning();
  } else {
    [after] = await db.insert(fsFirmProfiles).values({ ...ownerValues(owner), ...values }).returning();
  }
  await auditLog(tenantId, before ? 'update' : 'create', 'fs_letterhead', after!.id, redactLogo(before), redactLogo(after), userId);
  return after!;
}

// ─── Letters ───────────────────────────────────────────────────────

// Only one default per library table.
async function clearDefaultLetter(owner: FsOwner, exceptId: string) {
  await db.update(fsReportLetters).set({ isDefault: false })
    .where(and(ownerWhere(fsReportLetters, owner), ne(fsReportLetters.id, exceptId)));
}
async function clearDefaultPreset(owner: FsOwner, exceptId: string) {
  await db.update(fsStylePresets).set({ isDefault: false })
    .where(and(ownerWhere(fsStylePresets, owner), ne(fsStylePresets.id, exceptId)));
}
async function clearDefaultTemplate(owner: FsOwner, exceptId: string) {
  await db.update(fsLayoutTemplates).set({ isDefault: false })
    .where(and(ownerWhere(fsLayoutTemplates, owner), ne(fsLayoutTemplates.id, exceptId)));
}

export async function createLetter(tenantId: string, input: FsLetterInput, userId?: string) {
  const owner = await resolveFsOwner(tenantId);
  const [row] = await db.insert(fsReportLetters).values({
    ...ownerValues(owner),
    name: input.name,
    letterType: input.letterType,
    title: input.title ?? null,
    bodyHtml: sanitizeFsLetterHtml(input.bodyHtml),
    isActive: input.isActive ?? true,
    isDefault: input.isDefault ?? false,
    createdBy: userId ?? null,
  }).returning();
  if (row!.isDefault) await clearDefaultLetter(owner, row!.id);
  await auditLog(tenantId, 'create', 'fs_report_letter', row!.id, null, row, userId);
  return row!;
}

export async function updateLetter(tenantId: string, id: string, input: Partial<FsLetterInput>, userId?: string) {
  const { owner, row: before } = await ownedLetter(tenantId, id);
  const [row] = await db.update(fsReportLetters).set({
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.letterType !== undefined ? { letterType: input.letterType } : {}),
    ...(input.title !== undefined ? { title: input.title ?? null } : {}),
    ...(input.bodyHtml !== undefined ? { bodyHtml: sanitizeFsLetterHtml(input.bodyHtml) } : {}),
    ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
    ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
    updatedAt: new Date(),
  }).where(eq(fsReportLetters.id, id)).returning();
  if (row!.isDefault) await clearDefaultLetter(owner, id);
  await auditLog(tenantId, 'update', 'fs_report_letter', id, before, row, userId);
  return row!;
}

export async function deleteLetter(tenantId: string, id: string, userId?: string) {
  const { row: before } = await ownedLetter(tenantId, id);
  // Soft: reports that picked this letter keep working off their frozen
  // versions; drafts fall back to the default letter.
  const [row] = await db.update(fsReportLetters).set({ isActive: false, isDefault: false, updatedAt: new Date() })
    .where(eq(fsReportLetters.id, id)).returning();
  await auditLog(tenantId, 'delete', 'fs_report_letter', id, before, row, userId);
}

// ─── Style presets ─────────────────────────────────────────────────

export async function createPreset(tenantId: string, input: FsStylePresetInput, userId?: string) {
  const owner = await resolveFsOwner(tenantId);
  const [row] = await db.insert(fsStylePresets).values({
    ...ownerValues(owner), name: input.name, styleJson: input.style, isDefault: input.isDefault ?? false, createdBy: userId ?? null, sortOrder: 100,
  }).returning();
  if (row!.isDefault) await clearDefaultPreset(owner, row!.id);
  await auditLog(tenantId, 'create', 'fs_style_preset', row!.id, null, row, userId);
  return row!;
}

export async function updatePreset(tenantId: string, id: string, input: Partial<FsStylePresetInput>, userId?: string) {
  const { owner, row: before } = await ownedPreset(tenantId, id);
  const [row] = await db.update(fsStylePresets).set({
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.style !== undefined ? { styleJson: input.style } : {}),
    ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
    updatedAt: new Date(),
  }).where(eq(fsStylePresets.id, id)).returning();
  if (row!.isDefault) await clearDefaultPreset(owner, id);
  await auditLog(tenantId, 'update', 'fs_style_preset', id, before, row, userId);
  return row!;
}

export async function deletePreset(tenantId: string, id: string, userId?: string) {
  const { row: before } = await ownedPreset(tenantId, id);
  if (before.builtinKey) throw AppError.badRequest('Built-in presets cannot be deleted; edit or copy them instead.', 'TB_FS_BUILTIN');
  await db.delete(fsStylePresets).where(eq(fsStylePresets.id, id));
  await auditLog(tenantId, 'delete', 'fs_style_preset', id, before, null, userId);
}

// ─── Layout templates ──────────────────────────────────────────────

export async function createTemplate(tenantId: string, input: FsLayoutTemplateInput, userId?: string) {
  const owner = await resolveFsOwner(tenantId);
  const layout = fsTemplateLayoutSchema.parse(input.layout);
  const [row] = await db.insert(fsLayoutTemplates).values({
    ...ownerValues(owner), name: input.name, description: input.description ?? null, entityKind: input.entityKind,
    layoutJson: layout, isDefault: input.isDefault ?? false, createdBy: userId ?? null, sortOrder: 100,
  }).returning();
  if (row!.isDefault) await clearDefaultTemplate(owner, row!.id);
  await auditLog(tenantId, 'create', 'fs_layout_template', row!.id, null, row, userId);
  return row!;
}

export async function updateTemplate(tenantId: string, id: string, input: Partial<FsLayoutTemplateInput>, userId?: string) {
  const { owner, row: before } = await ownedTemplate(tenantId, id);
  const [row] = await db.update(fsLayoutTemplates).set({
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.description !== undefined ? { description: input.description ?? null } : {}),
    ...(input.entityKind !== undefined ? { entityKind: input.entityKind } : {}),
    ...(input.layout !== undefined ? { layoutJson: fsTemplateLayoutSchema.parse(input.layout) } : {}),
    ...(input.isDefault !== undefined ? { isDefault: input.isDefault } : {}),
    updatedAt: new Date(),
  }).where(eq(fsLayoutTemplates.id, id)).returning();
  if (row!.isDefault) await clearDefaultTemplate(owner, id);
  await auditLog(tenantId, 'update', 'fs_layout_template', id, before, row, userId);
  return row!;
}

export async function deleteTemplate(tenantId: string, id: string, userId?: string) {
  const { row: before } = await ownedTemplate(tenantId, id);
  await db.delete(fsLayoutTemplates).where(eq(fsLayoutTemplates.id, id));
  await auditLog(tenantId, 'delete', 'fs_layout_template', id, before, null, userId);
}
