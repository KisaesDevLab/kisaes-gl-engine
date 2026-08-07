// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Groupings / leadsheets / tickmarks / notes (Phase 7). Groupings are
// persistent across years (D8) — membership lives on the account, not
// per tax year. Tickmark applications and notes ARE per tax year.

import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import {
  accounts, tbGroupingAccounts, tbGroupings, tbNotes, tbTickmarkApplications, tbTickmarks,
} from '../../db/schema/index.js';
import { AppError } from '../../utils/errors.js';
import { auditLog } from '../../middleware/audit.js';

// Seeded default leadsheet structure (plan §4.8). Account membership
// auto-assigns by account_type + detail_type heuristics on seed.
const DEFAULT_LEADSHEETS: Array<{ code: string; name: string; match: (type: string, detail: string | null) => boolean }> = [
  { code: 'A', name: 'Cash', match: (t, d) => t === 'asset' && (d === 'bank' || d === 'cash' || /cash|bank/.test(d ?? '')) },
  { code: 'B', name: 'Accounts Receivable', match: (t, d) => t === 'asset' && d === 'accounts_receivable' },
  { code: 'C', name: 'Inventory', match: (t, d) => t === 'asset' && /inventory/.test(d ?? '') },
  { code: 'D', name: 'Fixed Assets', match: (t, d) => t === 'asset' && /fixed|depreciation|property|equipment/.test(d ?? '') },
  { code: 'E', name: 'Other Assets', match: (t) => t === 'asset' },
  { code: 'F', name: 'Accounts Payable', match: (t, d) => t === 'liability' && d === 'accounts_payable' },
  { code: 'G', name: 'Accrued Liabilities', match: (t, d) => t === 'liability' && /accrued|payroll|tax/.test(d ?? '') },
  { code: 'H', name: 'Debt', match: (t, d) => t === 'liability' && /loan|note|mortgage|credit_card|line_of_credit/.test(d ?? '') },
  { code: 'I', name: 'Other Liabilities', match: (t) => t === 'liability' },
  { code: 'J', name: 'Equity', match: (t) => t === 'equity' },
  { code: 'K', name: 'Revenue', match: (t) => t === 'revenue' },
  { code: 'L', name: 'Cost of Goods Sold', match: (t, d) => t === 'cogs' || (t === 'expense' && /cogs|cost_of_goods/.test(d ?? '')) },
  { code: 'M', name: 'Operating Expenses', match: (t) => t === 'expense' },
  { code: 'N', name: 'Other Income', match: (t) => t === 'other_revenue' },
  { code: 'O', name: 'Other Expenses', match: (t) => t === 'other_expense' },
];

export async function listGroupings(tenantId: string, companyId: string) {
  const groupings = await db.select().from(tbGroupings)
    .where(and(eq(tbGroupings.tenantId, tenantId), eq(tbGroupings.companyId, companyId)))
    .orderBy(asc(tbGroupings.sortOrder), asc(tbGroupings.name));
  const memberships = groupings.length
    ? await db.select().from(tbGroupingAccounts)
      .where(and(eq(tbGroupingAccounts.tenantId, tenantId), eq(tbGroupingAccounts.companyId, companyId)))
    : [];
  return {
    groupings: groupings.map((g) => ({
      ...g,
      accountIds: memberships.filter((m) => m.groupingId === g.id).map((m) => m.accountId),
    })),
  };
}

