// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router } from 'express';
import { z } from 'zod';
import multer from 'multer';
import path from 'path';
import crypto from 'crypto';
import { promises as fsp } from 'fs';
import {
  updateCompanySchema,
  updateCompanySettingsSchema,
  createCompanySchema,
  companySmtpUpdateSchema,
  companySmtpTestSchema,
  inviteUserSchema,
  updateUserSchema,
  createPermissionTemplateSchema,
  updatePermissionTemplateSchema,
  setUserPermissionsSchema,
  EQUITY_ROLE_REPORT_TAGS,
  intakeFolderSchema,
  putIntakeSettingsSchema,
} from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { requireTenantCapability } from '../middleware/firm-capabilities.js';
import { companyContext } from '../middleware/company.js';
import { requirePermission } from '../middleware/permission.js';
import { describe } from '../middleware/describe.js';
import { validate } from '../middleware/validate.js';
import { closingPasswordLimiter } from '../middleware/closing-password-limiter.js';
import { takeClosingPassword } from '../services/lock-context.js';
import * as closingPasswordService from '../services/closing-password.service.js';
import * as companyService from '../services/company.service.js';
import * as equityRolesService from '../services/equity-roles.service.js';
import * as intakeSettingsService from '../services/intake-settings.service.js';
import * as invoiceTemplateService from '../services/invoice-template.service.js';
import * as authService from '../services/auth.service.js';
import * as permissionService from '../services/permission.service.js';
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

// List all companies for the tenant. Registered BEFORE companyContext on
// purpose: this endpoint is tenant-scoped, not company-scoped, and the
// frontend calls it to recover from a stale X-Company-Id stored in
// localStorage. If we ran companyContext here, a stale id would 403 this
// request, the CompanyProvider's reconciliation block would never run,
// and the sidebar would be permanently stuck on "Select Company".
companyRouter.get('/list', async (req, res) => {
  const companiesList = await companyService.listCompanies(req.tenantId, req.userId);
  res.json({ companies: companiesList });
});

companyRouter.use(companyContext);

// Company-configuration writes (profile, logo, fiscal settings, invoice
// template, SMTP relay, extra companies) are gated on the
// company_settings resource. Without this a readonly member — or an
// external client-type user with a narrow permission template — could
// e.g. repoint the company's outbound SMTP at a relay they control and
// read every customer-facing email. Reads stay open: every role needs
// the company profile/settings to render the app.
const requireCompanySettingsWrite = requirePermission('company_settings', 'update');

// Create additional company
companyRouter.post('/create', requireCompanySettingsWrite, validate(createCompanySchema), async (req, res) => {
  const company = await companyService.createAdditionalCompany(req.tenantId, req.body);
  res.status(201).json({ company });
});

companyRouter.get('/', async (req, res) => {
  const company = await companyService.getCompany(req.tenantId, req.companyId);
  res.json({ company });
});

companyRouter.put('/', requireCompanySettingsWrite, validate(updateCompanySchema), async (req, res) => {
  const company = await companyService.updateCompany(req.tenantId, req.companyId, req.body, req.userId);
  res.json({ company });
});

companyRouter.post('/logo', requireCompanySettingsWrite, upload.single('logo'), async (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: { message: 'No file uploaded' } });
    return;
  }
  verifyLogoMagicBytes(req.file.path, req.file.mimetype);
  const logoUrl = `/uploads/logos/${req.file.filename}`;
  const company = await companyService.updateLogo(req.tenantId, req.companyId, logoUrl, req.userId);
  res.json({ company });
});

// The stored logo's bytes (U-110, company-logo-v1), for clients that print
// forms themselves and do not serve /uploads. Only a logo uploaded through
// POST /company/logo is served: logoUrl must be /uploads/logos/<uuid>.<png|jpg|webp>
// (the invoice template can store any string there); anything else, or a
// missing file, is 404.
const LOGO_URL_RE = /^\/uploads\/logos\/([0-9a-f-]{36})\.(png|jpg|webp)$/i;
const LOGO_EXT_TO_MIME: Record<string, string> = Object.fromEntries(
  Object.entries(LOGO_MIME_TO_EXT).map(([mime, ext]) => [ext.slice(1), mime]),
);

