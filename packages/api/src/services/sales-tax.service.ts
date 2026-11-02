// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Sales tax setup (U-147, sales-tax-setup-v1): agencies (a vendor the tax is
 * paid to), sales tax items (one rate with its agency) and groups (items
 * charged together), and tax codes (why a line is or is not taxed; `Tax` and
 * `Non` are system codes every company has). Deactivate, never delete.
 *
 * Tax rows (transaction_tax_lines): every posted sales document writes one
 * row per tax item in the posting's database transaction, so
 * Σ rows.tax = the transaction's Sales Tax Payable lines (signed by
 * liability effect: a credit memo's rows are negative). A document posted
 * with a line taxRate and no sales tax (the legacy path: MyBooks Online, the
 * API, MCP, batch, recurring) gets rows on a legacy item per rate (made on
 * first use, `ON CONFLICT (company_id, legacy_rate)`); tax the lines do not
 * explain (a hand-made STP line, daily sales) is an unassigned row.
 */

import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import DecimalLib from 'decimal.js';
import { db, type DbOrTx, type Tx } from '../db/index.js';
import {
  accounts, companies, contacts, salesTaxAgencies, salesTaxCodes, salesTaxGroupMembers, salesTaxItems, transactionTaxLines,
  salesTaxPaymentLines,
} from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import { claimIdempotency, recordIdempotentEntity } from './idempotency.service.js';
import { allocateCents, formatTaxRate, parseSetupTaxRate, TAX_RATE_PLACES } from '../utils/sales-compute.js';

const BaseDecimal = DecimalLib.default || DecimalLib;
const Decimal = BaseDecimal.clone({ precision: 40, rounding: BaseDecimal.ROUND_HALF_UP });
type DecimalValue = InstanceType<typeof Decimal>;

export const SALES_TAX_DOCUMENT_TYPES = ['invoice', 'cash_sale', 'credit_memo'] as const;
const ROW_TYPES = new Set<string>([...SALES_TAX_DOCUMENT_TYPES, 'daily_sales']);
export const MAX_GROUP_MEMBERS = 10;

type ItemRow = typeof salesTaxItems.$inferSelect;
type AgencyRow = typeof salesTaxAgencies.$inferSelect;
type CodeRow = typeof salesTaxCodes.$inferSelect;

const notFound = () => AppError.notFound('Not found');
const stale = () => AppError.conflict('Someone else changed this record. Reload it and try again.', 'STALE');
const isUniqueViolation = (e: unknown) => (e as { code?: string; cause?: { code?: string } })?.code === '23505'
  || (e as { cause?: { code?: string } })?.cause?.code === '23505';

function assertFresh(updatedAt: Date | null, expected: string | undefined) {
  if (expected === undefined) return;
  const have = updatedAt ? updatedAt.toISOString() : null;
  if (have !== new Date(expected).toISOString()) throw stale();
}

// ── Codes ───────────────────────────────────────────────────────────

/** The `Tax` and `Non` system codes of a company (made on first use; migration 0252 makes them for existing companies). */
export async function ensureSystemCodes(executor: DbOrTx, tenantId: string, companyId: string): Promise<{ tax: CodeRow; non: CodeRow }> {
  let rows = await executor.select().from(salesTaxCodes)
    .where(and(eq(salesTaxCodes.tenantId, tenantId), eq(salesTaxCodes.companyId, companyId), eq(salesTaxCodes.isSystem, true)));
  if (rows.length < 2) {
    await executor.insert(salesTaxCodes).values([
      { tenantId, companyId, code: 'Tax', name: 'Taxable', taxable: true, isSystem: true },
      { tenantId, companyId, code: 'Non', name: 'Non-taxable', taxable: false, isSystem: true },
    ]).onConflictDoNothing();
    rows = await executor.select().from(salesTaxCodes)
      .where(and(eq(salesTaxCodes.tenantId, tenantId), eq(salesTaxCodes.companyId, companyId), eq(salesTaxCodes.isSystem, true)));
  }
  const tax = rows.find((r) => r.taxable);
  const non = rows.find((r) => !r.taxable);
  if (!tax || !non) throw AppError.internal('Sales tax system codes missing');
  return { tax, non };
}

function codeOut(r: CodeRow) {
  return { id: r.id, code: r.code, name: r.name, taxable: r.taxable, isSystem: r.isSystem, isActive: r.isActive, updatedAt: r.updatedAt.toISOString() };
}

export async function listCodes(tenantId: string, companyId: string, includeInactive = false) {
  await ensureSystemCodes(db, tenantId, companyId);
  const rows = await db.select().from(salesTaxCodes)
    .where(and(eq(salesTaxCodes.tenantId, tenantId), eq(salesTaxCodes.companyId, companyId),
      includeInactive ? undefined : eq(salesTaxCodes.isActive, true)))
    .orderBy(sql`${salesTaxCodes.isSystem} DESC`, asc(salesTaxCodes.code));
  return { data: rows.map(codeOut) };
}

async function loadCode(executor: DbOrTx, tenantId: string, companyId: string, id: string, lock = false): Promise<CodeRow> {
  const q = executor.select().from(salesTaxCodes)
    .where(and(eq(salesTaxCodes.tenantId, tenantId), eq(salesTaxCodes.companyId, companyId), eq(salesTaxCodes.id, id))).limit(1);
  const [row] = lock ? await q.for('update') : await q;
  if (!row) throw notFound();
  return row;
}

export async function getCode(tenantId: string, companyId: string, id: string) {
  return codeOut(await loadCode(db, tenantId, companyId, id));
}

function codeInUse(): AppError {
  return AppError.conflict('Another tax code already uses this code.', 'CODE_IN_USE');
}

export async function createCode(tenantId: string, companyId: string, input: { code: string; name: string; taxable: boolean }, userId?: string) {
  return db.transaction(async (tx) => {
    await claimIdempotency(tx);
    await ensureSystemCodes(tx, tenantId, companyId);
    try {
      const [row] = await tx.insert(salesTaxCodes).values({
        tenantId, companyId, code: input.code.trim(), name: input.name.trim(), taxable: input.taxable,
      }).returning();
      await recordIdempotentEntity(tx, 'sales_tax_code', row!.id);
      await auditLog(tenantId, 'create', 'sales_tax_code', row!.id, null, codeOut(row!), userId, tx);
      return codeOut(row!);
    } catch (e) {
      if (isUniqueViolation(e)) throw codeInUse();
      throw e;
    }
  });
}

