// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

/**
 * Report areas (U-227, capability report-areas-v1). Besides `reports` read,
 * a report needs read on the area its data belongs to: A/R reports need
 * `invoices`, A/P reports `bills`, bank reports `banking`, and so on. The
 * statements, ledgers, journal, account reports, packs and Ask need
 * `financial_reports`, which a template without the key inherits from
 * `reports` (shared/constants/permissions.ts), so existing templates keep
 * their access.
 *
 * One table keyed by the path, enforced once in `authenticate` (as the U-33
 * table in visibility.ts): several routers share /api/v1/reports and a
 * router-level guard also runs for requests meant for a sibling router. A
 * slug missing from the table needs `financial_reports` (fail-closed); the
 * router walk in report-areas.routes.test.ts keeps every mounted report
 * route in the table.
 *
 * Not here: Report Builder runs, whose sections carry their own rights by
 * data source (`gl` needs financial_reports; services/report-builder/
 * rights.ts), and the practice portal reports (unchanged).
 */

import type { Request } from 'express';
import { can, type ResourceKey } from '@kis-books/shared';
import { AppError } from '../utils/errors.js';
import { resolvePermissionsForRequest } from '../middleware/permission.js';

const FIN: ResourceKey = 'financial_reports';

/**
 * Area of each first path segment under /api/v1/reports and /api/v2/reports
 * (lower case). `email` takes the area of the report it sends (body
 * `reportKey`, see areaForReportKey).
 */
export const REPORT_AREAS: Readonly<Record<string, ResourceKey>> = {
  // Statements, ledgers, journal, account reports
  'profit-loss': FIN,
  'balance-sheet': FIN,
  'cash-flow': FIN,
  'trial-balance': FIN,
  'general-ledger': FIN,
  'transaction-list': FIN,
  'journal-entry-report': FIN,
  'account-report': FIN,
  'account-activity-summary': FIN,
  'expense-by-category': FIN,
  'revenue-by-category': FIN,
  'tax-estimate': FIN,
  'assets-by-account': FIN,
  'liabilities-by-account': FIN,
  'equity-by-account': FIN,
  // Trial Balance module reports (packs and their routes)
  'tb-workpaper': FIN,
  'tb-workpaper-index': FIN,
  'tb-grouped': FIN,
  'tb-leadsheets': FIN,
  'tb-return-order': FIN,
  'tb-tax-basis-pl': FIN,
  'tb-flux': FIN,
  'tb-aje-listing': FIN,
  'tb-rje-listing': FIN,
  'tb-bookkeeper-letter': FIN,
  'tb-code-summary': FIN,
  'tb-m1': FIN,
  'tb-m2': FIN,
  'tb-diagnostics': FIN,
  // Report packs and Ask
  catalog: FIN,
  letters: FIN,
  packs: FIN,
  'pack-templates': FIN,
  ask: FIN,
  // A/R
  'ar-aging-summary': 'invoices',
  'ar-aging-detail': 'invoices',
  'customer-balance-summary': 'invoices',
  'customer-balance-detail': 'invoices',
  'invoice-list': 'invoices',
  'sales-by-customer': 'invoices',
  'sales-by-item': 'invoices',
  'customer-statement': 'invoices',
  'customer-statements': 'invoices',
  // A/P
  'ap-aging-summary': 'bills',
  'ap-aging-detail': 'bills',
  'unpaid-bills': 'bills',
  'bill-payment-history': 'bills',
  'vendor-statement': 'bills',
  'vendor-balance-summary': 'bills',
  'vendor-balance-detail': 'bills',
  'expense-by-vendor': 'bills',
  'transaction-list-by-vendor': 'bills',
  'vendor-1099-summary': 'bills',
  'ap-1099-prep': 'bills',
  // Banking
  'bank-balances': 'banking',
  'bank-reconciliation-summary': 'banking',
  'reconciliation-detail': 'banking',
  'reconciliation-discrepancy': 'banking',
  'deposit-detail': 'banking',
  'check-register': 'banking',
  // Sales tax
  'sales-tax-liability': 'sales_tax',
  'taxable-sales-summary': 'sales_tax',
  'sales-tax-payments': 'sales_tax',
  'exemptions-expiring': 'sales_tax',
  // Inventory
  'inventory-valuation': 'items',
  'inventory-valuation-detail': 'items',
  'inventory-stock-status': 'items',
  reorder: 'items',
  // Controls (audit_log alone: the route also needs it)
  'closing-date-exceptions': 'audit_log',
  // The integration API's names (/api/v2/reports/*)
  'ar-aging': 'invoices',
  'customer-balance': 'invoices',
  'vendor-balance': 'bills',
  '1099-vendor-summary': 'bills',
};

