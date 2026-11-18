// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

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
import { z } from 'zod';
import {
  importSessionRoleSchema,
  importBatchKindSchema,
  importBatchStatusSchema,
  importBatchOptionsSchema,
  importBatchCreateSchema,
  importBatchCommitSchema,
  importBatchListQuerySchema,
  importBatchUndoSchema,
  importTieoutRequestSchema,
  importSpotCheckSchema,
  importBatchTransactionsQuerySchema,
} from '@kis-books/shared';
import { validate } from '../middleware/validate.js';
import { describe } from '../middleware/describe.js';
import { idempotent } from '../middleware/idempotent.js';
import { closingPasswordLimiter } from '../middleware/closing-password-limiter.js';
import { lockContextMiddleware, getLockContext } from '../services/lock-context.js';
import type { LockDateContext } from '../services/ledger.service.js';
import { AppError } from '../utils/errors.js';
import * as importsService from '../services/imports/imports.service.js';
import * as batchService from '../services/imports/import-batch.service.js';
import * as tieoutService from '../services/imports/import-tieout.service.js';
import { buildSampleWorkbook, sampleFileName } from '../services/imports/generic-templates.service.js';

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

// ── GET /imports/sample/:kind ─────────────────────────────────────
// Download a blank Generic import template (.xlsx) for the given kind:
// headers + one example row + an Instructions sheet. Registered BEFORE
// companyContext — a static template needs no company scope — and before
// the '/:id' routes so 'sample' isn't parsed as a session id.
importsRouter.get('/sample/:kind', async (req, res) => {
  const kind = importKindSchema.parse(req.params['kind']);
  const buffer = await buildSampleWorkbook(kind);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${sampleFileName(kind)}"`);
  res.send(buffer);
});

importsRouter.use(companyContext);

// ── Batches (U-261, U-263) ────────────────────────────────────────
// Registered before the '/:id' session routes so 'batches' is never read
// as a session id.

const uuidParam = z.string().uuid();

const batchErrorSchema = z.object({
  code: z.string(), message: z.string(), status: z.number().int().optional(),
  rowNumber: z.number().int().optional(), sessionId: z.string().uuid().optional(),
  details: z.record(z.unknown()).optional(),
});
const batchSessionSchema = z.object({
  id: z.string().uuid(), kind: importKindSchema, sourceSystem: sourceSystemSchema, role: importSessionRoleSchema,
  status: z.string(), originalFilename: z.string(), rowCount: z.number().int(), errorCount: z.number().int(),
  reportDate: z.string().nullable(), dateFrom: z.string().nullable(), dateTo: z.string().nullable(),
  commitResult: z.record(z.unknown()).nullable(), committedAt: z.string().nullable(),
});
const dateWarningSchema = z.object({
  code: z.enum(['IMPORT_HISTORY_GAP', 'IMPORT_JOURNAL_BEFORE_OPENING']), message: z.string(),
  openingBalanceDate: z.string(), firstJournalDate: z.string(), days: z.number().int().optional(),
});
/** U-266 (qbd-dates-v1). */
const dateCheckSchema = z.object({
  conversionDate: z.string().nullable(), historyFrom: z.string().nullable(), historySkipped: z.number().int(),
  openingBalanceDate: z.string().nullable(), firstJournalDate: z.string().nullable(), warnings: z.array(dateWarningSchema),
});
const batchSchema = z.object({
  dateCheck: dateCheckSchema.nullable().optional(),
  id: z.string().uuid(), companyId: z.string().uuid(), sourceSystem: sourceSystemSchema,
  kind: importBatchKindSchema, status: importBatchStatusSchema, options: importBatchOptionsSchema,
  result: z.record(z.unknown()).nullable(), error: batchErrorSchema.nullable(), backupRef: z.string().nullable(),
  companyWasEmpty: z.boolean().nullable(), conversionDate: z.string().nullable(), historyFrom: z.string().nullable(),
  tieout: z.unknown().nullable(), spotCheck: z.unknown().nullable(),
  verifiedAt: z.string().nullable(), verifiedBy: z.string().uuid().nullable(),
  createdBy: z.string().uuid().nullable(), createdAt: z.string(), updatedAt: z.string(),
  committedBy: z.string().uuid().nullable(), committedAt: z.string().nullable(),
  undoneBy: z.string().uuid().nullable(), undoneAt: z.string().nullable(),
  sessions: z.array(batchSessionSchema),
});
const progressSchema = z.object({ step: z.string(), done: z.number().int(), total: z.number().int() });

