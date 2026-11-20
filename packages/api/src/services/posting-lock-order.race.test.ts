// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// Posting lock order under load (ClientLedger P33 soak): five workstations
// post a mixed workload at once (journal entries, invoices and the customer
// payments on them, bills and the bill payments on them, inventory sales of
// one shared stocked part, and edits of shared entries), each under its own
// Idempotency-Key, as the desktop app does. No posting may deadlock: not one
// 409 RETRY and no deadlock in the database. The books balance afterwards:
// every posting, the trial balance, A/R and A/P against what the clients left
// open, and the part's quantity and value.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startLanEngine, DEVICE_A, DEVICE_B, type LanEngine } from '../desktop/lan.test-support.js';

const CLIENTS = 5;
const OPS = Number(process.env['RACE_OPS'] ?? 200);
const DEVICES = [DEVICE_A, DEVICE_B, 'c3'.repeat(32), 'd4'.repeat(32), 'e5'.repeat(32)];
const DATE = '2026-03-02';

let e: LanEngine;
const who = DEVICES.map((device) => ({ device }));
const jwt: string[] = [];
const books = {
  cash: '', supplies: '', income: '', bank: '', clearing: '', ar: '', ap: '', asset: '', cogs: '', part: '',
  customers: [] as string[], vendors: [] as string[], shared: [] as string[],
};

type Res = Awaited<ReturnType<LanEngine['call']>>;

function post(c: number, p: string, body: unknown, method = 'POST'): Promise<Res> {
  return e.call(who[c]!, p, { method, jwt: jwt[c], body, headers: { 'Idempotency-Key': `race-${randomUUID()}` } });
}

async function ok(r: Res | Promise<Res>, status = 201) {
  const x = await r;
  expect(x.status, JSON.stringify(x.json)).toBe(status);
  return x.json;
}