companyRouter.get('/logo', describe({
  summary: "The company's uploaded logo image (company-logo-v1)",
  description: 'Streams the bytes with Content-Type image/png, image/jpeg or image/webp; 404 when the company has no uploaded logo.',
}), async (req, res) => {
  const company = await companyService.getCompany(req.tenantId, req.companyId);
  const m = LOGO_URL_RE.exec(company.logoUrl ?? '');
  if (!m) throw AppError.notFound('This company has no logo');
  const ext = m[2]!.toLowerCase();
  const dir = path.resolve(env.UPLOAD_DIR, 'logos');
  const file = path.join(dir, `${m[1]!.toLowerCase()}.${ext}`);
  if (path.dirname(file) !== dir) throw AppError.notFound('This company has no logo');
  let bytes: Buffer;
  try {
    bytes = await fsp.readFile(file);
  } catch {
    throw AppError.notFound('This company has no logo');
  }
  res.setHeader('Content-Type', LOGO_EXT_TO_MIME[ext] ?? 'application/octet-stream');
  res.setHeader('Content-Length', String(bytes.length));
  res.setHeader('Cache-Control', 'private, no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(bytes);
});

// Equity roles (U-55, equity-roles-v1): the company's entity type and, per
// role, the account playing it or null. Read-only; the roles are seeded on
// company creation and entity-type change, and reassigned through the
// system-accounts tools.
companyRouter.get('/equity-roles', describe({
  summary: 'Equity role accounts for the company (equity-roles-v1)',
  response: z.object({
    entityType: z.string(),
    roles: z.object(Object.fromEntries(EQUITY_ROLE_REPORT_TAGS.map((t) => [t, z.string().uuid().nullable()]))),
  }),
}), async (req, res) => {
  res.json(await equityRolesService.getEquityRoles(req.tenantId, req.companyId));
});

companyRouter.get('/settings', async (req, res) => {
  const settings = await companyService.getSettings(req.tenantId, req.companyId);
  res.json({ settings });
});

// The closing-date password (U-15) is taken out of the body before the
// schema sees it. With a password set, changing lockDate needs it; given
// while none is set, it becomes the password (owner or super admin).
// Documented on the schema for OpenAPI only.
const updateCompanySettingsBodyDoc = updateCompanySettingsSchema.extend({
  closingPassword: z.string().optional().describe('closing-date password (closing-password-v1); never stored or echoed'),
});

function captureClosingPassword(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) {
  res.locals['closingPassword'] = takeClosingPassword(req);
  next();
}

companyRouter.put('/settings', requireCompanySettingsWrite, closingPasswordLimiter, captureClosingPassword, validate(updateCompanySettingsSchema), describe({ body: updateCompanySettingsBodyDoc }), async (req, res) => {
  const company = await companyService.updateCompany(req.tenantId, req.companyId, req.body, req.userId, {
    password: res.locals['closingPassword'] as string | undefined,
    actor: { userId: req.userId, userRole: req.userRole, isSuperAdmin: req.isSuperAdmin },
  });
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
      categoryFilterMode: company.categoryFilterMode,
      defaultLineEntryMode: company.defaultLineEntryMode,
      lockDate: company.lockDate,
      chatSupportEnabled: company.chatSupportEnabled,
      billDiscountAccountId: company.billDiscountAccountId ?? null,
      billableMarkupAccountId: company.billableMarkupAccountId ?? null,
    },
  });
});

// ── Intake folders (U-93, capability intake-settings-v1) ──
// The folders a desktop client watches for bills and receipts, per company.
// Reading needs company_settings view (paths are owner data), writing
// company_settings update. A PUT replaces the whole list and names the
// updatedAt it last read (null before the first save); a different stored
// value is 409 STALE (details.updatedAt), nothing changed. Not keyed by
// Idempotency-Key: a retried full replace either matches or is STALE.
const intakeSettingsResponse = z.object({
  folders: z.array(intakeFolderSchema),
  updatedAt: z.string().nullable(),
});

companyRouter.get('/intake-settings', requirePermission('company_settings', 'read'), describe({
  summary: 'Intake folders of the company (intake-settings-v1)',
  response: intakeSettingsResponse,
}), async (req, res) => {
  res.json(await intakeSettingsService.getIntakeSettings(req.tenantId, req.companyId));
});

