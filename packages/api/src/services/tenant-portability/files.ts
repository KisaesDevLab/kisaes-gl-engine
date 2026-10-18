// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * File column resolvers (U-05 rule 7). Each resolver knows how to read a
 * column's bytes on export and where to put them, and what value the column
 * gets, on import.
 *
 *   provider-key          read through the tenant's StorageProvider by the stored key
 *                         (legacy attachments rows with a NULL key use the `/uploads/<key>`
 *                         path column); new key = tenantStorageKey(newTenant, domain, newRowId + ext)
 *   provider-path-mirror  `/uploads/<key>` of a provider-key column (never bundled)
 *   upload-encrypted      check signatures: AES-GCM ciphertext under this install's
 *                         key, decrypted on export, re-encrypted on import to
 *                         signatures/<newTenant>/<newRowId>.enc (relative to UPLOAD_DIR)
 *   upload-relative       payroll files: stored as an absolute path that must resolve
 *                         inside UPLOAD_DIR; new path UPLOAD_DIR/payroll/<newTenant>/<newRowId><ext>
 *   logo-url              `/uploads/logos/<name>` -> UPLOAD_DIR/logos/<name>; http(s) is external;
 *                         new name <randomUUID><ext>
 *   null                  cache or TTL artifact: NULL on import
 *   external / not-a-file value kept, nothing bundled
 *
 * On import a local resolver never copies an archived value into the
 * column (H2): the new value is derived from the new tenant and row id,
 * so a crafted archive cannot plant `../` paths or another tenant's
 * folder. A value whose file was not bundled becomes NULL (`nulled`), or
 * the tenant-rooted `placeholder` when the column is NOT NULL; the import
 * decides whether the absence is explained by the manifest (warning) or
 * not (ARCHIVE_CORRUPT). Only http(s) URLs pass through, as external.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { encryptBuffer, decryptBuffer } from '../../utils/encryption.js';
import { resolveInside } from '../../utils/contained-path.js';
import { tenantStorageKey } from '../storage/storage-keys.js';
import type { StorageProvider } from '../storage/storage-provider.interface.js';
import { ArchiveError } from './errors.js';
import type { FileColumnRule } from './plan.js';

export interface FileContext {
  uploadDir: string;
  /** Storage provider of the tenant being read (export) or written (import). */
  provider?: () => Promise<StorageProvider>;
}

export interface ExportRead {
  /** `external` when the value points outside this install (kept as is, nothing bundled). */
  kind: 'bundle' | 'external' | 'none';
  read?: () => Promise<Buffer>;
}

export interface ImportTarget {
  /** The column's new value. */
  value: string | null;
  /** Writes the bytes (decrypted from the archive) to their new place. */
  write?: (bytes: Buffer) => Promise<void>;
  /** Absolute path written on disk (for cleanup on rollback), when local. */
  localPath?: string;
  /** True when a non-null archived value was dropped because its file was not bundled. */
  nulled?: boolean;
  /** Tenant-rooted value to use instead of NULL on a NOT NULL column (names a file that does not exist). */
  placeholder?: string;
}

const UPLOADS_PREFIX = '/uploads/';

/** Resolves `candidate` under `root` and refuses anything that escapes it (realpath-based). */
export function containedPath(root: string, candidate: string): string {
  if (candidate.includes('\0')) throw new ArchiveError('FILE_MISSING', 'invalid file path');
  if (!fs.existsSync(root)) throw new ArchiveError('FILE_MISSING', 'file not found');
  const real = resolveInside(root, candidate);
  if (!real) {
    const rootReal = fs.realpathSync(root);
    const full = path.resolve(rootReal, candidate);
    if (full !== rootReal && !full.startsWith(rootReal + path.sep)) throw new ArchiveError('FILE_MISSING', 'file path escapes the upload directory');
    if (!fs.existsSync(full)) throw new ArchiveError('FILE_MISSING', 'file not found');
    throw new ArchiveError('FILE_MISSING', fs.statSync(full).isFile() ? 'file path escapes the upload directory' : 'not a regular file');
  }
  return real;
}

function safeExt(value: string): string {
  const ext = path.extname(path.posix.basename(value.split('?')[0]!)).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(ext) ? ext : '';
}

function isHttpUrl(v: string): boolean {
  return /^https?:\/\//i.test(v);
}