export async function updateCode(
  tenantId: string, companyId: string, id: string,
  input: { code?: string; name?: string; taxable?: boolean; expectedUpdatedAt?: string }, userId?: string,
) {
  return db.transaction(async (tx) => {
    await claimIdempotency(tx);
    const row = await loadCode(tx, tenantId, companyId, id, true);
    assertFresh(row.updatedAt, input.expectedUpdatedAt);
    if (row.isSystem && ((input.code !== undefined && input.code.trim() !== row.code) || (input.taxable !== undefined && input.taxable !== row.taxable))) {
      throw AppError.conflict('Tax and Non are built in: their code and taxable flag can\'t change.', 'SYSTEM_CODE');
    }
    try {
      const [updated] = await tx.update(salesTaxCodes).set({
        ...(input.code !== undefined ? { code: input.code.trim() } : {}),
        ...(input.name !== undefined ? { name: input.name.trim() } : {}),
        ...(input.taxable !== undefined ? { taxable: input.taxable } : {}),
        updatedAt: new Date(),
      }).where(eq(salesTaxCodes.id, id)).returning();
      await recordIdempotentEntity(tx, 'sales_tax_code', id);
      await auditLog(tenantId, 'update', 'sales_tax_code', id, codeOut(row), codeOut(updated!), userId, tx);
      return codeOut(updated!);
    } catch (e) {
      if (isUniqueViolation(e)) throw codeInUse();
      throw e;
    }
  });
}

export async function setCodeActive(tenantId: string, companyId: string, id: string, active: boolean, userId?: string) {
  return db.transaction(async (tx) => {
    await claimIdempotency(tx);
    const row = await loadCode(tx, tenantId, companyId, id, true);
    if (row.isSystem && !active) throw AppError.conflict('Tax and Non are built in and can\'t be made inactive.', 'SYSTEM_CODE');
    const [updated] = await tx.update(salesTaxCodes).set({ isActive: active, updatedAt: new Date() }).where(eq(salesTaxCodes.id, id)).returning();
    await recordIdempotentEntity(tx, 'sales_tax_code', id);
    await auditLog(tenantId, 'update', 'sales_tax_code', id, { isActive: row.isActive }, { isActive: active }, userId, tx);
    return codeOut(updated!);
  });
}

// ── Agencies ────────────────────────────────────────────────────────

async function vendorOf(executor: DbOrTx, tenantId: string, companyId: string, vendorId: string) {
  const [v] = await executor.select({ id: contacts.id, companyId: contacts.companyId, contactType: contacts.contactType, displayName: contacts.displayName })
    .from(contacts).where(and(eq(contacts.tenantId, tenantId), eq(contacts.id, vendorId))).limit(1);
  if (!v || (v.companyId !== null && v.companyId !== companyId) || !['vendor', 'both'].includes(v.contactType)) {
    throw AppError.badRequest('Choose a vendor of this company for the agency.', 'VALIDATION_ERROR', { field: 'vendorId' });
  }
  return v;
}

async function agencyOut(executor: DbOrTx, tenantId: string, rows: AgencyRow[]) {
  const ids = [...new Set(rows.map((r) => r.vendorId))];
  const names = ids.length === 0 ? [] : await executor.select({ id: contacts.id, name: contacts.displayName }).from(contacts)
    .where(and(eq(contacts.tenantId, tenantId), inArray(contacts.id, ids)));
  const byId = new Map(names.map((n) => [n.id, n.name]));
  return rows.map((r) => ({
    id: r.id, vendorId: r.vendorId, vendorName: byId.get(r.vendorId) ?? null, isActive: r.isActive, updatedAt: r.updatedAt.toISOString(),
  }));
}

async function loadAgency(executor: DbOrTx, tenantId: string, companyId: string, id: string, lock = false): Promise<AgencyRow> {
  const q = executor.select().from(salesTaxAgencies)
    .where(and(eq(salesTaxAgencies.tenantId, tenantId), eq(salesTaxAgencies.companyId, companyId), eq(salesTaxAgencies.id, id))).limit(1);
  const [row] = lock ? await q.for('update') : await q;
  if (!row) throw notFound();
  return row;
}

export async function listAgencies(tenantId: string, companyId: string, includeInactive = false) {
  const rows = await db.select().from(salesTaxAgencies)
    .where(and(eq(salesTaxAgencies.tenantId, tenantId), eq(salesTaxAgencies.companyId, companyId),
      includeInactive ? undefined : eq(salesTaxAgencies.isActive, true)));
  const out = await agencyOut(db, tenantId, rows);
  out.sort((a, b) => (a.vendorName ?? '').localeCompare(b.vendorName ?? ''));
  return { data: out };
}

export async function getAgency(tenantId: string, companyId: string, id: string) {
  return (await agencyOut(db, tenantId, [await loadAgency(db, tenantId, companyId, id)]))[0]!;
}

const agencyExists = () => AppError.conflict('This vendor is already a sales tax agency.', 'AGENCY_EXISTS');

export async function createAgency(tenantId: string, companyId: string, input: { vendorId: string }, userId?: string) {
  return db.transaction(async (tx) => {
    await claimIdempotency(tx);
    await vendorOf(tx, tenantId, companyId, input.vendorId);
    try {
      const [row] = await tx.insert(salesTaxAgencies).values({ tenantId, companyId, vendorId: input.vendorId }).returning();
      await recordIdempotentEntity(tx, 'sales_tax_agency', row!.id);
      await auditLog(tenantId, 'create', 'sales_tax_agency', row!.id, null, { vendorId: row!.vendorId }, userId, tx);
      return (await agencyOut(tx, tenantId, [row!]))[0]!;
    } catch (e) {
      if (isUniqueViolation(e)) throw agencyExists();
      throw e;
    }
  });
}

export async function updateAgency(tenantId: string, companyId: string, id: string, input: { vendorId: string; expectedUpdatedAt?: string }, userId?: string) {
  return db.transaction(async (tx) => {
    await claimIdempotency(tx);
    const row = await loadAgency(tx, tenantId, companyId, id, true);
    assertFresh(row.updatedAt, input.expectedUpdatedAt);
    await vendorOf(tx, tenantId, companyId, input.vendorId);
    try {
      const [updated] = await tx.update(salesTaxAgencies).set({ vendorId: input.vendorId, updatedAt: new Date() })
        .where(eq(salesTaxAgencies.id, id)).returning();
      await recordIdempotentEntity(tx, 'sales_tax_agency', id);
      await auditLog(tenantId, 'update', 'sales_tax_agency', id, { vendorId: row.vendorId }, { vendorId: input.vendorId }, userId, tx);
      return (await agencyOut(tx, tenantId, [updated!]))[0]!;
    } catch (e) {
      if (isUniqueViolation(e)) throw agencyExists();
      throw e;
    }
  });
}

