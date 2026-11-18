// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// Item lists and inventory valuations (U-265, qbd-mapping-v1), from
// QuickBooks Desktop (Latin-1 CSV), QuickBooks Online and the Generic template
// (CSV or .xlsx, raw number cells). One parser per kind; columns are found by
// name (several labels each), so the same code reads every source.
//
// items: Item (or Name / Product/Service), Type (required); Description,
// Purchase Description, Price, Cost, Account, Expense Account, COGS Account,
// Asset Account, Preferred Vendor, Sales Tax Code, Active Status, Reorder Pt
// (optional). The Type maps through ITEM_TYPE_MAP; sales tax items, groups and
// payment items are listed but not imported; an unknown Type is a row error.
//
// inventory_valuation (QuickBooks Desktop Inventory Valuation Summary): the
// item (an Item column, else the headings in the leading columns, a
// sub-item as "Parent:Sub"), On Hand and Asset Value, exactly as printed, as
// of the report's "As of" date. Never quantity x average cost (the Avg Cost
// column is not read).

import {
  ITEM_TYPE_MAP,
  type CanonicalItemRow,
  type CanonicalValuationRow,
  type ImportValidationError,
  type SourceSystem,
} from '@kis-books/shared';
import { Decimal, importAmountError, importAmountText, isImportAmount, parseImportAmount } from '../import-amount.js';
import { readGrid, scrapeReportDate } from './open-items.js';
import { splitQbdAccount } from './quickbooks-desktop.js';

const norm = (c: string | undefined) => (c ?? '').trim().toLowerCase();

function colAny(header: string[], labels: readonly string[]): number {
  for (const l of labels) {
    const i = header.findIndex((c) => norm(c) === l);
    if (i !== -1) return i;
  }
  return -1;
}

function findHeader(grid: string[][], required: ReadonlyArray<readonly string[]>): number {
  for (let i = 0; i < grid.length; i++) {
    const h = grid[i] ?? [];
    if (required.every((labels) => colAny(h, labels) !== -1)) return i;
  }
  return -1;
}

// ── Items ─────────────────────────────────────────────────────────

const ITEM_LABELS = {
  name: ['item', 'item name', 'name', 'product/service', 'product/service name'],
  type: ['type', 'item type'],
  description: ['description', 'sales description'],
  purchaseDescription: ['purchase description', 'purchase desc.', 'purchase desc'],
  price: ['price', 'sales price', 'sales price / rate', 'rate', 'unit price'],
  cost: ['cost', 'purchase cost'],
  income: ['account', 'income account'],
  expense: ['expense account'],
  cogs: ['cogs account', 'cost of goods sold account'],
  asset: ['asset account', 'inventory asset account'],
  vendor: ['preferred vendor', 'vendor'],
  tax: ['sales tax code', 'tax code', 'taxable'],
  active: ['active status', 'active', 'status'],
  reorder: ['reorder pt (min)', 'reorder pt', 'reorder point'],
} as const;

function accountRef(raw: string | undefined): { accountNumber?: string; accountName?: string } | undefined {
  const s = (raw ?? '').trim();
  if (!s) return undefined;
  const parts = splitQbdAccount(s);
  return parts.accountNumber || parts.accountName ? parts : undefined;
}

/** "Tax", "Yes", "true", "Taxable" are taxable; "Non", "No", "false", "Exempt" are not; blank: unknown. */
function taxable(raw: string | undefined): boolean | undefined {
  const t = norm(raw);
  if (!t) return undefined;
  if (['tax', 'yes', 'y', 'true', 'taxable'].includes(t)) return true;
  if (['non', 'no', 'n', 'false', 'exempt', 'non-taxable', 'nontaxable'].includes(t)) return false;
  return undefined;
}

/** "Inactive" (Active Status), "No"/"false" (an Active column): inactive. */
function active(raw: string | undefined): boolean {
  const t = norm(raw);
  return !['inactive', 'no', 'n', 'false'].includes(t);
}

