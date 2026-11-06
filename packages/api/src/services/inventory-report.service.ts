// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Inventory reports (U-160, inventory-reports-v1) and reorder alerts (U-78,
 * reorder-alerts-v1). Every figure comes from the stock ledger
 * (inventory_movements, U-157): on hand and value as of a date are the
 * running figures of each part's latest live movement dated on or before it,
 * so the valuation equals the inventory asset accounts' accrual GL balance
 * by construction (I2); the summary shows that check per account. Amounts
 * are decimal strings (money 2 places, quantities 4, average cost 6), never
 * JS numbers. Quantities are in each part's base unit.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, type DbOrTx } from '../db/index.js';
import { accounts, companies, contacts, items } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { Decimal, type Dec } from '../utils/inventory-walk.js';
import { assertInventoryOn, INVENTORY_ASSET_TAG } from './inventory.service.js';
import { companyIdOf, stockAsOf } from './inventory-adjustment.service.js';
import { baseUnits, unitsById } from './units.service.js';

const money = (v: Dec) => v.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
const qty = (v: Dec) => v.toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4);
const cost6 = (v: Dec) => v.toDecimalPlaces(6, Decimal.ROUND_HALF_UP).toFixed(6);
const today = () => new Date().toISOString().slice(0, 10);

/** The average cost shown after a row: value / on hand while on hand is above 0, else the last positive average (as GET /items). */
function averageOf(onHand: Dec, value: Dec, lastCost: Dec): string {
  return cost6(onHand.greaterThan(0) ? value.dividedBy(onHand) : lastCost);
}

/** The cash-basis note of the valuation summary (N3, Q-P24m). */
export const CASH_BASIS_NOTE = 'This report shows inventory at average cost as of the date (accrual). On cash basis, the balance sheet and '
  + 'profit and loss show inventory and cost of goods sold only as the bills and invoices that moved them are paid, so they can differ '
  + 'from this report.';

interface PartInfo {
  id: string; name: string; description: string | null; isActive: boolean; assetAccountId: string | null;
  preferredVendorId: string | null; reorderPoint: string | null; reorderQuantity: string | null; unitLabel: string | null;
  unitSetId: string | null; defaultPurchaseUnitId: string | null;
}

/** The company's inventory parts (company-less rows count as the company's, as elsewhere), by name. */
async function partsOf(executor: DbOrTx, tenantId: string, companyId: string): Promise<PartInfo[]> {
  const rows = await executor.select({
    id: items.id, name: items.name, description: items.description, isActive: items.isActive, assetAccountId: items.assetAccountId,
    preferredVendorId: items.preferredVendorId, reorderPoint: items.reorderPoint, reorderQuantity: items.reorderQuantity,
    unitLabel: items.unitLabel, unitSetId: items.unitSetId, defaultPurchaseUnitId: items.defaultPurchaseUnitId, companyId: items.companyId,
  }).from(items).where(and(eq(items.tenantId, tenantId), eq(items.itemType, 'inventory_part'))).orderBy(items.name, items.id);
  return rows.filter((r) => !r.companyId || r.companyId === companyId).map((r) => ({ ...r, isActive: r.isActive !== false }));
}

async function vendorNames(executor: DbOrTx, tenantId: string, ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const want = [...new Set(ids.filter((v): v is string => !!v))];
  if (want.length === 0) return new Map();
  const rows = await executor.select({ id: contacts.id, name: contacts.displayName }).from(contacts)
    .where(and(eq(contacts.tenantId, tenantId), inArray(contacts.id, want)));
  return new Map(rows.map((r) => [r.id, r.name]));
}

async function scope(tenantId: string, companyId: string | undefined) {
  await assertInventoryOn(db, tenantId, companyId);
  return companyIdOf(db, tenantId, companyId);
}

// ─── Valuation summary ───────────────────────────────────────────────

export interface ValuationRow {
  itemId: string; name: string; description: string | null; assetAccountId: string | null; unitLabel: string | null;
  onHand: string; averageCost: string; value: string; percentOfTotal: string | null;
}
export interface ValuationAccount { accountId: string; name: string; valuation: string; glBalance: string; difference: string }
export interface ValuationSummary {
  title: string; asOf: string; basis: 'accrual'; rows: ValuationRow[]; accounts: ValuationAccount[]; totalValue: string; basisNote: string | null;
}

