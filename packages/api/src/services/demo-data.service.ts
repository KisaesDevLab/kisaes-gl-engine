/**
 * Creates a "Demo Bookkeeping Co" tenant populated with realistic sample
 * transactions spanning the current year and the prior year.
 *
 * Used by:
 *   - The first-run setup wizard (when the admin opts in to a demo company)
 *   - The standalone `seed-demo-data.ts` CLI script
 *
 * Both entry points share this single implementation so they can't drift.
 *
 * The function is idempotent on the slug: if a tenant with the given slug
 * already exists, the function returns the existing tenant without creating
 * duplicates. To re-seed cleanly, delete the existing demo tenant first.
 */

import { eq, and, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants,
  companies,
  userTenantAccess,
  accounts,
  contacts,
} from '../db/schema/index.js';
import * as accountsService from './accounts.service.js';
import * as ledger from './ledger.service.js';
import * as invoiceService from './invoice.service.js';
import * as paymentService from './payment.service.js';
import * as billService from './bill.service.js';
import * as vendorCreditService from './vendor-credit.service.js';
import * as billPaymentService from './bill-payment.service.js';

export interface DemoTenantOptions {
  tenantName?: string;
  slug?: string;
  /** Logger for progress updates. Defaults to console.log. */
  log?: (line: string) => void;
}

export interface DemoTenantResult {
  tenantId: string;
  tenantName: string;
  alreadyExisted: boolean;
  counts: {
    invoices: number;
    customerPayments: number;
    cashSales: number;
    expenses: number;
    deposits: number;
    transfers: number;
    journalEntries: number;
    bills: number;
    vendorCredits: number;
    billPayments: number;
    total: number;
  };
  trialBalanceValid: boolean;
}

const DEFAULT_TENANT_NAME = 'Demo Bookkeeping Co';
const DEFAULT_SLUG = 'demo-co';

interface VendorSeed {
  displayName: string;
  email: string;
  defaultPaymentTerms?: string;
  is1099Eligible?: boolean;
}

// All vendors used by the demo. The first 5 are owned by the simple expense
// flow (rent, utilities, telco, insurance, office supplies). Vendors 5–8 are
// AP-flow vendors that get billed via the bills/pay-bills workflow.
const VENDOR_DATA: VendorSeed[] = [
  { displayName: 'City Power & Light', email: 'billing@citypower.example.com' },
  { displayName: 'Office Depot Supply', email: 'accounts@officedepot.example.com' },
  { displayName: 'AT&T Business', email: 'commercial@att.example.com' },
  { displayName: 'Commercial Insurance Group', email: 'policy@cig.example.com' },
  { displayName: 'Downtown Office Lease LLC', email: 'rent@downtownlease.example.com' },
  { displayName: 'TechWorks IT Solutions', email: 'ar@techworks.example.com', defaultPaymentTerms: 'net_30', is1099Eligible: true },
  { displayName: 'Crawford Legal LLP', email: 'billing@crawfordlegal.example.com', defaultPaymentTerms: 'net_15', is1099Eligible: true },
  { displayName: 'BrightAds Marketing', email: 'accounts@brightads.example.com', defaultPaymentTerms: 'net_30', is1099Eligible: true },
  { displayName: 'Cloudbase Software Inc', email: 'billing@cloudbase.example.com', defaultPaymentTerms: 'net_30' },
];

