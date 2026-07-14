// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Bulk-import HTTP endpoints. Mounted at /api/v1/imports under
// authenticate + requireSuperAdmin + companyContext. Multer's memory
// storage is sufficient — uploads are bounded at 10 MB and parsed
// inline; we never persist the raw file bytes (just sha256 + parsed
// canonical rows in the import_sessions row).

import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { authenticate } from '../middleware/auth.js';
import { companyContext } from '../middleware/company.js';
import {
  importUploadOptionsSchema,
  importKindSchema,
  sourceSystemSchema,
  importCommitSchema,
  importListQuerySchema,
  type ImportUploadOptions,
} from '@kis-books/shared';
import { AppError } from '../utils/errors.js';
import * as importsService from '../services/imports/imports.service.js';

// Magic-byte signatures we either require (xlsx/xls) or actively reject
// (executables). Mirrors payroll-import.routes.ts so the bulk-import
// surface enforces the same defense — without this, a renamed
// `evil.exe → data.csv` is accepted by the extension-only filter and
// the parser hands binary back to the operator with a confusing error.
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // xlsx is a zip
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0]); // xls
const PE_MAGIC = Buffer.from([0x4d, 0x5a]);              // Windows exe / DLL
const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);
const MACHO_MAGICS = [
  Buffer.from([0xfe, 0xed, 0xfa, 0xce]),
  Buffer.from([0xfe, 0xed, 0xfa, 0xcf]),
  Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
  Buffer.from([0xca, 0xfe, 0xba, 0xbe]),
];

function startsWith(buf: Buffer, magic: Buffer): boolean {
  return buf.length >= magic.length && buf.subarray(0, magic.length).equals(magic);
}

function verifyImportContent(file: Express.Multer.File): void {
  const buf = file.buffer;
  const name = file.originalname.toLowerCase();
  const reject = () => {
    throw AppError.badRequest(
      'Uploaded file content does not match its declared type.',
      'IMPORT_INVALID_FORMAT',
    );
  };
  if (name.endsWith('.xlsx')) {
    if (!startsWith(buf, ZIP_MAGIC)) reject();
    return;
  }
  if (name.endsWith('.xls')) {
    if (!startsWith(buf, OLE_MAGIC)) reject();
    return;
  }
  // .csv / .tsv — text formats with no fixed magic. Reject anything
  // that's obviously a binary executable or archive.
  if (
    startsWith(buf, ZIP_MAGIC) ||
    startsWith(buf, OLE_MAGIC) ||
    startsWith(buf, PE_MAGIC) ||
    startsWith(buf, ELF_MAGIC) ||
    MACHO_MAGICS.some((m) => startsWith(buf, m))
  ) {
    reject();
  }
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    const ext = file.originalname.toLowerCase();
    const allowedExt =
      ext.endsWith('.csv') || ext.endsWith('.xlsx') || ext.endsWith('.xls') || ext.endsWith('.tsv');
    if (allowedExt) {
      cb(null, true);
    } else {
      // Throw an AppError so error-handler.ts emits a structured
      // 400 with code IMPORT_INVALID_FORMAT instead of a generic 500
      // (multer wraps a plain Error and rethrows; our handler needs
      // the AppError shape to map status + code).
      cb(
        AppError.badRequest(
          `File type not allowed: ${file.originalname}. Accepted: .csv, .xlsx, .xls, .tsv`,
          'IMPORT_INVALID_FORMAT',
        ),
      );
    }
  },
});

/**
 * Staff-write gate. Bulk import was originally super-admin-only, but
 * the right scope for it is "any tenant staffer who can post to the
 * GL" — i.e. owner / accountant / bookkeeper. Mirrors the policy in
 * `requirePracticeAccess` (middleware/practice-access.ts:23-30):
 *   - userType !== 'client': clients have a separate /portal API surface
 *     and must never reach staff routes even with a write-equivalent role.
 *   - userRole !== 'readonly': readonly accounts may not post JEs, and
 *     bulk import posts JEs by definition.
 *
 * Mounted AFTER `authenticate` so req.userType / req.userRole are set.
 */
