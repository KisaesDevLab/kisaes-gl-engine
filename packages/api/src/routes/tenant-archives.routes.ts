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
 * Error bodies never echo file contents or the passphrase.
 */

import { Router } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { z } from 'zod';
import { authenticate, requireSessionAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { describe } from '../middleware/describe.js';
import { AppError } from '../utils/errors.js';
import { isDesktop, desktopProfile } from '../desktop/profile.js';
import { getJob, jobView, startJob } from '../services/tenant-portability/jobs.js';
import { archiveDir } from '../services/tenant-portability/export.service.js';
import { runImport } from '../services/tenant-portability/import.service.js';
import { ArchiveError } from '../services/tenant-portability/errors.js';
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
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, _file, cb) => cb(null, `${crypto.randomUUID()}.upload.zip`),
  }),
  limits: { fileSize: ARCHIVE_MAX_FILE_BYTES, files: 1 },
});

export const tenantArchivesRouter = Router();
tenantArchivesRouter.use(authenticate);

tenantArchivesRouter.get('/jobs/:jobId', describe({
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

tenantArchivesRouter.get('/:fileName/download', describe({
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
  fs.createReadStream(full).pipe(res);
});

export const importArchiveSchema = z.object({
  passphrase: z.string().min(1).max(1024),
  name: z.string().trim().min(1).max(255).optional(),
  scratch: z.boolean().optional(),
  /** Desktop (CL_LAN != 1) only: absolute path of a local .zip / .clbackup, opened read-only. */
  path: z.string().min(1).max(4096).optional(),
});

/** Validates a desktop path import: absolute, a regular file, .zip/.clbackup, within the size cap. */
export function resolveImportPath(raw: string): string {
  if (!path.isAbsolute(raw) || raw.includes('\0')) throw AppError.badRequest('path must be an absolute path to an archive file', 'VALIDATION_ERROR');
  let real: string;
  try {
    real = fs.realpathSync(raw);
  } catch {
    throw AppError.badRequest('The archive file was not found.', 'FILE_NOT_FOUND');
  }
  const ext = path.extname(real).toLowerCase();
  if (ext !== '.zip' && ext !== '.clbackup') throw AppError.badRequest('The archive must be a .zip or .clbackup file.', 'VALIDATION_ERROR');
  const stat = fs.statSync(real);
  if (!stat.isFile()) throw AppError.badRequest('The archive file was not found.', 'FILE_NOT_FOUND');
  if (stat.size > ARCHIVE_MAX_FILE_BYTES) throw new ArchiveError('ARCHIVE_TOO_LARGE', 'The archive exceeds the size this engine accepts.');
  return real;
}

tenantArchivesRouter.post('/import', requireSessionAuth, upload.single('file'), (req, _res, next) => {
  // multipart fields arrive as strings; coerce the two booleans before validation.
  const body = req.body as Record<string, unknown>;
  if (typeof body['scratch'] === 'string') body['scratch'] = body['scratch'] === 'true';
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
  } else if (body.path !== undefined) {
    if (!isDesktop() || desktopProfile().lan) {
      throw AppError.badRequest('Path imports are only available on the desktop without LAN mode; upload the file instead.', 'VALIDATION_ERROR');
    }
    filePath = resolveImportPath(body.path);
  } else {
    throw AppError.badRequest('Upload the archive as `file` or give its `path`.', 'VALIDATION_ERROR');
  }
  const { userId } = req;
  const job = startJob('import', null, userId, async (progress) => {
    try {
      return await runImport({ filePath, passphrase: body.passphrase, name: body.name, callerUserId: userId }, progress);
    } finally {
      if (temporary) fs.rmSync(filePath, { force: true });
    }
  });
  res.status(202).json({ jobId: job.id });
});
