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
import { can, DOCUMENT_CONVERT_KINDS, DOCUMENT_DRAFT_KINDS, type DocumentDraftKind, type PermissionAction } from '@kis-books/shared';
import { resolvePermissionsForRequest } from './permission.js';
import { resourceOfKind } from '../services/document-draft.service.js';
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