function requireStaffWrite(_req: Request, _res: Response, next: NextFunction): void {
  if (_req.userType === 'client') {
    // Pretend the surface doesn't exist rather than 403 — same posture
    // as practice-access.ts. Clients shouldn't even know it's there.
    throw AppError.notFound('Feature not available');
  }
  if (_req.userRole === 'readonly') {
    throw AppError.forbidden('Insufficient role for bulk import.', 'IMPORT_FORBIDDEN');
  }
  next();
}

export const importsRouter = Router();
importsRouter.use(authenticate);
importsRouter.use(requireStaffWrite);
importsRouter.use(companyContext);

// ── POST /imports/upload ──────────────────────────────────────────
//
// Multipart form-data: `file` plus scalar fields `kind`,
// `sourceSystem`, optional `options` (JSON string). Returns the new
// session row, a small preview of canonical rows, and any validation
// errors discovered at parse time.
importsRouter.post('/upload', upload.single('file'), async (req, res) => {
  if (!req.file) throw AppError.badRequest('No file uploaded.', 'IMPORT_NO_FILE');
  // Magic-byte check before we hand bytes to a CSV / XLSX parser.
  verifyImportContent(req.file);

  const kind = importKindSchema.parse(req.body['kind']);
  const sourceSystem = sourceSystemSchema.parse(req.body['sourceSystem']);

  // `options` arrives as a JSON-encoded string when sent via form-data.
  // Allow it to be absent or empty.
  let options: ImportUploadOptions = {};
  if (req.body['options']) {
    const raw = typeof req.body['options'] === 'string' ? req.body['options'] : '{}';
    try {
      options = importUploadOptionsSchema.parse(JSON.parse(raw));
    } catch (e) {
      throw AppError.badRequest(
        `options field is not valid JSON or fails schema: ${e instanceof Error ? e.message : String(e)}`,
        'IMPORT_BAD_OPTIONS',
      );
    }
  }

  const out = await importsService.createSession({
    tenantId: req.tenantId,
    companyId: req.companyId,
    userId: req.userId,
    file: { originalname: req.file.originalname, buffer: req.file.buffer },
    kind,
    sourceSystem,
    options,
  });
  res.status(201).json(out);
});

// ── GET /imports ──────────────────────────────────────────────────
// List this company's import sessions (newest first). This is how an
// operator gets BACK to an in-progress session — the duplicate-file
// guard on upload says "open it and commit or delete it", and until
// this route existed there was no way to do that. (The service
// function and the web hook both predate the route; it was never
// wired server-side.)
importsRouter.get('/', async (req, res) => {
  const q = importListQuerySchema.parse(req.query);
  const out = await importsService.listSessions(req.tenantId, req.companyId, q);
  res.json(out);
});

// ── GET /imports/:id ──────────────────────────────────────────────
importsRouter.get('/:id', async (req, res) => {
  const id = req.params['id'];
  if (!id) throw AppError.badRequest('Missing session id.');
  const out = await importsService.getSession(req.tenantId, req.companyId, id);
  if (!out) throw AppError.notFound('Import session not found.');
  res.json(out);
});

// ── POST /imports/:id/commit ──────────────────────────────────────
importsRouter.post('/:id/commit', async (req, res) => {
  const id = req.params['id'];
  if (!id) throw AppError.badRequest('Missing session id.');
  const parsed = importCommitSchema.parse(req.body ?? {});
  const out = await importsService.commitSession(
    req.tenantId,
    req.companyId,
    req.userId,
    id,
    parsed,
  );
  res.json(out);
});

// ── DELETE /imports/:id ───────────────────────────────────────────
importsRouter.delete('/:id', async (req, res) => {
  const id = req.params['id'];
  if (!id) throw AppError.badRequest('Missing session id.');
  const ok = await importsService.deleteSession(req.tenantId, req.companyId, id);
  if (!ok) throw AppError.notFound('Import session not found.');
  res.status(204).end();
});

// ── GET /imports ──────────────────────────────────────────────────
importsRouter.get('/', async (req, res) => {
  const filters = importListQuerySchema.parse(req.query);
  const out = await importsService.listSessions(req.tenantId, req.companyId, filters);
  res.json(out);
});