/**
 * GET /reports/inventory-valuation?asOf: one row per part (active parts, and
 * inactive ones still holding stock or value), and per inventory asset
 * account (tagged inventory_asset or named by a part) the valuation, the
 * accrual GL balance as of the date (posted lines dated on or before it) and
 * difference = glBalance - valuation ("0.00" unless a journal entry posted to
 * the account directly).
 */
export async function valuationSummary(tenantId: string, asOf: string, companyId?: string): Promise<ValuationSummary> {
  const co = await scope(tenantId, companyId);
  const parts = await partsOf(db, tenantId, co);
  const stock = await stockAsOf(db, tenantId, co, parts.map((p) => p.id), asOf);
  const zero = new Decimal(0);
  let total = zero;
  const byAccount = new Map<string, Dec>();
  const shown: Array<{ p: PartInfo; onHand: Dec; value: Dec; lastCost: Dec }> = [];
  for (const p of parts) {
    const s = stock.get(p.id) ?? { onHand: zero, value: zero, lastCost: zero };
    total = total.plus(s.value);
    if (p.assetAccountId) byAccount.set(p.assetAccountId, (byAccount.get(p.assetAccountId) ?? zero).plus(s.value));
    if (p.isActive || !s.onHand.isZero() || !s.value.isZero()) shown.push({ p, ...s });
  }
  const rows: ValuationRow[] = shown.map(({ p, onHand, value, lastCost }) => ({
    itemId: p.id, name: p.name, description: p.description ?? null, assetAccountId: p.assetAccountId, unitLabel: p.unitLabel ?? null,
    onHand: qty(onHand), averageCost: averageOf(onHand, value, lastCost), value: money(value),
    percentOfTotal: total.isZero() ? null : value.dividedBy(total).times(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2),
  }));

  // The inventory asset accounts of the company: tagged, or named by a part.
  const acctRows = await db.select({ id: accounts.id, name: accounts.name, companyId: accounts.companyId, systemTag: accounts.systemTag })
    .from(accounts).where(eq(accounts.tenantId, tenantId));
  const assetIds = new Set(parts.map((p) => p.assetAccountId).filter((v): v is string => !!v));
  const invAccounts = acctRows.filter((a) => (a.systemTag === INVENTORY_ASSET_TAG && (!a.companyId || a.companyId === co)) || assetIds.has(a.id))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  const gl = new Map<string, Dec>();
  if (invAccounts.length > 0) {
    const r = await db.execute(sql`
      SELECT jl.account_id::text AS account_id, COALESCE(SUM(jl.debit - jl.credit), 0)::text AS b
      FROM journal_lines jl JOIN transactions t ON t.id = jl.transaction_id
      WHERE jl.tenant_id = ${tenantId} AND t.status = 'posted' AND t.txn_date <= ${asOf}::date
        AND (t.company_id IS NULL OR t.company_id = ${co})
        AND jl.account_id IN (${sql.join(invAccounts.map((a) => sql`${a.id}::uuid`), sql`, `)})
      GROUP BY jl.account_id`);
    for (const row of r.rows as Array<{ account_id: string; b: string }>) gl.set(row.account_id, new Decimal(row.b));
  }
  const accts: ValuationAccount[] = invAccounts.map((a) => {
    const valuation = byAccount.get(a.id) ?? zero;
    const glBalance = gl.get(a.id) ?? zero;
    return { accountId: a.id, name: a.name, valuation: money(valuation), glBalance: money(glBalance), difference: money(glBalance.minus(valuation)) };
  });

  const [company] = await db.select({ method: companies.accountingMethod }).from(companies)
    .where(and(eq(companies.tenantId, tenantId), eq(companies.id, co))).limit(1);
  return {
    title: 'Inventory Valuation Summary', asOf, basis: 'accrual', rows, accounts: accts, totalValue: money(total),
    basisNote: company?.method === 'cash' ? CASH_BASIS_NOTE : null,
  };
}

