// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { Router } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { authenticate } from '../middleware/auth.js';
import { companyContext } from '../middleware/company.js';
import { validate } from '../middleware/validate.js';
import {
  payrollUploadSchema,
  applyMappingSchema,
  saveTemplateSchema,
  updateTemplateSchema,
  saveDescriptionMapSchema,
  postChecksSchema,
  generateJeSchema,
  payrollSessionFiltersSchema,
  reversePayrollSchema,
  postPayrollSchema,
  accountMappingSaveSchema,
} from '@kis-books/shared';
import * as importService from '../services/payroll-import.service.js';
import * as validationService from '../services/payroll-validation.service.js';
import * as jeService from '../services/payroll-je.service.js';
import * as modeBService from '../services/payroll-modeb.service.js';

const uuidParam = z.string().uuid();

const PAYROLL_MIME_TYPES = [
  'text/csv',
  'text/plain',
  'text/tab-separated-values',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
];

// Zip-container and binary signatures we reject even if the extension or
// MIME claims CSV. Without this, a renamed `evil.exe` uploaded with a
// blank MIME was accepted by the extension-only fallback.
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // xlsx is a zip
const OLE_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0]); // xls
const PE_MAGIC = Buffer.from([0x4d, 0x5a]);              // Windows exe
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

function verifyPayrollContent(file: Express.Multer.File): void {
  const buf = file.buffer;
  const name = file.originalname.toLowerCase();
  const err = () => { throw new Error('Uploaded payroll file content does not match its declared type.'); };
  if (name.endsWith('.xlsx')) {
    if (!startsWith(buf, ZIP_MAGIC)) err();
    return;
  }
  if (name.endsWith('.xls')) {
    if (!startsWith(buf, OLE_MAGIC)) err();
    return;
  }
  // .csv / .tsv / .txt — no magic, so reject anything that's obviously a
  // binary executable or archive.
  if (
    startsWith(buf, ZIP_MAGIC) ||
    startsWith(buf, OLE_MAGIC) ||
    startsWith(buf, PE_MAGIC) ||
    startsWith(buf, ELF_MAGIC) ||
    MACHO_MAGICS.some((m) => startsWith(buf, m))
  ) err();
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (PAYROLL_MIME_TYPES.includes(file.mimetype)) {
      cb(null, true);
      return;
    }
    // Browsers occasionally send `application/octet-stream` for CSV
    // uploads — allow an extension fallback only in that case so that
    // an attacker can't bypass the MIME allowlist by claiming
    // something else (e.g. `application/x-msdownload`). The magic-byte
    // check in the handler rejects anything binary regardless.
    const permissiveMime = file.mimetype === 'application/octet-stream' || file.mimetype === '';
    const ext = file.originalname.toLowerCase();
    const allowedExt = ext.endsWith('.csv') || ext.endsWith('.tsv') || ext.endsWith('.xlsx') || ext.endsWith('.xls') || ext.endsWith('.txt');
    if (permissiveMime && allowedExt) {
      cb(null, true);
    } else {
      cb(new Error(`File type ${file.mimetype} is not allowed. Accepted: .csv, .tsv, .xlsx, .xls, .txt`));
    }
  },
});

export const payrollImportRouter = Router();
payrollImportRouter.use(authenticate);
payrollImportRouter.use(companyContext);

// ── Upload ──
payrollImportRouter.post('/upload',
  upload.fields([
    { name: 'file', maxCount: 1 },
    { name: 'companionFile', maxCount: 1 },
  ]),
  async (req, res) => {
    const files = req.files as { [fieldname: string]: Express.Multer.File[] };
    const mainFile = files['file']?.[0];
    if (!mainFile) {
      res.status(400).json({ error: { message: 'No file uploaded' } });
      return;
    }

    try {
      verifyPayrollContent(mainFile);
    } catch (err: any) {
      res.status(400).json({ error: { message: err.message || 'Invalid upload' } });
      return;
    }

    // Validate body fields
    const opts = payrollUploadSchema.parse(req.body);

    const companionFile = files['companionFile']?.[0];
    if (companionFile) {
      try {
        verifyPayrollContent(companionFile);
      } catch (err: any) {
        res.status(400).json({ error: { message: err.message || 'Invalid companion file' } });
        return;
      }
    }
    const result = await importService.uploadPayrollFile(
      req.tenantId,
      opts.companyId || undefined,
      { buffer: mainFile.buffer, originalname: mainFile.originalname },
      companionFile ? { buffer: companionFile.buffer, originalname: companionFile.originalname } : undefined,
      {
        templateId: opts.templateId,
        importMode: opts.importMode,
        payPeriodStart: opts.payPeriodStart,
        payPeriodEnd: opts.payPeriodEnd,
        checkDate: opts.checkDate,
      },
      req.userId,
    );

    // Parse companion file (Mode B checks) if present
    if (companionFile && result.session) {
      await modeBService.parseAndStoreChecks(
        req.tenantId,
        result.session.id,
        companionFile.buffer,
        companionFile.originalname,
      );
    }

    res.status(201).json(result);
  },
);

// ── Preview ──
payrollImportRouter.get('/sessions/:id/preview', async (req, res) => {
  const sessionId = uuidParam.parse(req.params['id']);
  const preview = await importService.getPreview(req.tenantId, sessionId);
  res.json(preview);
});

// ── Apply Column Mapping (Mode A) ──
payrollImportRouter.post('/sessions/:id/apply-mapping', validate(applyMappingSchema), async (req, res) => {
  const sessionId = uuidParam.parse(req.params['id']);
  const result = await importService.applyMapping(req.tenantId, sessionId, req.body);
  res.json(result);
});

