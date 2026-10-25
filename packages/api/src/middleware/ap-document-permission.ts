// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

import type { Request, Response, NextFunction } from 'express';
import { can, type PermissionAction, type ResourceKey } from '@kis-books/shared';
import { resolvePermissionsForRequest } from './permission.js';
import * as ledger from '../services/ledger.service.js';
import { AppError } from '../utils/errors.js';

// The permission that owns an A/P document (review H1). The generic edit,
// void, delete and duplicate routes (v1 /transactions/:id… and v2
// /transactions/:id/void) run under `transactions`, but a bill, vendor credit
// or bill payment reached through them also needs its own screen's
// permission, so `transactions` alone can't void a bill. Mount it ahead of
// idempotent(), so a replay is checked too.
const AP_DOCUMENT_RESOURCE: Readonly<Record<string, ResourceKey>> = {
  bill: 'bills', vendor_credit: 'vendor_credits', bill_payment: 'pay_bills',
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The resource an A/P transaction type belongs to, or undefined for any other type. */
export function apDocumentResource(txnType: string | null | undefined): ResourceKey | undefined {
  return txnType ? AP_DOCUMENT_RESOURCE[txnType] : undefined;
}

/** Middleware: when `:id` is a bill, vendor credit or bill payment, the caller also needs `action` on its resource. */
export function apDocumentPermission(action: PermissionAction) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    const id = req.params['id'] ?? '';
    const type = UUID_RE.test(id) ? await ledger.getTransactionType(req.tenantId, id) : null;
    const resource = apDocumentResource(type);
    if (resource && !can(await resolvePermissionsForRequest(req), resource, action)) {
      throw AppError.forbidden('You do not have permission for this feature', 'PERMISSION_DENIED');
    }
    next();
  };
}
