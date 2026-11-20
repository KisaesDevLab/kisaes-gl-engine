// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// Posting lock order under load (ClientLedger P33 soak, company-row-lock.ts).
//
// Every posting with an Idempotency-Key holds FOR KEY SHARE on its company
// row (the idempotency_keys.company_id foreign key). The counters (invoice,
// check and vendor credit numbers) and the inventory costing lock then took
// the same row FOR UPDATE, which waits for every other posting's KEY SHARE:
// two invoice creates each waited for the other to upgrade, a deadlock on
// every pair (the soak refused 124 of 134 invoices with 409 RETRY).
//
//   - company row locks: a counter or the costing lock never waits for
//     another posting's KEY SHARE on the company row;
//   - /health answers at once while every connection of the main pool is
//     busy, and an idle connection the server ends does not stop the engine;
//   - five workstations post a mixed workload at once (journal entries,
//     invoices and the customer payments on them, bills and bill payments by
//     printed and by numbered check, vendor credits, inventory sales of one
//     shared part, edits of shared entries), each under its own
//     Idempotency-Key as the desktop app sends them: no 409 RETRY and no
//     deadlock in the database; every posting balances, the trial balance
//     balances, A/R and A/P tie to the open documents and to what the
//     clients left open, the part's stock and cost stay in order, invoice
//     and check numbers stay distinct and gap-free.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { startLanEngine, DEVICE_A, DEVICE_B, type LanEngine } from '../desktop/lan.test-support.js';
import type { Tx } from '../db/index.js';

const CLIENTS = 5;
const OPS = 200;
const DEVICES = [DEVICE_A, DEVICE_B, 'c3'.repeat(32), 'd4'.repeat(32), 'e5'.repeat(32)];
const DATE = '2026-03-02';
const STOCK = 100_000;

let e: LanEngine;
const who = DEVICES.map((device) => ({ device }));
const jwt: string[] = [];
const books = {
  tenantId: '', companyId: '',
  cash: '', supplies: '', income: '', bank: '', clearing: '', ar: '', ap: '', asset: '', cogs: '', part: '',
  customers: [] as string[], vendors: [] as string[], shared: [] as string[],
};
/** What the setup and the tests before the race made: A/R and A/P open (cents), units sold, numbered documents. */
const pre = { ar: 0, ap: 0, sold: 0, invoices: 0, vendorCredits: 0, checks: 0 };

type Res = Awaited<ReturnType<LanEngine['call']>>;

function post(c: number, p: string, body: unknown, method = 'POST'): Promise<Res> {
  return e.call(who[c]!, p, { method, jwt: jwt[c], body, headers: { 'Idempotency-Key': `race-${randomUUID()}` } });
}

async function ok(r: Res | Promise<Res>, status = 201) {
  const x = await r;
  expect(x.status, JSON.stringify(x.json)).toBe(status);
  return x.json;
}

function je(memo: string, amount: string, stamp?: string) {
  return {
    txnType: 'journal_entry', txnDate: DATE, memo, ...(stamp ? { expectedUpdatedAt: stamp } : {}),
    lines: [{ accountId: books.supplies, debit: amount, credit: '0' }, { accountId: books.cash, debit: '0', credit: amount }],
  };
}