// ── Description Map (Mode B) ──
payrollImportRouter.get('/sessions/:id/description-map', async (req, res) => {
  const sessionId = uuidParam.parse(req.params['id']);
  const result = await importService.getDescriptionMap(req.tenantId, sessionId);
  res.json({ mappings: result });
});

payrollImportRouter.put('/sessions/:id/description-map', validate(saveDescriptionMapSchema), async (req, res) => {
  const sessionId = uuidParam.parse(req.params['id']);
  await importService.saveDescriptionMap(
    req.tenantId,
    sessionId,
    req.body.providerKey,
    req.body.mappings,
  );
  res.json({ success: true });
});

// ── Validate (dispatches Mode A vs Mode B) ──
payrollImportRouter.post('/sessions/:id/validate', async (req, res) => {
  const sessionId = uuidParam.parse(req.params['id']);
  const result = await validationService.dispatchValidation(req.tenantId, sessionId);
  res.json(result);
});

// ── Generate JE Preview ──
payrollImportRouter.post('/sessions/:id/generate-je', validate(generateJeSchema), async (req, res) => {
  const sessionId = uuidParam.parse(req.params['id']);
  const session = await importService.getSession(req.tenantId, sessionId);
  let result;
  if (session.importMode === 'prebuilt_je') {
    result = await modeBService.generateModeBJE(req.tenantId, sessionId);
  } else {
    result = await jeService.generateJE(req.tenantId, sessionId, req.body);
  }
  res.json(result);
});

// ── Post JE ──
payrollImportRouter.post('/sessions/:id/post', validate(postPayrollSchema), async (req, res) => {
  const sessionId = uuidParam.parse(req.params['id']);
  const session = await importService.getSession(req.tenantId, sessionId);
  const { forcePost, aggregationMode } = req.body;
  let result;
  if (session.importMode === 'prebuilt_je') {
    result = await modeBService.postModeBJE(req.tenantId, sessionId, req.userId, forcePost, req.companyId);
  } else {
    result = await jeService.postJE(req.tenantId, sessionId, req.userId, forcePost, aggregationMode, req.companyId);
  }
  res.json(result);
});

// ── Reverse ──
payrollImportRouter.post('/sessions/:id/reverse', validate(reversePayrollSchema), async (req, res) => {
  const sessionId = uuidParam.parse(req.params['id']);
  const result = await jeService.reverseJE(req.tenantId, sessionId, req.body.reason, req.userId);
  res.json(result);
});

// ── Check Register (Mode B) ──
payrollImportRouter.get('/sessions/:id/checks', async (req, res) => {
  const sessionId = uuidParam.parse(req.params['id']);
  const result = await modeBService.getChecks(req.tenantId, sessionId);
  res.json({ checks: result });
});

payrollImportRouter.post('/sessions/:id/checks/post', validate(postChecksSchema), async (req, res) => {
  const sessionId = uuidParam.parse(req.params['id']);
  const result = await modeBService.postChecks(
    req.tenantId, sessionId, req.body.bankAccountId, req.body.clearingAccountId, req.body.checkIds, req.userId, req.companyId,
  );
  res.json(result);
});

// ── Templates ──
payrollImportRouter.get('/templates', async (req, res) => {
  const templates = await importService.listTemplates(req.tenantId);
  res.json({ templates });
});

payrollImportRouter.get('/templates/:id', async (req, res) => {
  const templateId = uuidParam.parse(req.params['id']);
  const template = await importService.getTemplate(req.tenantId, templateId);
  res.json({ template });
});

payrollImportRouter.post('/templates', validate(saveTemplateSchema), async (req, res) => {
  const template = await importService.createTemplate(req.tenantId, req.body);
  res.status(201).json({ template });
});

payrollImportRouter.put('/templates/:id', validate(updateTemplateSchema), async (req, res) => {
  const templateId = uuidParam.parse(req.params['id']);
  const template = await importService.updateTemplate(req.tenantId, templateId, req.body);
  res.json({ template });
});

payrollImportRouter.delete('/templates/:id', async (req, res) => {
  const templateId = uuidParam.parse(req.params['id']);
  await importService.deleteTemplate(req.tenantId, templateId);
  res.json({ success: true });
});

// ── Sessions List / Detail / Delete ──
payrollImportRouter.get('/sessions', async (req, res) => {
  const filters = payrollSessionFiltersSchema.parse(req.query);
  const result = await importService.listSessions(req.tenantId, filters);
  res.json(result);
});

payrollImportRouter.get('/sessions/:id', async (req, res) => {
  const sessionId = uuidParam.parse(req.params['id']);
  const session = await importService.getSession(req.tenantId, sessionId);
  res.json({ session });
});

payrollImportRouter.delete('/sessions/:id', async (req, res) => {
  const sessionId = uuidParam.parse(req.params['id']);
  await importService.deleteSession(req.tenantId, sessionId, req.userId);
  res.json({ success: true });
});

// ── Account Mappings ──
payrollImportRouter.get('/account-mappings/:companyId', async (req, res) => {
  const companyId = uuidParam.parse(req.params['companyId']);
  const mappings = await importService.getAccountMappings(req.tenantId, companyId);
  res.json({ mappings });
});

payrollImportRouter.put('/account-mappings/:companyId', validate(accountMappingSaveSchema), async (req, res) => {
  const companyId = uuidParam.parse(req.params['companyId']);
  await importService.saveAccountMappings(req.tenantId, companyId, req.body.mappings);
  res.json({ success: true });
});

payrollImportRouter.post('/account-mappings/:companyId/auto-map', async (req, res) => {
  const companyId = uuidParam.parse(req.params['companyId']);
  const suggestions = await importService.autoMapAccounts(req.tenantId, companyId);
  res.json({ suggestions });
});
