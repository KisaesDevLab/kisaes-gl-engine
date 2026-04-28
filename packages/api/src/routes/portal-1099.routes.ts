// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { AppError } from '../utils/errors.js';
import { baseUrlFor } from '../utils/base-url.js';
import * as svc from '../services/portal-1099.service.js';
import { FORM_1099_BOXES, type FormBox } from '../services/portal-1099.boxes.js';

// VIBE_MYBOOKS_PRACTICE_BUILD_PLAN Phase 14 + 15.

export const portal1099Router = Router();
portal1099Router.use(authenticate);
portal1099Router.use((req, _res, next) => {
  if (req.userType === 'client') throw AppError.notFound('Feature not available');
  if (req.userRole === 'readonly' && req.method !== 'GET') {
    throw AppError.forbidden('Read-only role cannot manage 1099 data');
  }
  next();
});

portal1099Router.get('/summary', async (req, res) => {
  const taxYear = parseInt((req.query['taxYear'] as string) ?? `${new Date().getUTCFullYear()}`, 10);
  const data = await svc.summary(req.tenantId, taxYear);
  res.json(data);
});

portal1099Router.get('/vendors', async (req, res) => {
  const taxYear = parseInt((req.query['taxYear'] as string) ?? `${new Date().getUTCFullYear()}`, 10);
  const list = await svc.listVendors(req.tenantId, taxYear);
  res.json({ vendors: list });
});

portal1099Router.get('/vendors/:contactId/profile', async (req, res) => {
  const profile = await svc.getProfile(req.tenantId, req.params['contactId']!);
  res.json({ profile });
});

const profileSchema = z.object({
  is1099Eligible: z.boolean().optional(),
  form1099Type: z.enum(['NEC', 'MISC', 'K']).nullable().optional(),
  exemptPayeeCode: z.string().max(10).nullable().optional(),
  tin: z.string().max(20).nullable().optional(),
  tinType: z.enum(['SSN', 'EIN']).nullable().optional(),
  backupWithholding: z.boolean().optional(),
  notes: z.string().max(2000).nullable().optional(),
  mailingAddress: z
    .union([
      z.null(),
      z.object({
        line1: z.string().max(255).nullable(),
        city: z.string().max(100).nullable(),
        state: z.string().max(50).nullable(),
        zip: z.string().max(20).nullable(),
      }),
    ])
    .optional(),
});

portal1099Router.put('/vendors/:contactId/profile', validate(profileSchema), async (req, res) => {
  await svc.updateProfile(req.tenantId, req.params['contactId']!, req.userId, req.body);
  res.json({ ok: true });
});

portal1099Router.post('/vendors/:contactId/apply-w9-address', async (req, res) => {
  await svc.applyW9AddressToContact(req.tenantId, req.userId, req.params['contactId']!);
  res.json({ ok: true });
});

const excludeSchema = z.object({
  reason: z.enum([
    'corporation',
    'foreign',
    'reimbursement_only',
    'tax_exempt',
    'employee',
    'other',
  ]),
  note: z.string().max(2000).optional(),
});

portal1099Router.post('/vendors/:contactId/exclude', validate(excludeSchema), async (req, res) => {
  await svc.setExclusion(
    req.tenantId,
    req.userId,
    req.params['contactId']!,
    req.body.reason,
    req.body.note,
  );
  res.json({ ok: true });
});

portal1099Router.delete('/vendors/:contactId/exclude', async (req, res) => {
  await svc.clearExclusion(req.tenantId, req.userId, req.params['contactId']!);
  res.json({ ok: true });
});

// At least one of email/phone is required — Zod's refine() captures
// the cross-field rule. Phone is loosely validated (digits + the
// usual separators) so US-domestic and E.164 forms both pass; the
// SMS provider will reject anything malformed at send time.
const requestW9Schema = z
  .object({
    contactId: z.string().uuid(),
    email: z.string().email().max(320).optional(),
    phone: z
      .string()
      .max(30)
      .regex(/^[+\d][\d\s().-]{6,}$/, 'Phone number looks invalid')
      .optional(),
    message: z.string().max(2000).optional(),
  })
  .refine((v) => !!v.email || !!v.phone, {
    message: 'Provide an email address, a phone number, or both',
    path: ['email'],
  });

portal1099Router.post('/w9-requests', validate(requestW9Schema), async (req, res) => {
  const result = await svc.requestW9({
    tenantId: req.tenantId,
    bookkeeperUserId: req.userId,
    contactId: req.body.contactId,
    email: req.body.email,
    phone: req.body.phone,
    message: req.body.message,
    baseUrl: baseUrlFor(req),
  });
  res.status(201).json(result);
});

portal1099Router.get('/vendors/:contactId/w9-requests', async (req, res) => {
  const requests = await svc.listRequestsForContact(req.tenantId, req.params['contactId']!);
  res.json({ requests });
});

portal1099Router.get('/vendors/:contactId/w9', async (req, res) => {
  const { stream, fileName, mimeType } = await svc.getW9Document(
    req.tenantId,
    req.params['contactId']!,
  );
  res.set('Content-Type', mimeType);
  res.set('Content-Disposition', `inline; filename="${fileName.replace(/"/g, '')}"`);
  stream.pipe(res);
});