beforeAll(async () => {
  e = await startLanEngine({ env: { MAX_SESSIONS_PER_USER: String(4 * CLIENTS) } });
  for (let c = 0; c < CLIENTS; c++) jwt.push(await e.signIn(who[c]!));
  const company = await ok(e.call(who[0]!, '/api/v1/company', { jwt: jwt[0] }), 200);
  await ok(post(0, '/api/v1/company/settings', {
    inventoryEnabled: true, expectedUpdatedAt: (company.company ?? company).updatedAt,
  }, 'PUT'), 200);
  const [co] = await e.query<{ id: string }>('SELECT id FROM companies WHERE tenant_id = $1', [e.company]);
  books.tenantId = e.company;
  books.companyId = co!.id;
  const account = async (name: string, accountType: string, detailType?: string) => {
    await ok(post(0, '/api/v1/accounts', { name, accountType, ...(detailType ? { detailType } : {}) }));
    return (await e.query<{ id: string }>('SELECT id FROM accounts WHERE name = $1', [name]))[0]!.id;
  };
  books.cash = await account('Race cash', 'asset');
  books.supplies = await account('Race supplies', 'expense');
  books.income = await account('Race sales', 'revenue');
  books.bank = await account('Race bank', 'asset', 'bank');
  const tagged = async (tag: string) => (await e.query<{ id: string }>(
    'SELECT id FROM accounts WHERE system_tag = $1 AND is_active ORDER BY created_at LIMIT 1', [tag]))[0]!.id;
  books.clearing = await tagged('payments_clearing');
  books.ar = await tagged('accounts_receivable');
  books.ap = await tagged('accounts_payable');
  books.asset = await tagged('inventory_asset');
  books.cogs = (await e.query<{ id: string }>(
    "SELECT id FROM accounts WHERE account_type = 'cogs' AND is_active ORDER BY created_at LIMIT 1"))[0]!.id;
  const item = await ok(post(0, '/api/v1/items', {
    name: 'Race part', itemType: 'inventory_part', unitPrice: '10.00', incomeAccountId: books.income,
    assetAccountId: books.asset, cogsAccountId: books.cogs,
  }));
  books.part = (item.item ?? item).id;
  const contact = async (contactType: string, displayName: string) =>
    ((await ok(post(0, '/api/v1/contacts', { contactType, displayName }))).contact ?? {}).id as string;
  const supplier = await contact('vendor', 'Race supplier');
  // Stock no run can sell out, at 0.25, on the run's own date (the soak's setup).
  await ok(post(0, '/api/v1/bills', {
    contactId: supplier, txnDate: DATE, vendorInvoiceNumber: 'STOCK-1', lines: [
      { accountId: books.asset, amount: (STOCK / 4).toFixed(2), itemId: books.part, quantity: String(STOCK), unitPrice: '0.25' }],
  }));
  pre.ap += STOCK * 25;
  for (let c = 0; c < CLIENTS; c++) {
    books.customers.push(await contact('customer', `Race client ${c}`));
    books.vendors.push(await contact('vendor', `Race vendor ${c}`));
  }
  for (let k = 0; k < 3; k++) {
    const t = await ok(post(0, '/api/v1/transactions', je(`shared ${k} #0`, '1.00')));
    books.shared.push(t.transaction.id);
  }
}, 300_000);

afterAll(async () => {
  await e?.close();
});

/** A transaction on its own connection that holds FOR KEY SHARE on the company row, as another posting's Idempotency-Key row does. */
async function holdKeyShare<T>(fn: () => Promise<T>): Promise<T> {
  const holder = new pg.Client({ connectionString: e.dbUrl });
  await holder.connect();
  try {
    await holder.query('BEGIN');
    await holder.query('SELECT 1 FROM companies WHERE id = $1 FOR KEY SHARE', [books.companyId]);
    return await fn();
  } finally {
    await holder.query('ROLLBACK').catch(() => undefined);
    await holder.end();
  }
}

