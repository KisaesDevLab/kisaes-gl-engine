// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// Report Packs — server-side render map.
//
// One entry per curated report. Each renderer reproduces the EXACT builder
// call + response shaping its /reports route handler performs (including the
// `_exportColumns` the Trial Balance / Expenses-by-Category summary paths
// attach, and the vendor-aggregation transform the A/R Aging Summary applies
// for PDF). The output object is exactly what `respond()` would have handed
// `extractDataAndColumns`, so section rendering matches the single-report
// export pixel-for-pixel.

import { getReportDef } from '@kis-books/shared';
import * as reportService from './report.service.js';
import * as apReportService from './ap-report.service.js';
import * as comparisonService from './report-comparison.service.js';
import { extractDataAndColumns, buildHtmlTable } from '../routes/reports.routes.js';

/** Query-shaped params from resolveReportDates (start_date/end_date/as_of_date). */
export type PackRenderParams = Record<string, string>;

export interface PackRenderOpts {
  basis: 'accrual' | 'cash';
  tagId: string | null;
  groupBy: 'detail_type' | null;
  showPct?: boolean;
  // When true, render the comparative variant (P&L / Balance Sheet vs. the
  // prior period) — mirrors the standalone report's ?compare=previous_period.
  compare?: boolean;
}

type Renderer = (
  tenantId: string,
  companyId: string,
  params: PackRenderParams,
  opts: PackRenderOpts,
) => Promise<unknown>;

// A/R Aging detail line — the fields the vendor-aggregation transform reads.
interface ArAgingDetailLine {
  contact_id?: string | null;
  customer_name?: string | null;
  balance?: string | null;
  balance_due?: string | null;
  bucket?: string | null;
}
interface ArAgingSummaryData {
  details?: ArAgingDetailLine[];
  buckets?: { current?: number; days1to30?: number; days31to60?: number; days61to90?: number; over90?: number };
  total?: number;
}
interface ArVendorRow {
  vendor_name: string;
  current: number;
  bucket1to30: number;
  bucket31to60: number;
  bucket61to90: number;
  bucketOver90: number;
  total: number;
}

/**
 * Reshape the A/R Aging Summary into the vendor-bucketed form
 * `extractDataAndColumns`'s aging handler renders (mirrors the CSV/PDF branch
 * of the /ar-aging-summary route handler).
 */
function shapeArAgingForPdf(data: ArAgingSummaryData): unknown {
  const custMap = new Map<string, ArVendorRow>();
  for (const d of data.details ?? []) {
    const key = d.contact_id || 'unknown';
    const entry = custMap.get(key) || {
      vendor_name: d.customer_name || 'Unknown',
      current: 0, bucket1to30: 0, bucket31to60: 0, bucket61to90: 0, bucketOver90: 0, total: 0,
    };
    const bal = parseFloat(d.balance || d.balance_due || '0');
    if (d.bucket === 'current') entry.current += bal;
    else if (d.bucket === '1-30') entry.bucket1to30 += bal;
    else if (d.bucket === '31-60') entry.bucket31to60 += bal;
    else if (d.bucket === '61-90') entry.bucket61to90 += bal;
    else entry.bucketOver90 += bal;
    entry.total += bal;
    custMap.set(key, entry);
  }
  const vendors = Array.from(custMap.values()).sort((a, b) => a.vendor_name.localeCompare(b.vendor_name));
  return {
    ...data,
    vendors,
    totals: {
      current: data.buckets?.current || 0,
      bucket1to30: data.buckets?.days1to30 || 0,
      bucket31to60: data.buckets?.days31to60 || 0,
      bucket61to90: data.buckets?.days61to90 || 0,
      bucketOver90: data.buckets?.over90 || 0,
      total: data.total || 0,
    },
  };
}