// Seed the default leadsheet tree + auto-membership. Idempotent: does
// nothing when any grouping already exists.
export async function seedDefaultGroupings(tenantId: string, companyId: string, userId?: string) {
  const [existing] = await db.select({ id: tbGroupings.id }).from(tbGroupings)
    .where(and(eq(tbGroupings.tenantId, tenantId), eq(tbGroupings.companyId, companyId))).limit(1);
  if (existing) return { seeded: false as const };

  const accountRows = await db.select({
    id: accounts.id, accountType: accounts.accountType, detailType: accounts.detailType,
  }).from(accounts)
    .where(and(
      eq(accounts.tenantId, tenantId),
      sql`(${accounts.companyId} = ${companyId} OR ${accounts.companyId} IS NULL)`,
    ));

  await db.transaction(async (tx) => {
    for (let i = 0; i < DEFAULT_LEADSHEETS.length; i++) {
      const def = DEFAULT_LEADSHEETS[i]!;
      const [g] = await tx.insert(tbGroupings).values({
        tenantId, companyId, name: def.name, leadsheetCode: def.code, sortOrder: i * 10,
      }).returning();
      if (!g) continue;
      // First matching leadsheet wins (order encodes specificity).
      const members = accountRows.filter((a) => {
        const winner = DEFAULT_LEADSHEETS.find((d) => d.match(a.accountType, a.detailType));
        return winner?.code === def.code;
      });
      if (members.length) {
        await tx.insert(tbGroupingAccounts).values(members.map((a) => ({
          tenantId, companyId, groupingId: g.id, accountId: a.id,
        })));
      }
    }
    await auditLog(tenantId, 'create', 'tb_groupings_seed', companyId, null, { count: DEFAULT_LEADSHEETS.length }, userId, tx);
  });
  return { seeded: true as const };
}

export async function createGrouping(tenantId: string, companyId: string, input: { name: string; leadsheetCode?: string | null; parentId?: string | null; sortOrder?: number }, userId?: string) {
  if (input.parentId) {
    const [parent] = await db.select({ id: tbGroupings.id }).from(tbGroupings)
      .where(and(eq(tbGroupings.id, input.parentId), eq(tbGroupings.tenantId, tenantId), eq(tbGroupings.companyId, companyId))).limit(1);
    if (!parent) throw AppError.notFound('Parent grouping not found');
  }
  const [g] = await db.insert(tbGroupings).values({
    tenantId, companyId,
    name: input.name,
    leadsheetCode: input.leadsheetCode ?? null,
    parentId: input.parentId ?? null,
    sortOrder: input.sortOrder ?? 0,
  }).returning();
  if (!g) throw AppError.internal('Grouping insert failed');
  await auditLog(tenantId, 'create', 'tb_grouping', g.id, null, g, userId);
  return g;
}

export async function updateGrouping(tenantId: string, companyId: string, id: string, input: { name?: string; leadsheetCode?: string | null; sortOrder?: number }, userId?: string) {
  const [before] = await db.select().from(tbGroupings)
    .where(and(eq(tbGroupings.id, id), eq(tbGroupings.tenantId, tenantId), eq(tbGroupings.companyId, companyId))).limit(1);
  if (!before) throw AppError.notFound('Grouping not found');
  const [after] = await db.update(tbGroupings).set({
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.leadsheetCode !== undefined ? { leadsheetCode: input.leadsheetCode } : {}),
    ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
  }).where(eq(tbGroupings.id, id)).returning();
  await auditLog(tenantId, 'update', 'tb_grouping', id, before, after ?? null, userId);
  return after;
}

export async function deleteGrouping(tenantId: string, companyId: string, id: string, userId?: string) {
  const [before] = await db.select().from(tbGroupings)
    .where(and(eq(tbGroupings.id, id), eq(tbGroupings.tenantId, tenantId), eq(tbGroupings.companyId, companyId))).limit(1);
  if (!before) throw AppError.notFound('Grouping not found');
  // Membership + sign-offs cascade via FK; accounts return to "ungrouped".
  await db.delete(tbGroupings).where(eq(tbGroupings.id, id));
  await auditLog(tenantId, 'delete', 'tb_grouping', id, before, null, userId);
}

// Move an account into a grouping (or out of all, groupingId=null).
export async function setAccountGrouping(tenantId: string, companyId: string, accountId: string, groupingId: string | null, userId?: string) {
  return db.transaction(async (tx) => {
    await tx.delete(tbGroupingAccounts)
      .where(and(eq(tbGroupingAccounts.companyId, companyId), eq(tbGroupingAccounts.accountId, accountId)));
    if (groupingId) {
      const [g] = await tx.select({ id: tbGroupings.id }).from(tbGroupings)
        .where(and(eq(tbGroupings.id, groupingId), eq(tbGroupings.companyId, companyId))).limit(1);
      if (!g) throw AppError.notFound('Grouping not found');
      await tx.insert(tbGroupingAccounts).values({ tenantId, companyId, groupingId, accountId });
    }
    await auditLog(tenantId, 'update', 'tb_grouping_membership', accountId, null, { groupingId }, userId, tx);
  });
}