describe('company row locks (company-row-lock.ts)', () => {
  /** Runs `fn` in an app transaction that gives up after 2 s of waiting for a lock (55P03 then). */
  async function inAppTx(fn: (tx: Tx) => Promise<unknown>) {
    const { db } = await import('../db/index.js');
    const { sql } = await import('drizzle-orm');
    return db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);
      await fn(tx);
    });
  }

  it('a counter or the costing lock does not wait for another posting\'s KEY SHARE on the company row', async () => {
    const documentNumbers = await import('./document-number.service.js');
    const checks = await import('./check.service.js');
    const costing = await import('./inventory-costing.service.js');
    await holdKeyShare(async () => {
      await inAppTx((tx) => documentNumbers.claim(books.tenantId, 'statement', books.companyId, tx));
      await inAppTx((tx) => checks.lockCheckCounter(tx, books.tenantId, books.companyId));
      await inAppTx((tx) => checks.lockCheckCounter(tx, books.tenantId, undefined));
      await inAppTx((tx) => costing.lockForInventory(tx, books.tenantId, books.companyId, [books.part], [DATE]));
    });
  });

  it('an invoice, a numbered check and a vendor credit save while another posting holds its KEY SHARE', async () => {
    await holdKeyShare(async () => {
      const deadline = <T>(p: Promise<T>) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('waited for the KEY SHARE')), 4000))]);
      // An inventory sale: the invoice number claim and the costing lock.
      await ok(deadline(post(0, '/api/v1/invoices', {
        contactId: books.customers[0], txnDate: DATE, lines: [{ itemId: books.part, quantity: '1', unitPrice: '10.00', isTaxable: false }],
      })));
      Object.assign(pre, { invoices: pre.invoices + 1, sold: pre.sold + 1, ar: pre.ar + 1000 });
      const bill = await ok(deadline(post(0, '/api/v1/bills', {
        contactId: books.vendors[0], txnDate: DATE, vendorInvoiceNumber: 'LOCK-1', lines: [{ accountId: books.supplies, amount: '3.00' }],
      })));
      // A check numbered now: the check counter.
      await ok(deadline(post(0, '/api/v1/bill-payments', {
        bankAccountId: books.bank, txnDate: DATE, method: 'check_handwritten', bills: [{ billId: (bill.bill ?? bill.transaction ?? bill).id, amount: '3.00' }],
      })));
      pre.checks += 1;
      // The vendor credit number.
      await ok(deadline(post(0, '/api/v1/vendor-credits', {
        contactId: books.vendors[0], txnDate: DATE, lines: [{ accountId: books.supplies, amount: '1.00' }],
      })));
      Object.assign(pre, { vendorCredits: pre.vendorCredits + 1, ap: pre.ap - 100 });
    });
  });
});

describe('/health under load', () => {
  it('answers at once, db ok, while every connection of the main pool is busy', async () => {
    const { pool } = await import('../db/index.js');
    // Warm the cached schema and role reads, as the host's start-up probes do.
    await e.call('host', '/health');
    const held: pg.PoolClient[] = [];
    try {
      for (let i = 0; i < 20; i++) held.push(await pool.connect());
      const at = performance.now();
      const h = await e.call('host', '/health');
      const ms = performance.now() - at;
      expect(h.json?.db, JSON.stringify(h.json)).toBe('ok');
      expect(ms).toBeLessThan(1000);
    } finally {
      for (const c of held) c.release();
    }
  });

  it('an idle connection the server ends does not stop the engine', async () => {
    const { pool } = await import('../db/index.js');
    const c = await pool.connect();
    const pid = (await c.query<{ p: number }>('SELECT pg_backend_pid() AS p')).rows[0]!.p;
    c.release();
    await e.query('SELECT pg_terminate_backend($1)', [pid]);
    await new Promise((r) => setTimeout(r, 300));
    const r = await e.call(who[0]!, '/api/v1/accounts', { jwt: jwt[0] });
    expect(r.status).toBe(200);
  });
});

interface Tally {
  retry: Record<string, number>;
  failures: string[];
  ms: number[];
  arOpen: number; // cents
  apOpen: number;
  done: Record<string, number>;
}

