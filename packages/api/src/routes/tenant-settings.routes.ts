// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import { Router } from 'express';
import {
  updateTenantReportSettingsSchema,
  createDetailTypeSchema,
  updateDetailTypeSchema,
  resolvePLLabels,
  resolveBSLabels,
  resolveCFLabels,
  TENANT_ASSIGNABLE_SYSTEM_ROLES,
  roleEligibilityError,
  assignTenantSystemAccountSchema,
} from '@kis-books/shared';
import { authenticate } from '../middleware/auth.js';
import { requireResource, requirePermission } from '../middleware/permission.js';
import { validate } from '../middleware/validate.js';
import * as service from '../services/tenant-report-settings.service.js';
import * as detailTypesService from '../services/detail-types.service.js';
import * as adminService from '../services/admin.service.js';
import { AppError } from '../utils/errors.js';

export const tenantSettingsRouter = Router();
tenantSettingsRouter.use(authenticate);
tenantSettingsRouter.use(requireResource('company_settings'));

function shape(settings: Awaited<ReturnType<typeof service.getSettings>>) {
  return {
    plLabels: settings.plLabels ?? {},
    bsLabels: settings.bsLabels ?? {},
    cfLabels: settings.cfLabels ?? {},
    reportFooter: settings.reportFooter ?? '',
    // CPA firm identity for SSARS-21 engagement letters (signature block).
    firmName: settings.firmName ?? '',
    firmCity: settings.firmCity ?? '',
    firmState: settings.firmState ?? '',
    accountantSignature: settings.accountantSignature ?? '',
    resolvedPLLabels: resolvePLLabels(settings.plLabels),
    resolvedBSLabels: resolveBSLabels(settings.bsLabels),
    resolvedCFLabels: resolveCFLabels(settings.cfLabels),
  };
}

tenantSettingsRouter.get('/report', async (req, res) => {
  const settings = await service.getSettings(req.tenantId);
  res.json(shape(settings));
});

tenantSettingsRouter.put('/report', validate(updateTenantReportSettingsSchema), async (req, res) => {
  const next = await service.updateSettings(req.tenantId, req.body, req.userId);
  res.json(shape(next));
});

// ─── Custom detail types ─────────────────────────────────────────
// Built-ins come from @kis-books/shared DETAIL_TYPES; tenants can add
// their own per account type. GET returns the merged list the account
// forms consume plus the raw custom rows for the management UI.
// requireResource('company_settings') above already gates reads to
// 'read' and mutations to 'update' (owner / accountant).

tenantSettingsRouter.get('/detail-types', async (req, res) => {
  const [merged, custom] = await Promise.all([
    detailTypesService.listMerged(req.tenantId),
    detailTypesService.listCustom(req.tenantId),
  ]);
  res.json({ detailTypes: merged, custom });
});

tenantSettingsRouter.post('/detail-types', validate(createDetailTypeSchema), async (req, res) => {
  const created = await detailTypesService.create(req.tenantId, req.body, req.userId);
  res.status(201).json(created);
});

// Rename / reorder. `sortOrder` drives presentation order in the merged
// dropdown list and in detail-type-grouped reports (P&L/BS, comparative,
// condensed display, CSV/PDF exports). `value` is immutable.
tenantSettingsRouter.patch('/detail-types/:id', validate(updateDetailTypeSchema), async (req, res) => {
  const updated = await detailTypesService.update(req.tenantId, req.params['id']!, req.body, req.userId);
  res.json(updated);
});

tenantSettingsRouter.delete('/detail-types/:id', async (req, res) => {
  await detailTypesService.remove(req.tenantId, req.params['id']!, req.userId);
  res.status(204).end();
});

// ── Tenant-assignable system accounts ───────────────────────────
//
// The super-admin System Accounts screen can re-point every ledger role. Most
// of those must stay there: getting A/R or retained earnings wrong breaks
// posting and the year-end close. `suspense` is different — it is opt-in, it
// breaks nothing when changed, and which account a firm wants to hold
// unclassified amounts is a bookkeeping preference, not a support decision.
// So roles flagged `tenantAssignable` are exposed here too, for the tenant's
// own admin, behind the same company_settings permission as the rest of this
// router.

// GET /tenant-settings/system-accounts
tenantSettingsRouter.get('/system-accounts', async (req, res) => {
  const info = await adminService.getSystemAccountsInfo(req.tenantId);
  const tags = new Set(TENANT_ASSIGNABLE_SYSTEM_ROLES.map((r) => r.tag));
  const roles = info.roles.filter((r) => tags.has(r.tag));

  // Only the accounts a tenant admin could legitimately pick, so the UI never
  // offers something the API will reject. Eligibility is computed by the
  // shared helper, so this list and the write check cannot drift.
  const candidates = TENANT_ASSIGNABLE_SYSTEM_ROLES.map((role) => ({
    tag: role.tag,
    accounts: info.accounts.filter((a) => {
      if (a.systemTag && a.systemTag !== role.tag) return false;
      return roleEligibilityError(role, a) === null;
    }),
  }));

  res.json({ roles, candidates });
});

// PUT /tenant-settings/system-accounts/:tag
tenantSettingsRouter.put(
  '/system-accounts/:tag',
  requirePermission('company_settings', 'update'),
  validate(assignTenantSystemAccountSchema),
  async (req, res) => {
    const tag = req.params['tag']!;
    // A tenant admin may only touch roles the catalog opens up. Anything else
    // is a 404: the surface does not exist for them, rather than a 403 that
    // confirms the role is there.
    if (!TENANT_ASSIGNABLE_SYSTEM_ROLES.some((r) => r.tag === tag)) {
      throw AppError.notFound('That system account cannot be set here.');
    }
    const info = await adminService.assignSystemAccount(
      req.tenantId, tag, req.body.accountId, req.userId,
      { balanceAction: req.body.balanceAction },
    );
    const tags = new Set(TENANT_ASSIGNABLE_SYSTEM_ROLES.map((r) => r.tag));
    res.json({ roles: info.roles.filter((r) => tags.has(r.tag)) });
  },
);