// ── Tickmarks (7.3) ─────────────────────────────────────────────────

// Standards from the Vibe TB library (docs/tb/ui-examples image5).
const STANDARD_TICKMARKS: Array<[string, string, string | null]> = [
  ['✓', 'Verified and agreed', 'gray'],
  ['A', 'Agreed to bank statement', 'green'],
  ['B', 'Agreed to prior year tax return', 'blue'],
  ['C', 'Agreed to client-provided schedule', 'blue'],
  ['D', 'Agreed to depreciation schedule', 'blue'],
  ['F', 'Footed / cross-footed', 'gray'],
  ['G', 'Agreed to general ledger', 'green'],
  ['P', 'Agreed to prior year workpapers', 'purple'],
  ['R', 'Reviewed by preparer', 'purple'],
  ['T', 'Traced to supporting schedule', 'purple'],
  ['N', 'See preparer note', 'yellow'],
  ['†', 'See footnote / explanation required', 'red'],
];

export async function listTickmarks(tenantId: string) {
  const marks = await db.select().from(tbTickmarks)
    .where(eq(tbTickmarks.tenantId, tenantId))
    .orderBy(asc(tbTickmarks.sortOrder), asc(tbTickmarks.symbol));
  return marks;
}

export async function seedStandardTickmarks(tenantId: string, userId?: string) {
  const existing = await listTickmarks(tenantId);
  const have = new Set(existing.map((m) => m.symbol));
  const missing = STANDARD_TICKMARKS.filter(([sym]) => !have.has(sym));
  if (missing.length === 0) return { seeded: 0 };
  await db.insert(tbTickmarks).values(missing.map(([symbol, description, color], i) => ({
    tenantId, symbol, description, color, sortOrder: existing.length + i + 1,
  })));
  await auditLog(tenantId, 'create', 'tb_tickmarks_seed', tenantId, null, { count: missing.length }, userId);
  return { seeded: missing.length };
}

export async function saveTickmark(tenantId: string, input: { id?: string; symbol: string; description: string; color?: string | null; sortOrder?: number }, userId?: string) {
  if (input.id) {
    const [before] = await db.select().from(tbTickmarks)
      .where(and(eq(tbTickmarks.id, input.id), eq(tbTickmarks.tenantId, tenantId))).limit(1);
    if (!before) throw AppError.notFound('Tickmark not found');
    const [after] = await db.update(tbTickmarks).set({
      symbol: input.symbol, description: input.description,
      color: input.color ?? null, sortOrder: input.sortOrder ?? before.sortOrder,
    }).where(eq(tbTickmarks.id, input.id)).returning();
    await auditLog(tenantId, 'update', 'tb_tickmark', input.id, before, after ?? null, userId);
    return after;
  }
  const [row] = await db.insert(tbTickmarks).values({
    tenantId, symbol: input.symbol, description: input.description,
    color: input.color ?? null, sortOrder: input.sortOrder ?? 0,
  }).returning();
  if (!row) throw AppError.internal('Tickmark insert failed');
  await auditLog(tenantId, 'create', 'tb_tickmark', row.id, null, row, userId);
  return row;
}

export async function deleteTickmark(tenantId: string, id: string, userId?: string) {
  const [before] = await db.select().from(tbTickmarks)
    .where(and(eq(tbTickmarks.id, id), eq(tbTickmarks.tenantId, tenantId))).limit(1);
  if (!before) throw AppError.notFound('Tickmark not found');
  await db.delete(tbTickmarks).where(eq(tbTickmarks.id, id)); // applications cascade
  await auditLog(tenantId, 'delete', 'tb_tickmark', id, before, null, userId);
}

export async function listTickmarkApplications(tenantId: string, companyId: string, taxYear: number) {
  return db.select().from(tbTickmarkApplications)
    .where(and(
      eq(tbTickmarkApplications.tenantId, tenantId),
      eq(tbTickmarkApplications.companyId, companyId),
      eq(tbTickmarkApplications.taxYear, taxYear),
    ));
}