export async function setAgencyActive(tenantId: string, companyId: string, id: string, active: boolean, userId?: string) {
  return db.transaction(async (tx) => {
    await claimIdempotency(tx);
    const row = await loadAgency(tx, tenantId, companyId, id, true);
    if (!active) {
      const [used] = await tx.select({ id: salesTaxItems.id }).from(salesTaxItems)
        .where(and(eq(salesTaxItems.companyId, companyId), eq(salesTaxItems.agencyId, id), eq(salesTaxItems.isActive, true))).limit(1);
      if (used) throw AppError.conflict('Active sales tax items are paid to this agency. Move them or make them inactive first.', 'AGENCY_IN_USE');
    }
    const [updated] = await tx.update(salesTaxAgencies).set({ isActive: active, updatedAt: new Date() }).where(eq(salesTaxAgencies.id, id)).returning();
    await recordIdempotentEntity(tx, 'sales_tax_agency', id);
    await auditLog(tenantId, 'update', 'sales_tax_agency', id, { isActive: row.isActive }, { isActive: active }, userId, tx);
    return (await agencyOut(tx, tenantId, [updated!]))[0]!;
  });
}

// ── Items and groups ────────────────────────────────────────────────

export interface ItemInput {
  kind?: 'item' | 'group';
  name?: string;
  description?: string | null;
  rate?: string;
  agencyId?: string | null;
  memberIds?: string[];
  expectedUpdatedAt?: string;
}

async function loadItem(executor: DbOrTx, tenantId: string, companyId: string, id: string, lock = false): Promise<ItemRow> {
  const q = executor.select().from(salesTaxItems)
    .where(and(eq(salesTaxItems.tenantId, tenantId), eq(salesTaxItems.companyId, companyId), eq(salesTaxItems.id, id))).limit(1);
  const [row] = lock ? await q.for('update') : await q;
  if (!row) throw notFound();
  return row;
}

/** Members of groups, in order: groupId -> member items. */
async function membersOf(executor: DbOrTx, companyId: string, groupIds: string[]) {
  const out = new Map<string, ItemRow[]>();
  if (groupIds.length === 0) return out;
  const rows = await executor.select({ m: salesTaxGroupMembers, i: salesTaxItems }).from(salesTaxGroupMembers)
    .innerJoin(salesTaxItems, eq(salesTaxItems.id, salesTaxGroupMembers.itemId))
    .where(and(eq(salesTaxGroupMembers.companyId, companyId), inArray(salesTaxGroupMembers.groupId, groupIds)))
    .orderBy(asc(salesTaxGroupMembers.sortOrder));
  for (const r of rows) out.set(r.m.groupId, [...(out.get(r.m.groupId) ?? []), r.i]);
  return out;
}

async function itemsOut(executor: DbOrTx, tenantId: string, companyId: string, rows: ItemRow[]) {
  const groups = await membersOf(executor, companyId, rows.filter((r) => r.kind === 'group').map((r) => r.id));
  const agencyIds = [...new Set(rows.map((r) => r.agencyId).filter((v): v is string => !!v))];
  const agencyNames = new Map<string, string | null>();
  if (agencyIds.length) {
    const ags = await executor.select({ id: salesTaxAgencies.id, name: contacts.displayName }).from(salesTaxAgencies)
      .leftJoin(contacts, eq(contacts.id, salesTaxAgencies.vendorId))
      .where(and(eq(salesTaxAgencies.companyId, companyId), inArray(salesTaxAgencies.id, agencyIds)));
    for (const a of ags) agencyNames.set(a.id, a.name ?? null);
  }
  const ids = rows.map((r) => r.id);
  const used = new Set<string>();
  if (ids.length) {
    const res = await executor.execute(sql`
      SELECT DISTINCT x.id FROM (
        SELECT tax_item_id AS id FROM transaction_tax_lines WHERE company_id = ${companyId} AND tax_item_id IN ${ids}
        UNION SELECT sales_tax_id FROM transaction_tax_lines WHERE company_id = ${companyId} AND sales_tax_id IN ${ids}
        UNION SELECT item_id FROM sales_tax_group_members WHERE company_id = ${companyId} AND item_id IN ${ids}
        UNION SELECT default_sales_tax_id FROM contacts WHERE tenant_id = ${tenantId} AND default_sales_tax_id IN ${ids}
        UNION SELECT default_sales_tax_id FROM companies WHERE id = ${companyId} AND default_sales_tax_id IN ${ids}
      ) x`);
    for (const r of res.rows as Array<{ id: string }>) used.add(r.id);
  }
  return rows.map((r) => {
    const members = r.kind === 'group' ? groups.get(r.id) ?? [] : null;
    const rate = r.kind === 'group'
      ? members!.reduce<DecimalValue>((s, m) => s.plus(m.rate ?? '0'), new Decimal(0))
      : new Decimal(r.rate ?? '0');
    return {
      id: r.id,
      kind: r.kind as 'item' | 'group',
      name: r.name,
      description: r.description ?? null,
      rate: rate.toFixed(TAX_RATE_PLACES),
      agencyId: r.agencyId ?? null,
      agencyName: r.agencyId ? agencyNames.get(r.agencyId) ?? null : null,
      ...(members ? { members: members.map((m) => ({ id: m.id, name: m.name, rate: formatTaxRate(m.rate), agencyId: m.agencyId ?? null, isActive: m.isActive })) } : {}),
      legacyRate: r.legacyRate == null ? null : formatTaxRate(r.legacyRate),
      isActive: r.isActive,
      inUse: used.has(r.id),
      updatedAt: r.updatedAt.toISOString(),
    };
  });
}

export async function listItems(tenantId: string, companyId: string, includeInactive = false) {
  const rows = await db.select().from(salesTaxItems)
    .where(and(eq(salesTaxItems.tenantId, tenantId), eq(salesTaxItems.companyId, companyId),
      includeInactive ? undefined : eq(salesTaxItems.isActive, true)))
    .orderBy(sql`${salesTaxItems.kind} DESC`, sql`lower(${salesTaxItems.name})`);
  return { data: await itemsOut(db, tenantId, companyId, rows) };
}

export async function getItem(tenantId: string, companyId: string, id: string) {
  return (await itemsOut(db, tenantId, companyId, [await loadItem(db, tenantId, companyId, id)]))[0]!;
}

