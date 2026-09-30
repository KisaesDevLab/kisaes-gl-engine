// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Owner of the financial-statement library (letterhead, letters, style
// presets, layout templates): the tenant's ACTIVE firm when it is firm-
// managed, else the tenant itself (standalone installs). Same "exactly one
// owner" contract as firm_tax_codes.

import { and, eq, isNull, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { db } from '../../../db/index.js';
import { tenantFirmAssignments } from '../../../db/schema/index.js';

export interface FsOwner { firmId: string | null; tenantId: string | null }

export async function resolveFsOwner(tenantId: string): Promise<FsOwner> {
  const [assignment] = await db.select({ firmId: tenantFirmAssignments.firmId })
    .from(tenantFirmAssignments)
    .where(and(eq(tenantFirmAssignments.tenantId, tenantId), eq(tenantFirmAssignments.isActive, true)))
    .limit(1);
  return assignment ? { firmId: assignment.firmId, tenantId: null } : { firmId: null, tenantId };
}

export function ownerWhere(t: { firmId: PgColumn; tenantId: PgColumn }, owner: FsOwner): SQL {
  return owner.firmId
    ? and(eq(t.firmId, owner.firmId), isNull(t.tenantId))!
    : and(isNull(t.firmId), eq(t.tenantId, owner.tenantId ?? ''))!;
}

export function ownerValues(owner: FsOwner): { firmId: string | null; tenantId: string | null } {
  return { firmId: owner.firmId, tenantId: owner.firmId ? null : owner.tenantId };
}