export async function applyTickmark(tenantId: string, companyId: string, input: { taxYear: number; accountId: string; column: string; tickmarkId: string; note?: string | null }, userId?: string) {
  const [mark] = await db.select({ id: tbTickmarks.id }).from(tbTickmarks)
    .where(and(eq(tbTickmarks.id, input.tickmarkId), eq(tbTickmarks.tenantId, tenantId))).limit(1);
  if (!mark) throw AppError.notFound('Tickmark not found');
  const [acct] = await db.select({ id: accounts.id }).from(accounts)
    .where(and(eq(accounts.tenantId, tenantId), eq(accounts.id, input.accountId))).limit(1);
  if (!acct) throw AppError.notFound('Account not found');
  const [row] = await db.insert(tbTickmarkApplications).values({
    tenantId, companyId,
    taxYear: input.taxYear,
    accountId: input.accountId,
    column: input.column,
    tickmarkId: input.tickmarkId,
    note: input.note ?? null,
    appliedBy: userId ?? null,
  }).returning();
  if (!row) throw AppError.internal('Tickmark application failed');
  return row;
}

export async function removeTickmarkApplication(tenantId: string, companyId: string, id: string) {
  await db.delete(tbTickmarkApplications)
    .where(and(
      eq(tbTickmarkApplications.id, id),
      eq(tbTickmarkApplications.tenantId, tenantId),
      eq(tbTickmarkApplications.companyId, companyId),
    ));
}

// ── Notes (7.4) ─────────────────────────────────────────────────────

export async function listNotes(tenantId: string, companyId: string, taxYear: number) {
  return db.select().from(tbNotes)
    .where(and(eq(tbNotes.tenantId, tenantId), eq(tbNotes.companyId, companyId), eq(tbNotes.taxYear, taxYear)))
    .orderBy(asc(tbNotes.createdAt));
}

export async function createNote(tenantId: string, companyId: string, input: { taxYear: number; accountId?: string | null; body: string }, userId?: string) {
  if (input.accountId) {
    const [acct] = await db.select({ id: accounts.id }).from(accounts)
      .where(and(eq(accounts.tenantId, tenantId), eq(accounts.id, input.accountId))).limit(1);
    if (!acct) throw AppError.notFound('Account not found');
  }
  const [row] = await db.insert(tbNotes).values({
    tenantId, companyId,
    taxYear: input.taxYear,
    accountId: input.accountId ?? null,
    body: input.body,
    authorId: userId ?? null,
  }).returning();
  if (!row) throw AppError.internal('Note insert failed');
  return row;
}

export async function resolveNote(tenantId: string, companyId: string, id: string, resolved: boolean, userId?: string) {
  const [row] = await db.update(tbNotes).set({
    resolvedAt: resolved ? new Date() : null,
    resolvedBy: resolved ? userId ?? null : null,
    updatedAt: new Date(),
  }).where(and(eq(tbNotes.id, id), eq(tbNotes.tenantId, tenantId), eq(tbNotes.companyId, companyId)))
    .returning();
  if (!row) throw AppError.notFound('Note not found');
  return row;
}

export async function deleteNote(tenantId: string, companyId: string, id: string) {
  await db.delete(tbNotes)
    .where(and(eq(tbNotes.id, id), eq(tbNotes.tenantId, tenantId), eq(tbNotes.companyId, companyId)));
}

// Accounts lookup for the grouping editor (id, number, name, type).
export async function listAccountsForGrouping(tenantId: string, companyId: string) {
  return db.select({
    id: accounts.id,
    accountNumber: accounts.accountNumber,
    name: accounts.name,
    accountType: accounts.accountType,
  }).from(accounts)
    .where(and(
      eq(accounts.tenantId, tenantId),
      sql`(${accounts.companyId} = ${companyId} OR ${accounts.companyId} IS NULL)`,
      sql`${accounts.isActive} IS DISTINCT FROM FALSE`,
    ))
    .orderBy(asc(accounts.accountNumber), asc(accounts.name));
}