importsRouter.post('/batches', validate(importBatchCreateSchema), describe({
  summary: 'Create an import batch (imports-batch-v1)',
  description: 'Groups uploaded sessions (same sourceSystem, status uploaded) into one batch, the unit of commit, undo and '
    + 'record. 201 {batch} with status draft. 409 IMPORT_SESSION_IN_BATCH {sessionId, batchId} when a session already '
    + 'belongs to a batch; 409 IMPORT_TERMINAL when a session is no longer uploaded; 400 IMPORT_SOURCE_MISMATCH; 409 '
    + 'IMPORT_PERIOD_OVERLAP {batchId|null, from, to} when two journal files of the batch, or one and a journal file a '
    + 'committed batch holds, cover the same dates; 409 IMPORT_ALREADY_COMMITTED {batchId, sessionId, committedAt} when a '
    + 'committed batch holds the same data (by parsed-row hash); 409 IMPORT_FISCAL_YEAR_LOCKED when '
    + 'options.fiscalYearStartMonth is set and the company has transactions. U-265 (qbd-mapping-v1): options.accountMap '
    + '{sourceKey (the source account number, else its name; preview.accountMatches[].sourceKey): account id | "create"} '
    + '(400 IMPORT_ACCOUNT_MAP_INVALID {keys} for an id outside the company); options.classMap {className: {group?, tag}}. '
    + 'A batch never posts to suspense: its commit fails with 422 IMPORT_UNMAPPED_ACCOUNT {unmappedAccountKeys, '
    + 'unmappedCount} for any account it can not resolve. Options can not change after create: to retry with a map, '
    + 'DELETE the failed batch\'s sessions, upload the files again and create a new batch. U-266 (qbd-dates-v1): with '
    + 'options.conversionDate, 422 IMPORT_DATE_MISMATCH {conversionDate, files [{sessionId, kind, role, originalFilename, '
    + 'reportDate, reason not_conversion_date|no_date|after_conversion}]} when a reference trial balance, an open-item '
    + 'report or the inventory valuation is not dated the conversion date (or a posted trial balance is after it); 422 '
    + 'IMPORT_JOURNAL_AFTER_CONVERSION {conversionDate, rowCount, rows [{sessionId, rowNumber, date, code, message}] (up '
    + 'to 500)} for journal rows after it; 400 IMPORT_BAD_DATE when historyFrom is after conversionDate. Journal rows '
    + 'before options.historyFrom are not posted. batch.dateCheck {conversionDate, historyFrom, historySkipped, '
    + 'openingBalanceDate, firstJournalDate, warnings [{code IMPORT_HISTORY_GAP|IMPORT_JOURNAL_BEFORE_OPENING, message, '
    + 'openingBalanceDate, firstJournalDate, days?}]} (warnings never block). Several journal files per batch (one per '
    + 'year); their dates may not overlap each other or a committed journal file (409 IMPORT_PERIOD_OVERLAP).',
  tags: ['Imports'],
  body: importBatchCreateSchema,
  response: z.object({ batch: batchSchema }),
}), async (req, res) => {
  const batch = await batchService.createBatch(req.tenantId, req.companyId, req.userId, req.body);
  res.status(201).json({ batch });
});

importsRouter.get('/batches', describe({
  summary: 'List import batches (imports-batch-v1)',
  description: 'Newest first. Pass nextCursor back as cursor for the next page (null on the last).',
  tags: ['Imports'],
  query: importBatchListQuerySchema,
  response: z.object({ batches: z.array(batchSchema), nextCursor: z.string().nullable() }),
}), async (req, res) => {
  const q = importBatchListQuerySchema.parse(req.query);
  res.json(await batchService.listBatches(req.tenantId, req.companyId, q));
});

importsRouter.get('/batches/:id', describe({
  summary: 'Read an import batch and its progress (imports-batch-v1)',
  description: 'progress {step, done, total} while the batch is committing or undoing (else null); error '
    + '{code, message, status?, rowNumber?, sessionId?} when it failed (nothing was posted). 404 when not in this company.',
  tags: ['Imports'],
  response: z.object({ batch: batchSchema, progress: progressSchema.nullable(), error: batchErrorSchema.optional() }),
}), async (req, res) => {
  const id = uuidParam.parse(req.params['id']);
  res.json(await batchService.getBatch(req.tenantId, req.companyId, id));
});

