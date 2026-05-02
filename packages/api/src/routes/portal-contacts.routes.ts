// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { AppError } from '../utils/errors.js';
import * as svc from '../services/portal-contact.service.js';
import * as portalAuth from '../services/portal-auth.service.js';
import { PORTAL_PREVIEW_COOKIE } from '../middleware/portal-auth.js';
import { resolvedSecure, appendSetCookie } from '../utils/cookie-secure.js';

// VIBE_MYBOOKS_PRACTICE_BUILD_PLAN Phase 8 — bookkeeper-side
// portal-contact admin endpoints. Mounted at /api/v1/practice/portal/...

export const portalContactsRouter = Router();

portalContactsRouter.use(authenticate);

// Block client user_type from every endpoint here — these are firm-side
// admin endpoints, not portal endpoints (those will live under /portal in Phase 9).
portalContactsRouter.use((req, _res, next) => {
  if (req.userType === 'client') {
    throw AppError.notFound('Feature not available');
  }
  if (req.userRole === 'readonly') {
    // Read-only staff may GET but not mutate; gate per-method below.
    if (req.method !== 'GET') {
      throw AppError.forbidden('Read-only role cannot manage portal contacts');
    }
  }
  next();
});

const companyAssignmentSchema = z.object({
  companyId: z.string().uuid(),
  role: z.string().max(40).optional(),
  assignable: z.boolean().optional(),
  financialsAccess: z.boolean().optional(),
  filesAccess: z.boolean().optional(),
  questionsForUsAccess: z.boolean().optional(),
});

const createContactSchema = z.object({
  email: z.string().email().max(320),
  phone: z.string().max(30).nullable().optional(),
  firstName: z.string().max(120).nullable().optional(),
  lastName: z.string().max(120).nullable().optional(),
  companies: z.array(companyAssignmentSchema).min(1),
});

const updateContactSchema = z.object({
  email: z.string().email().max(320).optional(),
  phone: z.string().max(30).nullable().optional(),
  firstName: z.string().max(120).nullable().optional(),
  lastName: z.string().max(120).nullable().optional(),
  status: z.enum(['active', 'paused']).optional(),
});

const setAssignmentsSchema = z.object({
  companies: z.array(companyAssignmentSchema),
});

portalContactsRouter.get('/contacts', async (req, res) => {
  const { status, companyId } = req.query as Record<string, string | undefined>;
  const validStatus = ['active', 'paused', 'deleted', 'all'] as const;
  const statusArg = status && (validStatus as readonly string[]).includes(status)
    ? (status as 'active' | 'paused' | 'deleted' | 'all')
    : 'active';
  const list = await svc.listContacts(req.tenantId, { status: statusArg, companyId });
  res.json({ contacts: list });
});

portalContactsRouter.get('/contacts/:id', async (req, res) => {
  const contact = await svc.getContact(req.tenantId, req.params['id']!);
  res.json({ contact });
});

portalContactsRouter.post('/contacts', validate(createContactSchema), async (req, res) => {
  const result = await svc.createContact(req.tenantId, req.body, req.userId);
  res.status(201).json(result);
});

portalContactsRouter.put('/contacts/:id', validate(updateContactSchema), async (req, res) => {
  await svc.updateContact(req.tenantId, req.params['id']!, req.body, req.userId);
  res.json({ ok: true });
});

portalContactsRouter.delete('/contacts/:id', async (req, res) => {
  await svc.softDeleteContact(req.tenantId, req.params['id']!, req.userId);
  res.json({ ok: true });
});

portalContactsRouter.put(
  '/contacts/:id/companies',
  validate(setAssignmentsSchema),
  async (req, res) => {
    await svc.setCompanyAssignments(req.tenantId, req.params['id']!, req.body.companies, req.userId);
    res.json({ ok: true });
  },
);

const csvImportSchema = z.object({
  rows: z.array(
    z.object({
      email: z.string(),
      phone: z.string().optional(),
      firstName: z.string().optional(),
      lastName: z.string().optional(),
      companyIds: z.array(z.string().uuid()).default([]),
      role: z.string().max(40).optional(),
    }),
  ).min(1).max(500),
});

portalContactsRouter.post('/contacts/import', validate(csvImportSchema), async (req, res) => {
  const result = await svc.bulkImport(req.tenantId, req.body.rows, req.userId);
  res.json(result);
});

