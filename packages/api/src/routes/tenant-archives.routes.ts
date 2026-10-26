// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Tenant archive routes (U-05), mounted at /api/v1/tenant-archives in every mode.
 *
 *   GET  /jobs/:jobId              export / import job state (404 JOB_UNKNOWN after a restart)
 *   GET  /:fileName/download       the encrypted archive file (no audit row)
 *   POST /import                   multipart upload (field `file`) or, on desktop without LAN,
 *                                  {path} to a local .zip/.clbackup; {passphrase} always;
 *                                  {scratch:true} -> 400 SCRATCH_NOT_AVAILABLE (E5b)
 *
 * Import permission (H1), checked before any upload byte is accepted:
 * desktop -> super admin only (403 SUPER_ADMIN_REQUIRED); server -> the
 * tenant-creation eligibility of POST /api/v1/tenants (403 with its
 * reason). User rows are created only for a super admin caller; the
 * service decides that from the caller's own row (import.service.ts).
 *
 * Error bodies never echo file contents or the passphrase.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream';
import multer from 'multer';
import { z } from 'zod';
import { authenticate, requireSessionAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { describe } from '../middleware/describe.js';
import { AppError } from '../utils/errors.js';
import { errorSummaryForLog } from '../utils/log-safe.js';
import { isDesktop, desktopProfile } from '../desktop/profile.js';
import { getJob, jobView, startJob } from '../services/tenant-portability/jobs.js';
import { archiveDir } from '../services/tenant-portability/export.service.js';
import { runImport } from '../services/tenant-portability/import.service.js';
import { ArchiveError } from '../services/tenant-portability/errors.js';
import { registerPassphrase, releasePassphrase } from '../services/tenant-portability/archive-crypto.js';
import { assertPassphraseAttemptAllowed, clearPassphraseFailures, recordPassphraseFailure } from '../services/tenant-portability/passphrase-limiter.js';
import { getTenantCreationEligibility } from '../services/auth.service.js';
import { assertTenantOwner } from './tenants.routes.js';

const FILE_NAME_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.zip$/;
const UUID_DIR_RE = /^[0-9a-f-]{36}$/;
/** Upload and path-import size cap. */
export const ARCHIVE_MAX_FILE_BYTES = 64 * 1024 * 1024 * 1024;

function importsDir(): string {
  return path.join(archiveDir(), 'imports');
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      const dir = importsDir();
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      cb(null, dir);
    },
    filename: (_req, _file, cb) => cb(null, `${crypto.randomUUID()}.upload.zip`),
  }),
  limits: { fileSize: ARCHIVE_MAX_FILE_BYTES, files: 1 },
});

export const tenantArchivesRouter = Router();
tenantArchivesRouter.use(authenticate);

tenantArchivesRouter.get('/jobs/:jobId', requireSessionAuth, describe({
  summary: 'State of an archive export or import job',
  tags: ['tenant-archives'],
  params: z.object({ jobId: z.string().uuid() }),
  response: z.object({
    jobId: z.string().uuid(),
    kind: z.enum(['export', 'import']),
    status: z.enum(['queued', 'running', 'succeeded', 'failed']),
    progress: z.number().int().min(0).max(100),
    step: z.string(),
    result: z.record(z.unknown()).optional(),
    error: z.object({ code: z.string(), message: z.string(), details: z.record(z.unknown()).optional() }).optional(),
  }),
}), async (req, res) => {
  const job = getJob(req.params['jobId']!, req.userId, !!req.isSuperAdmin);
  const view = jobView(job);
  // The absolute path is a desktop-only detail of the export result.
  if (!isDesktop() && view['result'] && typeof view['result'] === 'object') {
    const { path: _p, ...rest } = view['result'] as Record<string, unknown>;
    view['result'] = rest;
  }
  res.json(view);
});