async function client(c: number): Promise<Tally> {
  const t: Tally = { retry: {}, failures: [], ms: [], arOpen: 0, apOpen: 0, done: {} };
  const invoices: Array<{ id: string; cents: number }> = [];
  const bills: Array<{ id: string; cents: number }> = [];
  const timed = async (kind: string, f: () => Promise<Res>, want = 201): Promise<Res | null> => {
    const at = performance.now();
    const r = await f();
    t.ms.push(performance.now() - at);
    if (r.status === want) { t.done[kind] = (t.done[kind] ?? 0) + 1; return r; }
    if (r.status === 409 && r.json?.error?.code === 'RETRY') t.retry[kind] = (t.retry[kind] ?? 0) + 1;
    else if (!(r.status === 409 && r.json?.error?.code === 'STALE')) t.failures.push(`${kind} ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`);
    return null;
  };
  for (let n = 1; n <= OPS; n++) {
    const cents = 100 + ((n * 37 + c * 11) % 900);
    const amount = (cents / 100).toFixed(2);
    switch (n % 10) {
      case 0: {
        // A shared entry, read and saved on its stamp (a 409 STALE is a refusal, not a failure).
        const k = (Math.floor(n / 10) + c) % books.shared.length;
        const [row] = await e.query<{ s: string; memo: string }>(
          `SELECT to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS s, memo FROM transactions WHERE id = $1`, [books.shared[k]]);
        await timed('edit', () => post(c, `/api/v1/transactions/${books.shared[k]}`, je(`${row!.memo} by ${c}`, '1.00', row!.s), 'PUT'), 200);
        break;
      }
      case 2: {
        const r = await timed('invoice', () => post(c, '/api/v1/invoices', {
          contactId: books.customers[c], txnDate: DATE,
          lines: [{ accountId: books.income, description: 'Work', quantity: '1', unitPrice: amount, isTaxable: false }],
        }));
        if (r) { invoices.push({ id: r.json.invoice.id, cents }); t.arOpen += cents; }
        break;
      }
      case 4: {
        const inv = invoices.shift();
        if (!inv) break;
        const a = (inv.cents / 100).toFixed(2);
        const r = await timed('payment', () => post(c, '/api/v1/payments/receive', {
          customerId: books.customers[c], date: DATE, amount: a, depositTo: books.clearing, paymentMethod: 'check',
          applications: [{ invoiceId: inv.id, amount: a }],
        }));
        if (r) t.arOpen -= inv.cents; else invoices.unshift(inv);
        break;
      }
      case 5: {
        const r = await timed('bill', () => post(c, '/api/v1/bills', {
          contactId: books.vendors[c], txnDate: DATE, dueDate: DATE, vendorInvoiceNumber: `R${c}-${n}-${randomUUID().slice(0, 8)}`,
          lines: [{ accountId: books.supplies, amount }],
        }));
        if (r) { bills.push({ id: (r.json.bill ?? r.json.transaction ?? r.json).id, cents }); t.apOpen += cents; }
        break;
      }
      case 7: {
        const bill = bills.shift();
        if (!bill) break;
        // Printed later (no number) and numbered now (the company's check counter), in turn.
        const numbered = n % 20 === 17;
        const r = await timed(numbered ? 'numbered check' : 'bill payment', () => post(c, '/api/v1/bill-payments', {
          bankAccountId: books.bank, txnDate: DATE, ...(numbered ? { method: 'check_handwritten' } : { method: 'check', printLater: true }),
          bills: [{ billId: bill.id, amount: (bill.cents / 100).toFixed(2) }],
        }));
        if (r) t.apOpen -= bill.cents; else bills.unshift(bill);
        break;
      }
      case 8: {
        const r = await timed('inventory sale', () => post(c, '/api/v1/invoices', {
          contactId: books.customers[c], txnDate: DATE,
          lines: [{ itemId: books.part, quantity: '1', unitPrice: '10.00', isTaxable: false }],
        }));
        if (r) { invoices.push({ id: r.json.invoice.id, cents: 1000 }); t.arOpen += 1000; }
        break;
      }
      case 9:
        if (n % 20 === 9) {
          const r = await timed('vendor credit', () => post(c, '/api/v1/vendor-credits', {
            contactId: books.vendors[c], txnDate: DATE, lines: [{ accountId: books.supplies, amount }],
          }));
          if (r) t.apOpen -= cents;
          break;
        }
      // falls through: a journal entry on the other half
      default:
        await timed('entry', () => post(c, '/api/v1/transactions', je(`race ${c} ${n}`, amount)));
    }
  }
  return t;
}

async function deadlocks(): Promise<number> {
  const [row] = await e.query<{ n: string }>('SELECT deadlocks::text AS n FROM pg_stat_database WHERE datname = current_database()');
  return Number(row!.n);
}

function contiguous(nums: number[]): boolean {
  const s = [...nums].sort((a, b) => a - b);
  return s.every((v, i) => i === 0 || v === s[i - 1]! + 1);
}

