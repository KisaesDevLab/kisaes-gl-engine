import { Router } from 'express';
import crypto from 'crypto';
import multer from 'multer';
import { and, eq } from 'drizzle-orm';
import { authenticate } from '../middleware/auth.js';
import { validatePassphraseStrength } from '../services/portable-encryption.service.js';
import * as tenantExportService from '../services/tenant-export.service.js';
import { getImportProgress } from '../services/tenant-export.service.js';
import { db } from '../db/index.js';
import { userTenantAccess } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';

// A merge-import rewrites the target tenant's ledger. Only users with an
// active access grant on that tenant (and super admins) may initiate it —
// otherwise any authenticated user could send `target_company_id=<victim>`
// in the body and have their exported data written into somebody else's
// books. Previous code only checked that the tenant row existed.
async function assertUserMayMergeIntoTenant(userId: string, targetTenantId: string, isSuperAdmin: boolean): Promise<void> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(targetTenantId)) {
    throw AppError.badRequest('Invalid target tenant id');
  }
  if (isSuperAdmin) return;
  const access = await db.query.userTenantAccess.findFirst({
    where: and(
      eq(userTenantAccess.userId, userId),
      eq(userTenantAccess.tenantId, targetTenantId),
      eq(userTenantAccess.isActive, true),
    ),
  });
  if (!access) throw AppError.forbidden('You do not have access to this tenant');
  if (access.role !== 'owner' && access.role !== 'admin') {
    throw AppError.forbidden('Only tenant owners or admins may merge data into a tenant');
  }
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 1024 * 1024 * 1024 }, // 1 GB
});

export const tenantExportRouter = Router();
tenantExportRouter.use(authenticate);

// ─── EXPORT ────────────────────────────────────────────────

// Create a tenant export (.vmx)
tenantExportRouter.post('/', async (req, res) => {
  const { passphrase, date_range, include_attachments, include_audit, include_bank_rules } = req.body;

  if (!passphrase || typeof passphrase !== 'string') {
    res.status(400).json({ error: { message: 'Passphrase is required' } });
    return;
  }

  const strength = validatePassphraseStrength(passphrase);
  if (!strength.valid) {
    res.status(400).json({ error: { message: strength.message } });
    return;
  }

  const result = await tenantExportService.exportTenant(
    req.tenantId,
    passphrase,
    {
      dateRange: date_range,
      includeAttachments: include_attachments,
      includeAudit: include_audit,
      includeBankRules: include_bank_rules,
    },
    req.userId,
  );

  res.status(201).json(result);
});

// Download an export file
tenantExportRouter.get('/download/:fileName', async (req, res) => {
  const data = await tenantExportService.downloadExport(
    req.tenantId,
    req.params['fileName']!,
    req.userId,
  );
  const fileName = req.params['fileName']!;
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.send(data);
});

// ─── IMPORT ────────────────────────────────────────────────

// Validate/preview an import file (upload + decrypt, no import yet)
tenantExportRouter.post('/import/validate', upload.single('file'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: { message: 'No file uploaded' } });
    return;
  }

  const passphrase = req.body?.passphrase;
  if (!passphrase) {
    res.status(400).json({ error: { message: 'Passphrase is required' } });
    return;
  }

  const preview = await tenantExportService.previewImport(req.file.buffer, passphrase);
  res.json(preview);
});

// Execute import as new company
tenantExportRouter.post('/import', async (req, res) => {
  const { validation_token, mode, company_name, assign_users, target_company_id } = req.body;

  if (!validation_token) {
    res.status(400).json({ error: { message: 'Validation token is required' } });
    return;
  }

  if (mode === 'merge') {
    if (!target_company_id) {
      res.status(400).json({ error: { message: 'target_company_id is required for merge mode' } });
      return;
    }
    await assertUserMayMergeIntoTenant(req.userId, target_company_id, req.isSuperAdmin);
    const result = await tenantExportService.importMergeIntoTenant(
      validation_token,
      target_company_id,
      req.userId,
    );
    res.status(201).json(result);
    return;
  }

  // Default: import as new company
  const name = company_name || 'Imported Company';
  const users = assign_users || [req.userId];
  const jobId = crypto.randomUUID();

  const result = await tenantExportService.importAsNewTenant(
    validation_token,
    name,
    users,
    req.userId,
    jobId,
  );
  res.status(201).json({ ...result, job_id: jobId });
});

// Get import progress
tenantExportRouter.get('/import/status/:jobId', (req, res) => {
  const progress = getImportProgress(req.params['jobId']!);
  if (!progress) {
    res.status(404).json({ error: { message: 'Job not found' } });
    return;
  }
  res.json(progress);
});

// Get merge preview
tenantExportRouter.post('/import/merge-preview', async (req, res) => {
  const { validation_token, target_tenant_id } = req.body;

  if (!validation_token || !target_tenant_id) {
    res.status(400).json({ error: { message: 'validation_token and target_tenant_id are required' } });
    return;
  }

  await assertUserMayMergeIntoTenant(req.userId, target_tenant_id, req.isSuperAdmin);
  const preview = await tenantExportService.getMergePreview(validation_token, target_tenant_id);
  res.json(preview);
});
