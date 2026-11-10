// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

import { sql, type SQL } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tagIn } from './report.service.js';
import { ReportDecimal as Decimal, dec, dsum, exactStr, legacyNum } from './report-exact.js';

// Helper: add `b` to `a` via Decimal and return a plain number rounded
// to 4 decimals. Reports expose `number` to the UI, but accumulation
// happens through Decimal so sub-cent drift doesn't compound over
// hundreds of rows (which was making AP aging totals read "$12,345.67"
// when the underlying ledger said "$12,345.68").
function addMoney(a: number, b: number | string | null | undefined): number {
  return Number(new Decimal(a).plus(b || 0).toFixed(4));
}

interface DateRange { startDate?: string; endDate?: string }

function companyFilter(companyId: string | null) {
  if (!companyId) return sql`TRUE`;
  return sql`t.company_id = ${companyId}`;
}

export async function buildApAgingSummary(
  tenantId: string,
  asOfDate: string,
  companyId: string | null = null,
  // ADR 0XX §5.2 — header-level tag semantic: include the bill if any
  // of its journal_lines carries the tag. Bill totals remain the
  // transaction totals (the whole bill is either in or out of the
  // aging bucket, not partially apportioned by tagged line amount).
  tagId: string | null = null,
  // exactAmounts (U-14): *Exact strings on vendors, details and totalsExact.
  apOpts: { exactAmounts?: boolean } = {},
) {
  const ex = !!apOpts.exactAmounts;
  const tagClause = tagId
    ? sql` AND EXISTS (SELECT 1 FROM journal_lines jl WHERE jl.transaction_id = t.id AND jl.tenant_id = ${tenantId} AND jl.tag_id IN ${tagIn(tagId)})`
    : sql``;
  const rows = await db.execute(sql`
    SELECT t.id, t.txn_number, t.vendor_invoice_number, t.txn_date, t.due_date,
      t.total, t.amount_paid, t.credits_applied, t.balance_due,
      t.contact_id, c.display_name as vendor_name
    FROM transactions t
    LEFT JOIN contacts c ON c.id = t.contact_id AND c.tenant_id = ${tenantId}
    WHERE t.tenant_id = ${tenantId}
      AND t.txn_type = 'bill'
      AND t.status = 'posted'
      AND t.bill_status IN ('unpaid', 'partial', 'overdue')
      AND COALESCE(t.balance_due, 0) > 0
      AND t.txn_date <= ${asOfDate}
      AND ${companyFilter(companyId)}
      ${tagClause}
    ORDER BY c.display_name, t.due_date
  `);

  const asOf = new Date(asOfDate);
  const vendorMap = new Map<string, {
    contact_id: string;
    vendor_name: string;
    current: number;
    bucket1to30: number;
    bucket31to60: number;
    bucket61to90: number;
    bucketOver90: number;
    total: number;
  }>();
  const details: any[] = [];

  for (const row of rows.rows as any[]) {
    const balanceD = dec(row.balance_due || row.total || '0');
    const balance = legacyNum(balanceD);
    if (balance <= 0) continue;
    // Parse the date as UTC midnight to avoid a ±1 day drift in aging
    // buckets when the server's local timezone isn't UTC. Plain DATE
    // columns come back as YYYY-MM-DD, which JS Date interprets as
    // local time by default.
    const rawDate = row.due_date || row.txn_date;
    const dueDate = new Date(`${rawDate}T00:00:00Z`);
    const daysOverdue = Math.floor((asOf.getTime() - dueDate.getTime()) / 86400000);

    let bucket: 'current' | '1_30' | '31_60' | '61_90' | 'over_90';
    if (daysOverdue <= 0) bucket = 'current';
    else if (daysOverdue <= 30) bucket = '1_30';
    else if (daysOverdue <= 60) bucket = '31_60';
    else if (daysOverdue <= 90) bucket = '61_90';
    else bucket = 'over_90';

    const key = row.contact_id || 'unknown';
    const v = vendorMap.get(key) || {
      contact_id: row.contact_id || '',
      vendor_name: row.vendor_name || 'Unknown',
      current: 0, bucket1to30: 0, bucket31to60: 0, bucket61to90: 0, bucketOver90: 0, total: 0,
    };
    if (bucket === 'current') v.current = addMoney(v.current, balance);
    else if (bucket === '1_30') v.bucket1to30 = addMoney(v.bucket1to30, balance);
    else if (bucket === '31_60') v.bucket31to60 = addMoney(v.bucket31to60, balance);
    else if (bucket === '61_90') v.bucket61to90 = addMoney(v.bucket61to90, balance);
    else v.bucketOver90 = addMoney(v.bucketOver90, balance);
    v.total = addMoney(v.total, balance);
    vendorMap.set(key, v);

    details.push({
      contact_id: row.contact_id,
      vendor_name: row.vendor_name,
      bill_id: row.id,
      txn_number: row.txn_number,
      vendor_invoice_number: row.vendor_invoice_number,
      txn_date: row.txn_date,
      due_date: row.due_date,
      days_overdue: Math.max(0, daysOverdue),
      total: row.total,
      paid: Number(new Decimal(row.amount_paid || '0').plus(row.credits_applied || '0').toFixed(4)),
      balance,
      bucket,
      balanceD,
      ...(ex
        ? {
            totalExact: exactStr(row.total),
            paidExact: exactStr(dec(row.amount_paid).plus(dec(row.credits_applied))),
            balanceExact: exactStr(balanceD),
          }
        : {}),
    });
  }

  // Bucket totals and per-vendor sums in Decimal from the stored balances
  // (U-14); exact reports read the *Exact strings.
  const BUCKETS = ['current', 'bucket1to30', 'bucket31to60', 'bucket61to90', 'bucketOver90', 'total'] as const;
  const bucketOf: Record<string, typeof BUCKETS[number]> = {
    current: 'current', '1_30': 'bucket1to30', '31_60': 'bucket31to60', '61_90': 'bucket61to90', over_90: 'bucketOver90',
  };
  const vendorExact = new Map<string, Record<string, string>>();
  for (const d of details) {
    const key = d.contact_id || 'unknown';
    const v = vendorExact.get(key) ?? Object.fromEntries(BUCKETS.map((b) => [b, exactStr(0)]));
    const b = bucketOf[d.bucket]!;
    v[b] = exactStr(dec(v[b]).plus(d.balanceD));
    v['total'] = exactStr(dec(v['total']).plus(d.balanceD));
    vendorExact.set(key, v);
  }
  const vendors = Array.from(vendorMap.entries())
    .map(([key, v]) => {
      const vx = vendorExact.get(key)!;
      return {
        v,
        exact: {
          currentExact: vx['current']!, bucket1to30Exact: vx['bucket1to30']!, bucket31to60Exact: vx['bucket31to60']!,
          bucket61to90Exact: vx['bucket61to90']!, bucketOver90Exact: vx['bucketOver90']!, totalExact: vx['total']!,
        } as Record<string, string>,
      };
    })
    .sort((a, b) => a.v.vendor_name.localeCompare(b.v.vendor_name));
  const sumOf = (b: typeof BUCKETS[number]) => dsum(vendors.map((x) => x.exact[`${b}Exact`]));
  const totals = Object.fromEntries(BUCKETS.map((b) => [b, legacyNum(sumOf(b))])) as Record<typeof BUCKETS[number], number>;
  const totalsExact = Object.fromEntries(BUCKETS.map((b) => [b, exactStr(sumOf(b))])) as Record<typeof BUCKETS[number], string>;

  return {
    title: 'AP Aging Summary',
    asOfDate,
    vendors: vendors.map((x) => (ex ? { ...x.v, ...x.exact } : x.v)),
    totals,
    ...(ex ? { totalsExact } : {}),
    details: details.map(({ balanceD: _b, ...d }) => d),
  };
}