/** Report catalog keys a client sends with report email that are not route slugs (ClientLedger's catalog). */
const REPORT_KEY_AREAS: Readonly<Record<string, ResourceKey>> = {
  'profit-loss-by-month': FIN,
  'profit-loss-by-fiscal-period': FIN,
  'profit-loss-comparative': FIN,
  'profit-loss-ytd': FIN,
  'profit-loss-by-tag-group': FIN,
  'profit-loss-by-client': FIN,
  'balance-sheet-comparative': FIN,
  'transaction-detail-by-account': FIN,
  journal: FIN,
  'budget-vs-actual': FIN,
  'expenses-by-category': FIN,
  'open-invoices': 'invoices',
  'sales-by-client': 'invoices',
  'expenses-by-vendor': 'bills',
  'transactions-by-vendor': 'bills',
  'audit-trail': 'audit_log',
  'duplicate-finder': 'duplicates',
};

function normalizeKey(key: string): string {
  return key.trim().toLowerCase().replace(/_/g, '-');
}

/** The area of a report named by its catalog key or route slug; unknown or missing: financial_reports. */
export function areaForReportKey(key: unknown): ResourceKey {
  if (typeof key !== 'string') return FIN;
  const k = normalizeKey(key);
  return REPORT_AREAS[k] ?? REPORT_KEY_AREAS[k] ?? FIN;
}

/** Whether the slug has its own row (the router walk checks this; no fallback). */
export function hasExplicitArea(slug: string): boolean {
  return Object.prototype.hasOwnProperty.call(REPORT_AREAS, slug.toLowerCase());
}

function segments(p: string): string[] {
  return p.split('/').filter((s) => s.length > 0);
}

/**
 * The area a request needs, or null when it is not a report route. `path` is
 * the full URL path (any case, any trailing slash).
 */
export function reportAreaFor(method: string, path: string, body?: unknown): ResourceKey | null {
  const xs = segments(path.toLowerCase());
  // Budget vs. Actual (/api/v1/budgets/:id/vs-actual, /api/v2/budgets/:id/vs-actual).
  if (xs.length === 5 && xs[0] === 'api' && (xs[1] === 'v1' || xs[1] === 'v2') && xs[2] === 'budgets' && xs[4] === 'vs-actual') {
    return FIN;
  }
  let rest: string[] | null = null;
  if (xs[0] === 'api' && xs[1] === 'v1' && xs[2] === 'reports') rest = xs.slice(3);
  else if (xs[0] === 'api' && xs[1] === 'v2' && xs[2] === 'reports') rest = xs.slice(3);
  if (!rest) return null;
  const slug = rest[0];
  if (!slug) return FIN;
  if (slug === 'email' && method === 'POST' && rest.length === 1) {
    return areaForReportKey((body as { reportKey?: unknown } | null | undefined)?.reportKey);
  }
  return REPORT_AREAS[slug] ?? FIN;
}

/**
 * Called by `authenticate` once the principal is known: refuses a report
 * route whose area the viewer cannot read (403 PERMISSION_DENIED, as the
 * router guards).
 */
export async function refuseReportOutsideArea(req: Request): Promise<void> {
  if (req.method === 'OPTIONS') return;
  const path = (req.originalUrl ?? req.url).split('?')[0]!;
  const area = reportAreaFor(req.method, path, req.body);
  if (!area) return;
  const perms = await resolvePermissionsForRequest(req);
  if (!can(perms, area, 'read')) {
    throw AppError.forbidden('You do not have permission for this report', 'PERMISSION_DENIED');
  }
}