async function assertAgency(executor: DbOrTx, tenantId: string, companyId: string, agencyId: string) {
  const [a] = await executor.select().from(salesTaxAgencies)
    .where(and(eq(salesTaxAgencies.tenantId, tenantId), eq(salesTaxAgencies.companyId, companyId), eq(salesTaxAgencies.id, agencyId))).limit(1);
  if (!a || !a.isActive) throw AppError.badRequest('Choose an active agency of this company.', 'VALIDATION_ERROR', { field: 'agencyId' });
}

async function assertMembers(executor: DbOrTx, tenantId: string, companyId: string, memberIds: string[] | undefined, groupId?: string) {
  const ids = memberIds ?? [];
  if (ids.length < 1 || ids.length > MAX_GROUP_MEMBERS || new Set(ids).size !== ids.length) {
    throw AppError.badRequest(`A group has 1 to ${MAX_GROUP_MEMBERS} different sales tax items.`, 'GROUP_SIZE', { max: MAX_GROUP_MEMBERS });
  }
  const rows = await executor.select().from(salesTaxItems)
    .where(and(eq(salesTaxItems.tenantId, tenantId), eq(salesTaxItems.companyId, companyId), inArray(salesTaxItems.id, ids)));
  if (rows.length !== ids.length || rows.some((r) => r.kind !== 'item' || !r.isActive || r.id === groupId)) {
    throw AppError.badRequest('A group\'s members must be active sales tax items (not groups) of this company.', 'GROUP_MEMBER_NOT_ITEM');
  }
}

const nameInUse = () => AppError.conflict('Another sales tax item or group already has this name.', 'NAME_IN_USE');

export async function createItem(tenantId: string, companyId: string, input: ItemInput, userId?: string) {
  const kind = input.kind ?? 'item';
  return db.transaction(async (tx) => {
    await claimIdempotency(tx);
    let rate: string | null = null;
    if (kind === 'item') {
      if (input.rate === undefined) throw AppError.badRequest('A sales tax item needs a rate.', 'VALIDATION_ERROR', { field: 'rate' });
      rate = parseSetupTaxRate(input.rate, 'rate').toFixed(TAX_RATE_PLACES);
      if (!input.agencyId) throw AppError.badRequest('Choose the agency this tax is paid to.', 'AGENCY_REQUIRED');
      await assertAgency(tx, tenantId, companyId, input.agencyId);
    } else {
      if (input.rate !== undefined || input.agencyId) {
        throw AppError.badRequest('A group takes its rate and agencies from its members; send memberIds only.', 'VALIDATION_ERROR');
      }
      await assertMembers(tx, tenantId, companyId, input.memberIds);
    }
    let row: ItemRow;
    try {
      [row] = (await tx.insert(salesTaxItems).values({
        tenantId, companyId, kind, name: input.name!.trim(), description: input.description ?? null,
        rate, agencyId: kind === 'item' ? input.agencyId! : null,
      }).returning()) as [ItemRow];
    } catch (e) {
      if (isUniqueViolation(e)) throw nameInUse();
      throw e;
    }
    if (kind === 'group') {
      await tx.insert(salesTaxGroupMembers).values(input.memberIds!.map((itemId, i) => ({ tenantId, companyId, groupId: row.id, itemId, sortOrder: i })));
    }
    await recordIdempotentEntity(tx, 'sales_tax_item', row.id);
    const out = (await itemsOut(tx, tenantId, companyId, [row]))[0]!;
    await auditLog(tenantId, 'create', 'sales_tax_item', row.id, null, { kind, name: out.name, rate: out.rate, agencyId: out.agencyId, memberIds: input.memberIds }, userId, tx);
    return out;
  });
}

export async function updateItem(tenantId: string, companyId: string, id: string, input: ItemInput, userId?: string) {
  return db.transaction(async (tx) => {
    await claimIdempotency(tx);
    const row = await loadItem(tx, tenantId, companyId, id, true);
    assertFresh(row.updatedAt, input.expectedUpdatedAt);
    if (input.kind !== undefined && input.kind !== row.kind) {
      throw AppError.badRequest('An item can\'t become a group or the other way round.', 'VALIDATION_ERROR', { field: 'kind' });
    }
    const set: Partial<typeof salesTaxItems.$inferInsert> = { updatedAt: new Date() };
    if (input.name !== undefined) set.name = input.name.trim();
    if (input.description !== undefined) set.description = input.description;
    if (row.kind === 'item') {
      if (input.memberIds !== undefined) throw AppError.badRequest('Only a group has members.', 'VALIDATION_ERROR', { field: 'memberIds' });
      if (input.rate !== undefined) {
        const rate = parseSetupTaxRate(input.rate, 'rate').toFixed(TAX_RATE_PLACES);
        if (row.legacyRate != null && !new Decimal(rate).equals(row.legacyRate)) {
          throw AppError.badRequest('A legacy item stands for the rate saved on older documents; its rate can\'t change. Make a new item instead.', 'VALIDATION_ERROR', { field: 'rate' });
        }
        set.rate = rate;
      }
      // An agency change applies to documents saved from now on (Q-P23v): rows keep the agency they were written with.
      if (input.agencyId !== undefined) {
        if (!input.agencyId) {
          if (row.legacyRate == null) throw AppError.badRequest('Choose the agency this tax is paid to.', 'AGENCY_REQUIRED');
          set.agencyId = null;
        } else {
          await assertAgency(tx, tenantId, companyId, input.agencyId);
          set.agencyId = input.agencyId;
        }
      }
    } else {
      if (input.rate !== undefined || input.agencyId) {
        throw AppError.badRequest('A group takes its rate and agencies from its members; send memberIds only.', 'VALIDATION_ERROR');
      }
      if (input.memberIds !== undefined) {
        await assertMembers(tx, tenantId, companyId, input.memberIds, id);
        await tx.delete(salesTaxGroupMembers).where(and(eq(salesTaxGroupMembers.companyId, companyId), eq(salesTaxGroupMembers.groupId, id)));
        await tx.insert(salesTaxGroupMembers).values(input.memberIds.map((itemId, i) => ({ tenantId, companyId, groupId: id, itemId, sortOrder: i })));
      }
    }
    const before = (await itemsOut(tx, tenantId, companyId, [row]))[0]!;
    let updated: ItemRow;
    try {
      [updated] = (await tx.update(salesTaxItems).set(set).where(eq(salesTaxItems.id, id)).returning()) as [ItemRow];
    } catch (e) {
      if (isUniqueViolation(e)) throw nameInUse();
      throw e;
    }
    await recordIdempotentEntity(tx, 'sales_tax_item', id);
    const out = (await itemsOut(tx, tenantId, companyId, [updated]))[0]!;
    await auditLog(tenantId, 'update', 'sales_tax_item', id,
      { name: before.name, rate: before.rate, agencyId: before.agencyId, members: before.members?.map((m) => m.id) },
      { name: out.name, rate: out.rate, agencyId: out.agencyId, members: out.members?.map((m) => m.id) }, userId, tx);
    return out;
  });
}

