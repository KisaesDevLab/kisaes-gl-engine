// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';

interface DateRange { startDate?: string; endDate?: string }

function companyFilter(companyId: string | null) {
  if (!companyId) return sql`TRUE`;
  return sql`t.company_id = ${companyId}`;
}

export async function buildApAgingSummary(tenantId: string, asOfDate: string, companyId: string | null = null) {
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
    const balance = parseFloat(row.balance_due || row.total || '0');
    if (balance <= 0) continue;
    const dueDate = new Date(row.due_date || row.txn_date);
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
    if (bucket === 'current') v.current += balance;
    else if (bucket === '1_30') v.bucket1to30 += balance;
    else if (bucket === '31_60') v.bucket31to60 += balance;
    else if (bucket === '61_90') v.bucket61to90 += balance;
    else v.bucketOver90 += balance;
    v.total += balance;
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
      paid: parseFloat(row.amount_paid || '0') + parseFloat(row.credits_applied || '0'),
      balance,
      bucket,
    });
  }

  const vendors = Array.from(vendorMap.values()).sort((a, b) => a.vendor_name.localeCompare(b.vendor_name));
  const totals = vendors.reduce((acc, v) => ({
    current: acc.current + v.current,
    bucket1to30: acc.bucket1to30 + v.bucket1to30,
    bucket31to60: acc.bucket31to60 + v.bucket31to60,
    bucket61to90: acc.bucket61to90 + v.bucket61to90,
    bucketOver90: acc.bucketOver90 + v.bucketOver90,
    total: acc.total + v.total,
  }), { current: 0, bucket1to30: 0, bucket31to60: 0, bucket61to90: 0, bucketOver90: 0, total: 0 });

  return {
    title: 'AP Aging Summary',
    asOfDate,
    vendors,
    totals,
    details,
  };
}

export async function buildApAgingDetail(tenantId: string, asOfDate: string, companyId: string | null = null) {
  return buildApAgingSummary(tenantId, asOfDate, companyId);
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

export async function buildVendorStatement(tenantId: string, vendorId: string, range: DateRange, companyId: string | null = null) {
  const startDate = range.startDate || `${new Date().getFullYear()}-01-01`;
  const endDate = range.endDate || new Date().toISOString().split('T')[0]!;

  const openingResult = await db.execute(sql`
    SELECT COALESCE(SUM(
      CASE
        WHEN t.txn_type = 'bill' THEN CAST(t.total AS DECIMAL)
        WHEN t.txn_type = 'vendor_credit' THEN -CAST(t.total AS DECIMAL)
        WHEN t.txn_type = 'bill_payment' THEN -CAST(t.total AS DECIMAL)
        ELSE 0
      END
    ), 0) AS opening
    FROM transactions t
    WHERE t.tenant_id = ${tenantId}
      AND t.contact_id = ${vendorId}
      AND t.status = 'posted'
      AND t.txn_type IN ('bill', 'vendor_credit', 'bill_payment')
      AND t.txn_date < ${startDate}
      AND ${companyFilter(companyId)}
  `);
  const openingBalance = parseFloat((openingResult.rows[0] as { opening: string })?.opening || '0');

  const activity = await db.execute(sql`
    SELECT t.id, t.txn_type, t.txn_date, t.txn_number, t.vendor_invoice_number,
      t.total, t.memo
    FROM transactions t
    WHERE t.tenant_id = ${tenantId}
      AND t.contact_id = ${vendorId}
      AND t.status = 'posted'
      AND t.txn_type IN ('bill', 'vendor_credit', 'bill_payment')
      AND t.txn_date >= ${startDate} AND t.txn_date <= ${endDate}
      AND ${companyFilter(companyId)}
    ORDER BY t.txn_date, t.created_at
  `);

  let running = openingBalance;
  const lines = (activity.rows as any[]).map((row) => {
    const amount = parseFloat(row.total || '0');
    let charge = 0, payment = 0;
    if (row.txn_type === 'bill') { charge = amount; running += amount; }
    else if (row.txn_type === 'vendor_credit') { payment = amount; running -= amount; }
    else if (row.txn_type === 'bill_payment') { payment = amount; running -= amount; }
    return {
      txn_date: row.txn_date,
      txn_type: row.txn_type,
      txn_number: row.txn_number,
      vendor_invoice_number: row.vendor_invoice_number,
      memo: row.memo,
      charge,
      payment,
      balance: running,
    };
  });

  return {
    title: 'Vendor Statement',
    vendorId,
    startDate,
    endDate,
    openingBalance,
    closingBalance: running,
    lines,
  };
}

export async function buildAp1099Prep(tenantId: string, taxYear: number, companyId: string | null = null) {
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
    return {
      contact_id: row.id,
      vendor_name: row.display_name,
      address: parts.join(', ') || '',
      tax_id: row.tax_id,
      total_paid: parseFloat(row.total_paid || '0'),
      over_threshold: parseFloat(row.total_paid || '0') >= 600,
    };
  });

  return { title: '1099 Vendor Preparation', taxYear, data };
}
