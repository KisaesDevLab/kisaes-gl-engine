// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Tenant lifecycle routes (U-05), mounted at /api/v1/tenants in every mode.
 *
 *   GET    /               companies the user can access; on desktop a super admin sees every company
 *                           (Q-244). Never the workspace, never scratch copies.
 *   POST   /               create a company (createOwnedTenant; no firm join)
 *   PATCH  /:id            rename the tenant label (409 STALE on an expectedUpdatedAt mismatch)
 *   POST   /:id/archives   start an archive export job -> 202 {jobId, archiveId}
 *
 * Every endpoint that names a tenant answers 409 WORKSPACE_TENANT for the
 * desktop workspace. Writes need an interactive session and the owner
 * (or admin) role on the tenant; super admins pass.
 */

import { Router, type Request } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tenants, userTenantAccess } from '../db/schema/index.js';
import { authenticate, requireSessionAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { describe } from '../middleware/describe.js';
import { AppError } from '../utils/errors.js';
import { assertNotWorkspace } from '../desktop/workspace.js';
import { isDesktop } from '../desktop/profile.js';
import * as authService from '../services/auth.service.js';
import { runExport } from '../services/tenant-portability/export.service.js';
import { assertPassphraseStrong, registerPassphrase, releasePassphrase } from '../services/tenant-portability/archive-crypto.js';
import { startJob } from '../services/tenant-portability/jobs.js';
import { HOST_MAX_BYTES } from '../services/tenant-portability/format.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 403 unless the caller is a super admin or holds an active owner/admin access row on the tenant. */
export async function assertTenantOwner(req: Request, tenantId: string): Promise<void> {
  if (!UUID_RE.test(tenantId)) throw AppError.notFound('Company not found');
  if (req.isSuperAdmin) return;
  const row = await db.query.userTenantAccess.findFirst({
    where: and(eq(userTenantAccess.userId, req.userId), eq(userTenantAccess.tenantId, tenantId), eq(userTenantAccess.isActive, true)),
  });
  if (!row || (row.role !== 'owner' && row.role !== 'admin')) {
    throw AppError.forbidden('Only the company owner can do this.', 'TENANT_OWNER_REQUIRED');
  }
}

export const tenantsRouter = Router();
tenantsRouter.use(authenticate);

const tenantView = z.object({
  id: z.string().uuid(),
  name: z.string(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  role: z.string(),
});

tenantsRouter.get('/', describe({
  summary: 'List the companies the current user can access (desktop: a super admin sees every company)',
  tags: ['tenants'],
  response: z.array(tenantView),
}), async (req, res) => {
  // Desktop: the owner (a super admin, decided from the caller's own row)
  // sees every company on the install, access row or not (owner decision
  // Q-244); switch-tenant already lets a super admin in and issues 'owner'
  // where there is no row, so the list reports the same role. A server keeps
  // the access-row list for everyone (super admins use the admin routes).
  const seeAll = isDesktop() && (await db.execute(sql`
    SELECT 1 FROM users WHERE id = ${req.userId} AND is_super_admin = true AND is_active = true
  `)).rows.length > 0;
  const rows = (await db.execute(sql`
    SELECT t.id, t.name, t.created_at AS "createdAt", t.updated_at AS "updatedAt", COALESCE(a.role, 'owner') AS role
    FROM tenants t
    LEFT JOIN user_tenant_access a ON a.tenant_id = t.id AND a.user_id = ${req.userId} AND a.is_active = true
    WHERE t.is_workspace = false
      AND (a.id IS NOT NULL OR ${seeAll}::boolean)
      AND NOT EXISTS (SELECT 1 FROM tenant_archive_imports i WHERE i.tenant_id = t.id AND i.scratch)
    ORDER BY t.name, t.id
  `)).rows as Array<{ id: string; name: string; createdAt: Date | null; updatedAt: Date | null; role: string }>;
  res.json(rows.map((r) => ({
    id: r.id, name: r.name, role: r.role,
    createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : null,
    updatedAt: r.updatedAt ? new Date(r.updatedAt).toISOString() : null,
  })));
});

export const createTenantSchema = z.object({
  name: z.string().trim().min(1, 'Company name is required').max(255),
  businessType: z.string().trim().max(120).optional(),
  /** Alias of businessType (the chart-of-accounts template slug). */
  coaTemplate: z.string().trim().max(120).optional(),
  /** Seed only the required system accounts (same as auth/create-tenant), e.g. before importing a chart. */
  systemAccountsOnly: z.boolean().optional(),
});

tenantsRouter.post('/', requireSessionAuth, validate(createTenantSchema), describe({
  summary: 'Create a company (tenant + company row + chart of accounts) owned by the current user',
  tags: ['tenants'],
  response: z.object({ id: z.string().uuid(), name: z.string(), companyId: z.string() }),
}), async (req, res) => {
  const body = req.body as z.infer<typeof createTenantSchema>;
  const result = await authService.createOwnedTenant(req.userId, req.userRole, {
    companyName: body.name,
    businessType: body.businessType ?? body.coaTemplate,
    systemAccountsOnly: body.systemAccountsOnly,
  });
  res.status(201).json({ id: result.tenantId, name: result.tenantName, companyId: result.companyId });
});

export const renameTenantSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(255),
  expectedUpdatedAt: z.string().datetime({ offset: true }),
});