export async function setItemActive(tenantId: string, companyId: string, id: string, active: boolean, userId?: string) {
  return db.transaction(async (tx) => {
    await claimIdempotency(tx);
    const row = await loadItem(tx, tenantId, companyId, id, true);
    if (!active && row.kind === 'item') {
      const res = await tx.execute(sql`
        SELECT g.name FROM sales_tax_group_members m JOIN sales_tax_items g ON g.id = m.group_id
        WHERE m.company_id = ${companyId} AND m.item_id = ${id} AND g.is_active = true ORDER BY g.name`);
      const groups = (res.rows as Array<{ name: string }>).map((r) => r.name);
      if (groups.length) {
        throw AppError.conflict('This item is in an active group. Take it out of the group or make the group inactive first.', 'ITEM_IN_GROUP', { groups });
      }
    }
    if (active && row.kind === 'group') {
      const members = (await membersOf(tx, companyId, [id])).get(id) ?? [];
      if (members.some((m) => !m.isActive)) {
        throw AppError.badRequest('A group\'s members must be active sales tax items (not groups) of this company.', 'GROUP_MEMBER_NOT_ITEM');
      }
    }
    const [updated] = await tx.update(salesTaxItems).set({ isActive: active, updatedAt: new Date() }).where(eq(salesTaxItems.id, id)).returning();
    await recordIdempotentEntity(tx, 'sales_tax_item', id);
    await auditLog(tenantId, 'update', 'sales_tax_item', id, { isActive: row.isActive }, { isActive: active }, userId, tx);
    return (await itemsOut(tx, tenantId, companyId, [updated!]))[0]!;
  });
}

// ── Legacy items ────────────────────────────────────────────────────

/** "Sales tax 8.25%" for 0.082500 (migration 0252 sales_tax_legacy_name). */
export function legacyItemName(rate: string): string {
  const pct = new Decimal(rate).times(100).toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  return `Sales tax ${pct}%`;
}

/**
 * The legacy item standing for a stored line rate (S5): made on first use;
 * two posts racing on a new rate make one (ON CONFLICT on the unique
 * (company_id, legacy_rate)). Never a 400 to the web.
 */
export async function legacyItemFor(executor: DbOrTx, tenantId: string, companyId: string, rate: string): Promise<ItemRow> {
  const r = new Decimal(rate).toFixed(TAX_RATE_PLACES);
  await executor.insert(salesTaxItems).values({ tenantId, companyId, kind: 'item', name: legacyItemName(r), rate: r, legacyRate: r })
    .onConflictDoNothing({ target: [salesTaxItems.companyId, salesTaxItems.legacyRate] });
  const [row] = await executor.select().from(salesTaxItems)
    .where(and(eq(salesTaxItems.companyId, companyId), eq(salesTaxItems.legacyRate, r))).limit(1);
  if (!row) throw AppError.internal('Legacy sales tax item missing');
  return row;
}

// ── Tax rows ────────────────────────────────────────────────────────

/** A row a writer computed for a document (E1b writers); the ledger adds ids, company and date. */
export interface TaxRowInput {
  kind?: 'sale' | 'discount' | 'bad_debt' | 'recovery';
  salesTaxId: string | null;
  taxItemId: string | null;
  agencyId: string | null;
  taxCodeId?: string | null;
  invoiceId?: string | null;
  applicationId?: string | null;
  rate: string | null;
  base: string;
  tax: string;
  eventDate?: string;
}

interface PostedLine {
  accountId: string;
  debit?: string | null;
  credit?: string | null;
  isTaxable?: boolean | null;
  taxRate?: string | null;
  taxAmount?: string | null;
  taxCodeId?: string | null;
}

/** The company rows are filed under: the document's, else the tenant's first company (as loadSalesCompany). */
export async function rowCompanyId(executor: DbOrTx, tenantId: string, companyId: string | null | undefined): Promise<string | null> {
  if (companyId) return companyId;
  const [first] = await executor.select({ id: companies.id }).from(companies).where(eq(companies.tenantId, tenantId))
    .orderBy(asc(companies.createdAt), asc(companies.id)).limit(1);
  return first?.id ?? null;
}

async function systemAccountIds(executor: DbOrTx, tenantId: string) {
  const rows = await executor.select({ id: accounts.id, tag: accounts.systemTag }).from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), inArray(accounts.systemTag, ['sales_tax_payable', 'accounts_receivable'])));
  return {
    stp: new Set(rows.filter((r) => r.tag === 'sales_tax_payable').map((r) => r.id)),
    ar: new Set(rows.filter((r) => r.tag === 'accounts_receivable').map((r) => r.id)),
  };
}

const d0 = (v: unknown) => new Decimal(v === null || v === undefined || v === '' ? '0' : String(v));

/**
 * Writes a posted transaction's tax rows in the posting's database
 * transaction (S3; called by ledger.postTransaction and updateTransaction
 * for every path). `explicit`: the rows a sales tax writer computed; else
 * rows are derived from the lines (legacy items per rate, unassigned for the
 * rest). Either way Σ rows.tax = the transaction's STP lines: a gap left by
 * explicit rows is an unassigned row too. Other transaction types and a
 * transaction with no STP line and no explicit rows get none.
 */