export async function parseItems(
  buf: Buffer,
  sourceSystem: SourceSystem,
): Promise<{ rows: CanonicalItemRow[]; errors: ImportValidationError[] }> {
  const grid = await readGrid(buf, sourceSystem);
  const rows: CanonicalItemRow[] = [];
  const errors: ImportValidationError[] = [];
  const headerIdx = findHeader(grid, [ITEM_LABELS.name, ITEM_LABELS.type]);
  if (headerIdx === -1) {
    errors.push({
      rowNumber: 0, code: 'IMPORT_HEADER_NOT_FOUND',
      message: 'Could not find the item list columns (Item, Type). Did you upload the right list?',
    });
    return { rows, errors };
  }
  const h = grid[headerIdx]!;
  const col = Object.fromEntries(Object.entries(ITEM_LABELS).map(([k, labels]) => [k, colAny(h, labels)])) as Record<keyof typeof ITEM_LABELS, number>;
  const cell = (r: string[], k: keyof typeof ITEM_LABELS) => (col[k] === -1 ? '' : (r[col[k]] ?? '').trim());
  const seen = new Set<string>();

  for (let i = headerIdx + 1; i < grid.length; i++) {
    const r = grid[i] ?? [];
    const rowNumber = i + 1;
    const name = cell(r, 'name');
    const typeText = cell(r, 'type');
    if (!name || /^total\b/i.test(name)) continue;
    if (!typeText) continue; // a heading or a blank line
    const mapped = ITEM_TYPE_MAP[typeText.toLowerCase()];
    if (!mapped) {
      errors.push({ rowNumber, field: 'Type', code: 'IMPORT_UNKNOWN_TYPE', message: `Unknown item type "${typeText}".` });
      continue;
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      errors.push({ rowNumber, field: 'Item', code: 'IMPORT_DUPLICATE_ITEM', message: `Item "${name}" appears more than once in this file.` });
      continue;
    }
    seen.add(key);
    const isActive = active(cell(r, 'active'));
    if (mapped.startsWith('skip:')) {
      rows.push({ rowNumber, name, sourceType: typeText, itemType: null, skipReason: mapped.slice(5) as CanonicalItemRow['skipReason'], isActive });
      continue;
    }
    const itemType = mapped as NonNullable<CanonicalItemRow['itemType']>;
    const row: CanonicalItemRow = { rowNumber, name, sourceType: typeText, itemType, isActive };

    // Money and quantities: exact (U-260), never a float.
    const priceRaw = cell(r, 'price');
    let bad = false;
    if (priceRaw) {
      const pct = priceRaw.endsWith('%');
      const v = parseImportAmount(pct ? priceRaw.slice(0, -1) : priceRaw, { signed: true });
      if (!isImportAmount(v)) {
        errors.push(importAmountError(rowNumber, 'Price', priceRaw));
        bad = true;
      } else if (pct) {
        if (itemType !== 'discount') {
          errors.push({ rowNumber, field: 'Price', code: 'IMPORT_AMOUNT_INVALID', message: `Row ${rowNumber}: only a discount item takes a percent price.` });
          bad = true;
        } else if (!v.abs().isZero()) row.discountPercent = v.abs().toFixed();
      } else if (!v.isZero() || itemType !== 'subtotal') {
        // A discount's amount off is kept positive (QuickBooks may print it negative).
        row.unitPrice = importAmountText(itemType === 'discount' ? v.abs() : v);
      }
    }
    const costRaw = cell(r, 'cost');
    if (costRaw) {
      const v = parseImportAmount(costRaw);
      if (!isImportAmount(v) || v.isNegative()) {
        errors.push(importAmountError(rowNumber, 'Cost', costRaw));
        bad = true;
      } else if (!v.isZero()) row.purchaseCost = importAmountText(v);
    }
    const reorderRaw = cell(r, 'reorder');
    if (reorderRaw && itemType === 'inventory_part') {
      const v = parseImportAmount(reorderRaw);
      if (!isImportAmount(v) || v.isNegative()) {
        errors.push(importAmountError(rowNumber, 'Reorder Pt', reorderRaw));
        bad = true;
      } else if (!v.isZero()) row.reorderPoint = v.toFixed();
    }
    if (bad) continue;

    const description = cell(r, 'description');
    if (description) row.description = description;
    const purchaseDescription = cell(r, 'purchaseDescription');
    if (purchaseDescription) row.purchaseDescription = purchaseDescription;
    const income = accountRef(cell(r, 'income'));
    if (income) row.incomeAccount = income;
    const expense = accountRef(cell(r, 'expense'));
    const cogs = accountRef(cell(r, 'cogs'));
    // QuickBooks Desktop has one cost column: a part's cost of goods sold, another item's expense account.
    if (itemType === 'inventory_part') {
      if (cogs) row.cogsAccount = cogs;
      if (expense) row.expenseAccount = expense;
    } else if (expense ?? cogs) row.expenseAccount = (expense ?? cogs)!;
    const asset = accountRef(cell(r, 'asset'));
    if (asset && itemType === 'inventory_part') row.assetAccount = asset;
    const vendor = cell(r, 'vendor');
    if (vendor) row.preferredVendor = vendor;
    const tax = taxable(cell(r, 'tax'));
    if (tax !== undefined) row.isTaxable = tax;

    if (itemType !== 'subtotal' && !row.incomeAccount) {
      errors.push({ rowNumber, field: 'Account', code: 'IMPORT_ITEM_NO_ACCOUNT', message: `Item "${name}" has no income account.` });
      continue;
    }
    if (itemType === 'inventory_part' && (!row.assetAccount || !row.cogsAccount)) {
      errors.push({
        rowNumber, field: row.assetAccount ? 'COGS Account' : 'Asset Account', code: 'IMPORT_ITEM_NO_ACCOUNT',
        message: `Inventory item "${name}" needs an asset account and a cost of goods sold account.`,
      });
      continue;
    }
    rows.push(row);
  }
  return { rows, errors };
}

