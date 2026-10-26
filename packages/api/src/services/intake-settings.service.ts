// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Company intake settings (U-93, intake-settings-v1): the list of folders a
 * desktop client watches for bills and receipts, stored per company in
 * companies.intake_settings and replaced whole.
 *
 * Concurrency: the list carries its own token, `updatedAt` (ISO 8601, ms).
 * A PUT names the token it last read (`null` before the first save); the
 * company row is locked FOR UPDATE and a different stored token is 409 STALE
 * with details.updatedAt, nothing changed. companies.updated_at is not the
 * token, so other company settings saves never make this list stale.
 *
 * Privacy: folder paths are owner data from one computer (and UNC paths name
 * servers). They are returned only by GET /company/intake-settings; the audit
 * row of a change lists each folder's id, name, kind and switches, never its
 * path, and the company row read by every other route leaves the column out
 * (company.service.publicCompanyRow).
 */

import { and, eq } from 'drizzle-orm';
import {
  INTAKE_FOLDERS_MAX, intakeFolderSchema, intakeNameKey, intakePathKey, type IntakeFolder, type IntakeSettings, type PutIntakeSettingsInput,
} from '@kis-books/shared';
import { db } from '../db/index.js';
import { companies } from '../db/schema/index.js';
import { auditLog } from '../middleware/audit.js';
import { AppError } from '../utils/errors.js';

export const INTAKE_AUDIT_ENTITY_TYPE = 'company_intake_settings';

export interface IntakeSettingsView {
  folders: IntakeFolder[];
  updatedAt: string | null;
}

/**
 * The stored value as the API shows it. The column may hold anything a
 * restored archive carried, so each folder is checked again and one that no
 * longer passes the folder rules is left out (never sent to a client that
 * would start watching it), and the list rules hold too: a folder whose id,
 * name (intakeNameKey) or path (intakePathKey) repeats an earlier one is
 * left out, and at most INTAKE_FOLDERS_MAX are shown (the first ones).
 */
export function viewOf(stored: unknown): IntakeSettingsView {
  const s = (stored && typeof stored === 'object' ? stored : {}) as Partial<IntakeSettings>;
  const folders: IntakeFolder[] = [];
  if (Array.isArray(s.folders)) {
    const ids = new Set<string>();
    const names = new Set<string>();
    const paths = new Set<string>();
    for (const f of s.folders) {
      if (folders.length >= INTAKE_FOLDERS_MAX) break;
      const parsed = intakeFolderSchema.safeParse(f);
      if (!parsed.success) continue;
      const id = parsed.data.id.toLowerCase();
      const name = intakeNameKey(parsed.data.name);
      const path = intakePathKey(parsed.data.path);
      if (ids.has(id) || names.has(name) || paths.has(path)) continue;
      ids.add(id);
      names.add(name);
      paths.add(path);
      folders.push(parsed.data);
    }
  }
  const updatedAt = typeof s.updatedAt === 'string' && !Number.isNaN(Date.parse(s.updatedAt)) ? s.updatedAt : null;
  return { folders, updatedAt };
}

/** A folder as the audit log records it: no path. */
export function auditFolder(f: IntakeFolder): Pick<IntakeFolder, 'id' | 'name' | 'defaultKind' | 'autoRead' | 'keepOriginals'> {
  return { id: f.id, name: f.name, defaultKind: f.defaultKind, autoRead: f.autoRead, keepOriginals: f.keepOriginals };
}

export async function getIntakeSettings(tenantId: string, companyId: string): Promise<IntakeSettingsView> {
  const [row] = await db.select({ intakeSettings: companies.intakeSettings }).from(companies)
    .where(and(eq(companies.tenantId, tenantId), eq(companies.id, companyId)))
    .limit(1);
  if (!row) throw AppError.notFound('Company not found');
  return viewOf(row.intakeSettings);
}

function sameToken(stored: string | null, expected: string | null): boolean {
  if (stored === null || expected === null) return stored === expected;
  const a = Date.parse(stored);
  const b = Date.parse(expected);
  return !Number.isNaN(a) && a === b;
}

/**
 * Replaces the company's folder list (already validated by
 * putIntakeSettingsSchema). Returns the stored value.
 */
export async function putIntakeSettings(
  tenantId: string,
  companyId: string,
  input: PutIntakeSettingsInput,
  userId?: string,
): Promise<IntakeSettingsView> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select({ intakeSettings: companies.intakeSettings }).from(companies)
      .where(and(eq(companies.tenantId, tenantId), eq(companies.id, companyId)))
      .for('update')
      .limit(1);
    if (!row) throw AppError.notFound('Company not found');
    const before = viewOf(row.intakeSettings);
    if (!sameToken(before.updatedAt, input.expectedUpdatedAt)) {
      throw AppError.conflict(
        'Intake folders were changed elsewhere since you opened them. Reload them and make your change again.',
        'STALE',
        { updatedAt: before.updatedAt },
      );
    }
    // The new token is always later than the old one, even within one millisecond.
    let now = Date.now();
    const prev = before.updatedAt ? Date.parse(before.updatedAt) : Number.NaN;
    if (!Number.isNaN(prev) && now <= prev) now = prev + 1;
    const next: IntakeSettings = { version: 1, folders: input.folders, updatedAt: new Date(now).toISOString() };
    await tx.update(companies).set({ intakeSettings: next })
      .where(and(eq(companies.tenantId, tenantId), eq(companies.id, companyId)));
    await auditLog(tenantId, 'update', INTAKE_AUDIT_ENTITY_TYPE, companyId,
      { folders: before.folders.map(auditFolder) },
      { folders: next.folders.map(auditFolder) },
      userId, tx);
    return { folders: next.folders, updatedAt: next.updatedAt };
  });
}
