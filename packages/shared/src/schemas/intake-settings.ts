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
/** `statements` (U-94, document-drafts-statement-v1): a folder of vendor statements. */
export const INTAKE_KINDS = ['bills', 'receipts', 'auto', 'statements'] as const;

/** The column default: no folders, never saved. */
export const INTAKE_SETTINGS_DEFAULT_JSON = '{"version":1,"folders":[],"updatedAt":null}';

// Control (C0, C1, DEL, NUL), format (zero-width, bidirectional overrides
// and isolates, BOM, soft hyphen) and line/paragraph separator characters:
// invisible, or change how the text reads.
const INVISIBLE_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
// A UTF-16 surrogate not part of a pair (with the u flag only lone ones
// match). PostgreSQL jsonb refuses them, so they are a 400 here, never a 500.
const LONE_SURROGATE_RE = /\p{Cs}/u;
// Win32 reserved device names, with or without an extension, and with the
// trailing dots and spaces Windows strips (`NUL.txt`, `con .`, `COM¹`).
const RESERVED_SEGMENT_RE = /^(CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³]|CONIN\$|CONOUT\$)(\.[^\\/]*)?[ .]*$/i;
// A UNC host: a DNS name or IPv4 address, or a bracketed IPv6 address. No
// `user:pw@`, no `@SSL` / `@<port>` WebDAV forms.
const UNC_HOST_RE = /^(?:[A-Za-z0-9._-]+|\[[0-9A-Fa-f]*:[0-9A-Fa-f:.]*\])$/;

/** Why a name or path holds characters it must not, or null. */
function charactersProblem(s: string, what: 'Folder' | 'Name'): string | null {
  if (LONE_SURROGATE_RE.test(s)) return `${what} must be valid text`;
  if (INVISIBLE_RE.test(s)) return `${what} must not contain control or invisible characters`;
  return null;
}

/** `/` and `\` are the same separator; device and NT namespace prefixes are compared on this form. */
function backslashed(path: string): string {
  return path.replace(/\//g, '\\');
}

/**
 * Why a folder path is refused, or null when it is accepted. Syntax only:
 * an absolute local path (`C:\…`, `/…`) or a UNC share (`\\server\share…`).
 * Refused: control, invisible and direction-changing characters and lone
 * surrogates, Win32 device and NT namespace prefixes (`\\?\`, `\\.\`,
 * `\??\`, also spelled with `/`), URLs (`://`), a `:` after the drive or
 * in a UNC share path (alternate data streams), a UNC host that is not a
 * plain name, IPv4 or bracketed IPv6 address (`user:pw@host`, WebDAV
 * `@SSL` / `@<port>`), `DavWWWRoot`, `..` segments, reserved device names
 * (`CON`, `NUL.txt`, `COM1` …) and segments ending in `.` or a space.
 */
export function intakePathProblem(path: string): string | null {
  if (path.length < 1) return 'Folder is required';
  if (path.length > INTAKE_FOLDER_PATH_MAX) return `Folder must be at most ${INTAKE_FOLDER_PATH_MAX} characters`;
  const chars = charactersProblem(path, 'Folder');
  if (chars) return chars;
  if (path.includes('://')) return 'Folder must be a local or network folder, not a web address';
  const b = backslashed(path);
  if (b.startsWith('\\\\?\\') || b.startsWith('\\\\.\\') || b.startsWith('\\??\\')) return 'Folder must not use a device path';
  const drive = /^[A-Za-z]:[\\/]/.test(path);
  const unc = /^\\\\[^\\?.]/.test(b) && !path.startsWith('//');
  const unix = path.startsWith('/') && !path.startsWith('//');
  if (!drive && !unc && !unix) return 'Folder must be a full path (C:\\…, \\\\server\\share or /…)';
  const segments = b.split('\\');
  if (/@ssl/i.test(b) || segments.some((s) => s.toLowerCase() === 'davwwwroot')) return 'Folder must not be a WebDAV address';
  if (unc) {
    if (!UNC_HOST_RE.test(segments[2] ?? '')) return 'Folder must name the server by its plain name or address';
    if (segments.slice(3).some((s) => s.includes(':'))) return 'Folder must not contain ":" after the server name';
  }
  if (drive && path.slice(2).includes(':')) return 'Folder must not contain ":" after the drive letter';
  // The path proper: after the drive (`C:`) or the UNC host; a trailing separator leaves an empty segment.
  const named = segments.slice(drive ? 1 : unc ? 3 : 1).filter((s) => s.length > 0);
  if (named.some((s) => s === '..')) return 'Folder must not contain ".." segments';
  if (named.some((s) => RESERVED_SEGMENT_RE.test(s))) return 'Folder must not use a reserved device name (CON, NUL, COM1 …)';
  if (named.some((s) => /[. ]$/.test(s))) return 'Folder names in the path must not end in a dot or a space';
  return null;
}

/** Uniqueness key of a path: Unicode NFC, case folded, `/` as `\`, trailing separators dropped. */
export function intakePathKey(path: string): string {
  const b = backslashed(path).normalize('NFC').toLowerCase();
  const trimmed = b.replace(/\\+$/, '');
  return trimmed.length > 0 ? trimmed : b;
}

/** Uniqueness key of a folder name: Unicode NFC, case folded (names are already trimmed). */
export function intakeNameKey(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

export const intakeFolderSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1, 'Name is required').max(INTAKE_FOLDER_NAME_MAX)
    .superRefine((s, ctx) => {
      const problem = charactersProblem(s, 'Name');
      if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
    }),
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

/** The list rules: at most 20, ids, names (intakeNameKey) and paths (intakePathKey) unique. */
export const intakeFoldersSchema = z.array(intakeFolderSchema).max(INTAKE_FOLDERS_MAX).superRefine((folders, ctx) => {
  const ids = new Set<string>();
  const names = new Set<string>();
  const paths = new Set<string>();
  folders.forEach((f, i) => {
    const id = f.id.toLowerCase();
    if (ids.has(id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [i, 'id'], message: 'Folder ids must be unique' });
    ids.add(id);
    const name = intakeNameKey(f.name);
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