/** Finds `<archiveDir>/<tenantId>/<fileName>`; the caller must own that tenant. */
async function locateArchive(fileName: string, req: Parameters<typeof assertTenantOwner>[0]): Promise<string> {
  if (!FILE_NAME_RE.test(fileName)) throw AppError.notFound('Archive not found');
  const root = archiveDir();
  if (!fs.existsSync(root)) throw AppError.notFound('Archive not found');
  for (const d of fs.readdirSync(root, { withFileTypes: true })) {
    if (!d.isDirectory() || !UUID_DIR_RE.test(d.name)) continue;
    const full = path.join(root, d.name, fileName);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      await assertTenantOwner(req, d.name);
      return full;
    }
  }
  throw AppError.notFound('Archive not found');
}

tenantArchivesRouter.get('/:fileName/download', requireSessionAuth, describe({
  summary: 'Download an archive file (encrypted bytes; writes no audit row)',
  tags: ['tenant-archives'],
  params: z.object({ fileName: z.string().regex(FILE_NAME_RE) }),
}), async (req, res) => {
  const full = await locateArchive(req.params['fileName']!, req);
  const stat = fs.statSync(full);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Length', String(stat.size));
  res.setHeader('Content-Disposition', `attachment; filename="${path.basename(full)}"`);
  res.setHeader('Cache-Control', 'no-store');
  // pipeline (not pipe): a read error or a client that goes away destroys
  // both sides and closes the file descriptor instead of leaving a stream
  // open and the response hanging (M4).
  const source = fs.createReadStream(full);
  await new Promise<void>((resolve) => {
    pipeline(source, res, (err) => {
      if (err && !res.headersSent) {
        res.status(500).json({ error: { message: 'The archive could not be read.', code: 'ARCHIVE_READ_FAILED' } });
      } else if (err) {
        console.warn(`[tenant-archive] download aborted: ${errorSummaryForLog(err)}`);
      }
      resolve();
    });
  });
});

export const importArchiveSchema = z.object({
  /** An export never accepts fewer than 12 characters (PASSPHRASE_TOO_WEAK), so a shorter one cannot open any archive. */
  passphrase: z.string().min(12).max(1024),
  name: z.string().trim().min(1).max(255).optional(),
  scratch: z.boolean().optional(),
  /** Restore every company with no intake folders (U-93, intake-settings-v1); ClientLedger sets it for transfer files. */
  resetIntakeSettings: z.boolean().optional().default(false)
    .describe('Restore every company with no intake folders (intake-settings-v1); applied after content verification. ClientLedger sets it for transfer files.'),
  /** Restore with no document drafts or vendor layouts (U-92, document-drafts-v1); ClientLedger sets it for transfer files. */
  resetDocumentDrafts: z.boolean().optional().default(false)
    .describe('Restore with no document drafts and no vendor layouts (document-drafts-v1); applied after content verification. ClientLedger sets it for transfer files.'),
  /** Desktop (CL_LAN != 1) only: absolute path of a local .zip / .clbackup, opened read-only. */
  path: z.string().min(1).max(4096).optional(),
});

/** Validates a desktop path import: absolute, a regular file, .zip/.clbackup, within the size cap. */
export function resolveImportPath(raw: string): string {
  if (!path.isAbsolute(raw) || raw.includes('\0')) throw AppError.badRequest('path must be an absolute path to an archive file', 'VALIDATION_ERROR');
  // UNC and other network paths are refused: the engine never opens a share on the owner's behalf.
  if (/^[\\/]{2}/.test(raw)) throw AppError.badRequest('Network paths are not supported; copy the archive to a local disk first.', 'VALIDATION_ERROR');
  // One answer for a missing file, a directory, a symlink elsewhere or a wrong extension: nothing about the file system leaks.
  const notFound = () => AppError.badRequest('The archive file was not found or is not a .zip/.clbackup file.', 'FILE_NOT_FOUND');
  let real: string;
  try {
    real = fs.realpathSync(raw);
  } catch {
    throw notFound();
  }
  const ext = path.extname(real).toLowerCase();
  if (ext !== '.zip' && ext !== '.clbackup') throw notFound();
  if (/^[\\/]{2}/.test(real)) throw notFound();
  const stat = fs.statSync(real);
  if (!stat.isFile()) throw notFound();
  if (stat.size > ARCHIVE_MAX_FILE_BYTES) throw new ArchiveError('ARCHIVE_TOO_LARGE', 'The archive exceeds the size this engine accepts.');
  return real;
}