/**
 * Commit, undo and verify are company-admin acts (U-263, review S4): the
 * tenant role owner, or a super admin (as reconciliation undo, U-190).
 * Ahead of idempotent(), so a replay needs the right too.
 */
function isImportAdmin(req: Request): boolean {
  return req.isSuperAdmin === true || req.userRole === 'owner';
}

function importAdminRequired(): AppError {
  return AppError.forbidden('Only a company administrator can commit or undo an import.', 'IMPORT_ADMIN_REQUIRED');
}

function requireImportAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (isImportAdmin(req)) {
    next();
    return;
  }
  next(importAdminRequired());
}

/** The closed-period context the batch job runs with, copied from the request's (U-262). */
function batchLockContext(req: Request): LockDateContext {
  const reqCtx = getLockContext();
  return {
    userType: req.userType === 'client' ? 'client' : 'staff',
    userId: req.userId,
    overrideConfirmed: (req.body as { confirmClosedPeriod?: unknown } | undefined)?.confirmClosedPeriod === true,
    ...(reqCtx?.closingPassword !== undefined ? { closingPassword: reqCtx.closingPassword } : {}),
  };
}

const CLOSED_PERIOD_DOC = 'A date on or before the closing date needs closingPassword (423 TB_PERIOD_LOCKED without it, '
  + '403 CLOSING_PASSWORD_INVALID when wrong, 429 when tried too often); with no closing-date password set, staff may send '
  + 'confirmClosedPeriod: true instead. Checked before the 202 for the earliest date; one closing_date_override audit row per '
  + 'batch. Owner or super admin only (403 IMPORT_ADMIN_REQUIRED).';

importsRouter.post('/batches/:id/commit',
  requireImportAdmin, closingPasswordLimiter, lockContextMiddleware,
  idempotent({ successStatus: 202, replay: async (req) => ({ batchId: req.params['id'] }) }),
  validate(importBatchCommitSchema), describe({
    summary: 'Commit an import batch in the background (imports-batch-v1)',
    description: 'Checks, then claims the batch (draft or failed -> committing) and answers 202 {batchId}; the batch then '
      + 'posts every post-role session in ONE database transaction (chart of accounts, contacts, items, trial balance, '
      + 'journal, open invoices, unpaid bills, inventory valuation, in that order; U-265). Poll GET /imports/batches/:id: it ends committed, or failed with error and nothing posted (a failed '
      + 'batch may be committed again with a new Idempotency-Key; the same key replays the 202). 409 IMPORT_BUSY while '
      + 'another import or undo of the company runs; 409 IMPORT_ALREADY_COMMITTED {batchId, sessionId, committedAt}; 409 '
      + 'IMPORT_PERIOD_OVERLAP; 409 IMPORT_BATCH_UNDONE; 409 IMPORT_HAS_ERRORS {sessionId, errors}; 409 '
      + 'IMPORT_COMPANY_NOT_EMPTY; 409 IMPORT_FISCAL_YEAR_LOCKED; 400 IMPORT_BATCH_EMPTY; 409 IMPORT_INVENTORY_OFF (inventory '
      + 'items or a valuation while company inventory is off); 409 INVENTORY_PERIOD_CLOSED {closingDate} (a valuation dated '
      + 'on or before the closing date; no password lifts it). Failures after the 202 (batch error): 422 '
      + 'IMPORT_UNMAPPED_ACCOUNT, IMPORT_UNKNOWN_ITEM, IMPORT_ITEM_NOT_INVENTORY, IMPORT_VALUATION_MISMATCH (U-265); '
      + 'U-266: the date refusals of create again before the 202 (422 IMPORT_DATE_MISMATCH, '
      + 'IMPORT_JOURNAL_AFTER_CONVERSION); after the 202, 409 IMPORT_PERIOD_OVERLAP when another batch committed an '
      + 'overlapping journal meanwhile, and 422 IMPORT_VALUATION_REQUIRED {sessionId, accounts [{sourceKey, balance}]} '
      + 'for a conversion batch with no inventory valuation whose conversion-date trial balance shows an inventory '
      + 'asset balance. The committed batch keeps result.dateCheck; the journal result has skippedBeforeHistory. '
      + 'backupRef names the verified '
      + 'backup the client took first. ' + CLOSED_PERIOD_DOC,
    tags: ['Imports'],
    body: importBatchCommitSchema.extend({ closingPassword: z.string().optional() }),
    response: z.object({ batchId: z.string().uuid() }),
  }), async (req, res) => {
    const batchId = uuidParam.parse(req.params['id']);
    const out = await batchService.startCommit({
      tenantId: req.tenantId,
      companyId: req.companyId,
      userId: req.userId,
      batchId,
      backupRef: req.body.backupRef ?? null,
      lockContext: batchLockContext(req),
    });
    res.status(202).json(out);
  });