// Deterministic LCG — same call order produces the same demo data every run.
// This is NOT cryptographic; it's so the demo tenant looks identical across
// reinstalls, which makes screenshots/docs reproducible.
function createRng(seedValue = 1) {
  let seed = seedValue;
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

function dateStr(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export async function createDemoTenant(
  adminUserId: string,
  options: DemoTenantOptions = {},
): Promise<DemoTenantResult> {
  const tenantName = options.tenantName ?? DEFAULT_TENANT_NAME;
  const slug = options.slug ?? DEFAULT_SLUG;
  const log = options.log ?? ((line: string) => console.log(line));

  const rand = createRng(1);
  const pick = <T>(arr: T[]): T => arr[Math.floor(rand() * arr.length)]!;
  const money = (min: number, max: number): string => {
    const v = min + rand() * (max - min);
    return (Math.round(v * 100) / 100).toFixed(2);
  };

  // ── 1. Check for existing tenant ──────────────────────────────
  //
  // The seeder is idempotent on the slug. If a tenant with this slug
  // already exists we don't recreate the base data — but we DO check
  // whether the AP section has been run against it. This makes the
  // seeder upgrade-aware: a tenant that was seeded before bills/AP
  // existed gets the new AP data backfilled the next time the seeder
  // runs, without the user having to delete + reseed.
  const existing = await db.query.tenants.findFirst({ where: eq(tenants.slug, slug) });
  if (existing) {
    const hasBills = await db.execute(sql`
      SELECT 1 FROM transactions
      WHERE tenant_id = ${existing.id} AND txn_type = 'bill'
      LIMIT 1
    `);
    const apAlreadySeeded = (hasBills.rows as any[]).length > 0;

    if (apAlreadySeeded) {
      log(`Demo tenant "${slug}" already exists with AP data; skipping.`);
      return {
        tenantId: existing.id,
        tenantName: existing.name,
        alreadyExisted: true,
        counts: {
          invoices: 0, customerPayments: 0, cashSales: 0, expenses: 0,
          deposits: 0, transfers: 0, journalEntries: 0,
          bills: 0, vendorCredits: 0, billPayments: 0, total: 0,
        },
        trialBalanceValid: true,
      };
    }

    // Backfill AP into the existing tenant
    log(`Demo tenant "${slug}" exists but has no AP data — backfilling bills, vendor credits, and bill payments.`);
    const counts = {
      invoices: 0, customerPayments: 0, cashSales: 0, expenses: 0,
      deposits: 0, transfers: 0, journalEntries: 0,
      bills: 0, vendorCredits: 0, billPayments: 0, total: 0,
    };

    // Resolve the accounts and contacts that the AP section needs
    const allAccounts = await db.select().from(accounts).where(eq(accounts.tenantId, existing.id));
    const checking = allAccounts.find((a) => a.systemTag === 'cash_on_hand');
    const expenseAccts = allAccounts.filter((a) => a.accountType === 'expense' && !a.isSystem);
    if (!checking || expenseAccts.length === 0) {
      log(`  ⚠ Cannot backfill AP — checking or expense accounts not found in existing tenant.`);
      return {
        tenantId: existing.id,
        tenantName: existing.name,
        alreadyExisted: true,
        counts,
        trialBalanceValid: true,
      };
    }

    const apVendors = await ensureApVendors(existing.id, log);

    await seedAccountsPayable(existing.id, apVendors, expenseAccts, checking, counts, log);

    counts.total = counts.bills + counts.vendorCredits + counts.billPayments;
    const val = await ledger.validateBalance(existing.id);
    log(
      `AP backfill complete: ${counts.total} new transactions, trial balance ${val.valid ? 'VALID' : 'INVALID'}`,
    );

    return {
      tenantId: existing.id,
      tenantName: existing.name,
      alreadyExisted: true,
      counts,
      trialBalanceValid: val.valid,
    };
  }

  // ── 2. Create tenant + grant user access + create company ────
  const [tenant] = await db.insert(tenants).values({ name: tenantName, slug }).returning();
  if (!tenant) throw new Error('Failed to create demo tenant');
  log(`Created tenant: ${tenant.name} (${tenant.id})`);

  await db.insert(userTenantAccess).values({
    userId: adminUserId,
    tenantId: tenant.id,
    role: 'owner',
    isActive: true,
  });

  await db.insert(companies).values({
    tenantId: tenant.id,
    businessName: tenantName,
    entityType: 'single_member_llc',
    industry: 'Professional Services',
    addressLine1: '123 Main Street',
    city: 'Austin',
    state: 'TX',
    zip: '78701',
    phone: '(512) 555-0100',
    email: 'hello@demobookkeeping.example.com',
    setupComplete: true,
    invoicePrefix: 'INV-',
    invoiceNextNumber: 1001,
  });

  // ── 3. Seed COA ───────────────────────────────────────────────
  await accountsService.seedFromTemplate(tenant.id, 'default');
  const allAccounts = await db.select().from(accounts).where(eq(accounts.tenantId, tenant.id));
  log(`Seeded ${allAccounts.length} accounts`);

  const byTag = (tag: string) => {
    const a = allAccounts.find((x) => x.systemTag === tag);
    if (!a) throw new Error(`System account not found: ${tag}`);
    return a;
  };
  const checkingAcct = byTag('cash_on_hand');
  const paymentsClearingAcct = byTag('payments_clearing');
  const revenueAccts = allAccounts.filter((a) => a.accountType === 'revenue' && !a.isSystem);
  const expenseAccts = allAccounts.filter((a) => a.accountType === 'expense' && !a.isSystem);
  if (revenueAccts.length === 0) throw new Error('No revenue accounts in COA');
  if (expenseAccts.length === 0) throw new Error('No expense accounts in COA');

  // ── 4. Contacts ───────────────────────────────────────────────
  const customerData = [
    { displayName: 'Acme Corporation', email: 'ap@acme.example.com' },
    { displayName: 'Global Industries Inc', email: 'billing@global.example.com' },
    { displayName: 'Smith & Associates', email: 'office@smithassoc.example.com' },
    { displayName: 'Tech Solutions LLC', email: 'accounts@techsol.example.com' },
    { displayName: 'Metro Design Studio', email: 'contact@metrodesign.example.com' },
    { displayName: 'Sunrise Consulting', email: 'hello@sunrise.example.com' },
  ];
  const vendorData = VENDOR_DATA;

  const customers: Array<{ id: string; displayName: string }> = [];
  for (const c of customerData) {
    const [row] = await db.insert(contacts).values({
      tenantId: tenant.id,
      displayName: c.displayName,
      contactType: 'customer',
      email: c.email,
      isActive: true,
    }).returning();
    if (row) customers.push({ id: row.id, displayName: row.displayName });
  }
  const vendors: Array<{ id: string; displayName: string }> = [];
  for (const v of vendorData) {
    const [row] = await db.insert(contacts).values({
      tenantId: tenant.id,
      displayName: v.displayName,
      contactType: 'vendor',
      email: v.email,
      isActive: true,
      defaultPaymentTerms: v.defaultPaymentTerms || null,
      is1099Eligible: v.is1099Eligible || false,
    }).returning();
    if (row) vendors.push({ id: row.id, displayName: row.displayName });
  }
  log(`Created ${customers.length} customers, ${vendors.length} vendors`);

  // ── 5. Build transaction plan ─────────────────────────────────
  // Distribute activity across 2025 (full year) and 2026 (Jan–early Apr).
  // Use realistic patterns: monthly rent, mid-month utilities, semi-monthly
  // payroll, 2–3 invoices per month, quarterly insurance.
  type Plan =
    | { kind: 'invoice'; date: string; customerIdx: number; amount: string; description: string; accountIdx: number }
    | { kind: 'cash_sale'; date: string; customerIdx: number; amount: string; description: string; accountIdx: number }
    | { kind: 'expense'; date: string; vendorIdx: number; amount: string; description: string; accountIdx: number }
    | { kind: 'payroll'; date: string; amount: string }
    | { kind: 'rent'; date: string; amount: string };

  const plans: Plan[] = [];
  const months: Array<{ year: number; month: number }> = [];
  for (let m = 1; m <= 12; m++) months.push({ year: 2025, month: m });
  for (let m = 1; m <= 4; m++) months.push({ year: 2026, month: m });

  const utilIdx = Math.max(0, expenseAccts.findIndex((a) => /utilit/i.test(a.name)));
  const phoneIdx = Math.max(0, expenseAccts.findIndex((a) => /utilit|phone|internet/i.test(a.name)));
  const officeIdx = Math.max(0, expenseAccts.findIndex((a) => /office|supplies/i.test(a.name)));
  const insuranceIdx = Math.max(0, expenseAccts.findIndex((a) => /insurance/i.test(a.name)));

  for (const { year, month } of months) {
    plans.push({ kind: 'rent', date: dateStr(year, month, 1), amount: '2500.00' });

    plans.push({
      kind: 'expense',
      date: dateStr(year, month, 15),
      vendorIdx: 0,
      amount: money(180, 260),
      description: `Electricity - ${month}/${year}`,
      accountIdx: utilIdx,
    });

    plans.push({
      kind: 'expense',
      date: dateStr(year, month, 10),
      vendorIdx: 2,
      amount: money(85, 95),
      description: `Internet service - ${month}/${year}`,
      accountIdx: phoneIdx,
    });

    const numInvoices = month <= 4 && year === 2026 ? 3 : 2 + Math.floor(rand() * 2);
    for (let i = 0; i < numInvoices; i++) {
      const day = 2 + Math.floor(rand() * 27);
      plans.push({
        kind: 'invoice',
        date: dateStr(year, month, day),
        customerIdx: Math.floor(rand() * customers.length),
        amount: money(800, 6500),
        description: pick([
          'Consulting services',
          'Software development',
          'IT support contract',
          'Web development project',
          'Monthly retainer',
          'Strategic planning engagement',
          'Quarterly accounting work',
        ]),
        accountIdx: Math.floor(rand() * revenueAccts.length),
      });
    }

    const numCashSales = 1 + Math.floor(rand() * 2);
    for (let i = 0; i < numCashSales; i++) {
      const day = 5 + Math.floor(rand() * 24);
      plans.push({
        kind: 'cash_sale',
        date: dateStr(year, month, day),
        customerIdx: Math.floor(rand() * customers.length),
        amount: money(150, 900),
        description: 'Over-the-counter sale',
        accountIdx: Math.floor(rand() * revenueAccts.length),
      });
    }

    plans.push({ kind: 'payroll', date: dateStr(year, month, 15), amount: '4250.00' });
    const lastDay = new Date(year, month, 0).getDate();
    plans.push({ kind: 'payroll', date: dateStr(year, month, lastDay), amount: '4250.00' });

    if (rand() > 0.3) {
      plans.push({
        kind: 'expense',
        date: dateStr(year, month, 8 + Math.floor(rand() * 20)),
        vendorIdx: 1,
        amount: money(40, 220),
        description: 'Office supplies',
        accountIdx: officeIdx,
      });
    }

    if (month % 3 === 1) {
      plans.push({
        kind: 'expense',
        date: dateStr(year, month, 5),
        vendorIdx: 3,
        amount: '850.00',
        description: `Business insurance premium - Q${Math.ceil(month / 3)} ${year}`,
        accountIdx: insuranceIdx,
      });
    }
  }

  plans.sort((a, b) => a.date.localeCompare(b.date));

  // ── 6. Execute the plan ───────────────────────────────────────
  const counts = {
    invoices: 0,
    customerPayments: 0,
    cashSales: 0,
    expenses: 0,
    deposits: 0,
    transfers: 0,
    journalEntries: 0,
    bills: 0,
    vendorCredits: 0,
    billPayments: 0,
    total: 0,
  };

  type Invoice = { id: string; total: number; contactId: string; date: string };
  const createdInvoices: Invoice[] = [];

  for (const plan of plans) {
    try {
      if (plan.kind === 'invoice') {
        const customer = customers[plan.customerIdx]!;
        const revenueAcct = revenueAccts[plan.accountIdx % revenueAccts.length]!;
        const inv = await invoiceService.createInvoice(tenant.id, {
          contactId: customer.id,
          txnDate: plan.date,
          paymentTerms: 'net_30',
          memo: plan.description,
          lines: [
            {
              accountId: revenueAcct.id,
              description: plan.description,
              quantity: '1',
              unitPrice: plan.amount,
              isTaxable: false,
            },
          ],
        } as unknown as Parameters<typeof invoiceService.createInvoice>[1]);
        createdInvoices.push({
          id: inv.id,
          total: parseFloat(plan.amount),
          contactId: customer.id,
          date: plan.date,
        });
        counts.invoices++;
      } else if (plan.kind === 'cash_sale') {
        const customer = customers[plan.customerIdx]!;
        const revenueAcct = revenueAccts[plan.accountIdx % revenueAccts.length]!;
        await ledger.postTransaction(tenant.id, {
          txnType: 'cash_sale',
          txnDate: plan.date,
          contactId: customer.id,
          memo: plan.description,
          total: plan.amount,
          lines: [
            { accountId: paymentsClearingAcct.id, debit: plan.amount, credit: '0' },
            { accountId: revenueAcct.id, debit: '0', credit: plan.amount, description: plan.description },
          ],
        });
        counts.cashSales++;
      } else if (plan.kind === 'expense') {
        const vendor = vendors[plan.vendorIdx]!;
        const expAcct = expenseAccts[plan.accountIdx % expenseAccts.length]!;
        await ledger.postTransaction(tenant.id, {
          txnType: 'expense',
          txnDate: plan.date,
          contactId: vendor.id,
          memo: plan.description,
          total: plan.amount,
          lines: [
            { accountId: expAcct.id, debit: plan.amount, credit: '0', description: plan.description },
            { accountId: checkingAcct.id, debit: '0', credit: plan.amount },
          ],
        });
        counts.expenses++;
      } else if (plan.kind === 'rent') {
        const vendor = vendors[4]!;
        const rentAcct = expenseAccts.find((a) => /rent/i.test(a.name)) || expenseAccts[0]!;
        await ledger.postTransaction(tenant.id, {
          txnType: 'expense',
          txnDate: plan.date,
          contactId: vendor.id,
          memo: 'Office rent',
          total: plan.amount,
          lines: [
            { accountId: rentAcct.id, debit: plan.amount, credit: '0', description: 'Monthly office rent' },
            { accountId: checkingAcct.id, debit: '0', credit: plan.amount },
          ],
        });
        counts.expenses++;
      } else if (plan.kind === 'payroll') {
        const payrollAcct = expenseAccts.find((a) => /salar|payroll|wage/i.test(a.name)) || expenseAccts[0]!;
        await ledger.postTransaction(tenant.id, {
          txnType: 'journal_entry',
          txnDate: plan.date,
          memo: 'Semi-monthly payroll',
          total: plan.amount,
          lines: [
            { accountId: payrollAcct.id, debit: plan.amount, credit: '0', description: 'Payroll' },
            { accountId: checkingAcct.id, debit: '0', credit: plan.amount },
          ],
        });
        counts.journalEntries++;
      }
    } catch (err) {
      log(`  ✗ Failed to create ${plan.kind} on ${plan.date}: ${(err as Error).message}`);
    }
  }

  // ── 7. Pay most invoices (leave the newest ones open for AR aging) ──
  for (const inv of createdInvoices) {
    const ageInDays = Math.floor(
      (Date.parse('2026-04-06') - Date.parse(inv.date)) / (86400 * 1000),
    );
    if (ageInDays < 20 && rand() < 0.6) continue;

    try {
      const paymentDate = new Date(Date.parse(inv.date) + (5 + Math.floor(rand() * 20)) * 86400 * 1000);
      const today = new Date('2026-04-06');
      if (paymentDate > today) paymentDate.setTime(today.getTime());
      const paymentDateStr = paymentDate.toISOString().split('T')[0]!;
      const partial = rand() < 0.15;
      const amount = (partial ? inv.total / 2 : inv.total).toFixed(2);

      await paymentService.receivePayment(
        tenant.id,
        {
          customerId: inv.contactId,
          date: paymentDateStr,
          amount,
          depositTo: paymentsClearingAcct.id,
          memo: 'Customer payment',
          applications: [{ invoiceId: inv.id, amount }],
        } as unknown as Parameters<typeof paymentService.receivePayment>[1],
      );
      counts.customerPayments++;
    } catch (err) {
      log(`  ✗ Failed to pay invoice: ${(err as Error).message}`);
    }
  }

  // ── 8. Monthly bank deposits sweeping Payments Clearing → Checking ──
  for (const { year, month } of months) {
    const depositDate = dateStr(year, month, 28);
    const result = await db.execute(sql`
      SELECT COALESCE(SUM(debit) - SUM(credit), 0) AS balance
      FROM journal_lines
      WHERE tenant_id = ${tenant.id}
        AND account_id = ${paymentsClearingAcct.id}
        AND transaction_id IN (
          SELECT id FROM transactions
          WHERE tenant_id = ${tenant.id} AND txn_date <= ${depositDate} AND status = 'posted'
        )
    `);
    const bal = parseFloat((result.rows[0] as { balance: string } | undefined)?.balance || '0');
    if (bal <= 0) continue;
    const depositAmount = (bal * (0.85 + rand() * 0.1)).toFixed(2);

    try {
      await ledger.postTransaction(tenant.id, {
        txnType: 'deposit',
        txnDate: depositDate,
        memo: `Month-end bank deposit - ${year}-${String(month).padStart(2, '0')}`,
        total: depositAmount,
        lines: [
          { accountId: checkingAcct.id, debit: depositAmount, credit: '0' },
          { accountId: paymentsClearingAcct.id, debit: '0', credit: depositAmount },
        ],
      });
      counts.deposits++;
    } catch (err) {
      log(`  ✗ Failed deposit for ${year}-${month}: ${(err as Error).message}`);
    }
  }

  // ── 9. Transfers to savings ───────────────────────────────────
  const savingsAcct = allAccounts.find((a) => a.accountNumber === '10120');
  if (savingsAcct) {
    for (const [year, month, amt] of [
      [2025, 3, '5000.00'],
      [2025, 9, '3000.00'],
      [2026, 2, '4000.00'],
    ] as const) {
      try {
        await ledger.postTransaction(tenant.id, {
          txnType: 'transfer',
          txnDate: dateStr(year, month, 20),
          memo: 'Transfer to savings',
          total: amt,
          lines: [
            { accountId: savingsAcct.id, debit: amt, credit: '0' },
            { accountId: checkingAcct.id, debit: '0', credit: amt },
          ],
        });
        counts.transfers++;
      } catch (err) {
        log(`  ✗ Transfer failed: ${(err as Error).message}`);
      }
    }
  }

  // ── 10. Accounts Payable: bills, vendor credits, bill payments ──
  //
  // Demonstrates the full AP lifecycle separately from the simple expense
  // flow above. Plan:
  //   - Quarterly bills from 4 AP-specific vendors (IT, legal, marketing,
  //     software) across the same date range as the rest of the demo
  //   - Most bills get paid via the Pay Bills workflow (consolidating
  //     multiple bills per vendor into one check)
  //   - A few bills are left open: some current, some overdue
  //   - Two vendor credits — one applied during a payment, one still
  //     available — so the AP aging report shows credit balances too
  await seedAccountsPayable(tenant.id, vendors, expenseAccts, checkingAcct, counts, log);

  counts.total =
    counts.invoices +
    counts.customerPayments +
    counts.cashSales +
    counts.expenses +
    counts.deposits +
    counts.transfers +
    counts.journalEntries +
    counts.bills +
    counts.vendorCredits +
    counts.billPayments;

  // ── 11. Sanity check: trial balance must balance ──────────────
  const val = await ledger.validateBalance(tenant.id);
  log(
    `Demo seed complete: ${counts.total} transactions, trial balance ${val.valid ? 'VALID' : 'INVALID'} ` +
    `(debits=${val.totalDebits.toFixed(2)}, credits=${val.totalCredits.toFixed(2)})`,
  );

  return {
    tenantId: tenant.id,
    tenantName: tenant.name,
    alreadyExisted: false,
    counts,
    trialBalanceValid: val.valid,
  };
}

/**
 * Ensure all 9 demo vendors exist for the given tenant. Used by the AP
 * backfill path: an existing demo tenant created before AP existed only
 * has the first 5 vendors, so we look up by display name and create the
 * AP-flow vendors if missing. Returns the vendors in VENDOR_DATA order so
 * seedAccountsPayable's positional indices (vendors[5]–vendors[8]) work
 * the same way for both the fresh-create and backfill paths.
 */
async function ensureApVendors(
  tenantId: string,
  log: (line: string) => void,
): Promise<Array<{ id: string; displayName: string }>> {
  const result: Array<{ id: string; displayName: string }> = [];

  for (const v of VENDOR_DATA) {
    const found = await db.query.contacts.findFirst({
      where: and(
        eq(contacts.tenantId, tenantId),
        eq(contacts.displayName, v.displayName),
      ),
    });

    if (found) {
      result.push({ id: found.id, displayName: found.displayName });
    } else {
      const [row] = await db.insert(contacts).values({
        tenantId,
        displayName: v.displayName,
        contactType: 'vendor',
        email: v.email,
        isActive: true,
        defaultPaymentTerms: v.defaultPaymentTerms || null,
        is1099Eligible: v.is1099Eligible || false,
      }).returning();
      if (row) {
        result.push({ id: row.id, displayName: row.displayName });
        log(`  Created vendor: ${v.displayName}`);
      }
    }
  }

  return result;
}

// ─── Accounts Payable demo seeding ──────────────────────────────────
//
// Builds out the AP side of the demo: bills from 4 dedicated AP vendors,
// realistic payment patterns (most paid via consolidated checks, some
// partial, some unpaid, some overdue, with a couple of vendor credits
// applied along the way).
//
// All bills go through bill.service.createBill (so bill_status, due_date,
// numbering, and journal entries follow the production code path) and all
// payments go through bill-payment.service.payBills (which exercises the
// FOR UPDATE locks, credit allocation, and bill_payment_applications logic
// the AP tests cover). This means the demo doubles as a smoke test of the
// AP code path on every fresh install.
async function seedAccountsPayable(
  tenantId: string,
  vendors: Array<{ id: string; displayName: string }>,
  expenseAccts: Array<{ id: string; name: string }>,
  checkingAcct: { id: string },
  counts: { bills: number; vendorCredits: number; billPayments: number },
  log: (line: string) => void,
) {
  // Vendor lookup — relies on the order in vendorData. The first 5 vendors
  // (utility, office supply, telco, insurance, landlord) are still owned by
  // the simple-expense flow above; vendors 5–8 are AP-flow vendors.
  const techVendor = vendors[5];      // TechWorks IT Solutions
  const legalVendor = vendors[6];     // Crawford Legal LLP
  const marketingVendor = vendors[7]; // BrightAds Marketing
  const softwareVendor = vendors[8];  // Cloudbase Software Inc

  if (!techVendor || !legalVendor || !marketingVendor || !softwareVendor) {
    log('  ⚠ AP demo skipped — required vendors not found');
    return;
  }

  // Map bill descriptions to plausible expense accounts. Falls back to the
  // first available expense account so the demo never crashes if the COA
  // template doesn't include an exact match.
  const findExpenseAcct = (pattern: RegExp) =>
    expenseAccts.find((a) => pattern.test(a.name)) || expenseAccts[0]!;
  const itAcct = findExpenseAcct(/comput|office|equipment|technology|supplies/i);
  const legalAcct = findExpenseAcct(/legal|professional|consulting/i);
  const marketingAcct = findExpenseAcct(/market|advertis|promotion/i);
  const softwareAcct = findExpenseAcct(/software|subscript|dues/i);

  // ── Bill plan ──────────────────────────────────────────────────
  //
  // Each entry: { date, vendor, account, amount, description, vendor invoice #
  // (the vendor's reference, distinct from our BILL-NNNNN), and an optional
  // payment plan that says how/when this bill should be paid.
  //
  // payAfter days: how long after the bill date the payment was made
  // payment   : 'check' | 'ach' | null (null = leave unpaid)
  // partial   : if true, only pay half (creates a 'partial' bill_status)
  // useCredit : if set, applies the indexed vendor credit during payment
  type BillSpec = {
    date: string;
    vendor: { id: string; displayName: string };
    accountId: string;
    amount: string;
    description: string;
    vendorInvoiceNumber: string;
    paymentTerms: string;
    pay: { after: number; method: 'check' | 'ach' | 'check_handwritten'; partial?: boolean } | null;
  };

  const billSpecs: BillSpec[] = [
    // ─── 2025 Q1
    {
      date: '2025-01-12', vendor: techVendor, accountId: itAcct.id,
      amount: '2450.00', description: 'Workstation refresh - 3 units',
      vendorInvoiceNumber: 'TW-25011', paymentTerms: 'net_30',
      pay: { after: 22, method: 'check' },
    },
    {
      date: '2025-02-05', vendor: legalVendor, accountId: legalAcct.id,
      amount: '1200.00', description: 'Contract review - service agreements',
      vendorInvoiceNumber: 'CL-2502-A', paymentTerms: 'net_15',
      pay: { after: 12, method: 'ach' },
    },
    {
      date: '2025-03-18', vendor: marketingVendor, accountId: marketingAcct.id,
      amount: '3850.00', description: 'Q1 digital ad campaign',
      vendorInvoiceNumber: 'BA-Q1-2025', paymentTerms: 'net_30',
      pay: { after: 18, method: 'ach' },
    },
    {
      date: '2025-03-22', vendor: softwareVendor, accountId: softwareAcct.id,
      amount: '480.00', description: 'CRM software - annual license',
      vendorInvoiceNumber: 'CB-9981', paymentTerms: 'net_30',
      pay: { after: 8, method: 'check' },
    },

    // ─── 2025 Q2
    {
      date: '2025-04-15', vendor: techVendor, accountId: itAcct.id,
      amount: '725.00', description: 'Network switch + cabling',
      vendorInvoiceNumber: 'TW-25048', paymentTerms: 'net_30',
      pay: { after: 25, method: 'check' },
    },
    {
      date: '2025-05-09', vendor: legalVendor, accountId: legalAcct.id,
      amount: '2200.00', description: 'Trademark filing + counsel',
      vendorInvoiceNumber: 'CL-2505-B', paymentTerms: 'net_15',
      pay: { after: 14, method: 'ach' },
    },
    {
      date: '2025-06-04', vendor: marketingVendor, accountId: marketingAcct.id,
      amount: '1650.00', description: 'Logo redesign + brand guide',
      vendorInvoiceNumber: 'BA-25060', paymentTerms: 'net_30',
      pay: { after: 30, method: 'check' },
    },

    // ─── 2025 Q3
    {
      date: '2025-07-08', vendor: softwareVendor, accountId: softwareAcct.id,
      amount: '299.00', description: 'Project management tool - annual',
      vendorInvoiceNumber: 'CB-10422', paymentTerms: 'net_30',
      pay: { after: 5, method: 'ach' },
    },
    {
      date: '2025-08-11', vendor: techVendor, accountId: itAcct.id,
      amount: '1875.00', description: 'Server upgrade + installation',
      vendorInvoiceNumber: 'TW-25117', paymentTerms: 'net_30',
      pay: { after: 28, method: 'check' },
    },
    {
      date: '2025-09-02', vendor: legalVendor, accountId: legalAcct.id,
      amount: '950.00', description: 'Employee handbook review',
      vendorInvoiceNumber: 'CL-2509-A', paymentTerms: 'net_15',
      pay: { after: 12, method: 'ach' },
    },
    {
      date: '2025-09-19', vendor: marketingVendor, accountId: marketingAcct.id,
      amount: '4200.00', description: 'Trade show booth + materials',
      vendorInvoiceNumber: 'BA-25092', paymentTerms: 'net_30',
      pay: { after: 35, method: 'check' },
    },

    // ─── 2025 Q4
    {
      date: '2025-10-14', vendor: techVendor, accountId: itAcct.id,
      amount: '540.00', description: 'Backup software licenses',
      vendorInvoiceNumber: 'TW-25143', paymentTerms: 'net_30',
      pay: { after: 18, method: 'check' },
    },
    {
      date: '2025-11-06', vendor: softwareVendor, accountId: softwareAcct.id,
      amount: '1200.00', description: 'Cloud storage - annual upgrade',
      vendorInvoiceNumber: 'CB-11507', paymentTerms: 'net_30',
      pay: { after: 22, method: 'ach' },
    },
    {
      date: '2025-12-01', vendor: legalVendor, accountId: legalAcct.id,
      amount: '1800.00', description: 'Year-end compliance review',
      vendorInvoiceNumber: 'CL-2512-A', paymentTerms: 'net_15',
      // Paid only partially — illustrates the 'partial' bill status
      pay: { after: 14, method: 'ach', partial: true },
    },

    // ─── 2026 Q1
    {
      date: '2026-01-08', vendor: marketingVendor, accountId: marketingAcct.id,
      amount: '2750.00', description: 'New year campaign launch',
      vendorInvoiceNumber: 'BA-26001', paymentTerms: 'net_30',
      pay: { after: 25, method: 'check' },
    },
    {
      date: '2026-02-11', vendor: techVendor, accountId: itAcct.id,
      amount: '395.00', description: 'Replacement laptop battery',
      vendorInvoiceNumber: 'TW-26019', paymentTerms: 'net_30',
      pay: { after: 12, method: 'check_handwritten' },
    },

    // ─── Open / unpaid bills (relative to demo "today" = 2026-04-06)
    // Recent + within terms — should show as 'unpaid', not yet due
    {
      date: '2026-03-25', vendor: softwareVendor, accountId: softwareAcct.id,
      amount: '660.00', description: 'Helpdesk software - quarterly',
      vendorInvoiceNumber: 'CB-12104', paymentTerms: 'net_30',
      pay: null,
    },
    {
      date: '2026-04-01', vendor: marketingVendor, accountId: marketingAcct.id,
      amount: '1900.00', description: 'April content production',
      vendorInvoiceNumber: 'BA-26032', paymentTerms: 'net_30',
      pay: null,
    },

    // Past due — should appear in the AP aging "1-30 days" bucket
    {
      date: '2026-02-20', vendor: legalVendor, accountId: legalAcct.id,
      amount: '1450.00', description: 'Vendor contract negotiation',
      vendorInvoiceNumber: 'CL-2602-B', paymentTerms: 'net_15',
      pay: null, // due 2026-03-07, ~30 days overdue as of 2026-04-06
    },
    {
      date: '2026-03-05', vendor: techVendor, accountId: itAcct.id,
      amount: '880.00', description: 'Conference room AV equipment',
      vendorInvoiceNumber: 'TW-26032', paymentTerms: 'net_15',
      pay: null, // due 2026-03-20, ~17 days overdue
    },
  ];

  // ── Create the bills ──────────────────────────────────────────
  type CreatedBill = {
    id: string;
    spec: BillSpec;
    totalNum: number;
  };
  const created: CreatedBill[] = [];

  for (const spec of billSpecs) {
    try {
      const bill = await billService.createBill(tenantId, {
        contactId: spec.vendor.id,
        txnDate: spec.date,
        paymentTerms: spec.paymentTerms,
        vendorInvoiceNumber: spec.vendorInvoiceNumber,
        memo: spec.description,
        lines: [
          { accountId: spec.accountId, amount: spec.amount, description: spec.description },
        ],
      });
      created.push({ id: bill.id, spec, totalNum: parseFloat(spec.amount) });
      counts.bills++;
    } catch (err) {
      log(`  ✗ Failed to create bill for ${spec.vendor.displayName} on ${spec.date}: ${(err as Error).message}`);
    }
  }
  log(`Created ${counts.bills} bills`);

  // ── Vendor credits ────────────────────────────────────────────
  //
  // Two credits issued by vendors:
  //   1. From TechWorks (returned defective equipment) — applied during a
  //      bill payment so the demo's "credits applied" report has data.
  //   2. From BrightAds (pricing adjustment) — left available so the
  //      AP aging report shows credit balances and the Pay Bills page
  //      can offer it next time those bills get paid.
  let techCreditId: string | null = null;
  try {
    const techCredit = await vendorCreditService.createVendorCredit(tenantId, {
      contactId: techVendor.id,
      txnDate: '2025-08-15',
      memo: 'Returned defective workstation',
      lines: [{ accountId: itAcct.id, amount: '375.00', description: 'Returned defective workstation' }],
    });
    techCreditId = techCredit.id;
    counts.vendorCredits++;
  } catch (err) {
    log(`  ✗ Failed to create TechWorks credit: ${(err as Error).message}`);
  }

  try {
    await vendorCreditService.createVendorCredit(tenantId, {
      contactId: marketingVendor.id,
      txnDate: '2026-03-15',
      memo: 'Q1 spend over-billing - partial refund',
      lines: [{ accountId: marketingAcct.id, amount: '250.00', description: 'Pricing adjustment' }],
    });
    counts.vendorCredits++;
  } catch (err) {
    log(`  ✗ Failed to create BrightAds credit: ${(err as Error).message}`);
  }
  log(`Created ${counts.vendorCredits} vendor credits`);

  // ── Pay bills ─────────────────────────────────────────────────
  //
  // Group payable bills by (vendor, payment date, method) so multi-bill
  // payments to the same vendor get consolidated into one check — this is
  // how Pay Bills behaves in production.
  type PayKey = string;
  const payGroups = new Map<PayKey, {
    vendorId: string;
    txnDate: string;
    method: 'check' | 'ach' | 'check_handwritten';
    bills: Array<{ billId: string; amount: string }>;
  }>();

  for (const c of created) {
    if (!c.spec.pay) continue;
    // Compute the payment date deterministically from bill date + offset
    const billDate = new Date(c.spec.date);
    billDate.setDate(billDate.getDate() + c.spec.pay.after);
    const payDate = billDate.toISOString().split('T')[0]!;
    const method = c.spec.pay.method;
    const key: PayKey = `${c.spec.vendor.id}|${payDate}|${method}`;

    const amount = c.spec.pay.partial
      ? (c.totalNum / 2).toFixed(2)
      : c.totalNum.toFixed(2);

    const existing = payGroups.get(key);
    if (existing) {
      existing.bills.push({ billId: c.id, amount });
    } else {
      payGroups.set(key, {
        vendorId: c.spec.vendor.id,
        txnDate: payDate,
        method,
        bills: [{ billId: c.id, amount }],
      });
    }
  }

  // Pick one payment group from TechWorks to apply the tech credit against.
  // We mutate the first techVendor group's amount to match (the credit
  // application reduces the cash leg, so the chosen bill must be at least
  // as large as the credit).
  let creditApplicationDone = false;

  for (const group of payGroups.values()) {
    try {
      // Apply the TechWorks credit to the first eligible TechWorks payment
      // (one bill ≥ $375). Limited to a single application so the demo
      // shows both the "credit applied" and "credit available" states.
      let credits: Array<{ creditId: string; billId: string; amount: string }> | undefined;
      if (
        !creditApplicationDone &&
        techCreditId &&
        group.vendorId === techVendor.id &&
        group.bills.length > 0 &&
        parseFloat(group.bills[0]!.amount) >= 375
      ) {
        credits = [{ creditId: techCreditId, billId: group.bills[0]!.billId, amount: '375.00' }];
        creditApplicationDone = true;
      }

      await billPaymentService.payBills(tenantId, {
        bankAccountId: checkingAcct.id,
        txnDate: group.txnDate,
        method: group.method,
        // For 'check' method, queue for printing (mirrors how a real user
        // would prep checks for the next print run); 'check_handwritten'
        // immediately allocates a number; 'ach' has no print state.
        printLater: group.method === 'check',
        bills: group.bills,
        credits,
      });
      counts.billPayments++;
    } catch (err) {
      log(`  ✗ Failed bill payment on ${group.txnDate}: ${(err as Error).message}`);
    }
  }
  log(`Posted ${counts.billPayments} bill payments`);
}