portal1099Router.get('/threshold-hits', async (req, res) => {
  const taxYear = parseInt((req.query['taxYear'] as string) ?? `${new Date().getUTCFullYear()}`, 10);
  const hits = await svc.scanThresholds(req.tenantId, taxYear);
  res.json({ hits });
});

const exportSchema = z.object({
  taxYear: z.number().int().min(2000).max(2099),
  formType: z.enum(['1099-NEC', '1099-MISC']),
});

portal1099Router.post('/export', validate(exportSchema), async (req, res) => {
  if (req.userRole !== 'owner') throw AppError.forbidden('Owner role required to export filings');
  const result = await svc.exportFiling(req.tenantId, req.userId, req.body);
  res.set('Content-Type', 'application/json');
  res.json(result);
});

portal1099Router.get('/filings', async (req, res) => {
  const list = await svc.listFilings(req.tenantId);
  res.json({ filings: list });
});

portal1099Router.get('/filings/:filingId', async (req, res) => {
  const result = await svc.getFilingDetails(req.tenantId, req.params['filingId']!);
  res.json(result);
});

const correctionSchema = z.object({
  originalFilingId: z.string().uuid(),
  adjustments: z
    .array(
      z.object({
        contactId: z.string().uuid(),
        type: z.enum(['C', 'G']),
        newAmount: z.number().nonnegative().optional(),
      }),
    )
    .min(1),
  notes: z.string().max(2000).optional(),
});

portal1099Router.post('/corrections', validate(correctionSchema), async (req, res) => {
  if (req.userRole !== 'owner') {
    throw AppError.forbidden('Owner role required to file corrections');
  }
  const result = await svc.exportCorrection(req.tenantId, req.userId, req.body);
  res.status(201).json(result);
});

// 15.5 — IRS Bulk TIN Matching (Pub 2108A). Operator-driven
// 2-step flow: download .txt → upload to IRS e-Services → upload
// the IRS result file back here.
portal1099Router.post('/tin-match/export', async (req, res) => {
  const result = await svc.exportBulkTinMatch(req.tenantId, req.userId);
  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${result.fileName}"`);
  res.set('X-Vibe-Record-Count', String(result.recordCount));
  res.set('X-Vibe-Skipped-Count', String(result.skipped.length));
  // Body is the raw file; the skipped-vendor list ships as a JSON
  // header so the UI can surface it without a second round-trip.
  if (result.skipped.length > 0) {
    res.set(
      'X-Vibe-Skipped',
      Buffer.from(JSON.stringify(result.skipped), 'utf8').toString('base64'),
    );
  }
  res.send(result.body);
});

const tinImportSchema = z.object({
  // The .txt file is small (max ~8MB at 100k rows × 80B). Take it as
  // a JSON-wrapped string so the existing express.json() pipeline +
  // CSRF / cache-control headers apply uniformly with the rest of
  // /api/v1.
  content: z.string().min(1).max(20 * 1024 * 1024),
});

portal1099Router.post('/tin-match/import', validate(tinImportSchema), async (req, res) => {
  const result = await svc.importBulkTinMatchResults(
    req.tenantId,
    req.userId,
    req.body.content,
  );
  res.json(result);
});

// ── account → (form, box) mapping ───────────────────────────────
//
// Three endpoints power the 1099 Center mapping panel:
//   GET    /account-mappings           — grouped view + unmapped list
//   PUT    /account-mappings/:formBox  — replace the set under one box
//   DELETE /account-mappings/:accountId — single-account clear
//
// The closed enum of accepted form_box values lives in
// portal-1099.boxes.ts; the catalog is built into the Zod schema
// below so an unknown box value 400s before reaching the service.

const formBoxValues = FORM_1099_BOXES.map((b) => b.value) as [FormBox, ...FormBox[]];
const formBoxParamSchema = z.enum(formBoxValues);

const accountMappingBodySchema = z.object({
  accountIds: z.array(z.string().uuid()).max(500),
});

portal1099Router.get('/account-mappings', async (req, res) => {
  const view = await svc.listAccountMappings(req.tenantId);
  res.json(view);
});

portal1099Router.put(
  '/account-mappings/:formBox',
  validate(accountMappingBodySchema),
  async (req, res) => {
    const parsedBox = formBoxParamSchema.safeParse(req.params['formBox']);
    if (!parsedBox.success) {
      throw AppError.badRequest('Unknown form/box');
    }
    await svc.setAccountMappings(
      req.tenantId,
      req.userId,
      parsedBox.data,
      req.body.accountIds,
    );
    res.json({ ok: true });
  },
);

portal1099Router.delete('/account-mappings/:accountId', async (req, res) => {
  const accountId = req.params['accountId'];
  if (!accountId || !/^[0-9a-f-]{36}$/i.test(accountId)) {
    throw AppError.badRequest('Invalid account id');
  }
  await svc.clearAccountMapping(req.tenantId, req.userId, accountId);
  res.json({ ok: true });
});