companyRouter.put('/intake-settings', requireCompanySettingsWrite, validate(putIntakeSettingsSchema), describe({
  summary: 'Replace the intake folders of the company (409 STALE when expectedUpdatedAt no longer matches)',
  response: intakeSettingsResponse,
}), async (req, res) => {
  res.json(await intakeSettingsService.putIntakeSettings(req.tenantId, req.companyId, req.body, req.userId));
});

// ── Closing-date password (U-15, capability closing-password-v1) ──
// Status for the closing-date screen; never the hash.
companyRouter.get('/closing-password', describe({
  summary: 'Closing date and whether a closing-date password is set',
  response: z.object({
    closingDate: z.string().nullable(), setBy: z.string().nullable(),
    setAt: z.string().nullable(), closingPasswordSet: z.boolean(),
  }),
}), async (req, res) => {
  res.json(await closingPasswordService.getClosingDateStatus(req.tenantId, req.companyId));
});

// Set, change or clear (newPassword: null). With a password set the
// current one is required; setting the first one is for the owner or a
// super admin. Wrong current password: 403 CLOSING_PASSWORD_INVALID.
const closingPasswordBody = z.object({
  currentPassword: z.string().max(200).optional(),
  newPassword: z.string().max(200).nullable(),
});

companyRouter.put('/closing-password', requireCompanySettingsWrite, closingPasswordLimiter, validate(closingPasswordBody), describe({
  summary: 'Set, change or clear the closing-date password',
  response: z.object({ closingPasswordSet: z.boolean() }),
}), async (req, res) => {
  const result = await closingPasswordService.setClosingPassword(req.tenantId, req.companyId, {
    currentPassword: req.body.currentPassword,
    newPassword: req.body.newPassword,
  }, { userId: req.userId, userRole: req.userRole, isSuperAdmin: req.isSuperAdmin });
  res.json(result);
});

// Owner reset of a forgotten closing-date password (Q-239): the owner or a
// super admin re-enters their own sign-in password and clears
// (newPassword: null) or replaces it without the old one. Wrong sign-in
// password: 403 ACCOUNT_PASSWORD_INVALID; not the owner: 403
// CLOSING_PASSWORD_OWNER_REQUIRED. Rate limited with the other closing
// password routes.
const closingPasswordResetBody = z.object({
  accountPassword: z.string().min(1).max(200),
  newPassword: z.string().max(200).nullable(),
});

companyRouter.post('/closing-password/reset', requireCompanySettingsWrite, closingPasswordLimiter, validate(closingPasswordResetBody), describe({
  summary: 'Owner reset of the closing-date password (needs the caller sign-in password)',
  response: z.object({ closingPasswordSet: z.boolean() }),
}), async (req, res) => {
  const result = await closingPasswordService.resetClosingPassword(req.tenantId, req.companyId, {
    accountPassword: req.body.accountPassword,
    newPassword: req.body.newPassword,
  }, { userId: req.userId, userRole: req.userRole, isSuperAdmin: req.isSuperAdmin });
  res.json(result);
});

// ── Invoice Template (branding for generated invoices) ──
// The invoice_templates table + service pre-existed but were never exposed
// over HTTP, so /settings/invoice-template could not persist anything. These
// endpoints read/update the tenant's single default template, seeding one on
// first access so the settings page always has a row to write to.
const invoiceTemplateUpdateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Must be a 6-digit hex color').optional(),
  showShipTo: z.boolean().optional(),
  showPoNumber: z.boolean().optional(),
  showTerms: z.boolean().optional(),
  footerText: z.string().max(1000).nullable().optional(),
  logoUrl: z.string().max(500).nullable().optional(),
  // Per-type footer text (U-111, document-numbers-v1); a sent map replaces
  // the stored one. Blank, null or absent -> footerText.
  footerOverrides: z.object({
    invoice: z.string().max(1000).nullable().optional(),
    cash_sale: z.string().max(1000).nullable().optional(),
    credit_memo: z.string().max(1000).nullable().optional(),
    statement: z.string().max(1000).nullable().optional(),
  }).strict().optional(),
});