/** How to read the bytes of one file column value on export. */
export function resolveForExport(
  rule: FileColumnRule,
  ctx: FileContext,
  value: string | null,
  row: Record<string, string | null>,
): ExportRead {
  switch (rule.resolver) {
    case 'provider-key': {
      let key = value;
      if (!key && rule.fallbackPathColumn) {
        const p = row[rule.fallbackPathColumn];
        if (p && p.startsWith(UPLOADS_PREFIX)) key = p.slice(UPLOADS_PREFIX.length);
      }
      if (!key) return { kind: 'none' };
      if (isHttpUrl(key)) return { kind: 'external' };
      const k = key;
      return {
        kind: 'bundle',
        read: async () => {
          if (!ctx.provider) throw new ArchiveError('FILE_MISSING', 'no storage provider');
          const provider = await ctx.provider();
          try {
            return await provider.download(k);
          } catch {
            // Attachments written before cloud storage live under UPLOAD_DIR/<key>.
            const local = containedPath(ctx.uploadDir, k.replace(/^\/+/, ''));
            return fs.promises.readFile(local);
          }
        },
      };
    }
    case 'upload-encrypted': {
      if (!value) return { kind: 'none' };
      return {
        kind: 'bundle',
        read: async () => {
          const full = containedPath(ctx.uploadDir, value);
          const plain = decryptBuffer(await fs.promises.readFile(full, 'utf8'));
          if (rule.sha256Column) {
            const expected = row[rule.sha256Column];
            const actual = crypto.createHash('sha256').update(plain).digest('hex');
            if (expected && expected !== actual) throw new ArchiveError('FILE_SIZE_MISMATCH', 'signature image does not match its recorded hash');
          }
          return plain;
        },
      };
    }
    case 'upload-relative': {
      if (!value) return { kind: 'none' };
      return {
        kind: 'bundle',
        read: async () => {
          const rel = path.isAbsolute(value) ? path.relative(path.resolve(ctx.uploadDir), path.resolve(value)) : value;
          if (rel.startsWith('..')) throw new ArchiveError('FILE_MISSING', 'file path escapes the upload directory');
          return fs.promises.readFile(containedPath(ctx.uploadDir, rel));
        },
      };
    }
    case 'logo-url': {
      if (!value) return { kind: 'none' };
      if (isHttpUrl(value)) return { kind: 'external' };
      if (!value.startsWith(`${UPLOADS_PREFIX}logos/`)) return { kind: 'external' };
      const name = value.slice(`${UPLOADS_PREFIX}logos/`.length);
      return {
        kind: 'bundle',
        read: async () => fs.promises.readFile(containedPath(path.join(ctx.uploadDir, 'logos'), name)),
      };
    }
    case 'provider-path-mirror':
    case 'null':
    case 'external':
    case 'not-a-file':
      return { kind: 'none' };
    default:
      return { kind: 'none' };
  }
}

/** The new value of one file column on import, and how to write its bytes. */
export function resolveForImport(
  rule: FileColumnRule,
  ctx: FileContext,
  newTenantId: string,
  newRowId: string,
  oldValue: string | null,
  wasBundled: boolean,
  siblings: Record<string, string | null> = {},
): ImportTarget {
  /** A dropped value: NULL, or (NOT NULL columns) a tenant-rooted name of a file that does not exist. */
  const dropped = (placeholder: string): ImportTarget => ({ value: null, nulled: oldValue !== null && oldValue !== '', placeholder });
  switch (rule.resolver) {
    case 'provider-key': {
      const key = tenantStorageKey(newTenantId, rule.domain ?? 'attachments', `${newRowId}${wasBundled ? safeExt(oldValue ?? '') : '.missing'}`);
      if (!wasBundled) {
        if (oldValue && isHttpUrl(oldValue)) return { value: oldValue };
        return dropped(key);
      }
      return {
        value: key,
        write: async (bytes) => {
          if (!ctx.provider) throw new ArchiveError('FILE_MISSING', 'no storage provider');
          const provider = await ctx.provider();
          await provider.upload(key, bytes, { fileName: path.posix.basename(key), mimeType: 'application/octet-stream', sizeBytes: bytes.length });
        },
        localPath: path.join(ctx.uploadDir, key),
      };
    }
    case 'provider-path-mirror': {
      // Always derived from the new key; the archived path is never copied.
      const key = rule.mirrorOf ? siblings[rule.mirrorOf] : null;
      if (key) return { value: `${UPLOADS_PREFIX}${key}` };
      return dropped(`${UPLOADS_PREFIX}${tenantStorageKey(newTenantId, rule.domain ?? 'attachments', `${newRowId}.missing`)}`);
    }
    case 'upload-encrypted': {
      const rel = path.join('signatures', newTenantId, `${newRowId}${wasBundled ? '.enc' : '.missing'}`);
      if (!wasBundled) return dropped(rel);
      const full = path.join(ctx.uploadDir, rel);
      return {
        value: rel,
        localPath: full,
        write: async (bytes) => {
          await fs.promises.mkdir(path.dirname(full), { recursive: true, mode: 0o700 });
          await fs.promises.writeFile(full, encryptBuffer(bytes), { mode: 0o600 });
        },
      };
    }
    case 'upload-relative': {
      const full = path.join(path.resolve(ctx.uploadDir), 'payroll', newTenantId, `${newRowId}${wasBundled ? safeExt(oldValue ?? '') : '.missing'}`);
      if (!wasBundled) return dropped(full);
      return {
        value: full,
        localPath: full,
        write: async (bytes) => {
          await fs.promises.mkdir(path.dirname(full), { recursive: true, mode: 0o700 });
          await fs.promises.writeFile(full, bytes, { mode: 0o600 });
        },
      };
    }
    case 'logo-url': {
      if (!wasBundled) {
        if (oldValue && isHttpUrl(oldValue)) return { value: oldValue };
        return dropped(`${UPLOADS_PREFIX}logos/${newRowId}.missing`);
      }
      const name = `${crypto.randomUUID()}${safeExt(oldValue ?? '')}`;
      const full = path.join(ctx.uploadDir, 'logos', name);
      return {
        value: `${UPLOADS_PREFIX}logos/${name}`,
        localPath: full,
        write: async (bytes) => {
          await fs.promises.mkdir(path.dirname(full), { recursive: true });
          await fs.promises.writeFile(full, bytes, { flag: 'wx' });
        },
      };
    }
    case 'null':
      return { value: null };
    case 'external':
    case 'not-a-file':
    default:
      return { value: oldValue };
  }
}