importsRouter.post('/batches/:id/undo',
  requireImportAdmin, closingPasswordLimiter, lockContextMiddleware,
  idempotent({ successStatus: 202, replay: async (req) => ({ batchId: req.params['id'] }) }),
  validate(importBatchUndoSchema), describe({
    summary: 'Undo a committed import batch in the background (imports-batch-v1)',
    description: 'Removes everything the batch created in ONE database transaction (a hard delete; stored balances move '
      + 'back exactly) and restores what it changed (accounts, the fiscal year month). Checks run before the 202: 409 '
      + 'IMPORT_UNDO_BLOCKED {blockers:[{kind, id, reason, target?}], blockerCount} when something imported has been used '
      + 'since: reconciled, deposited, payment_applied, bill_paid, credit_applied, bank_match, tax_filed, billed, '
      + 'used_by_other_transaction, used_by_void_transaction, edited, changed_since, inventory_used, payroll, attached or '
      + 'linked (the advice is to restore the backup taken before the import). Voided payment applications are removed with '
      + 'the batch; the voided payment stays. Then committed -> undoing and 202 {batchId}; poll GET: undone, or back to '
      + 'committed with error. 409 IMPORT_BATCH_NOT_COMMITTED, IMPORT_BATCH_UNDONE, IMPORT_BUSY. Sessions become undone, '
      + 'their parsed rows are deleted, and the same data may be imported again. One delete audit row per removed record '
      + '(before-image) and one for the batch. ' + CLOSED_PERIOD_DOC,
    tags: ['Imports'],
    body: importBatchUndoSchema.extend({ closingPassword: z.string().optional() }),
    response: z.object({ batchId: z.string().uuid() }),
  }), async (req, res) => {
    const batchId = uuidParam.parse(req.params['id']);
    const out = await batchService.startUndo({
      tenantId: req.tenantId,
      companyId: req.companyId,
      userId: req.userId,
      batchId,
      backupRef: req.body.backupRef ?? null,
      lockContext: batchLockContext(req),
    });
    res.status(202).json(out);
  });

// ── Tie-out, verify, spot-check, transactions (U-267, U-271) ──────

const exact = z.string();
const tieoutTotalSchema = z.object({ sourceExact: exact, booksExact: exact, diffExact: exact });
const tieoutItemSchema = z.object({
  sourceRow: z.number().int().nullable(), sessionId: z.string().uuid().nullable(), transactionId: z.string().uuid().nullable(),
  contactName: z.string().nullable(), number: z.string().nullable(), docType: z.string().nullable(), date: z.string().nullable(),
  sourceExact: exact, booksExact: exact, diffExact: exact,
});
const tieoutBalanceRowSchema = z.object({
  key: z.enum(['history_ar', 'history_ap', 'history_inventory', 'valuation_vs_asset']), accountId: z.string().uuid().nullable(),
  sourceExact: exact, booksExact: exact, diffExact: exact,
});
const tieoutSchema = z.object({
  batchId: z.string().uuid(), asOf: z.string(), computedAt: z.string(), books: z.enum(['company', 'batch']),
  referenceTrialBalance: z.object({ sessionId: z.string().uuid(), reportDate: z.string().nullable() }).nullable(),
  accounts: z.array(z.object({
    accountId: z.string().uuid().nullable(), number: z.string().nullable(), name: z.string(),
    sourceRow: z.number().int().nullable(), sourceRows: z.array(z.number().int()), sourceKeys: z.array(z.string()),
    sourceExact: exact, booksExact: exact, diffExact: exact,
  })),
  arItems: z.array(tieoutItemSchema), apItems: z.array(tieoutItemSchema),
  inventoryItems: z.array(z.object({
    sourceRow: z.number().int().nullable(), item: z.string(), itemId: z.string().uuid().nullable(),
    sourceQuantity: exact, booksQuantity: exact, quantityDiff: exact, sourceExact: exact, booksExact: exact, diffExact: exact,
  })),
  balanceRows: z.array(tieoutBalanceRowSchema),
  totals: z.object({
    accounts: z.object({ sourceDebitExact: exact, sourceCreditExact: exact, booksDebitExact: exact, booksCreditExact: exact }).nullable(),
    ar: tieoutTotalSchema.nullable(), ap: tieoutTotalSchema.nullable(), inventory: tieoutTotalSchema.nullable(),
  }),
  differenceCount: z.number().int(), allZero: z.boolean(), verifiedAt: z.string().nullable(),
});