export async function buildApAgingDetail(
  tenantId: string,
  asOfDate: string,
  companyId: string | null = null,
  tagId: string | null = null,
  apOpts: { exactAmounts?: boolean } = {},
) {
  return buildApAgingSummary(tenantId, asOfDate, companyId, tagId, apOpts);
}

export async function buildUnpaidBills(tenantId: string, filters?: {
  contactId?: string;
  dueOnOrBefore?: string;
  overdueOnly?: boolean;
}, companyId: string | null = null) {
  const conditions = [
    sql`t.tenant_id = ${tenantId}`,
    sql`t.txn_type = 'bill'`,
    sql`t.status = 'posted'`,
    sql`t.bill_status IN ('unpaid', 'partial', 'overdue')`,
    sql`COALESCE(t.balance_due, 0) > 0`,
    companyFilter(companyId),
  ];
  if (filters?.contactId) conditions.push(sql`t.contact_id = ${filters.contactId}`);
  if (filters?.dueOnOrBefore) conditions.push(sql`t.due_date <= ${filters.dueOnOrBefore}`);
  if (filters?.overdueOnly) conditions.push(sql`t.due_date < CURRENT_DATE`);

  const rows = await db.execute(sql`
    SELECT t.id, t.txn_number, t.vendor_invoice_number, t.txn_date, t.due_date,
      t.total, t.amount_paid, t.credits_applied, t.balance_due, t.bill_status,
      c.display_name as vendor_name
    FROM transactions t
    LEFT JOIN contacts c ON c.id = t.contact_id AND c.tenant_id = ${tenantId}
    WHERE ${sql.join(conditions, sql` AND `)}
    ORDER BY t.due_date NULLS LAST, c.display_name
  `);

  return {
    title: 'Unpaid Bills',
    data: rows.rows as any[],
  };
}

