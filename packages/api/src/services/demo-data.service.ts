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

import { eq, sql } from 'drizzle-orm';
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
    total: number;
  };
  trialBalanceValid: boolean;
}

const DEFAULT_TENANT_NAME = 'Demo Bookkeeping Co';
const DEFAULT_SLUG = 'demo-co';

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
  const existing = await db.query.tenants.findFirst({ where: eq(tenants.slug, slug) });
  if (existing) {
    log(`Demo tenant "${slug}" already exists; skipping creation.`);
    return {
      tenantId: existing.id,
      tenantName: existing.name,
      alreadyExisted: true,
      counts: { invoices: 0, customerPayments: 0, cashSales: 0, expenses: 0, deposits: 0, transfers: 0, journalEntries: 0, total: 0 },
      trialBalanceValid: true,
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
  const byNumber = (num: string) => {
    const a = allAccounts.find((x) => x.accountNumber === num);
    if (!a) throw new Error(`Account not found: ${num}`);
    return a;
  };

  const checkingAcct = byNumber('10110');
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
  const vendorData = [
    { displayName: 'City Power & Light', email: 'billing@citypower.example.com' },
    { displayName: 'Office Depot Supply', email: 'accounts@officedepot.example.com' },
    { displayName: 'AT&T Business', email: 'commercial@att.example.com' },
    { displayName: 'Commercial Insurance Group', email: 'policy@cig.example.com' },
    { displayName: 'Downtown Office Lease LLC', email: 'rent@downtownlease.example.com' },
  ];

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

  counts.total =
    counts.invoices +
    counts.customerPayments +
    counts.cashSales +
    counts.expenses +
    counts.deposits +
    counts.transfers +
    counts.journalEntries;

  // ── 10. Sanity check: trial balance must balance ──────────────
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