// Company scope (U-111): reads return the company's own default template,
// else the legacy tenant-wide one; the first write gives the company its own
// copy, so editing one company's footer no longer changes another's.
async function getOrCreateDefaultTemplate(tenantId: string, companyId: string) {
  let template = await invoiceTemplateService.getDefault(tenantId, companyId);
  if (!template) {
    await invoiceTemplateService.seedDefault(tenantId);
    template = await invoiceTemplateService.getDefault(tenantId, companyId);
  }
  // Templates exist but none is flagged default (legacy data): adopt the
  // first one of this company or of no company.
  if (!template) {
    const all = await invoiceTemplateService.list(tenantId);
    template = all.find((t) => t.companyId === companyId) ?? all.find((t) => t.companyId === null) ?? null;
  }
  return template;
}

const invoiceTemplateResponseDoc = z.object({
  template: z.record(z.string(), z.unknown()).nullable(),
  resolvedFooters: z.object({
    invoice: z.string(), cash_sale: z.string(), credit_memo: z.string(), statement: z.string(),
  }).describe('the footer each form type prints (override, else footerText, else the default)'),
});

companyRouter.get('/invoice-template', describe({
  summary: "The company's invoice template, with the footer each form type prints (document-numbers-v1)",
  response: invoiceTemplateResponseDoc,
}), async (req, res) => {
  const template = await getOrCreateDefaultTemplate(req.tenantId, req.companyId);
  res.json({ template, resolvedFooters: invoiceTemplateService.resolvedFooters(template) });
});

companyRouter.put('/invoice-template', requireCompanySettingsWrite, validate(invoiceTemplateUpdateSchema), describe({
  summary: "Update the company's invoice template (footerText, footerOverrides per form type) (document-numbers-v1)",
  response: invoiceTemplateResponseDoc,
}), async (req, res) => {
  const existing = await invoiceTemplateService.getOrCreateCompanyDefault(req.tenantId, req.companyId, req.userId);
  const template = await invoiceTemplateService.update(req.tenantId, existing.id, req.body, req.userId);
  res.json({ template, resolvedFooters: invoiceTemplateService.resolvedFooters(template) });
});

// ── Invoice layouts (U-130, invoice-layouts-v1) ──
// Several named print layouts per company, one the default. The
// /invoice-template routes above read and write the default layout.
const layoutColumnsSchema = z.object({
  item: z.boolean().optional(),
  description: z.boolean().optional(),
  serviceDate: z.boolean().optional(),
  quantity: z.boolean().optional(),
  rate: z.boolean().optional(),
}).strict();
const layoutFieldsSchema = invoiceTemplateUpdateSchema.omit({ name: true }).extend({
  columns: layoutColumnsSchema.optional()
    .describe('line columns the form prints (amount always prints); sent keys are laid over the stored ones'),
});
const layoutNameSchema = z.string().trim().min(1).max(100);
const createLayoutSchema = layoutFieldsSchema.extend({ name: layoutNameSchema }).strict();
const updateLayoutSchema = layoutFieldsSchema.extend({
  name: layoutNameSchema.optional(),
  expectedUpdatedAt: z.string().datetime({ offset: true }).optional()
    .describe('the layout updatedAt as last read; a mismatch is 409 STALE (details.updatedAt) and nothing changes'),
}).strict();
const layoutIdParams = z.object({ id: z.string().uuid() });
const deleteLayoutQuery = z.object({ reassignToDefault: z.enum(['true', 'false']).optional() });
const layoutDoc = z.object({
  id: z.string().uuid(), name: z.string(), isDefault: z.boolean(), accentColor: z.string(), logoUrl: z.string().nullable(),
  showShipTo: z.boolean(), showPoNumber: z.boolean(), showTerms: z.boolean(), footerText: z.string().nullable(),
  footerOverrides: z.record(z.string(), z.string().nullable()),
  columns: z.object({ item: z.boolean(), description: z.boolean(), serviceDate: z.boolean(), quantity: z.boolean(), rate: z.boolean() }),
  resolvedFooters: z.object({ invoice: z.string(), cash_sale: z.string(), credit_memo: z.string(), statement: z.string() }),
  invoiceCount: z.number().int().describe('invoices (void ones too) that print with this layout'),
  createdAt: z.string(), updatedAt: z.string(),
});
const layoutErrors = '404 INVOICE_LAYOUT_NOT_FOUND (not a layout of this company).';