tenantsRouter.patch('/:id', requireSessionAuth, validate(renameTenantSchema), describe({
  summary: 'Rename the company label (409 STALE when expectedUpdatedAt no longer matches)',
  tags: ['tenants'],
  params: z.object({ id: z.string().uuid() }),
  response: z.object({ id: z.string().uuid(), name: z.string(), updatedAt: z.string() }),
}), async (req, res) => {
  const tenantId = req.params['id']!;
  await assertTenantOwner(req, tenantId);
  await assertNotWorkspace(tenantId);
  const body = req.body as z.infer<typeof renameTenantSchema>;
  const current = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId), columns: { id: true, updatedAt: true } });
  if (!current) throw AppError.notFound('Company not found');
  const expected = new Date(body.expectedUpdatedAt).getTime();
  if (!current.updatedAt || current.updatedAt.getTime() !== expected) {
    throw AppError.conflict('The company was changed by someone else. Reload and try again.', 'STALE', {
      updatedAt: current.updatedAt ? current.updatedAt.toISOString() : null,
    });
  }
  // updated_at carries microseconds; the client echoes milliseconds, so compare at that precision.
  const updated = (await db.execute(sql`
    UPDATE tenants SET name = ${body.name}, updated_at = now()
    WHERE id = ${tenantId} AND date_trunc('milliseconds', updated_at) = ${new Date(expected).toISOString()}::timestamptz
    RETURNING id, name, updated_at AS "updatedAt"
  `)).rows[0] as { id: string; name: string; updatedAt: Date } | undefined;
  if (!updated) throw AppError.conflict('The company was changed by someone else. Reload and try again.', 'STALE');
  res.json({ id: updated.id, name: updated.name, updatedAt: new Date(updated.updatedAt).toISOString() });
});

export const exportArchiveSchema = z.object({
  includeAttachments: z.boolean().optional().default(true),
  includeAudit: z.boolean().optional().default(true),
  /** Leave the company intake folders out (U-93, intake-settings-v1): the archive carries the column default (no folders). */
  omitIntakeSettings: z.boolean().optional().default(false),
  /**
   * Leave unconverted document drafts out (U-92, document-drafts-v1): converted drafts travel, other drafts and
   * their audit rows do not; vendor_layout_templates travels with no rows; live drafts' attachments and files are
   * left out unless another exported row references them (manifest `omitted`, `omittedRows`).
   */
  omitDocumentDrafts: z.boolean().optional().default(false)
    .describe('Leave unconverted document drafts (and their audit rows), vendor layouts and live drafts\' files out (document-drafts-v1); converted drafts and files other records use travel. ClientLedger sets it for transfer files.'),
  /** Opaque application metadata, stored in the manifest, never interpreted (<= 16 KiB). */
  host: z.record(z.unknown()).optional(),
  passphrase: z.string().min(1).max(1024),
});

tenantsRouter.post('/:id/archives', requireSessionAuth, validate(exportArchiveSchema), describe({
  summary: 'Start an archive export of the company (202; poll /api/v1/tenant-archives/jobs/{jobId})',
  tags: ['tenant-archives'],
  params: z.object({ id: z.string().uuid() }),
  response: z.object({ jobId: z.string().uuid(), archiveId: z.string().uuid() }),
}), async (req, res) => {
  const tenantId = req.params['id']!;
  await assertTenantOwner(req, tenantId);
  await assertNotWorkspace(tenantId);
  const body = req.body as z.infer<typeof exportArchiveSchema>;
  assertPassphraseStrong(body.passphrase);
  if (body.host && Buffer.byteLength(JSON.stringify(body.host), 'utf8') > HOST_MAX_BYTES) {
    throw AppError.badRequest('host metadata is too large (16 KiB)', 'VALIDATION_ERROR');
  }
  const exists = await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId), columns: { id: true } });
  if (!exists) throw AppError.notFound('Company not found');
  const archiveId = crypto.randomUUID();
  const { userId } = req;
  // The passphrase is scrubbed from logs from here until the job ends.
  registerPassphrase(body.passphrase);
  const job = startJob('export', tenantId, userId, async (progress) => {
    try {
      return await runExport(tenantId, userId, {
        includeAttachments: body.includeAttachments,
        includeAudit: body.includeAudit,
        omitIntakeSettings: body.omitIntakeSettings,
        omitDocumentDrafts: body.omitDocumentDrafts,
        host: body.host,
        passphrase: body.passphrase,
        archiveId,
      }, progress);
    } finally {
      releasePassphrase(body.passphrase);
    }
  }, [archiveId]);
  res.status(202).json({ jobId: job.id, archiveId });
});