// ── Inventory valuation ───────────────────────────────────────────

const VALUATION_LABELS = {
  item: ['item', 'item name', 'name', 'product/service'],
  onHand: ['on hand', 'qty on hand', 'quantity on hand', 'quantity'],
  value: ['asset value', 'total value', 'inventory value'],
} as const;

/** Top-level headings of the QuickBooks report that are sections, not items. */
const SECTION_HEADINGS = new Set(['inventory', 'inventory part', 'inventory parts', 'assembly', 'assemblies', 'inventory assembly']);

export async function parseInventoryValuation(
  buf: Buffer,
  sourceSystem: SourceSystem,
): Promise<{ rows: CanonicalValuationRow[]; errors: ImportValidationError[]; reportDate: string | null }> {
  const grid = await readGrid(buf, sourceSystem);
  const rows: CanonicalValuationRow[] = [];
  const errors: ImportValidationError[] = [];
  const headerIdx = findHeader(grid, [VALUATION_LABELS.onHand, VALUATION_LABELS.value]);
  if (headerIdx === -1) {
    errors.push({
      rowNumber: 0, code: 'IMPORT_HEADER_NOT_FOUND',
      message: 'Could not find the Inventory Valuation Summary columns (On Hand, Asset Value). Did you upload the right report?',
    });
    return { rows, errors, reportDate: null };
  }
  const reportDate = scrapeReportDate(grid, headerIdx);
  const h = grid[headerIdx]!;
  const iItem = colAny(h, VALUATION_LABELS.item);
  const iQty = colAny(h, VALUATION_LABELS.onHand);
  const iVal = colAny(h, VALUATION_LABELS.value);
  const leading = Math.min(iQty, iVal);
  const groups: string[] = [];
  const seen = new Set<string>();

  for (let i = headerIdx + 1; i < grid.length; i++) {
    const r = grid[i] ?? [];
    const rowNumber = i + 1;
    const qtyRaw = (r[iQty] ?? '').trim();
    const valRaw = (r[iVal] ?? '').trim();
    // The row's own name: the Item column, else the last non-blank leading cell (its column is its depth).
    let own = '';
    let depth = -1;
    if (iItem !== -1) own = (r[iItem] ?? '').trim();
    else {
      for (let c = leading - 1; c >= 0; c--) {
        const t = (r[c] ?? '').trim();
        if (t) { own = t; depth = c; break; }
      }
    }
    if (/^total\b/i.test(own)) {
      if (depth >= 0) groups.length = Math.min(groups.length, depth);
      continue;
    }
    if (!qtyRaw && !valRaw) {
      // A heading (a section, or a parent item over its sub-items) or a blank line.
      if (own && depth >= 0) { groups.length = depth; groups[depth] = own; }
      continue;
    }
    if (!own) continue;
    const path = iItem !== -1 ? [] : groups.slice(0, Math.max(depth, 0)).filter((g, idx) => !!g && !(idx === 0 && SECTION_HEADINGS.has(g.toLowerCase())));
    // A parent's own stock beside its sub-items: "<Parent> - Other" is the parent.
    const parent = path[path.length - 1];
    const item = parent && own === `${parent} - Other` ? path.join(':') : [...path, own].join(':');

    const qty = parseImportAmount(qtyRaw);
    const val = parseImportAmount(valRaw);
    if (!isImportAmount(qty) || !isImportAmount(val)) {
      if (!isImportAmount(qty)) errors.push(importAmountError(rowNumber, 'On Hand', qtyRaw));
      if (!isImportAmount(val)) errors.push(importAmountError(rowNumber, 'Asset Value', valRaw));
      continue;
    }
    if (qty.isZero() && val.isZero()) continue;
    // Rows an opening adjustment can't bring in exactly are errors, never dropped: a dropped row would leave
    // "Inventory before conversion" off zero.
    if (qty.isNegative() || val.isNegative()) {
      errors.push({ rowNumber, field: qty.isNegative() ? 'On Hand' : 'Asset Value', code: 'IMPORT_VALUATION_NEGATIVE',
        message: `"${item}" has a negative ${qty.isNegative() ? 'quantity on hand' : 'value'}. Correct it in QuickBooks before the switch.` });
      continue;
    }
    if (qty.isZero()) {
      errors.push({ rowNumber, field: 'On Hand', code: 'IMPORT_VALUATION_NO_QUANTITY',
        message: `"${item}" has a value but nothing on hand. Correct it in QuickBooks before the switch.` });
      continue;
    }
    if (val.decimalPlaces() > 2) {
      errors.push({ rowNumber, field: 'Asset Value', code: 'IMPORT_VALUATION_CENTS', message: `Asset value "${valRaw}" has more than 2 decimal places.` });
      continue;
    }
    if (qty.greaterThanOrEqualTo(new Decimal('1e8'))) {
      errors.push(importAmountError(rowNumber, 'On Hand', qtyRaw));
      continue;
    }
    const key = item.toLowerCase();
    if (seen.has(key)) {
      errors.push({ rowNumber, field: 'Item', code: 'IMPORT_DUPLICATE_ITEM', message: `Item "${item}" appears more than once in this report.` });
      continue;
    }
    seen.add(key);
    rows.push({ rowNumber, item, onHand: qty.toFixed(), assetValue: val.toFixed(2) });
  }
  return { rows, errors, reportDate };
}

/** The exact sum of the asset values. */
export function valuationTotal(rows: CanonicalValuationRow[]): string {
  return rows.reduce((s, r) => s.plus(r.assetValue), new Decimal(0)).toFixed(2);
}