function validLayoutId(id: string | undefined): string {
  if (!id || !layoutIdParams.safeParse({ id }).success) throw new AppError(404, 'Invoice layout not found', 'INVOICE_LAYOUT_NOT_FOUND');
  return id;
}

companyRouter.get('/invoice-layouts', describe({
  summary: "The company's invoice layouts, default first (invoice-layouts-v1)",
  description: 'Response {data: [layout]}. A company without layouts gets its default one ("Standard", a copy of the template it printed with) on first read.',
  response: z.object({ data: z.array(layoutDoc) }),
}), async (req, res) => {
  res.json({ data: await invoiceTemplateService.listLayouts(req.tenantId, req.companyId, req.userId) });
});

companyRouter.post('/invoice-layouts', requireCompanySettingsWrite, validate(createLayoutSchema), describe({
  summary: 'Create an invoice layout (invoice-layouts-v1)',
  description: 'Response 201 {layout}; never the default. Omitted options copy the default layout. 409 INVOICE_LAYOUT_NAME_IN_USE (names are unique in the company, any case).',
  body: createLayoutSchema,
  response: z.object({ layout: layoutDoc }),
}), async (req, res) => {
  const layout = await invoiceTemplateService.createLayout(req.tenantId, req.companyId, req.body, req.userId);
  res.status(201).json({ layout });
});

companyRouter.get('/invoice-layouts/:id', describe({
  summary: 'Get an invoice layout (invoice-layouts-v1)',
  description: `Response {layout}. ${layoutErrors}`,
  params: layoutIdParams,
  response: z.object({ layout: layoutDoc }),
}), async (req, res) => {
  res.json({ layout: await invoiceTemplateService.getLayout(req.tenantId, req.companyId, validLayoutId(req.params['id'])) });
});

companyRouter.put('/invoice-layouts/:id', requireCompanySettingsWrite, validate(updateLayoutSchema), describe({
  summary: 'Edit an invoice layout (invoice-layouts-v1)',
  description: 'Response {layout}. Omitted fields keep their values; a footerOverrides map replaces the stored one. '
    + `409 STALE, 409 INVOICE_LAYOUT_NAME_IN_USE. ${layoutErrors}`,
  body: updateLayoutSchema,
  params: layoutIdParams,
  response: z.object({ layout: layoutDoc }),
}), async (req, res) => {
  const layout = await invoiceTemplateService.updateLayout(req.tenantId, req.companyId, validLayoutId(req.params['id']), req.body, req.userId);
  res.json({ layout });
});

companyRouter.post('/invoice-layouts/:id/default', requireCompanySettingsWrite, describe({
  summary: 'Make an invoice layout the company default (invoice-layouts-v1)',
  description: `Response {layout}. Invoices without their own layout print with it; GET/PUT /company/invoice-template read and write it. ${layoutErrors}`,
  params: layoutIdParams,
  response: z.object({ layout: layoutDoc }),
}), async (req, res) => {
  res.json({ layout: await invoiceTemplateService.setDefaultLayout(req.tenantId, req.companyId, validLayoutId(req.params['id']), req.userId) });
});

companyRouter.delete('/invoice-layouts/:id', requireCompanySettingsWrite, describe({
  summary: 'Delete an invoice layout (invoice-layouts-v1)',
  description: 'Response 200 {reassignedCount}. 409 INVOICE_LAYOUT_IS_DEFAULT (make another the default first). A layout invoices print with (void ones too) '
    + 'is 409 INVOICE_LAYOUT_IN_USE (details.invoiceCount) unless ?reassignToDefault=true: those invoices then print with the default layout '
    + `(layoutId null; their updatedAt is kept). ${layoutErrors}`,
  params: layoutIdParams,
  query: deleteLayoutQuery,
  response: z.object({ reassignedCount: z.number().int() }),
}), async (req, res) => {
  const q = deleteLayoutQuery.safeParse(req.query);
  if (!q.success) throw AppError.badRequest('reassignToDefault must be true or false', 'VALIDATION_ERROR');
  const result = await invoiceTemplateService.deleteLayout(req.tenantId, req.companyId, validLayoutId(req.params['id']),
    { reassignToDefault: q.data.reassignToDefault === 'true' }, req.userId);
  res.json(result);
});