export const REPORT_PACK_RENDERERS: Record<string, Renderer> = {
  'profit-loss': async (tenantId, companyId, params, opts) => {
    // Comparative mode mirrors the standalone route's ?compare=previous_period
    // path (buildComparativePL doesn't take a tag filter, same as the route).
    const data = opts.compare
      ? await comparisonService.buildComparativePL(
          tenantId, params['start_date']!, params['end_date']!, opts.basis,
          'previous_period', 6, 'month', companyId, opts.groupBy,
        )
      : await reportService.buildProfitAndLoss(
          tenantId, params['start_date']!, params['end_date']!, opts.basis, companyId, opts.tagId, opts.groupBy,
        );
    return opts.showPct ? { ...data, showPct: true } : data;
  },

  'balance-sheet': async (tenantId, companyId, params, opts) => {
    if (opts.compare) {
      return comparisonService.buildComparativeBS(
        tenantId, params['as_of_date']!, opts.basis, 'previous_period', companyId, opts.groupBy,
      );
    }
    return reportService.buildBalanceSheet(
      tenantId, params['as_of_date']!, opts.basis, companyId, opts.tagId, opts.groupBy,
    );
  },

  'cash-flow': async (tenantId, companyId, params, opts) => {
    return reportService.buildCashFlowStatement(
      tenantId, params['start_date']!, params['end_date']!, companyId, opts.tagId,
    );
  },

  'trial-balance': async (tenantId, companyId, params, opts) => {
    const data = await reportService.buildTrialBalance(
      tenantId, params['start_date']!, params['end_date']!, companyId, opts.tagId, opts.basis,
    );
    return {
      ...data,
      _exportColumns: [
        { key: 'account_number', label: '#' },
        { key: 'name', label: 'Account' },
        { key: 'account_type', label: 'Type' },
        { key: 'debit', label: 'Debit', align: 'right' },
        { key: 'credit', label: 'Credit', align: 'right' },
      ],
    };
  },

  'general-ledger': async (tenantId, companyId, params, opts) => {
    return reportService.buildGeneralLedger(
      tenantId, params['start_date']!, params['end_date']!, companyId, opts.tagId, opts.basis,
    );
  },

  'ar-aging-summary': async (tenantId, companyId, params, opts) => {
    const data = await reportService.buildARAgingSummary(
      tenantId, params['as_of_date']!, companyId, opts.tagId,
    );
    return shapeArAgingForPdf(data as ArAgingSummaryData);
  },

  'ap-aging-summary': async (tenantId, companyId, params, opts) => {
    return apReportService.buildApAgingSummary(
      tenantId, params['as_of_date']!, companyId, opts.tagId,
    );
  },

  'expense-by-category': async (tenantId, companyId, params, opts) => {
    const data = await reportService.buildExpenseByCategory(
      tenantId, params['start_date']!, params['end_date']!, companyId, opts.tagId, null, false, opts.basis,
    );
    return {
      ...data,
      _exportColumns: [
        { key: 'account_number', label: '#' },
        { key: 'category', label: 'Category' },
        { key: 'total', label: 'Total', align: 'right' },
      ],
    };
  },

  'transaction-list': async (tenantId, companyId, params, opts) => {
    const data = await reportService.buildTransactionList(
      tenantId,
      { startDate: params['start_date']!, endDate: params['end_date']!, ...(opts.tagId ? { tagId: opts.tagId } : {}), basis: opts.basis },
      companyId,
    );
    // Mirror the /transaction-list route: mark each transaction's first line
    // so the PDF rules between transactions (landscape comes from the catalog).
    const listRows = (data.data as Array<{ id?: string }>).map((r, i, arr) => ({
      ...r,
      _groupStart: i > 0 && r.id !== arr[i - 1]!.id,
    }));
    return {
      ...data,
      data: listRows,
      _exportColumns: [
        { key: 'txn_date', label: 'Date' },
        { key: 'txn_type', label: 'Type' },
        { key: 'txn_number', label: 'Number' },
        { key: 'contact_name', label: 'Contact' },
        { key: 'account', label: 'Account' },
        { key: 'amount', label: 'Amount', align: 'right' },
        { key: 'memo', label: 'Memo' },
        { key: 'line_tag', label: 'Tag' },
      ],
    };
  },
};

/**
 * Run a report's data through the shared export pipeline
 * (extractDataAndColumns → buildHtmlTable) and return the section's table
 * HTML + its page orientation (from the catalog).
 */
export function renderReportSectionHtml(
  reportId: string,
  reportData: unknown,
): { html: string; orientation: 'portrait' | 'landscape' } {
  const { rows, columns } = extractDataAndColumns(reportData);
  const html = buildHtmlTable(rows, columns);
  const def = getReportDef(reportId);
  return { html, orientation: def?.orientation ?? 'portrait' };
}
