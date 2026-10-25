// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { z } from 'zod';

/**
 * Company intake settings (U-93, intake-settings-v1): the folders a desktop
 * client watches for bills and receipts, stored per company in
 * companies.intake_settings. The engine never touches these paths; it
 * stores and validates them so every computer that opens the company sees
 * the same list. Paths never go into the audit log.
 */

export const INTAKE_FOLDERS_MAX = 20;
export const INTAKE_FOLDER_NAME_MAX = 100;
export const INTAKE_FOLDER_PATH_MAX = 1024;
export const INTAKE_KINDS = ['bills', 'receipts', 'auto'] as const;

/** The column default: no folders, never saved. */
export const INTAKE_SETTINGS_DEFAULT_JSON = '{"version":1,"folders":[],"updatedAt":null}';

// C0 and C1 control characters, DEL and NUL.
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

/** `/` and `\` are the same separator; device and NT namespace prefixes are compared on this form. */
function backslashed(path: string): string {
  return path.replace(/\//g, '\\');
}

/**
 * Why a folder path is refused, or null when it is accepted. Syntax only:
 * an absolute local path (`C:\…`, `/…`) or a UNC share (`\\server\share…`).
 * Refused: control characters, Win32 device and NT namespace prefixes
 * (`\\?\`, `\\.\`, `\??\`, also spelled with `/`), URLs (`://`), WebDAV
 * forms (`@SSL`, `server@<port>`, `DavWWWRoot`) and `..` segments.
 */
export function intakePathProblem(path: string): string | null {
  if (path.length < 1) return 'Folder is required';
  if (path.length > INTAKE_FOLDER_PATH_MAX) return `Folder must be at most ${INTAKE_FOLDER_PATH_MAX} characters`;
  if (CONTROL_RE.test(path)) return 'Folder must not contain control characters';
  if (path.includes('://')) return 'Folder must be a local or network folder, not a web address';
  const b = backslashed(path);
  if (b.startsWith('\\\\?\\') || b.startsWith('\\\\.\\') || b.startsWith('\\??\\')) return 'Folder must not use a device path';
  const drive = /^[A-Za-z]:[\\/]/.test(path);
  const unc = /^\\\\[^\\?.]/.test(b) && !path.startsWith('//');
  const unix = path.startsWith('/') && !path.startsWith('//');
  if (!drive && !unc && !unix) return 'Folder must be a full path (C:\\…, \\\\server\\share or /…)';
  const segments = b.split('\\');
  if (segments.some((s) => s === '..')) return 'Folder must not contain ".." segments';
  if (/@ssl/i.test(b) || segments.some((s) => s.toLowerCase() === 'davwwwroot')) return 'Folder must not be a WebDAV address';
  if (unc) {
    const host = segments[2] ?? '';
    if (/@\d+(@|$)/.test(host)) return 'Folder must not be a WebDAV address';
  }
  return null;
}

/** Uniqueness key of a path: case folded, `/` as `\`, trailing separators dropped. */
export function intakePathKey(path: string): string {
  const b = backslashed(path).toLowerCase();
  const trimmed = b.replace(/\\+$/, '');
  return trimmed.length > 0 ? trimmed : b;
}

export const intakeFolderSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1, 'Name is required').max(INTAKE_FOLDER_NAME_MAX)
    .refine((s) => !CONTROL_RE.test(s), 'Name must not contain control characters'),
  path: z.string().superRefine((p, ctx) => {
    const problem = intakePathProblem(p);
    if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
  }),
  defaultKind: z.enum(INTAKE_KINDS),
  autoRead: z.boolean(),
  keepOriginals: z.boolean().default(false),
}).strict();

export type IntakeFolder = z.infer<typeof intakeFolderSchema>;
export type IntakeKind = (typeof INTAKE_KINDS)[number];

/** The list rules: at most 20, ids, names (case-insensitive) and paths (intakePathKey) unique. */
export const intakeFoldersSchema = z.array(intakeFolderSchema).max(INTAKE_FOLDERS_MAX).superRefine((folders, ctx) => {
  const ids = new Set<string>();
  const names = new Set<string>();
  const paths = new Set<string>();
  folders.forEach((f, i) => {
    const id = f.id.toLowerCase();
    if (ids.has(id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, 'id'], message: 'Folder ids must be unique' });
    ids.add(id);
    const name = f.name.toLowerCase();
    if (names.has(name)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, 'name'], message: 'Another folder already has this name' });
    names.add(name);
    const key = intakePathKey(f.path);
    if (paths.has(key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, 'path'], message: 'Another folder already uses this folder' });
    paths.add(key);
  });
});

/** PUT /api/v1/company/intake-settings: a full replace, guarded by the updatedAt last read (null before the first save). */
export const putIntakeSettingsSchema = z.object({
  folders: intakeFoldersSchema,
  expectedUpdatedAt: z.string().datetime({ offset: true }).nullable(),
}).strict();

export type PutIntakeSettingsInput = z.infer<typeof putIntakeSettingsSchema>;

/** The stored column value. */
export interface IntakeSettings {
  version: 1;
  folders: IntakeFolder[];
  updatedAt: string | null;
}