companyRouter.get('/smtp', async (req, res) => {
  const smtp = await companyService.getSmtpSettings(req.tenantId, req.companyId);
  res.json(smtp);
});

companyRouter.put('/smtp', requireCompanySettingsWrite, validate(companySmtpUpdateSchema), async (req, res) => {
  await companyService.updateSmtpSettings(req.tenantId, req.companyId, req.body, req.userId);
  res.json({ message: 'SMTP settings saved' });
});

companyRouter.post('/smtp/test', requireCompanySettingsWrite, validate(companySmtpTestSchema), async (req, res) => {
  const result = await testSmtpConnection(req.body, req.body.testEmail);
  res.json(result);
});

companyRouter.post('/setup-complete', requireCompanySettingsWrite, async (req, res) => {
  await companyService.markSetupComplete(req.tenantId, req.companyId);
  res.json({ message: 'Setup complete' });
});

// ─── Team Management ────────────────────────────────────────

companyRouter.get('/users', async (req, res) => {
  const users = await authService.listTenantUsers(req.tenantId);
  const sanitized = users.map((u) => ({
    id: u.id, email: u.email, displayName: u.displayName, role: u.role, userType: u.userType,
    isActive: u.isActive, lastLoginAt: u.lastLoginAt, createdAt: u.createdAt,
    // Login lockout state, so the Team page can show it and offer Unlock.
    isLocked: u.isLocked, loginFailedAttempts: u.loginFailedAttempts,
    // Peer screen share per-user override (D9); tri-state, null = inherit.
    shareAllowed: u.shareAllowed ?? null,
  }));
  res.json({ users: sanitized });
});

// Team management is owner-parity: the tenant owner, a super admin, or a
// firm member holding the `team_management` access right on this tenant
// (middleware/firm-capabilities.ts). Service-level guards (last owner,
// no self role change) apply to all of them alike.
const requireTeamManagement = requireTenantCapability('team_management', 'Only owners can manage users');

companyRouter.post('/invite-user', requireTeamManagement, validate(inviteUserSchema), async (req, res) => {
  const { email, displayName, role, userType } = req.body;
  // External (client) users default to a view-only baseline until the owner
  // applies a permission template; internal staff default to accountant.
  const resolvedRole = role || (userType === 'client' ? 'readonly' : 'accountant');
  const result = await authService.inviteUser(req.tenantId, { email, displayName, role: resolvedRole, userType }, req.userId);
  res.status(201).json({
    user: {
      id: result.user.id,
      email: result.user.email,
      displayName: result.user.displayName,
      role: result.existingUser ? resolvedRole : result.user.role,
      userType: result.user.userType === 'client' ? 'client' : 'staff',
    },
    temporaryPassword: result.temporaryPassword,
    existingUser: result.existingUser,
    message: result.existingUser ? 'Existing user granted access to this tenant' : 'New user created',
  });
});

companyRouter.patch('/users/:userId', requireTeamManagement, validate(updateUserSchema), async (req, res) => {
  const { email, displayName, role } = req.body;
  const user = await authService.updateUser(req.tenantId, req.params['userId']!, { email, displayName, role }, req.userId);
  res.json({
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      // user.role is the HOME-tenant role; echo the tenant-effective value
      // when this request changed it.
      role: role ?? user.role,
      userType: user.userType === 'client' ? 'client' : 'staff',
    },
  });
});

companyRouter.post('/users/:userId/deactivate', requireTeamManagement, async (req, res) => {
  await authService.deactivateUser(req.tenantId, req.params['userId']!);
  res.json({ message: 'User deactivated' });
});

companyRouter.post('/users/:userId/reactivate', requireTeamManagement, async (req, res) => {
  await authService.reactivateUser(req.tenantId, req.params['userId']!);
  res.json({ message: 'User reactivated' });
});

