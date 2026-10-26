// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Permissions of the document drafts routes (U-92, document-drafts-v1).
// A draft becomes a bill, a check or an expense, so it is guarded by the
// permission of what it becomes:
//   bill (and unknown)            -> bills
//   check                         -> checks
//   card_charge, cash_expense     -> transactions
// Reading drafts and vendor layouts needs view access to any of the three.
// The keyed routes (create, convert) check the kind named in the body here,
// ahead of idempotent(), so a replay is checked too (the pattern of
// ap-document-permission.ts).

import type { Request, Response, NextFunction } from 'express';
import { sql } from 'drizzle-orm';
import {
  can, DOCUMENT_CONVERT_KINDS, DOCUMENT_DRAFT_KINDS, type DocumentDraftKind, type PermissionAction, type ResourceKey,
} from '@kis-books/shared';
import { db } from '../db/index.js';
import { resolvePermissionsForRequest } from './permission.js';
import { resourceOfKind, resourceOfTarget } from '../services/document-draft.service.js';
import * as featureFlags from '../services/feature-flags.service.js';
import { AppError } from '../utils/errors.js';

const DOCUMENT_RESOURCES = ['bills', 'checks', 'transactions'] as const;

function denied(): AppError {
  return AppError.forbidden('You do not have permission for this feature', 'PERMISSION_DENIED');
}

/** View (GET) or full (other methods) access to any of bills, checks, transactions. */
export function requireAnyDocumentResource(action?: PermissionAction) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const a: PermissionAction = action ?? (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS' ? 'read' : 'update');
    const perms = await resolvePermissionsForRequest(req);
    if (!DOCUMENT_RESOURCES.some((r) => can(perms, r, a))) throw denied();
    next();
  };
}

/** Whether the request may change a draft of `kind`. */
export async function canChangeKind(req: Request, kind: DocumentDraftKind): Promise<boolean> {
  return can(await resolvePermissionsForRequest(req), resourceOfKind(kind), 'update');
}

/**
 * POST /document-drafts: full access to the resource of `kindHint`
 * (unknown or absent -> bills). An unknown value is left to validation.
 */
export async function requireCreateKindPermission(req: Request, _res: Response, next: NextFunction) {
  const hint = (req.body as { kindHint?: unknown } | undefined)?.kindHint;
  const kind: DocumentDraftKind = typeof hint === 'string' && (DOCUMENT_DRAFT_KINDS as readonly string[]).includes(hint)
    ? hint as DocumentDraftKind : 'unknown';
  if (!(await canChangeKind(req, kind))) throw denied();
  next();
}

/** Whether the request may change a transaction of permission resource `resource`. */
export async function canChangeResource(req: Request, resource: ResourceKey): Promise<boolean> {
  return can(await resolvePermissionsForRequest(req), resource, 'update');
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Whether the request may file a document on a transaction of `txnType`
 * (U-95 review L-1): an adjusting journal entry (`aje`) belongs to the
 * Trial Balance module, which client users and tenants with
 * TRIAL_BALANCE_V1 off can't reach (tb.routes.ts), so it is not attachable
 * for them. Every other type is.
 */
export async function canAttachToType(req: Request, txnType: string): Promise<boolean> {
  if (txnType !== 'aje') return true;
  if (req.userType === 'client') return false;
  return featureFlags.isEnabled(req.tenantId, 'TRIAL_BALANCE_V1');
}

/**
 * POST /document-drafts/:id/attach (U-95): full access to the draft's
 * current kind's resource and to the target transaction's resource
 * (resourceOfTarget), checked here ahead of idempotent() so a replay is
 * checked too, and again on the locked rows. The target is looked up in the
 * request's company and tenant-wide only (review L-2): another company's
 * transaction is treated as missing, as the service treats it (404), so a
 * 403 never reveals it. An AJE the request can't reach is 422
 * TARGET_NOT_ATTACHABLE (canAttachToType). A draft or transaction that isn't
 * there is left to the service (404).
 */
export async function requireAttachPermission(req: Request, _res: Response, next: NextFunction) {
  const id = req.params['id'] ?? '';
  const transactionId = (req.body as { transactionId?: unknown } | undefined)?.transactionId;
  if (UUID_RE.test(id) && req.companyId) {
    const r = await db.execute(sql`SELECT kind FROM document_drafts
      WHERE tenant_id = ${req.tenantId} AND company_id = ${req.companyId} AND id = ${id} LIMIT 1`);
    const kind = (r.rows[0] as { kind: DocumentDraftKind } | undefined)?.kind;
    if (kind && !(await canChangeKind(req, kind))) throw denied();
  }
  if (typeof transactionId === 'string' && UUID_RE.test(transactionId) && req.companyId) {
    const t = await db.execute(sql`SELECT txn_type FROM transactions
      WHERE tenant_id = ${req.tenantId} AND id = ${transactionId} AND status <> 'deleted'
        AND (company_id IS NULL OR company_id = ${req.companyId}) LIMIT 1`);
    const type = (t.rows[0] as { txn_type: string } | undefined)?.txn_type;
    if (type && !(await canAttachToType(req, type))) {
      throw AppError.unprocessableEntity('A document can\'t be attached to this kind of transaction.', 'TARGET_NOT_ATTACHABLE', { txnType: type });
    }
    if (type && !(await canChangeResource(req, resourceOfTarget(type)))) throw denied();
  }
  next();
}

/**
 * POST /document-drafts/:id/convert: full access to the resource of the
 * body's `kind`; a missing or other value is 400 INVALID_KIND.
 */
export async function requireConvertKindPermission(req: Request, _res: Response, next: NextFunction) {
  const kind = (req.body as { kind?: unknown } | undefined)?.kind;
  if (typeof kind !== 'string' || !(DOCUMENT_CONVERT_KINDS as readonly string[]).includes(kind)) {
    throw AppError.badRequest(`kind must be one of ${DOCUMENT_CONVERT_KINDS.join(', ')}`, 'INVALID_KIND');
  }
  if (!(await canChangeKind(req, kind as DocumentDraftKind))) throw denied();
  next();
}
