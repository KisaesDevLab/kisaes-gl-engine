// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Equity roles (U-55, equity-roles-v1): owner-money accounts resolved by
// role through accounts.system_tag, seeded by company entity type.
//
// ensureEquityRoleAccounts is idempotent: for every role the tenant's
// companies need (by entity type) and that no account carries yet, it adopts
// an untagged equity account with a known name or template number ("Owner
// Withdraw" 30170 becomes owner_draw) or creates one. Companies in a tenant
// share one chart of accounts (company.service), so accounts are tenant-wide
// (company_id NULL) and so are the tags. Migration 0223 applies the same
// rules to existing tenants.

import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  EQUITY_ROLE_REPORT_TAGS, EQUITY_ROLE_SPECS, EQUITY_ROLES_BY_ENTITY_TYPE,
  type EquityRoleTag,
} from '@kis-books/shared';
import { db, type DbOrTx } from '../db/index.js';
import { accounts, companies } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';

function rolesFor(entityType: string | null | undefined): Array<{ tag: EquityRoleTag; name: string }> {
  return EQUITY_ROLES_BY_ENTITY_TYPE[(entityType ?? 'sole_prop') as keyof typeof EQUITY_ROLES_BY_ENTITY_TYPE] ?? [];
}

/**
 * Adopts or creates the equity role accounts the tenant's companies need.
 * Returns the tags it assigned. Safe to call repeatedly.
 */
export async function ensureEquityRoleAccounts(
  tenantId: string,
  actingUserId?: string,
  executor: DbOrTx = db,
): Promise<EquityRoleTag[]> {
  const companyRows = await executor.select({ entityType: companies.entityType }).from(companies)
    .where(eq(companies.tenantId, tenantId))
    .orderBy(asc(companies.createdAt));
  const wanted = new Map<EquityRoleTag, string>();
  for (const c of companyRows) {
    for (const r of rolesFor(c.entityType)) if (!wanted.has(r.tag)) wanted.set(r.tag, r.name);
  }
  if (wanted.size === 0) return [];

  const tagged = await executor.select({ systemTag: accounts.systemTag }).from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), inArray(accounts.systemTag, [...wanted.keys()])));
  const have = new Set(tagged.map((t) => t.systemTag));

  const assigned: EquityRoleTag[] = [];
  for (const [tag, name] of wanted) {
    if (have.has(tag)) continue;
    const spec = EQUITY_ROLE_SPECS[tag];
    const matchers = [
      ...(spec.adoptAccountNumbers.length > 0 ? [inArray(accounts.accountNumber, spec.adoptAccountNumbers)] : []),
      ...(spec.adoptNames.length > 0 ? [inArray(sql`lower(${accounts.name})`, spec.adoptNames)] : []),
    ];
    const [candidate] = await executor.select({ id: accounts.id }).from(accounts)
      .where(and(
        eq(accounts.tenantId, tenantId),
        isNull(accounts.systemTag),
        eq(accounts.accountType, 'equity'),
        or(...matchers),
      ))
      .orderBy(sql`${accounts.accountNumber} ASC NULLS LAST`, asc(accounts.createdAt), asc(accounts.id))
      .limit(1);
    if (candidate) {
      await executor.update(accounts).set({ systemTag: tag, updatedAt: new Date() })
        .where(and(eq(accounts.tenantId, tenantId), eq(accounts.id, candidate.id)));
      await auditLog(tenantId, 'update', 'equity_role', candidate.id,
        { systemTag: null }, { systemTag: tag, adopted: true }, actingUserId, executor);
      assigned.push(tag);
      continue;
    }
    const [numTaken] = await executor.select({ id: accounts.id }).from(accounts)
      .where(and(eq(accounts.tenantId, tenantId), eq(accounts.accountNumber, spec.accountNumber)))
      .limit(1);
    const [created] = await executor.insert(accounts).values({
      tenantId,
      companyId: null,
      accountNumber: numTaken ? null : spec.accountNumber,
      name,
      accountType: 'equity',
      detailType: spec.detailType,
      // Engine-made role account: a system account, as the daily-sales
      // roles are (an adopted account above keeps its own flag).
      isSystem: true,
      systemTag: tag,
      isActive: true,
    }).returning({ id: accounts.id, accountNumber: accounts.accountNumber });
    if (!created) throw AppError.internal(`Could not create the '${tag}' equity account.`);
    await auditLog(tenantId, 'create', 'equity_role', created.id, null,
      { systemTag: tag, accountNumber: created.accountNumber }, actingUserId, executor);
    assigned.push(tag);
  }
  return assigned;
}

/**
 * Seeding hook for company creation and entity-type changes. Never fails
 * the caller: a missing role reads as null and the next call fills it.
 */
export async function seedEquityRolesBestEffort(tenantId: string, actingUserId?: string): Promise<void> {
  try {
    await ensureEquityRoleAccounts(tenantId, actingUserId);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[equity-roles] seed failed:', err instanceof Error ? err.message : err);
  }
}

/**
 * GET /company/equity-roles: the company's entity type and, per role, the
 * account playing it (tenant-wide or this company's), or null.
 */
export async function getEquityRoles(tenantId: string, companyId: string) {
  const company = await db.query.companies.findFirst({
    where: and(eq(companies.tenantId, tenantId), eq(companies.id, companyId)),
    columns: { entityType: true },
  });
  if (!company) throw AppError.notFound('Company not found');
  const rows = await db.select({ id: accounts.id, systemTag: accounts.systemTag }).from(accounts)
    .where(and(
      eq(accounts.tenantId, tenantId),
      inArray(accounts.systemTag, [...EQUITY_ROLE_REPORT_TAGS]),
      or(isNull(accounts.companyId), eq(accounts.companyId, companyId)),
    ))
    .orderBy(sql`${accounts.accountNumber} ASC NULLS LAST`, asc(accounts.createdAt), asc(accounts.id));
  const roles: Record<string, string | null> = {};
  for (const tag of EQUITY_ROLE_REPORT_TAGS) {
    roles[tag] = rows.find((r) => r.systemTag === tag)?.id ?? null;
  }
  return { entityType: company.entityType, roles };
}
