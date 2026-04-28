// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { Router } from 'express';
import { eq, and } from 'drizzle-orm';
import {
  assignTenantToFirmSchema,
  createFirmSchema,
  createFirmTagTemplateSchema,
  inviteFirmUserSchema,
  updateFirmSchema,
  updateFirmTagTemplateSchema,
  updateFirmUserSchema,
  upsertTagBindingSchema,
} from '@kis-books/shared';
import { authenticate, requireSuperAdmin } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { resolveFirmFromPath, requireFirmAdmin } from '../middleware/firm-access.js';
import { auditLog } from '../middleware/audit.js';
import { AppError } from '../utils/errors.js';
import { db } from '../db/index.js';
import { userTenantAccess } from '../db/schema/index.js';
import * as firmsService from '../services/firms.service.js';
import * as firmUsersService from '../services/firm-users.service.js';
import * as tenantFirmAssignmentService from '../services/tenant-firm-assignment.service.js';
import * as tagTemplatesService from '../services/firm-tag-templates.service.js';

// 3-tier rules plan, Phase 1 — firms management API.
// Mount at `/api/v1/firms`. Composes `authenticate` for every
// request; per-route gates layer on `requireSuperAdmin`,
// `resolveFirmFromPath`, and `requireFirmAdmin`.

export const firmsRouter = Router();

firmsRouter.use(authenticate);

// ─── Firm collection ─────────────────────────────────────────

// List firms the caller is a member of. Super-admins get every
// firm; everyone else gets only the firms they have a
// `firm_users` row in.
firmsRouter.get('/', async (req, res) => {
  const firms = req.isSuperAdmin
    ? await firmsService.listAll()
    : await firmsService.listForUser(req.userId);
  res.json({ firms });
});

// Create a firm — super-admin only. The creator is auto-added as
// `firm_admin`.
firmsRouter.post('/', requireSuperAdmin, validate(createFirmSchema), async (req, res) => {
  const firm = await firmsService.create(req.body, req.userId);
  await firmUsersService.addCreatorAsAdmin(firm.id, req.userId);
  await auditLog(
    // No tenant context for firm-level resources; pass the
    // creator's tenant for traceability — auditLog requires a
    // tenant id.
    req.tenantId,
    'create',
    'firm',
    firm.id,
    null,
    { name: firm.name, slug: firm.slug },
    req.userId,
  );
  res.status(201).json(firm);
});

// ─── Firm scoped routes ──────────────────────────────────────
// Every route below resolves the path firm and sets req.firmId /
// req.firmRole.
firmsRouter.use('/:firmId', resolveFirmFromPath());

firmsRouter.get('/:firmId', async (req, res) => {
  const firm = await firmsService.getById(req.firmId!);
  res.json(firm);
});

firmsRouter.patch(
  '/:firmId',
  requireFirmAdmin,
  validate(updateFirmSchema),
  async (req, res) => {
    const before = await firmsService.getById(req.firmId!);
    const after = await firmsService.update(req.firmId!, req.body);
    await auditLog(
      req.tenantId,
      'update',
      'firm',
      after.id,
      { name: before.name, slug: before.slug, isActive: before.isActive },
      { name: after.name, slug: after.slug, isActive: after.isActive },
      req.userId,
    );
    res.json(after);
  },
);

firmsRouter.delete('/:firmId', requireSuperAdmin, async (req, res) => {
  // Active tenant assignments would block the cascade (FK ON
  // DELETE RESTRICT); surface a 409 with the count so the admin
  // un-assigns first.
  const assignments = await tenantFirmAssignmentService.listForFirm(req.firmId!);
  const active = assignments.filter((a) => a.isActive);
  if (active.length > 0) {
    throw AppError.conflict(
      `Cannot delete firm: ${active.length} active tenant assignment(s) remain. Un-assign tenants first.`,
      'FIRM_HAS_ACTIVE_ASSIGNMENTS',
      { activeAssignments: active.length },
    );
  }
  const before = await firmsService.getById(req.firmId!);
  await firmsService.remove(req.firmId!);
  await auditLog(
    req.tenantId,
    'delete',
    'firm',
    before.id,
    { name: before.name },
    null,
    req.userId,
  );
  res.json({ deleted: true });
});