const TIEOUT_DOC = 'asOf is the batch\'s conversionDate, else its reference trial balance\'s date. accounts: the reference trial '
  + 'balance (required by default for every source, review S9: 422 TIEOUT_REFERENCE_REQUIRED; requireReference false skips '
  + 'the accounts side), each row resolved as the commit resolved it (accountMap, merged or mapped chart rows, number, name) '
  + 'and grouped per account (sourceKeys, sourceRows), against the exact accrual trial balance as of asOf (P&L fiscal year to '
  + 'date, earlier years in the retained earnings account): the whole company when it was empty at commit (books "company"), '
  + 'else only the batch\'s own lines (books "batch", Q-P31h). The before-conversion accounts are not in accounts but in '
  + 'balanceRows (history_ar, history_ap, history_inventory: 0.00 expected at asOf; valuation_vs_asset: inventory asset '
  + 'accounts in the books vs the valuation file). arItems/apItems: each open-item row (sourceRow) vs the open balance of the '
  + 'document it became, as of asOf; with books "company", an open item no row made is a row with sourceRow null. '
  + 'inventoryItems: each valuation row vs the engine valuation of its item (value in cents). totals: ar and ap aging totals '
  + 'and inventory (file and books), accounts debit and credit sums. Exact decimal strings (accounts debit - credit); '
  + 'diffExact = booksExact - sourceExact; allZero only when every difference (quantities too) is exactly 0. 409 '
  + 'IMPORT_BATCH_NOT_COMMITTED / IMPORT_BATCH_UNDONE; 422 TIEOUT_NO_DATE, TIEOUT_REFERENCE_AMBIGUOUS. Error messages never '
  + 'name accounts or contacts.';

importsRouter.post('/batches/:id/tieout', validate(importTieoutRequestSchema), describe({
  summary: 'Tie out a committed import batch (imports-tieout-v1)',
  description: 'Compares the batch\'s source files with the books and keeps the result on the batch (GET shows its summary: '
    + 'asOf, books, balanceRows, totals, differenceCount, allZero, counts, verifiedAt). A verified batch answers the tie-out '
    + 'kept at verify (its source rows are deleted). ' + TIEOUT_DOC,
  tags: ['Imports'],
  body: importTieoutRequestSchema,
  response: tieoutSchema,
}), async (req, res) => {
  const id = uuidParam.parse(req.params['id']);
  res.json(await tieoutService.runTieout(req.tenantId, req.companyId, id, req.body));
});

importsRouter.post('/batches/:id/verify', requireImportAdmin, validate(importTieoutRequestSchema), describe({
  summary: 'Verify a committed import batch (imports-tieout-v1)',
  description: 'Recomputes the tie-out. 409 TIEOUT_NOT_ZERO {batchId, differenceCount, firstDifferences [{section '
    + 'accounts|arItems|apItems|inventoryItems|balanceRows|totals, key (balanceRows: the balance key; totals: ar|ap|inventory; '
    + 'else null), sourceRow, accountId, transactionId, itemId, diffExact, quantityDiff?}] (up to 20, ids only, never names)} unless every difference is exactly 0. Else 200 {batch, tieout}: the '
    + 'batch is verified (verifiedAt, verifiedBy), keeps the tie-out, and the stored parsed rows of its sessions are deleted '
    + '(review S8); one audit row. Verifying a verified batch answers 200 with what it kept. 409 IMPORT_BUSY while another '
    + 'import or undo of the company runs. Owner or super admin only (403 IMPORT_ADMIN_REQUIRED). ' + TIEOUT_DOC,
  tags: ['Imports'],
  body: importTieoutRequestSchema,
  response: z.object({ batch: batchSchema, tieout: tieoutSchema }),
}), async (req, res) => {
  const id = uuidParam.parse(req.params['id']);
  res.json(await tieoutService.verifyBatch(req.tenantId, req.companyId, req.userId, id, req.body));
});