export async function buildBillPaymentHistory(tenantId: string, range: DateRange, companyId: string | null = null) {
  const conditions = [
    sql`t.tenant_id = ${tenantId}`,
    sql`t.txn_type = 'bill_payment'`,
    sql`t.status = 'posted'`,
    companyFilter(companyId),
  ];
  if (range.startDate) conditions.push(sql`t.txn_date >= ${range.startDate}`);
  if (range.endDate) conditions.push(sql`t.txn_date <= ${range.endDate}`);

  const rows = await db.execute(sql`
    SELECT t.id, t.txn_number, t.txn_date, t.total, t.check_number,
      c.display_name as vendor_name,
      (SELECT COUNT(*) FROM bill_payment_applications WHERE payment_id = t.id) as bill_count
    FROM transactions t
    LEFT JOIN contacts c ON c.id = t.contact_id AND c.tenant_id = ${tenantId}
    WHERE ${sql.join(conditions, sql` AND `)}
    ORDER BY t.txn_date DESC
  `);

  return { title: 'Bill Payment History', data: rows.rows as any[] };
}

export async function buildVendorStatement(
  tenantId: string, vendorId: string, range: DateRange, companyId: string | null = null,
  // exactAmounts (U-14): id and *Exact strings on lines, *Exact balances and totals.
  vsOpts: { exactAmounts?: boolean } = {},
) {
  const startDate = range.startDate || `${new Date().getFullYear()}-01-01`;
  const endDate = range.endDate || new Date().toISOString().split('T')[0]!;

  // Documents on the vendor (bills, credits, bill payments: the header
  // contact and total) plus deposits that put money back on the vendor's
  // A/P (a vendor refund, U-54: the deposit's A/P lines naming the vendor;
  // the header contact of a deposit is not the vendor). `amount` is signed
  // as the vendor balance moves: + charge (bill, refund), − payment.
  const vendorActivity = (dateCond: SQL) => sql`
    SELECT t.id, t.txn_type, t.txn_date, t.created_at, t.txn_number, t.vendor_invoice_number, t.memo,
      CASE WHEN t.txn_type = 'bill' THEN CAST(t.total AS DECIMAL) ELSE -CAST(t.total AS DECIMAL) END AS amount
    FROM transactions t
    WHERE t.tenant_id = ${tenantId}
      AND t.contact_id = ${vendorId}
      AND t.status = 'posted'
      AND t.txn_type IN ('bill', 'vendor_credit', 'bill_payment')
      AND ${dateCond}
      AND ${companyFilter(companyId)}
    UNION ALL
    SELECT t.id, t.txn_type, t.txn_date, t.created_at, t.txn_number, t.vendor_invoice_number, t.memo,
      SUM(jl.credit - jl.debit) AS amount
    FROM transactions t
    JOIN journal_lines jl ON jl.transaction_id = t.id AND jl.tenant_id = ${tenantId}
      AND jl.is_void_reversal = false AND jl.contact_id = ${vendorId}
    JOIN accounts a ON a.id = jl.account_id AND a.tenant_id = ${tenantId} AND a.system_tag = 'accounts_payable'
    WHERE t.tenant_id = ${tenantId}
      AND t.status = 'posted'
      AND t.txn_type = 'deposit'
      AND ${dateCond}
      AND ${companyFilter(companyId)}
    GROUP BY t.id, t.txn_type, t.txn_date, t.created_at, t.txn_number, t.vendor_invoice_number, t.memo
    HAVING SUM(jl.credit - jl.debit) <> 0
  `;

  const openingResult = await db.execute(sql`
    SELECT COALESCE(SUM(v.amount), 0) AS opening
    FROM (${vendorActivity(sql`t.txn_date < ${startDate}`)}) v
  `);
  const openingD = dec((openingResult.rows[0] as { opening: string })?.opening || '0');
  const openingBalance = legacyNum(openingD);

  const activity = await db.execute(sql`
    SELECT v.* FROM (${vendorActivity(sql`t.txn_date >= ${startDate} AND t.txn_date <= ${endDate}`)}) v
    ORDER BY v.txn_date, v.created_at, v.id
  `);

  // Running balance in Decimal (U-14); the numbers derive from it.
  let runningD = openingD;
  const lines = (activity.rows as any[]).map((row) => {
    const signedD = dec(row.amount || '0');
    const chargeD = signedD.gte(0) ? signedD : dec(0);
    const paymentD = signedD.lt(0) ? signedD.negated() : dec(0);
    runningD = runningD.plus(signedD);
    return {
      ...(vsOpts.exactAmounts ? { id: row.id as string } : {}),
      txn_date: row.txn_date,
      txn_type: row.txn_type,
      txn_number: row.txn_number,
      vendor_invoice_number: row.vendor_invoice_number,
      memo: row.memo,
      charge: legacyNum(chargeD),
      payment: legacyNum(paymentD),
      balance: legacyNum(runningD),
      ...(vsOpts.exactAmounts
        ? { chargeExact: exactStr(chargeD), paymentExact: exactStr(paymentD), balanceExact: exactStr(runningD) }
        : {}),
    };
  });

  return {
    title: 'Vendor Statement',
    vendorId,
    startDate,
    endDate,
    openingBalance,
    closingBalance: legacyNum(runningD),
    ...(vsOpts.exactAmounts
      ? {
          openingBalanceExact: exactStr(openingD),
          closingBalanceExact: exactStr(runningD),
          totalChargesExact: exactStr(dsum(lines.map((l) => l.chargeExact))),
          totalPaymentsExact: exactStr(dsum(lines.map((l) => l.paymentExact))),
        }
      : {}),
    lines,
  };
}