// ─── Firm staff management ───────────────────────────────────

firmsRouter.get('/:firmId/users', async (req, res) => {
  const users = await firmUsersService.listForFirm(req.firmId!);
  res.json({ users });
});

firmsRouter.post(
  '/:firmId/users',
  requireFirmAdmin,
  validate(inviteFirmUserSchema),
  async (req, res) => {
    const member = await firmUsersService.invite(req.firmId!, req.body);
    await auditLog(
      req.tenantId,
      'create',
      'firm_user',
      member.id,
      null,
      { firmId: req.firmId, userId: member.userId, firmRole: member.firmRole },
      req.userId,
    );
    res.status(201).json(member);
  },
);

firmsRouter.patch(
  '/:firmId/users/:firmUserId',
  requireFirmAdmin,
  validate(updateFirmUserSchema),
  async (req, res) => {
    const after = await firmUsersService.updateMembership(
      req.firmId!,
      req.params['firmUserId']!,
      req.body,
    );
    await auditLog(
      req.tenantId,
      'update',
      'firm_user',
      after.id,
      null,
      { firmRole: after.firmRole, isActive: after.isActive },
      req.userId,
    );
    res.json(after);
  },
);

firmsRouter.delete(
  '/:firmId/users/:firmUserId',
  requireFirmAdmin,
  async (req, res) => {
    await firmUsersService.remove(req.firmId!, req.params['firmUserId']!);
    await auditLog(
      req.tenantId,
      'delete',
      'firm_user',
      req.params['firmUserId']!,
      null,
      null,
      req.userId,
    );
    res.json({ deleted: true });
  },
);

// ─── Tenant assignment ──────────────────────────────────────

firmsRouter.get('/:firmId/tenants', async (req, res) => {
  const assignments = await tenantFirmAssignmentService.listForFirm(req.firmId!);
  res.json({ assignments });
});

// Assign a tenant to this firm. Requires:
//   - firm_admin on this firm (covered by requireFirmAdmin)
//   - accountant or owner role on the target tenant via
//     user_tenant_access (the caller must have authority to
//     "give" the tenant to the firm)
firmsRouter.post(
  '/:firmId/tenants',
  requireFirmAdmin,
  validate(assignTenantToFirmSchema),
  async (req, res) => {
    const callerTenantAccess = await db.query.userTenantAccess.findFirst({
      where: and(
        eq(userTenantAccess.userId, req.userId),
        eq(userTenantAccess.tenantId, req.body.tenantId),
        eq(userTenantAccess.isActive, true),
      ),
    });
    const isPrivilegedOnTarget =
      req.isSuperAdmin ||
      (callerTenantAccess !== undefined &&
        ['accountant', 'owner'].includes(callerTenantAccess.role));
    if (!isPrivilegedOnTarget) {
      throw AppError.forbidden(
        'You must be the owner or accountant on the target tenant to assign it to a firm',
        'INSUFFICIENT_TENANT_ROLE',
      );
    }
    const assignment = await tenantFirmAssignmentService.assignTenant(
      req.firmId!,
      req.body,
      req.userId,
    );
    await auditLog(
      req.body.tenantId,
      'create',
      'tenant_firm_assignment',
      assignment.id,
      null,
      { firmId: req.firmId, tenantId: assignment.tenantId, force: req.body.force },
      req.userId,
    );
    res.status(201).json(assignment);
  },
);