const spotCheckOutSchema = z.object({
  items: z.array(z.object({ key: z.string(), label: z.string(), done: z.boolean(), note: z.string().nullable().optional() })),
  updatedAt: z.string(), updatedBy: z.string().uuid(),
});

importsRouter.put('/batches/:id/spot-check', validate(importSpotCheckSchema), describe({
  summary: 'Save the spot-check list of an import batch (imports-tieout-v1)',
  description: 'Replaces the batch\'s spot-check list {items [{key, label, done, note?}]} (up to 200) and answers {spotCheck '
    + '{items, updatedAt, updatedBy}}; GET /imports/batches/:id returns it as batch.spotCheck. A committed batch only (409 '
    + 'IMPORT_BATCH_NOT_COMMITTED / IMPORT_BATCH_UNDONE).',
  tags: ['Imports'],
  body: importSpotCheckSchema,
  response: z.object({ spotCheck: spotCheckOutSchema }),
}), async (req, res) => {
  const id = uuidParam.parse(req.params['id']);
  const spotCheck = await tieoutService.saveSpotCheck(req.tenantId, req.companyId, req.userId, id, req.body.items);
  res.json({ spotCheck });
});

importsRouter.get('/batches/:id/transactions', describe({
  summary: 'List the transactions an import batch created (imports-tieout-v1)',
  description: 'U-271: by date then id, paged (pass nextCursor back as cursor; null on the last page); txnType filters '
    + '(e.g. invoice, bill, journal_entry). total counts every match (for sampling). Each: {id, txnType, txnDate, txnNumber, '
    + 'vendorInvoiceNumber, status, contactId, contactName, total (exact; a journal entry\'s debits)}. Empty after undo.',
  tags: ['Imports'],
  query: importBatchTransactionsQuerySchema,
  response: z.object({
    transactions: z.array(z.object({
      id: z.string().uuid(), txnType: z.string(), txnDate: z.string(), txnNumber: z.string().nullable(),
      vendorInvoiceNumber: z.string().nullable(), status: z.string(), contactId: z.string().uuid().nullable(),
      contactName: z.string().nullable(), total: z.string(),
    })),
    nextCursor: z.string().nullable(),
    total: z.number().int(),
  }),
}), async (req, res) => {
  const id = uuidParam.parse(req.params['id']);
  const q = importBatchTransactionsQuerySchema.parse(req.query);
  res.json(await tieoutService.listBatchTransactions(req.tenantId, req.companyId, id, q));
});

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

  // U-261: 'post' (default) or 'reference' (a file only compared against).
  const role = req.body['role'] ? importSessionRoleSchema.parse(req.body['role']) : 'post';

  const out = await importsService.createSession({
    tenantId: req.tenantId,
    companyId: req.companyId,
    userId: req.userId,
    file: { originalname: req.file.originalname, buffer: req.file.buffer },
    kind,
    sourceSystem,
    options,
    role,
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
// U-261: commits the session as a one-session batch (kind 'single') in ONE
// database transaction, synchronously; a failure posts nothing.
importsRouter.post('/:id/commit', describe({
  summary: 'Commit one import session (one-session batch)',
  description: 'Commits the session as a one-session batch (kind single, U-261) in one database transaction and answers '
    + '{session, result}. A failure posts nothing and leaves the session failed. 409 IMPORT_SESSION_IN_BATCH when the '
    + 'session belongs to a batch (commit the batch); 409 IMPORT_ALREADY_COMMITTED / IMPORT_PERIOD_OVERLAP (U-263); 409 '
    + 'IMPORT_BUSY while another import of the company runs; 409 IMPORT_HAS_ERRORS; 409 IMPORT_TERMINAL. dryRun validates only. '
    + 'A commit (not a dryRun) is owner or super admin only, as a batch commit (403 IMPORT_ADMIN_REQUIRED, U-264).',
  tags: ['Imports'],
}), async (req, res) => {
  const id = req.params['id'];
  if (!id) throw AppError.badRequest('Missing session id.');
  const parsed = importCommitSchema.parse(req.body ?? {});
  // U-264 (E1 open point): posting through the old route needs the same right
  // as a batch commit; a dry run posts nothing and stays open to staff.
  if (!parsed.dryRun && !isImportAdmin(req)) throw importAdminRequired();
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