// Clear a login lockout. Lockouts are admin-release-only by design (there
// is no wait-it-out window), so without this an owner had to call the
// super-admin endpoint or edit the database to let a locked-out teammate
// back in. Tenant-scoped: the target must be on this tenant's team.
companyRouter.post('/users/:userId/unlock', requireTeamManagement, async (req, res) => {
  const result = await authService.unlockUserForTenant(req.tenantId, req.params['userId']!, req.userId);
  res.json({
    message: result.wasLocked
      ? `${result.email} can sign in again`
      : `${result.email} was not locked; failed-attempt count cleared`,
    ...result,
  });
});

// Email the user a password-reset link (same flow as self-service
// forgot-password). Never reveals or sets a password server-side.
companyRouter.post('/users/:userId/send-password-reset', requireTeamManagement, async (req, res) => {
  const result = await authService.sendPasswordReset(req.tenantId, req.params['userId']!, req.userId);
  res.json({ message: `Password reset email sent to ${result.email}` });
});

// ─── Permission Templates & Per-User Permissions ────────────
// Owner-parity (team_management). Templates are named, reusable access
// sets; per-user permissions assign a template + overrides. Bookkeepers and
// external (client) users consult these at enforcement time (see
// permission.service).

const requirePermissionAdmin = requireTenantCapability('team_management', 'Only owners can manage permissions');

companyRouter.get('/permission-templates', requirePermissionAdmin, async (req, res) => {
  const templates = await permissionService.listTemplates(req.tenantId);
  res.json({ templates });
});

companyRouter.post('/permission-templates', requirePermissionAdmin, validate(createPermissionTemplateSchema), async (req, res) => {
  const template = await permissionService.createTemplate(req.tenantId, req.body, req.userId);
  res.status(201).json({ template });
});

companyRouter.put('/permission-templates/:id', requirePermissionAdmin, validate(updatePermissionTemplateSchema), async (req, res) => {
  const template = await permissionService.updateTemplate(req.tenantId, req.params['id']!, req.body, req.userId);
  res.json({ template });
});

companyRouter.delete('/permission-templates/:id', requirePermissionAdmin, async (req, res) => {
  await permissionService.deleteTemplate(req.tenantId, req.params['id']!, req.userId);
  res.json({ message: 'Template deleted' });
});

companyRouter.get('/users/:userId/permissions', requirePermissionAdmin, async (req, res) => {
  const row = await permissionService.getUserPermissionRow(req.tenantId, req.params['userId']!);
  res.json({ permissions: row });
});

companyRouter.put('/users/:userId/permissions', requirePermissionAdmin, validate(setUserPermissionsSchema), async (req, res) => {
  const row = await permissionService.setUserPermissions(req.tenantId, req.params['userId']!, req.body, req.userId);
  res.json({ permissions: row });
});

// ── Stripe Settings ──

companyRouter.get('/stripe', async (req, res) => {
  const { getStripeConfig } = await import('../services/stripe.service.js');
  const config = await getStripeConfig(req.tenantId, req.companyId);
  res.json(config);
});

// Owner-parity via the `integrations_payments` access right.
const requirePaymentsAdmin = requireTenantCapability('integrations_payments', 'Only owners can configure payment settings');

companyRouter.put('/stripe', requirePaymentsAdmin, async (req, res) => {
  const { stripeConfigSchema } = await import('@kis-books/shared');
  const parsed = stripeConfigSchema.parse(req.body);
  const { configureStripe } = await import('../services/stripe.service.js');
  await configureStripe(req.tenantId, req.companyId, parsed);
  res.json({ message: 'Stripe configured', onlinePaymentsEnabled: true });
});

companyRouter.delete('/stripe', requirePaymentsAdmin, async (req, res) => {
  const { removeStripeConfig } = await import('../services/stripe.service.js');
  await removeStripeConfig(req.tenantId, req.companyId);
  res.json({ message: 'Stripe configuration removed', onlinePaymentsEnabled: false });
});

// Delete an additional company. Registered last so the '/:id' param route does
// not shadow the named routes above. Owner-only; guarded server-side against
// deleting the last company or one with real activity.
companyRouter.delete('/:id', async (req, res) => {
  if (req.userRole !== 'owner' && !req.isSuperAdmin) throw AppError.forbidden('Only owners can delete companies');
  const result = await companyService.deleteCompany(req.tenantId, req.params['id']!, req.userId);
  res.json(result);
});