describe('posting lock order (P33 soak)', () => {
  it(`five workstations, ${OPS} mixed postings each: no deadlock, no 409 RETRY, the books balance`, async () => {
    const before = await deadlocks();
    // The host's health check runs throughout (P33: it never waits behind postings).
    let running = true;
    const health: Array<{ status: number; ms: number }> = [];
    const probe = (async () => {
      while (running) {
        const at = performance.now();
        const h = await e.call('host', '/health');
        health.push({ status: h.status, ms: performance.now() - at });
        await new Promise((r) => setTimeout(r, 250));
      }
    })();
    const tallies = await Promise.all(Array.from({ length: CLIENTS }, (_, c) => client(c)));
    running = false;
    await probe;
    // A backend reports its deadlock count when it goes idle, within 10 s
    // (PostgreSQL 15+ cumulative statistics); this also counts deadlocks an
    // engine-side retry (transactionWithRetry) hid from the client.
    await new Promise((r) => setTimeout(r, 11_000));
    const after = await deadlocks();
    const retry: Record<string, number> = {};
    const done: Record<string, number> = {};
    for (const t of tallies) {
      for (const [k, v] of Object.entries(t.retry)) retry[k] = (retry[k] ?? 0) + v;
      for (const [k, v] of Object.entries(t.done)) done[k] = (done[k] ?? 0) + v;
    }
    const ms = tallies.flatMap((t) => t.ms).sort((a, b) => a - b);
    const pct = (p: number) => Math.round(ms[Math.min(ms.length - 1, Math.floor((ms.length * p) / 100))]!);
    const healthMax = Math.round(Math.max(...health.map((h) => h.ms)));
    const statuses = [...new Set(health.map((h) => h.status))];
    const failures = tallies.flatMap((t) => t.failures);
    console.log(`[posting race] ${CLIENTS} clients x ${OPS} ops: done ${JSON.stringify(done)}; 409 RETRY ${JSON.stringify(retry)}; `
      + `${after - before} database deadlocks; p50 ${pct(50)} ms, p95 ${pct(95)} ms, p99 ${pct(99)} ms, max ${Math.round(ms[ms.length - 1]!)} ms; `
      + `${failures.length} failures; /health ${health.length} probes, max ${healthMax} ms, status ${statuses.join('/')}`);
    expect(failures, failures.slice(0, 5).join('\n')).toEqual([]);
    expect(retry).toEqual({});
    expect(after - before).toBe(0);
    expect(healthMax).toBeLessThan(1000);

    // Every posting balances.
    const unbalanced = await e.query<{ id: string }>(`
      SELECT t.id FROM transactions t JOIN journal_lines jl ON jl.transaction_id = t.id
      WHERE t.status = 'posted' GROUP BY t.id HAVING SUM(jl.debit) <> SUM(jl.credit)`);
    expect(unbalanced).toEqual([]);
    // Every account's balance is the sum of its posted lines (no balance update lost or doubled).
    const off = await e.query<{ id: string }>(`
      SELECT a.id FROM accounts a
      LEFT JOIN (SELECT jl.account_id, SUM(jl.debit - jl.credit) AS net FROM journal_lines jl
        JOIN transactions t ON t.id = jl.transaction_id WHERE t.status = 'posted' GROUP BY jl.account_id) s ON s.account_id = a.id
      WHERE COALESCE(s.net, 0) <> a.balance`);
    expect(off).toEqual([]);
    // The trial balance balances.
    const [tb] = await e.query<{ d: string; c: string }>(`
      SELECT COALESCE(SUM(jl.debit), 0)::text AS d, COALESCE(SUM(jl.credit), 0)::text AS c
      FROM journal_lines jl JOIN transactions t ON t.id = jl.transaction_id WHERE t.status = 'posted'`);
    expect(tb!.d).toBe(tb!.c);
    // A/R and A/P tie: the control account = the open documents = what the clients left open.
    const cents = (v: string) => Math.round(Number(v) * 100);
    const arOpen = tallies.reduce((s, t) => s + t.arOpen, 0) + pre.ar;
    const apOpen = tallies.reduce((s, t) => s + t.apOpen, 0) + pre.ap;
    const [ar] = await e.query<{ gl: string; docs: string }>(`
      SELECT (SELECT balance FROM accounts WHERE id = $1)::text AS gl,
        (SELECT COALESCE(SUM(balance_due), 0) FROM transactions WHERE txn_type = 'invoice' AND status = 'posted')::text AS docs`, [books.ar]);
    expect(cents(ar!.gl)).toBe(arOpen);
    expect(cents(ar!.docs)).toBe(arOpen);
    const [ap] = await e.query<{ gl: string; docs: string }>(`
      SELECT (SELECT balance FROM accounts WHERE id = $1)::text AS gl,
        (SELECT COALESCE(SUM(CASE txn_type WHEN 'bill' THEN balance_due ELSE -balance_due END), 0) FROM transactions
          WHERE txn_type IN ('bill', 'vendor_credit') AND status = 'posted')::text AS docs`, [books.ap]);
    expect(-cents(ap!.gl)).toBe(apOpen);
    expect(cents(ap!.docs)).toBe(apOpen);
    // Inventory: on hand = stock - sales; every sale costed at the one cost
    // (0.25), the running figures in position order, the asset account = on hand at cost.
    const sold = (done['inventory sale'] ?? 0) + pre.sold;
    const [part] = await e.query<{ q: string; last_q: string; last_v: string; sales: number; costs: string }>(`
      SELECT (SELECT SUM(quantity) FROM inventory_movements WHERE item_id = $1 AND NOT voided)::text AS q,
        (SELECT running_qty::text FROM inventory_movements WHERE item_id = $1 AND NOT voided
          ORDER BY movement_date DESC, txn_created_at DESC, transaction_id DESC LIMIT 1) AS last_q,
        (SELECT running_value::text FROM inventory_movements WHERE item_id = $1 AND NOT voided
          ORDER BY movement_date DESC, txn_created_at DESC, transaction_id DESC LIMIT 1) AS last_v,
        (SELECT count(*)::int FROM inventory_movements WHERE item_id = $1 AND kind = 'sale' AND NOT voided) AS sales,
        (SELECT string_agg(DISTINCT value::text, ',') FROM inventory_movements WHERE item_id = $1 AND kind = 'sale' AND NOT voided) AS costs`,
    [books.part]);
    expect(part!.sales).toBe(sold);
    expect(Number(part!.q)).toBe(STOCK - sold);
    expect(Number(part!.last_q)).toBe(STOCK - sold);
    expect(Number(part!.last_v)).toBe((STOCK - sold) * 0.25);
    expect(part!.costs).toBe('-0.2500');
    const [asset] = await e.query<{ b: string }>('SELECT balance::text AS b FROM accounts WHERE id = $1', [books.asset]);
    expect(Number(asset!.b)).toBe((STOCK - sold) * 0.25);
    // Invoice, vendor credit and check numbers: one per document, gap-free (a refused post takes none).
    const inv = await e.query<{ n: string }>("SELECT txn_number AS n FROM transactions WHERE txn_type = 'invoice'");
    expect(inv).toHaveLength((done['invoice'] ?? 0) + (done['inventory sale'] ?? 0) + pre.invoices);
    expect(contiguous(inv.map((x) => Number(/(\d+)$/.exec(x.n)![1])))).toBe(true);
    const vc = await e.query<{ n: string }>("SELECT txn_number AS n FROM transactions WHERE txn_type = 'vendor_credit'");
    expect(vc).toHaveLength((done['vendor credit'] ?? 0) + pre.vendorCredits);
    expect(contiguous(vc.map((x) => Number(/(\d+)$/.exec(x.n)![1])))).toBe(true);
    const checks = await e.query<{ n: number }>(
      "SELECT check_number AS n FROM transactions WHERE txn_type = 'bill_payment' AND check_number IS NOT NULL");
    expect(checks).toHaveLength((done['numbered check'] ?? 0) + pre.checks);
    expect(contiguous(checks.map((x) => x.n))).toBe(true);
  }, 900_000);
});