export async function buildAp1099Prep(
  tenantId: string, taxYear: number, companyId: string | null = null,
  // exactAmounts (U-14): total_paidExact on rows and totalPaidExact.
  prepOpts: { exactAmounts?: boolean } = {},
) {
  const start = `${taxYear}-01-01`;
  const end = `${taxYear}-12-31`;

  const rows = await db.execute(sql`
    SELECT c.id, c.display_name, c.tax_id,
      c.billing_line1, c.billing_city, c.billing_state, c.billing_zip,
      COALESCE(SUM(CAST(t.total AS DECIMAL)), 0) as total_paid
    FROM contacts c
    LEFT JOIN transactions t ON t.contact_id = c.id AND t.tenant_id = ${tenantId}
      AND t.status = 'posted'
      AND t.txn_type IN ('expense', 'bill_payment')
      AND t.txn_date >= ${start} AND t.txn_date <= ${end}
      AND ${companyFilter(companyId)}
    WHERE c.tenant_id = ${tenantId}
      AND c.is_1099_eligible = true
      AND c.contact_type IN ('vendor', 'both')
    GROUP BY c.id, c.display_name, c.tax_id, c.billing_line1, c.billing_city, c.billing_state, c.billing_zip
    ORDER BY c.display_name
  `);

  const data = (rows.rows as any[]).map((row) => {
    const parts = [row.billing_line1, row.billing_city, row.billing_state, row.billing_zip].filter(Boolean);
    // 1099 threshold check must not drift — $599.99999 should NOT hit
    // the 1099 bucket. Decimal comparison is exact.
    const totalPaid = new Decimal(row.total_paid || '0');
    return {
      contact_id: row.id,
      vendor_name: row.display_name,
      address: parts.join(', ') || '',
      tax_id: row.tax_id,
      total_paid: Number(totalPaid.toFixed(4)),
      ...(prepOpts.exactAmounts ? { total_paidExact: exactStr(totalPaid) } : {}),
      over_threshold: totalPaid.greaterThanOrEqualTo(600),
    };
  });

  return {
    title: '1099 Vendor Preparation', taxYear, data,
    ...(prepOpts.exactAmounts ? { totalPaidExact: exactStr(dsum(data.map((r) => r.total_paidExact))) } : {}),
  };
}