// ── Practice & company portal settings (8.3) ─────────────────────

const updatePracticeSettingsSchema = z.object({
  remindersEnabled: z.boolean().optional(),
  reminderCadenceDays: z.array(z.number().int().min(1).max(365)).optional(),
  openTrackingEnabled: z.boolean().optional(),
  assignableQuestionsEnabled: z.boolean().optional(),
  customDomain: z.string().max(253).nullable().optional(),
  brandingLogoUrl: z.string().max(2048).nullable().optional(),
  brandingPrimaryColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/)
    .nullable()
    .optional(),
  announcementText: z.string().max(2000).nullable().optional(),
  announcementEnabled: z.boolean().optional(),
  previewEnabled: z.boolean().optional(),
  previewAllowedRoles: z.array(z.string()).optional(),
});

portalContactsRouter.get('/settings/practice', async (req, res) => {
  const settings = await svc.getPracticeSettings(req.tenantId);
  res.json({ settings });
});

portalContactsRouter.put(
  '/settings/practice',
  validate(updatePracticeSettingsSchema),
  async (req, res) => {
    if (req.userRole !== 'owner') {
      throw AppError.forbidden('Owner role required to change portal settings');
    }
    const settings = await svc.updatePracticeSettings(req.tenantId, req.body, req.userId);
    res.json({ settings });
  },
);

const updateCompanySettingsSchema = z.object({
  remindersEnabled: z.boolean().nullable().optional(),
  reminderCadenceDays: z.array(z.number().int().min(1).max(365)).nullable().optional(),
  assignableQuestionsEnabled: z.boolean().nullable().optional(),
  financialsAccessDefault: z.boolean().nullable().optional(),
  filesAccessDefault: z.boolean().nullable().optional(),
  previewRequireReauth: z.boolean().optional(),
  paused: z.boolean().optional(),
});

portalContactsRouter.get('/settings/company/:companyId', async (req, res) => {
  const settings = await svc.getCompanySettings(req.tenantId, req.params['companyId']!);
  res.json({ settings });
});

portalContactsRouter.put(
  '/settings/company/:companyId',
  validate(updateCompanySettingsSchema),
  async (req, res) => {
    if (req.userRole === 'readonly') {
      throw AppError.forbidden('Read-only role cannot change portal settings');
    }
    const settings = await svc.updateCompanySettings(
      req.tenantId,
      req.params['companyId']!,
      req.body,
      req.userId,
    );
    res.json({ settings });
  },
);

// 8.4 — start/end a "View as Client" preview session. The start
// returns a redirect URL the bookkeeper opens in a new tab; the
// JWT preview token is set as an httpOnly cookie.
const startPreviewSchema = z.object({
  contactId: z.string().uuid(),
  companyId: z.string().uuid(),
  origin: z.enum(['contact_detail', 'contact_list', 'close_page', 'question_view']),
});

portalContactsRouter.post('/preview/start', validate(startPreviewSchema), async (req, res) => {
  const result = await portalAuth.startPreview({
    initiatingUserId: req.userId,
    initiatingUserRole: req.userRole,
    tenantId: req.tenantId,
    contactId: req.body.contactId,
    companyId: req.body.companyId,
    origin: req.body.origin,
  });
  // Same emergency-access-friendly cookie shape as portal-auth.routes.ts.
  const maxAgeSec = Math.max(0, Math.floor((result.expiresAt.getTime() - Date.now()) / 1000));
  const cookieParts = [
    `${PORTAL_PREVIEW_COOKIE}=${encodeURIComponent(result.token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
  ];
  if (resolvedSecure()) cookieParts.push('Secure');
  appendSetCookie(res, cookieParts.join('; '));
  res.json({
    redirectUrl: '/portal/',
    expiresAt: result.expiresAt.toISOString(),
    previewSessionId: result.previewSessionId,
  });
});

portalContactsRouter.post('/preview/end', async (req, res) => {
  const id = (req.body?.previewSessionId ?? '') as string;
  if (id) {
    await portalAuth.endPreview(id, req.userId);
  }
  res.setHeader(
    'Set-Cookie',
    `${PORTAL_PREVIEW_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
  );
  res.json({ ok: true });
});