export async function writeTransactionTaxRows(
  tx: Tx, tenantId: string,
  txn: { id: string; txnType: string; txnDate: string; companyId: string | null; status: string; salesTaxId?: string | null },
  lines: readonly PostedLine[], explicit?: readonly TaxRowInput[] | null,
  memberRates?: ReadonlyArray<{ itemId: string; rate: string }> | null,
): Promise<void> {
  // The rates the document was computed with (its writer's), else the ones
  // its rows were written with (an edit keeps them, Q-P23i), else current.
  const saved = memberRates?.length ? new Map(memberRates.map((m) => [m.itemId, m.rate]))
    : txn.salesTaxId ? await savedMemberRates(tx, tenantId, txn.id, txn.salesTaxId) : new Map<string, string>();
  await tx.delete(transactionTaxLines).where(and(eq(transactionTaxLines.tenantId, tenantId), eq(transactionTaxLines.transactionId, txn.id),
    eq(transactionTaxLines.kind, 'sale')));
  if (!ROW_TYPES.has(txn.txnType) || txn.status !== 'posted') return;
  const sys = await systemAccountIds(tx, tenantId);
  const stp = lines.filter((l) => sys.stp.has(l.accountId)).reduce<DecimalValue>((s, l) => s.plus(d0(l.credit)).minus(d0(l.debit)), new Decimal(0));
  const hasSalesTax = !!txn.salesTaxId && txn.txnType !== 'daily_sales';
  if (stp.isZero() && !explicit?.length && !hasSalesTax) return;
  const companyId = await rowCompanyId(tx, tenantId, txn.companyId);
  if (!companyId) return;
  const rows: Array<typeof transactionTaxLines.$inferInsert> = [];
  const base = { tenantId, companyId, transactionId: txn.id, kind: 'sale' as const, eventDate: txn.txnDate };
  const isItemLine = (l: PostedLine) => !sys.stp.has(l.accountId) && !sys.ar.has(l.accountId);
  if (explicit?.length) {
    for (const r of explicit) {
      rows.push({
        ...base, kind: r.kind ?? 'sale', eventDate: r.eventDate ?? txn.txnDate, salesTaxId: r.salesTaxId, taxItemId: r.taxItemId,
        agencyId: r.agencyId, taxCodeId: r.taxCodeId ?? null, invoiceId: r.invoiceId ?? null, applicationId: r.applicationId ?? null,
        rate: r.rate, base: d0(r.base).toFixed(4), tax: d0(r.tax).toFixed(4),
      });
    }
  } else if (hasSalesTax) {
    // One sales tax for the document (Q-P23d): the STP tax over its items by
    // largest remainder of base x item rate (as the document compute did).
    const unit = await loadUnit(tx, tenantId, companyId, txn.salesTaxId!);
    if (unit) {
      const members = unit.members.map((m) => ({ ...m, rate: saved.get(m.itemId) ?? m.rate }));
      let taxBase = lines.filter((l) => l.isTaxable && isItemLine(l)).reduce<DecimalValue>((s, l) => s.plus(d0(l.credit)).minus(d0(l.debit)), new Decimal(0));
      if (stp.isZero() && taxBase.isNegative()) taxBase = new Decimal(0);
      const shares = splitTax(members.map((m) => taxBase.times(m.rate)), members.map((m) => new Decimal(m.rate)), stp);
      members.forEach((m, k) => rows.push({
        ...base, salesTaxId: unit.id, taxItemId: m.itemId, agencyId: m.agencyId, rate: new Decimal(m.rate).toFixed(TAX_RATE_PLACES),
        base: taxBase.toFixed(4), tax: shares[k]!.toFixed(4),
      }));
      // Non-taxable lines by code, under every item (tax 0): the nonTaxable column.
      const byCode = new Map<string, DecimalValue>();
      for (const l of lines) {
        if (l.isTaxable || !l.taxCodeId || !isItemLine(l)) continue;
        byCode.set(l.taxCodeId, (byCode.get(l.taxCodeId) ?? new Decimal(0)).plus(d0(l.credit)).minus(d0(l.debit)));
      }
      for (const [codeId, amount] of byCode) {
        if (amount.isZero()) continue;
        for (const m of members) {
          rows.push({ ...base, salesTaxId: unit.id, taxItemId: m.itemId, agencyId: m.agencyId, taxCodeId: codeId, rate: new Decimal(m.rate).toFixed(TAX_RATE_PLACES), base: amount.toFixed(4), tax: '0' });
        }
      }
    }
  } else if (txn.txnType !== 'daily_sales') {
    // The legacy path: taxable lines grouped by their stored rate.
    const sign = txn.txnType === 'credit_memo' ? -1 : 1;
    const byRate = new Map<string, { base: DecimalValue; tax: DecimalValue }>();
    for (const l of lines) {
      if (!l.isTaxable || !isItemLine(l)) continue;
      const rate = d0(l.taxRate);
      if (!rate.greaterThan(0) || rate.greaterThanOrEqualTo(1)) continue;
      const key = rate.toFixed(TAX_RATE_PLACES);
      const g = byRate.get(key) ?? { base: new Decimal(0), tax: new Decimal(0) };
      g.base = g.base.plus(d0(l.credit)).minus(d0(l.debit));
      g.tax = g.tax.plus(d0(l.taxAmount).times(sign));
      byRate.set(key, g);
    }
    for (const [rate, g] of [...byRate.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const item = await legacyItemFor(tx, tenantId, companyId, rate);
      rows.push({ ...base, salesTaxId: item.id, taxItemId: item.id, agencyId: item.agencyId ?? null, rate, base: g.base.toFixed(4), tax: g.tax.toFixed(4) });
    }
  }
  const explained = rows.reduce<DecimalValue>((s, r) => s.plus(d0(r.tax)), new Decimal(0));
  const gap = stp.minus(explained);
  if (!gap.isZero()) rows.push({ ...base, salesTaxId: null, taxItemId: null, agencyId: null, rate: null, base: '0', tax: gap.toFixed(4) });
  if (rows.length) await tx.insert(transactionTaxLines).values(rows);
}

/** allocateCents of the exact shares; when stored rates no longer explain the tax, the tax split by rate instead (always in range). */
function splitTax(shares: DecimalValue[], rates: DecimalValue[], tax: DecimalValue): DecimalValue[] {
  if (shares.length === 0) return [];
  try {
    return allocateCents(shares, tax);
  } catch {
    const total = rates.reduce((s, r) => s.plus(r), new Decimal(0));
    const scaled = total.isZero() ? rates.map((_, k) => (k === 0 ? tax : new Decimal(0))) : rates.map((r) => tax.times(r).dividedBy(total));
    return allocateCents(scaled, tax);
  }
}

/** taxItemId -> rate of a transaction's sale rows for its sales tax (an edit keeps them unless the sales tax changes or useCurrentRates). */
export async function savedMemberRates(executor: DbOrTx, tenantId: string, txnId: string, salesTaxId: string): Promise<Map<string, string>> {
  const rows = await executor.select({ itemId: transactionTaxLines.taxItemId, rate: transactionTaxLines.rate }).from(transactionTaxLines)
    .where(and(eq(transactionTaxLines.tenantId, tenantId), eq(transactionTaxLines.transactionId, txnId), eq(transactionTaxLines.kind, 'sale'),
      eq(transactionTaxLines.salesTaxId, salesTaxId)));
  const out = new Map<string, string>();
  for (const r of rows) if (r.itemId && r.rate != null) out.set(r.itemId, new Decimal(r.rate).toFixed(TAX_RATE_PLACES));
  return out;
}

export interface LoadedUnit {
  id: string; name: string; kind: string; isActive: boolean;
  members: Array<{ itemId: string; name: string; rate: string; agencyId: string | null; isActive: boolean }>;
}

/** A sales tax item or group of the company with its members (current rates); null when not found. */
export async function loadUnit(executor: DbOrTx, tenantId: string, companyId: string, id: string): Promise<LoadedUnit | null> {
  const [row] = await executor.select().from(salesTaxItems)
    .where(and(eq(salesTaxItems.tenantId, tenantId), eq(salesTaxItems.companyId, companyId), eq(salesTaxItems.id, id))).limit(1);
  if (!row) return null;
  const items = row.kind === 'group' ? (await membersOf(executor, companyId, [id])).get(id) ?? [] : [row];
  return {
    id: row.id, name: row.name, kind: row.kind, isActive: row.isActive,
    members: items.map((m) => ({ itemId: m.id, name: m.name, rate: new Decimal(m.rate ?? '0').toFixed(TAX_RATE_PLACES), agencyId: m.agencyId ?? null, isActive: m.isActive })),
  };
}

// ── Document resolution (U-147, sales-tax-setup-v1) ──────────────────

export interface DocTaxLineInput {
  taxRate?: unknown;
  taxCodeId?: string | null;
  /** The line's taxable flag as resolved today (the request's, else the item's). */
  isTaxable: boolean;
  itemTaxCodeId?: string | null;
  isSubtotal?: boolean;
}

export interface DocTaxCode { id: string; code: string; taxable: boolean; source: 'request' | 'client' | 'item' | 'is_taxable' | 'default' }

export interface DocTaxResolution {
  /** null: the legacy path (line rates / the company default rate) or no tax. */
  unit: (SalesTaxUnit & { name: string; kind: string }) | null;
  salesTaxId: string | null;
  /** Per line on the sales tax path; null on the legacy path. */
  codes: Array<DocTaxCode | null> | null;
  /** No tax at all: tax is off, or the document says none (salesTaxId null). */
  noTax: boolean;
  problems: Array<{ code: string; message: string; details?: Record<string, unknown> }>;
}

type SalesTaxUnit = import('../utils/sales-compute.js').SalesTaxUnit;

const present = (v: unknown) => v !== undefined && v !== null && v !== '';

/**
 * The document's sales tax and line codes (Q-P23d, Q-P23k, S5):
 * - a line taxRate selects the legacy path (never a 400 to MyBooks Online);
 *   with salesTaxId as well it is 400 TAX_RATE_WITH_SALES_TAX;
 * - else request salesTaxId (null = none) -> the edited document's -> the
 *   client's default -> the company's; none -> the legacy path with the
 *   company default rate; tax off (salesTaxEnabled false) -> no tax
 *   (salesTaxId sent is 400 SALES_TAX_OFF);
 * - an inactive sales tax is 400 TAX_ITEM_INACTIVE when it is new to the
 *   document; an edit keeps its saved member rates unless the sales tax
 *   changes or useCurrentRates (Q-P23i; problem RATE_CHANGED);
 * - line code: the line's, else the client's non-taxable code, else the
 *   item's, else the taxable flag (Tax / Non); a subtotal line is Non.
 */
export async function resolveDocumentTax(
  executor: DbOrTx, tenantId: string, companyIdIn: string | null | undefined,
  company: { salesTaxEnabled?: boolean | null; defaultSalesTaxId?: string | null } | null,
  customer: { defaultSalesTaxId?: string | null; taxCodeId?: string | null } | null,
  input: { salesTaxId?: string | null; useCurrentRates?: boolean; lines: readonly DocTaxLineInput[] },
  existing?: { id: string; salesTaxId: string | null } | null,
): Promise<DocTaxResolution> {
  const legacy = input.lines.some((l) => present(l.taxRate));
  const off = company?.salesTaxEnabled === false;
  const out: DocTaxResolution = { unit: null, salesTaxId: null, codes: null, noTax: false, problems: [] };
  if (legacy && present(input.salesTaxId)) {
    throw AppError.badRequest('Send a sales tax (salesTaxId) or line tax rates, not both.', 'TAX_RATE_WITH_SALES_TAX');
  }
  if (off && present(input.salesTaxId)) throw AppError.badRequest('Sales tax is turned off for this company.', 'SALES_TAX_OFF');
  if (legacy) return out;
  if (off || input.salesTaxId === null) { out.noTax = true; return out; }
  const companyId = await rowCompanyId(executor, tenantId, companyIdIn);
  const id = input.salesTaxId ?? existing?.salesTaxId ?? customer?.defaultSalesTaxId ?? company?.defaultSalesTaxId ?? null;
  if (!id || !companyId) return out;
  const unit = await loadUnit(executor, tenantId, companyId, id);
  if (!unit) throw AppError.badRequest('Choose a sales tax item or group of this company.', 'VALIDATION_ERROR', { field: 'salesTaxId' });
  const isNew = !existing || existing.salesTaxId !== id;
  if (isNew && (!unit.isActive || unit.members.some((m) => !m.isActive))) {
    throw AppError.badRequest(`The sales tax "${unit.name}" is inactive; choose another.`, 'TAX_ITEM_INACTIVE', { salesTaxId: id });
  }
  let members = unit.members.map((m) => ({ itemId: m.itemId, rate: m.rate }));
  if (!isNew && existing) {
    const saved = await savedMemberRates(executor, tenantId, existing.id, id);
    if (saved.size > 0) {
      const changed = members.some((m) => saved.has(m.itemId) && saved.get(m.itemId) !== m.rate);
      if (changed && !input.useCurrentRates) {
        members = members.map((m) => ({ itemId: m.itemId, rate: saved.get(m.itemId) ?? m.rate }));
        out.problems.push({ code: 'RATE_CHANGED', message: 'A rate changed since this document was saved; it keeps its saved rates unless useCurrentRates is sent.' });
      }
    }
  }
  out.unit = { id: unit.id, name: unit.name, kind: unit.kind, members };
  out.salesTaxId = unit.id;
  const sys = await ensureSystemCodes(executor, tenantId, companyId);
  const codeIds = [...new Set([
    ...input.lines.flatMap((l) => [l.taxCodeId, l.itemTaxCodeId]), customer?.taxCodeId,
  ].filter((v): v is string => !!v))];
  const codeRows = codeIds.length === 0 ? [] : await executor.select().from(salesTaxCodes)
    .where(and(eq(salesTaxCodes.tenantId, tenantId), eq(salesTaxCodes.companyId, companyId), inArray(salesTaxCodes.id, codeIds)));
  const byId = new Map(codeRows.map((r) => [r.id, r]));
  const clientCode = customer?.taxCodeId ? byId.get(customer.taxCodeId) : undefined;
  out.codes = input.lines.map((l, i) => {
    if (l.isSubtotal) return { id: sys.non.id, code: sys.non.code, taxable: false, source: 'default' };
    if (l.taxCodeId) {
      const r = byId.get(l.taxCodeId);
      if (!r) throw AppError.badRequest(`lines[${i}].taxCodeId is not a tax code of this company`, 'VALIDATION_ERROR', { line: i });
      return { id: r.id, code: r.code, taxable: r.taxable, source: 'request' };
    }
    if (clientCode && !clientCode.taxable) return { id: clientCode.id, code: clientCode.code, taxable: false, source: 'client' };
    const ic = l.itemTaxCodeId ? byId.get(l.itemTaxCodeId) : undefined;
    if (ic) return { id: ic.id, code: ic.code, taxable: ic.taxable, source: 'item' };
    const f = l.isTaxable ? sys.tax : sys.non;
    return { id: f.id, code: f.code, taxable: f.taxable, source: 'is_taxable' };
  });
  return out;
}

/**
 * A posted document's sales tax for responses (U-147): {id, name, kind,
 * rate, members [{id, name, rate, tax}]} from its rows (members' tax signed
 * as stored: a credit memo's is negative); null without a sales tax.
 */
export async function documentSalesTax(executor: DbOrTx, tenantId: string, txn: { id: string; salesTaxId?: string | null; companyId: string | null }) {
  if (!txn.salesTaxId) return null;
  const companyId = await rowCompanyId(executor, tenantId, txn.companyId);
  if (!companyId) return null;
  const unit = await loadUnit(executor, tenantId, companyId, txn.salesTaxId);
  if (!unit) return null;
  const rows = await executor.select().from(transactionTaxLines)
    .where(and(eq(transactionTaxLines.tenantId, tenantId), eq(transactionTaxLines.transactionId, txn.id), eq(transactionTaxLines.kind, 'sale'),
      eq(transactionTaxLines.salesTaxId, txn.salesTaxId)));
  const members = unit.members.map((m) => {
    const mine = rows.filter((r) => r.taxItemId === m.itemId && !r.taxCodeId);
    const rate = mine[0]?.rate != null ? new Decimal(mine[0].rate).toFixed(TAX_RATE_PLACES) : m.rate;
    return { id: m.itemId, name: m.name, rate, tax: mine.reduce((s, r) => s.plus(r.tax), new Decimal(0)).toFixed(2) };
  });
  return {
    id: unit.id, name: unit.name, kind: unit.kind,
    rate: members.reduce((s, m) => s.plus(m.rate), new Decimal(0)).toFixed(TAX_RATE_PLACES), members,
  };
}

/** Computed figures as the response's salesTax (preview / POST): names from the unit. */
export function computedSalesTax(
  unit: (SalesTaxUnit & { name: string; kind: string }) | null, names: Map<string, string>,
  members: Array<{ itemId: string; rate: string; tax: string }> | undefined, sign = 1,
) {
  if (!unit || !members) return null;
  return {
    id: unit.id, name: unit.name, kind: unit.kind,
    rate: unit.members.reduce((s, m) => s.plus(m.rate), new Decimal(0)).toFixed(TAX_RATE_PLACES),
    members: members.map((m) => ({ id: m.itemId, name: names.get(m.itemId) ?? null, rate: m.rate, tax: new Decimal(m.tax).times(sign).toFixed(2) })),
  };
}

/** Line codes of a posted document for GET: journal line tax_code_id -> {id, code, taxable}. */
export async function codesById(executor: DbOrTx, tenantId: string, ids: Array<string | null | undefined>) {
  const list = [...new Set(ids.filter((v): v is string => !!v))];
  const rows = list.length === 0 ? [] : await executor.select().from(salesTaxCodes).where(and(eq(salesTaxCodes.tenantId, tenantId), inArray(salesTaxCodes.id, list)));
  return new Map(rows.map((r) => [r.id, { id: r.id, code: r.code, taxable: r.taxable }]));
}
/** A void removes the transaction's tax rows (its STP lines are reversed with it). */
export async function deleteTransactionTaxRows(tx: Tx, tenantId: string, txnId: string): Promise<void> {
  await tx.delete(transactionTaxLines).where(and(eq(transactionTaxLines.tenantId, tenantId), eq(transactionTaxLines.transactionId, txnId)));
  await tx.delete(salesTaxPaymentLines).where(and(eq(salesTaxPaymentLines.tenantId, tenantId), eq(salesTaxPaymentLines.transactionId, txnId)));
}

/** Runs migration 0252's backfill for one company (a pre-0252 archive import, tests). */
export async function backfillCompany(executor: DbOrTx, tenantId: string, companyId: string): Promise<Record<string, unknown>> {
  const res = await executor.execute(sql`SELECT sales_tax_backfill_company(${tenantId}::uuid, ${companyId}::uuid) AS r`);
  const r = (res.rows as Array<{ r: Record<string, unknown> }>)[0]!.r;
  await auditLog(tenantId, 'create', 'sales_tax_backfill', companyId, null, r, undefined, executor);
  return r;
}

/**
 * A client's or item's sales tax references (U-147): defaultSalesTaxId an
 * active item or group, taxCodeId an active code, of the record's company
 * (any company of the tenant when the record has none); else 400 VALIDATION_ERROR.
 */
export async function assertTaxRefs(
  executor: DbOrTx, tenantId: string, companyId: string | null | undefined,
  refs: { defaultSalesTaxId?: string | null; taxCodeId?: string | null },
): Promise<void> {
  const inScope = (row: { companyId: string; isActive: boolean } | undefined) => !!row && row.isActive && (!companyId || row.companyId === companyId);
  if (refs.defaultSalesTaxId) {
    const [r] = await executor.select({ companyId: salesTaxItems.companyId, isActive: salesTaxItems.isActive }).from(salesTaxItems)
      .where(and(eq(salesTaxItems.tenantId, tenantId), eq(salesTaxItems.id, refs.defaultSalesTaxId))).limit(1);
    if (!inScope(r)) throw AppError.badRequest('Choose an active sales tax item or group of this company.', 'VALIDATION_ERROR', { field: 'defaultSalesTaxId' });
  }
  if (refs.taxCodeId) {
    const [r] = await executor.select({ companyId: salesTaxCodes.companyId, isActive: salesTaxCodes.isActive }).from(salesTaxCodes)
      .where(and(eq(salesTaxCodes.tenantId, tenantId), eq(salesTaxCodes.id, refs.taxCodeId))).limit(1);
    if (!inScope(r)) throw AppError.badRequest('Choose an active tax code of this company.', 'VALIDATION_ERROR', { field: 'taxCodeId' });
  }
}