import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import crypto from 'crypto';
import { updateCompanySchema, updateCompanySettingsSchema } from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { companyContext } from '../middleware/company.js';
import { validate } from '../middleware/validate.js';
import * as companyService from '../services/company.service.js';
import * as authService from '../services/auth.service.js';
import { testSmtpConnection } from '../services/setup.service.js';
import { AppError } from '../utils/errors.js';
import { env } from '../config/env.js';

// Force the on-disk extension from the claimed MIME, not from the upload
// filename. An uploader can send `Content-Type: image/png` with an
// `evil.svg` originalname — and if we trusted the original extension, the
// file would be saved as .svg and later served with SVG MIME, turning the
// logo URL into an XSS vector (inline SVG is scriptable).
const LOGO_MIME_TO_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
};

const upload = multer({
  storage: multer.diskStorage({
    destination: path.join(env.UPLOAD_DIR, 'logos'),
    filename: (_req, file, cb) => {
      const ext = LOGO_MIME_TO_EXT[file.mimetype] || '.bin';
      cb(null, `${crypto.randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB for logos
  fileFilter: (_req, file, cb) => {
    cb(null, !!LOGO_MIME_TO_EXT[file.mimetype]);
  },
});

// Post-upload: sniff buffer header so a misdeclared MIME (e.g., SVG
// claiming image/png) still can't land on disk with a script payload.
function verifyLogoMagicBytes(filePath: string, mime: string): void {
  const fs = require('fs') as typeof import('fs');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(16);
    fs.readSync(fd, buf, 0, 16, 0);
    const pngOk = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    const jpegOk = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    const webpOk = buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP';
    const match =
      (mime === 'image/png' && pngOk) ||
      (mime === 'image/jpeg' && jpegOk) ||
      (mime === 'image/webp' && webpOk);
    if (!match) {
      fs.unlinkSync(filePath);
      throw AppError.badRequest('Logo content does not match its declared image type');
    }
  } finally {
    fs.closeSync(fd);
  }
}

export const companyRouter = Router();

companyRouter.use(authenticate);
companyRouter.use(companyContext);

// List all companies for the tenant
companyRouter.get('/list', async (req, res) => {
  const companiesList = await companyService.listCompanies(req.tenantId, req.userId);
  res.json({ companies: companiesList });
});

// Create additional company
companyRouter.post('/create', async (req, res) => {
  const company = await companyService.createAdditionalCompany(req.tenantId, req.body);
  res.status(201).json({ company });
});

companyRouter.get('/', async (req, res) => {
  const company = await companyService.getCompany(req.tenantId, req.companyId);
  res.json({ company });
});

companyRouter.put('/', validate(updateCompanySchema), async (req, res) => {
  const company = await companyService.updateCompany(req.tenantId, req.companyId, req.body, req.userId);
  res.json({ company });
});

companyRouter.post('/logo', upload.single('logo'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: { message: 'No file uploaded' } });
    return;
  }
  verifyLogoMagicBytes(req.file.path, req.file.mimetype);
  const logoUrl = `/uploads/logos/${req.file.filename}`;
  const company = await companyService.updateLogo(req.tenantId, req.companyId, logoUrl, req.userId);
  res.json({ company });
});

companyRouter.get('/settings', async (req, res) => {
  const settings = await companyService.getSettings(req.tenantId, req.companyId);
  res.json({ settings });
});

companyRouter.put('/settings', validate(updateCompanySettingsSchema), async (req, res) => {
  const company = await companyService.updateCompany(req.tenantId, req.companyId, req.body, req.userId);
  res.json({
    settings: {
      fiscalYearStartMonth: company.fiscalYearStartMonth,
      accountingMethod: company.accountingMethod,
      defaultPaymentTerms: company.defaultPaymentTerms,
      invoicePrefix: company.invoicePrefix,
      invoiceNextNumber: company.invoiceNextNumber,
      defaultSalesTaxRate: company.defaultSalesTaxRate,
      currency: company.currency,
      dateFormat: company.dateFormat,
      lockDate: company.lockDate,
    },
  });
});

companyRouter.get('/smtp', async (req, res) => {
  const smtp = await companyService.getSmtpSettings(req.tenantId, req.companyId);
  res.json(smtp);
});

companyRouter.put('/smtp', async (req, res) => {
  await companyService.updateSmtpSettings(req.tenantId, req.companyId, req.body, req.userId);
  res.json({ message: 'SMTP settings saved' });
});

companyRouter.post('/smtp/test', async (req, res) => {
  const result = await testSmtpConnection(req.body, req.body.testEmail);
  res.json(result);
});

companyRouter.post('/setup-complete', async (req, res) => {
  await companyService.markSetupComplete(req.tenantId, req.companyId);
  res.json({ message: 'Setup complete' });
});

// ─── Team Management ────────────────────────────────────────

companyRouter.get('/users', async (req, res) => {
  const users = await authService.listTenantUsers(req.tenantId);
  const sanitized = users.map((u) => ({
    id: u.id, email: u.email, displayName: u.displayName, role: u.role,
    isActive: u.isActive, lastLoginAt: u.lastLoginAt, createdAt: u.createdAt,
  }));
  res.json({ users: sanitized });
});

companyRouter.post('/invite-user', async (req, res) => {
  if (req.userRole !== 'owner') throw AppError.forbidden('Only owners can invite users');
  const { email, displayName, role } = req.body;
  if (!email || !displayName) {
    res.status(400).json({ error: { message: 'Email and display name are required' } });
    return;
  }
  const validRoles = ['accountant', 'bookkeeper'];
  if (role && !validRoles.includes(role)) {
    res.status(400).json({ error: { message: `Role must be one of: ${validRoles.join(', ')}` } });
    return;
  }
  const result = await authService.inviteUser(req.tenantId, { email, displayName: displayName || email, role: role || 'accountant' });
  res.status(201).json({
    user: { id: result.user.id, email: result.user.email, displayName: result.user.displayName, role: result.existingUser ? role : result.user.role },
    temporaryPassword: result.temporaryPassword,
    existingUser: result.existingUser,
    message: result.existingUser ? 'Existing user granted access to this tenant' : 'New user created',
  });
});

companyRouter.post('/users/:userId/deactivate', async (req, res) => {
  if (req.userRole !== 'owner') throw AppError.forbidden('Only owners can manage users');
  await authService.deactivateUser(req.tenantId, req.params['userId']!);
  res.json({ message: 'User deactivated' });
});

companyRouter.post('/users/:userId/reactivate', async (req, res) => {
  if (req.userRole !== 'owner') throw AppError.forbidden('Only owners can manage users');
  await authService.reactivateUser(req.tenantId, req.params['userId']!);
  res.json({ message: 'User reactivated' });
});

// ── Stripe Settings ──

companyRouter.get('/stripe', async (req, res) => {
  const { getStripeConfig } = await import('../services/stripe.service.js');
  const config = await getStripeConfig(req.tenantId, req.companyId);
  res.json(config);
});

companyRouter.put('/stripe', async (req, res) => {
  if (req.userRole !== 'owner') throw AppError.forbidden('Only owners can configure payment settings');
  const { stripeConfigSchema } = await import('@kis-books/shared');
  const parsed = stripeConfigSchema.parse(req.body);
  const { configureStripe } = await import('../services/stripe.service.js');
  await configureStripe(req.tenantId, req.companyId, parsed);
  res.json({ message: 'Stripe configured', onlinePaymentsEnabled: true });
});

companyRouter.delete('/stripe', async (req, res) => {
  if (req.userRole !== 'owner') throw AppError.forbidden('Only owners can configure payment settings');
  const { removeStripeConfig } = await import('../services/stripe.service.js');
  await removeStripeConfig(req.tenantId, req.companyId);
  res.json({ message: 'Stripe configuration removed', onlinePaymentsEnabled: false });
});