firmsRouter.delete(
  '/:firmId/tenants/:tenantId',
  requireFirmAdmin,
  async (req, res) => {
    await tenantFirmAssignmentService.unassignTenant(
      req.firmId!,
      req.params['tenantId']!,
    );
    await auditLog(
      req.params['tenantId']!,
      'delete',
      'tenant_firm_assignment',
      req.params['tenantId']!,
      null,
      null,
      req.userId,
    );
    res.json({ unassigned: true });
  },
);

// ─── Tag templates (Phase 7) ─────────────────────────────────
//
// Firm-level catalog of semantic tag keys + per-tenant bindings
// that map a key to a tenant-local tags.id. Read endpoints are
// open to any firm member; mutating endpoints require firm_admin.

firmsRouter.get('/:firmId/tag-templates', async (req, res) => {
  const templates = await tagTemplatesService.listTemplates(req.firmId!);
  res.json({ templates });
});

firmsRouter.post(
  '/:firmId/tag-templates',
  requireFirmAdmin,
  validate(createFirmTagTemplateSchema),
  async (req, res) => {
    const tpl = await tagTemplatesService.createTemplate(req.firmId!, req.body);
    await auditLog(
      req.tenantId,
      'create',
      'firm_tag_template',
      tpl.id,
      null,
      { firmId: req.firmId, templateKey: tpl.templateKey, displayName: tpl.displayName },
      req.userId,
    );
    res.status(201).json(tpl);
  },
);

firmsRouter.get('/:firmId/tag-templates/:id', async (req, res) => {
  const tpl = await tagTemplatesService.getTemplate(req.firmId!, req.params['id']!);
  res.json(tpl);
});

firmsRouter.patch(
  '/:firmId/tag-templates/:id',
  requireFirmAdmin,
  validate(updateFirmTagTemplateSchema),
  async (req, res) => {
    const tpl = await tagTemplatesService.updateTemplate(
      req.firmId!,
      req.params['id']!,
      req.body,
    );
    await auditLog(
      req.tenantId,
      'update',
      'firm_tag_template',
      tpl.id,
      null,
      { displayName: tpl.displayName },
      req.userId,
    );
    res.json(tpl);
  },
);

firmsRouter.delete(
  '/:firmId/tag-templates/:id',
  requireFirmAdmin,
  async (req, res) => {
    const tpl = await tagTemplatesService.getTemplate(req.firmId!, req.params['id']!);
    await tagTemplatesService.deleteTemplate(req.firmId!, req.params['id']!);
    await auditLog(
      req.tenantId,
      'delete',
      'firm_tag_template',
      tpl.id,
      { templateKey: tpl.templateKey },
      null,
      req.userId,
    );
    res.json({ deleted: true });
  },
);

// Bindings — list, upsert (POST), delete one.
firmsRouter.get('/:firmId/tag-templates/:id/bindings', async (req, res) => {
  const bindings = await tagTemplatesService.listBindings(req.firmId!, req.params['id']!);
  res.json({ bindings });
});

firmsRouter.post(
  '/:firmId/tag-templates/:id/bindings',
  requireFirmAdmin,
  validate(upsertTagBindingSchema),
  async (req, res) => {
    const binding = await tagTemplatesService.upsertBinding(
      req.firmId!,
      req.params['id']!,
      req.body,
    );
    await auditLog(
      req.body.tenantId,
      'update',
      'firm_tag_binding',
      binding.id,
      null,
      { templateKey: binding.templateKey, tagId: binding.tagId },
      req.userId,
    );
    res.status(201).json(binding);
  },
);

firmsRouter.delete(
  '/:firmId/tag-templates/:id/bindings/:tenantId',
  requireFirmAdmin,
  async (req, res) => {
    await tagTemplatesService.deleteBinding(
      req.firmId!,
      req.params['id']!,
      req.params['tenantId']!,
    );
    await auditLog(
      req.params['tenantId']!,
      'delete',
      'firm_tag_binding',
      req.params['id']!,
      null,
      null,
      req.userId,
    );
    res.json({ deleted: true });
  },
);