/**
 * Who may import (H1). Runs before multer so a refused caller never gets a
 * byte of upload written to disk. Desktop: super admin only. Server: the
 * same eligibility as creating a company.
 */
export async function requireImportPermission(req: Request, _res: Response, next: NextFunction): Promise<void> {
  if (isDesktop()) {
    if (!req.isSuperAdmin) throw AppError.forbidden('Only the owner can restore a company file.', 'SUPER_ADMIN_REQUIRED');
    next();
    return;
  }
  const eligibility = await getTenantCreationEligibility(req.userId, req.userRole);
  if (!eligibility.allowed) throw AppError.forbidden(eligibility.reason || 'You are not allowed to create a new business.', 'TENANT_CREATION_NOT_ALLOWED');
  next();
}

tenantArchivesRouter.post('/import', requireSessionAuth, requireImportPermission, upload.single('file'), (req, _res, next) => {
  // multipart fields arrive as strings; coerce the two booleans before validation.
  const body = req.body as Record<string, unknown>;
  if (typeof body['scratch'] === 'string') body['scratch'] = body['scratch'] === 'true';
  if (typeof body['resetIntakeSettings'] === 'string') body['resetIntakeSettings'] = body['resetIntakeSettings'] === 'true';
  if (typeof body['resetDocumentDrafts'] === 'string') body['resetDocumentDrafts'] = body['resetDocumentDrafts'] === 'true';
  next();
}, validate(importArchiveSchema), describe({
  summary: 'Import an archive as a new company (202; multipart `file`, or {path} on desktop without LAN)',
  tags: ['tenant-archives'],
  response: z.object({ jobId: z.string().uuid() }),
}), async (req, res) => {
  const body = req.body as z.infer<typeof importArchiveSchema>;
  const uploaded = (req as unknown as { file?: { path: string } }).file;
  if (body.scratch) {
    if (uploaded) fs.rmSync(uploaded.path, { force: true });
    throw new ArchiveError('SCRATCH_NOT_AVAILABLE', 'Scratch (test-restore) imports are not available yet.');
  }
  let filePath: string;
  let temporary = false;
  if (uploaded) {
    filePath = uploaded.path;
    temporary = true;
    try {
      fs.chmodSync(filePath, 0o600); // owner-only while it waits for its job (no-op on Windows)
    } catch { /* best effort */ }
  } else if (body.path !== undefined) {
    if (!isDesktop() || desktopProfile().lan) {
      throw AppError.badRequest('Path imports are only available on the desktop without LAN mode; upload the file instead.', 'VALIDATION_ERROR');
    }
    filePath = resolveImportPath(body.path);
  } else {
    throw AppError.badRequest('Upload the archive as `file` or give its `path`.', 'VALIDATION_ERROR');
  }
  const { userId } = req;
  // M3: a user who keeps guessing waits before any key derivation runs.
  try {
    assertPassphraseAttemptAllowed(userId);
  } catch (err) {
    if (temporary) fs.rmSync(filePath, { force: true });
    throw err;
  }
  // The passphrase is scrubbed from logs from here until the job ends.
  registerPassphrase(body.passphrase);
  const job = startJob('import', null, userId, async (progress) => {
    try {
      const result = await runImport({ filePath, passphrase: body.passphrase, name: body.name, callerUserId: userId, resetIntakeSettings: body.resetIntakeSettings, resetDocumentDrafts: body.resetDocumentDrafts }, progress);
      clearPassphraseFailures(userId);
      return result;
    } catch (err) {
      if (err instanceof ArchiveError && err.code === 'ARCHIVE_PASSPHRASE_INVALID') recordPassphraseFailure(userId);
      throw err;
    } finally {
      if (temporary) fs.rmSync(filePath, { force: true });
      releasePassphrase(body.passphrase);
    }
  }, temporary ? [filePath] : []);
  res.status(202).json({ jobId: job.id });
});