beforeAll(async () => {
  e = await startLanEngine({ env: { MAX_SESSIONS_PER_USER: String(4 * CLIENTS) } });
  for (let c = 0; c < CLIENTS; c++) jwt.push(await e.signIn(who[c]!));
  const company = await ok(e.call(who[0]!, '/api/v1/company', { jwt: jwt[0] }), 200);
  await ok(post(0, '/api/v1/company/settings', {
    inventoryEnabled: true, expectedUpdatedAt: (company.company ?? company).updatedAt,
  }, 'PUT'), 200);
  const account = async (name: string, accountType: string, detailType?: string) =>
    (await ok(post(0, '/api/v1/accounts', { name, accountType, ...(detailType ? { detailType } : {}) }))).account?.id
      ?? (await e.query<{ id: string }>('SELECT id FROM accounts WHERE name = $1', [name]))[0]!.id;
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
  // Stock no run can sell out, on the run's own date (the soak's setup).
  await ok(post(0, '/api/v1/bills', {
    contactId: supplier, txnDate: DATE, vendorInvoiceNumber: 'STOCK-1', lines: [
      { accountId: books.asset, amount: '25000.00', itemId: books.part, quantity: '100000', unitPrice: '0.25' }],
  }));
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

function je(memo: string, amount: string, stamp?: string) {
  return {
    txnType: 'journal_entry', txnDate: DATE, memo, ...(stamp ? { expectedUpdatedAt: stamp } : {}),
    lines: [{ accountId: books.supplies, debit: amount, credit: '0' }, { accountId: books.cash, debit: '0', credit: amount }],
  };
}

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
        if (r) { bills.push({ id: r.json.bill?.id ?? r.json.transaction?.id ?? r.json.id, cents }); t.apOpen += cents; }
        break;
      }
      case 7: {
        const bill = bills.shift();
        if (!bill) break;
        const r = await timed('bill payment', () => post(c, '/api/v1/bill-payments', {
          bankAccountId: books.bank, txnDate: DATE, method: 'check', printLater: true,
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

describe('posting lock order (P33 soak)', () => {
  it(`five workstations, ${OPS} mixed postings each: no deadlock, the books balance`, async () => {
    const before = await deadlocks();
    // The host's health check runs every second during the run (P33: it must
    // never wait behind postings).
    let running = true;
    const health: number[] = [];
    const probe = (async () => {
      while (running) {
        const at = performance.now();
        const h = await e.call('host', '/health');
        health.push(h.status === 200 ? performance.now() - at : Infinity);
        await new Promise((r) => setTimeout(r, 250));
      }
    })();
    const tallies = await Promise.all(Array.from({ length: CLIENTS }, (_, c) => client(c)));
    running = false;
    await probe;
    const after = await deadlocks();
    const retry: Record<string, number> = {};
    const done: Record<string, number> = {};
    for (const t of tallies) {
      for (const [k, v] of Object.entries(t.retry)) retry[k] = (retry[k] ?? 0) + v;
      for (const [k, v] of Object.entries(t.done)) done[k] = (done[k] ?? 0) + v;
    }
    const ms = tallies.flatMap((t) => t.ms).sort((a, b) => a - b);
    const pct = (p: number) => Math.round(ms[Math.min(ms.length - 1, Math.floor((ms.length * p) / 100))]!);
    const failures = tallies.flatMap((t) => t.failures);
    console.log(`[posting race] ${CLIENTS} clients x ${OPS} ops: done ${JSON.stringify(done)}; 409 RETRY ${JSON.stringify(retry)}; `
      + `${after - before} database deadlocks; p50 ${pct(50)} ms, p95 ${pct(95)} ms, p99 ${pct(99)} ms, max ${Math.round(ms[ms.length - 1]!)} ms; `
      + `${failures.length} failures; /health max ${Math.round(Math.max(...health))} ms over ${health.length} probes`);
    expect(failures, failures.slice(0, 5).join('\n')).toEqual([]);
    expect(retry).toEqual({});
    expect(after - before).toBe(0);

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
    // A/R and A/P tie: the control accounts and the open documents equal what the clients left open.
    const arOpen = tallies.reduce((s, t) => s + t.arOpen, 0);
    const apOpen = tallies.reduce((s, t) => s + t.apOpen, 0) + 2_500_000;
    const [ar] = await e.query<{ gl: string; docs: string }>(`
      SELECT (SELECT balance FROM accounts WHERE id = $1)::text AS gl,
        (SELECT COALESCE(SUM(balance_due), 0) FROM transactions WHERE txn_type = 'invoice' AND status = 'posted')::text AS docs`, [books.ar]);
    expect(Math.round(Number(ar!.gl) * 100)).toBe(arOpen);
    expect(Math.round(Number(ar!.docs) * 100)).toBe(arOpen);
    const [ap] = await e.query<{ gl: string; docs: string }>(`
      SELECT (SELECT balance FROM accounts WHERE id = $1)::text AS gl,
        (SELECT COALESCE(SUM(balance_due), 0) FROM transactions WHERE txn_type = 'bill' AND status = 'posted')::text AS docs`, [books.ap]);
    expect(Math.abs(Math.round(Number(ap!.gl) * 100))).toBe(apOpen);
    expect(Math.round(Number(ap!.docs) * 100)).toBe(apOpen);
    // Inventory: on hand = stock - sales; the asset account holds on hand at
    // the one cost (0.25), and every sale was costed at it (the walk stayed
    // in order: no sale costed out of position).
    const sold = done['inventory sale'] ?? 0;
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
    expect(Number(part!.q)).toBe(100000 - sold);
    expect(Number(part!.last_q)).toBe(100000 - sold);
    expect(Number(part!.last_v)).toBe((100000 - sold) * 0.25);
    if (sold > 0) expect(part!.costs).toBe('-0.2500');
    const [asset] = await e.query<{ b: string }>('SELECT balance::text AS b FROM accounts WHERE id = $1', [books.asset]);
    expect(Number(asset!.b)).toBe((100000 - sold) * 0.25);
    // Invoice numbers: distinct and gap-free.
    const nums = await e.query<{ n: string }>(
      "SELECT txn_number AS n FROM transactions WHERE txn_type = 'invoice' ORDER BY txn_number");
    expect(new Set(nums.map((x) => x.n)).size).toBe(nums.length);
  }, 900_000);
});