// ─── Valuation detail ────────────────────────────────────────────────

export interface ValuationDetailRow {
  movementId: string; itemId: string; date: string; transactionId: string; txnType: string; txnNumber: string | null; kind: string;
  quantity: string; value: string; movementValue: string; correction: string; residual: string;
  runningQuantity: string; runningValue: string; averageCost: string;
}
export interface ValuationDetail {
  title: string; from: string; to: string; itemId: string | null;
  opening: Array<{ itemId: string; onHand: string; value: string }>;
  data: ValuationDetailRow[]; total: number;
}

/**
 * GET /reports/inventory-valuation-detail?from&to&itemId: every live
 * movement dated in the range, in position order (date, the document's
 * created_at, its id), with the running figures after it. value is the
 * row's whole effect on the asset account (movementValue + correction +
 * residual), so runningValue = the previous row's runningValue + value.
 * opening: each part's on hand and value just before `from`.
 */
export async function valuationDetail(tenantId: string, q: { from: string; to: string; itemId?: string | null; limit?: number; offset?: number },
  companyId?: string): Promise<ValuationDetail> {
  if (q.to < q.from) throw AppError.badRequest('to must be on or after from', 'VALIDATION_ERROR', { field: 'to' });
  const co = await scope(tenantId, companyId);
  const parts = await partsOf(db, tenantId, co);
  if (q.itemId && !parts.some((p) => p.id === q.itemId)) throw AppError.notFound('Inventory item not found');
  const ids = q.itemId ? [q.itemId] : parts.map((p) => p.id);
  if (ids.length === 0) return { title: 'Inventory Valuation Detail', from: q.from, to: q.to, itemId: q.itemId ?? null, opening: [], data: [], total: 0 };
  const idList = sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `);
  const where = sql`m.tenant_id = ${tenantId} AND m.company_id = ${co} AND m.voided = false AND m.item_id IN (${idList})
    AND m.movement_date >= ${q.from}::date AND m.movement_date <= ${q.to}::date`;
  const count = await db.execute(sql`SELECT COUNT(*)::int AS n FROM inventory_movements m WHERE ${where}`);
  const total = Number((count.rows[0] as { n: number }).n);
  const r = await db.execute(sql`
    SELECT m.id::text AS id, m.item_id::text AS item_id, m.movement_date::text AS date, m.transaction_id::text AS txn_id, m.kind,
      m.quantity::text AS q, m.value::text AS v, m.correction::text AS c, m.residual::text AS r,
      m.running_qty::text AS rq, m.running_value::text AS rv, m.last_cost::text AS l, t.txn_type, t.txn_number
    FROM inventory_movements m JOIN transactions t ON t.id = m.transaction_id
    WHERE ${where}
    ORDER BY m.movement_date, m.txn_created_at, m.transaction_id, m.item_id, m.id
    ${q.limit !== undefined ? sql`LIMIT ${q.limit}` : sql``} OFFSET ${q.offset ?? 0}`);
  const data = (r.rows as Array<Record<string, string>>).map((m) => {
    const v = new Decimal(m['v']!); const c = new Decimal(m['c']!); const res = new Decimal(m['r']!);
    const rq = new Decimal(m['rq']!); const rv = new Decimal(m['rv']!);
    return {
      movementId: m['id']!, itemId: m['item_id']!, date: String(m['date']).slice(0, 10), transactionId: m['txn_id']!, txnType: m['txn_type']!,
      txnNumber: m['txn_number'] ?? null, kind: m['kind']!, quantity: qty(new Decimal(m['q']!)),
      value: money(v.plus(c).plus(res)), movementValue: money(v), correction: money(c), residual: money(res),
      runningQuantity: qty(rq), runningValue: money(rv), averageCost: averageOf(rq, rv, new Decimal(m['l']!)),
    };
  });
  const before = new Date(`${q.from}T00:00:00Z`);
  before.setUTCDate(before.getUTCDate() - 1);
  const stock = await stockAsOf(db, tenantId, co, ids, before.toISOString().slice(0, 10));
  const opening = ids.filter((i) => stock.has(i)).map((i) => ({ itemId: i, onHand: qty(stock.get(i)!.onHand), value: money(stock.get(i)!.value) }));
  return { title: 'Inventory Valuation Detail', from: q.from, to: q.to, itemId: q.itemId ?? null, opening, data, total };
}

// ─── Stock status and reorder ────────────────────────────────────────

export interface StockStatusRow {
  itemId: string; name: string; description: string | null; unitLabel: string | null;
  /** U-161: the item's unit set and base unit name (quantities are in it); null without a set. */
  unitSetId: string | null; baseUnit: string | null;
  preferredVendorId: string | null; preferredVendor: { id: string; name: string } | null;
  reorderPoint: string | null; reorderQuantity: string | null; onHand: string; value: string; reorder: boolean;
}

async function statusRows(tenantId: string, co: string, asOf: string | null): Promise<StockStatusRow[]> {
  const parts = (await partsOf(db, tenantId, co)).filter((p) => p.isActive);
  const stock = await stockAsOf(db, tenantId, co, parts.map((p) => p.id), asOf);
  const vnames = await vendorNames(db, tenantId, parts.map((p) => p.preferredVendorId));
  const bases = await baseUnits(db, tenantId, parts.map((p) => p.unitSetId));
  const zero = new Decimal(0);
  return parts.map((p) => {
    const s = stock.get(p.id);
    const onHand = s?.onHand ?? zero;
    const point = p.reorderPoint === null ? null : new Decimal(p.reorderPoint);
    return {
      itemId: p.id, name: p.name, description: p.description ?? null, unitLabel: p.unitLabel ?? null,
      unitSetId: p.unitSetId, baseUnit: p.unitSetId ? bases.get(p.unitSetId)?.name ?? null : null,
      preferredVendorId: p.preferredVendorId,
      preferredVendor: p.preferredVendorId && vnames.has(p.preferredVendorId) ? { id: p.preferredVendorId, name: vnames.get(p.preferredVendorId)! } : null,
      reorderPoint: point === null ? null : qty(point), reorderQuantity: p.reorderQuantity === null ? null : qty(new Decimal(p.reorderQuantity)),
      onHand: qty(onHand), value: money(s?.value ?? zero), reorder: point !== null && onHand.lessThanOrEqualTo(point),
    };
  });
}

/** GET /reports/inventory-stock-status?asOf: every active part with on hand as of the date and whether it is at or below its reorder point. */
export async function stockStatus(tenantId: string, asOf: string, companyId?: string) {
  const co = await scope(tenantId, companyId);
  return { title: 'Inventory Stock Status', asOf, data: await statusRows(tenantId, co, asOf) };
}

/** GET /items/reorder-alerts: active parts with a reorder point whose on hand now (all dates) is at or below it. */
export async function reorderAlerts(tenantId: string, companyId?: string) {
  const co = await scope(tenantId, companyId);
  const data = (await statusRows(tenantId, co, null)).filter((r) => r.reorder);
  return { data, total: data.length };
}

/**
 * GET /reports/reorder: the reorder alerts as a report, with how many to order:
 * the reorder quantity (base unit) and, for an item with a default purchase
 * unit (U-161), the same in that unit, round4(reorderQuantity / factor).
 */
export async function reorderReport(tenantId: string, companyId?: string) {
  const co = await scope(tenantId, companyId);
  const rows = (await statusRows(tenantId, co, null)).filter((r) => r.reorder);
  const parts = new Map((await partsOf(db, tenantId, co)).map((p) => [p.id, p]));
  const purchase = await unitsById(db, tenantId, rows.map((r) => parts.get(r.itemId)?.defaultPurchaseUnitId));
  const data = rows.map((r) => {
    const u = purchase.get(parts.get(r.itemId)?.defaultPurchaseUnitId ?? '');
    return {
      ...r,
      purchaseUnit: u ? { id: u.id, name: u.name, abbreviation: u.abbreviation, factor: u.factor.toFixed(6) } : null,
      reorderQuantityInPurchaseUnit: u && r.reorderQuantity !== null ? qty(new Decimal(r.reorderQuantity).dividedBy(u.factor)) : null,
    };
  });
  return { title: 'Items to Reorder', asOf: today(), data };
}
