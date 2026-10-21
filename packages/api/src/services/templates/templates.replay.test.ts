// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// Replay equivalence (U-62): entering a template on a date posts exactly
// what the kind's live create endpoint posts for the same draft on the same
// date — accounts, debit and credit strings, line names, tags, billable
// marks, descriptions, header fields and header tags. Random drafts per
// kind (seeded, so a failure reproduces).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { journalLines, transactions, transactionTags } from '../../db/schema/index.js';
import { TestServer, makeCompany, cleanTenant, type Co } from './templates.test-helpers.js';

const PER_KIND = 200;
const srv = new TestServer();
const tenantIds: string[] = [];
let c: Co;

beforeAll(async () => {
  await srv.start();
  c = await makeCompany('replay', tenantIds);
});

afterAll(async () => {
  await srv.stop();
  while (tenantIds.length) await cleanTenant(tenantIds.pop()!);
});

/** Small deterministic PRNG (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function money(r: () => number, max = 100000): string {
  // Integer minor units -> an exact string with 0..4 places (never a float).
  const units = 1 + Math.floor(r() * max * 10000);
  const whole = Math.floor(units / 10000);
  const frac = String(units % 10000).padStart(4, '0');
  const places = Math.floor(r() * 5);
  if (places === 0) return `${whole + 1}`;
  return `${whole}.${frac.slice(0, places).replace(/^0+$/, '1'.padStart(places, '0'))}`;
}

const pick = <T>(r: () => number, xs: T[]) => xs[Math.floor(r() * xs.length)]!;

function sumStrings(xs: string[]): string {
  // Exact sum in integer 1/10000 units (BigInt), as a 4-place string.
  const units = xs.reduce((s, x) => {
    const [w, f = ''] = x.split('.');
    return s + BigInt(w!) * 10000n + BigInt((f + '0000').slice(0, 4));
  }, 0n);
  return `${units / 10000n}.${String(units % 10000n).padStart(4, '0')}`;
}

async function gl(txnId: string) {
  const [h] = await db.select().from(transactions).where(and(eq(transactions.tenantId, c.tenantId), eq(transactions.id, txnId)));
  const lines = await db.select().from(journalLines)
    .where(and(eq(journalLines.tenantId, c.tenantId), eq(journalLines.transactionId, txnId))).orderBy(asc(journalLines.lineOrder));
  const headerTags = (await db.select({ t: transactionTags.tagId }).from(transactionTags).where(eq(transactionTags.transactionId, txnId)))
    .map((x) => x.t).sort();
  return {
    header: {
      txnType: h!.txnType, total: h!.total, contactId: h!.contactId, memo: h!.memo, basis: h!.basis,
      printStatus: h!.printStatus, payeeNameOnCheck: h!.payeeNameOnCheck, paymentMethod: h!.paymentMethod, status: h!.status,
    },
    lines: lines.map((l) => ({
      accountId: l.accountId, debit: l.debit, credit: l.credit, contactId: l.contactId, tagId: l.tagId,
      isBillable: l.isBillable, description: l.description, lineRole: l.lineRole,
    })),
    headerTags,
  };
}

type Gen = (r: () => number, i: number) => { kind: string; draft: Record<string, unknown>; live: { path: string; body: Record<string, unknown> } };

const accountsOf = () => [c.expense, c.expense2, c.income];
const optional = <T>(r: () => number, v: T) => (r() < 0.5 ? v : undefined);

const gens: Record<string, Gen> = {
  check: (r) => {
    const lines = Array.from({ length: 1 + Math.floor(r() * 3) }, () => {
      const billable = r() < 0.3;
      return {
        accountId: pick(r, [c.expense, c.expense2]), amount: money(r), tagId: r() < 0.5 ? c.tag : null,
        ...(billable ? { contactId: c.customer, isBillable: true } : {}),
        ...(r() < 0.5 ? { description: `Line ${Math.floor(r() * 100)}` } : {}),
      };
    });
    const draft = {
      bankAccountId: c.bank, payeeNameOnCheck: 'Payee', amount: sumStrings(lines.map((l) => l.amount)),
      printLater: r() < 0.5, tagIds: r() < 0.5 ? [c.tag] : [],
      ...(r() < 0.5 ? { contactId: c.vendor } : {}), ...(r() < 0.5 ? { memo: 'Memo' } : {}),
      lines,
    };
    return { kind: 'check', draft, live: { path: '/api/v1/checks', body: { ...draft, txnDate: '2026-05-15' } } };
  },
  expense: (r) => {
    const lines = Array.from({ length: 1 + Math.floor(r() * 3) }, () => ({
      expenseAccountId: pick(r, [c.expense, c.expense2]), amount: money(r), tagId: r() < 0.5 ? c.tag : null,
      ...(r() < 0.3 ? { contactId: c.customer, isBillable: r() < 0.5 } : {}),
    }));
    const draft = { payFromAccountId: c.bank, tagIds: [], ...(r() < 0.5 ? { contactId: c.vendor } : {}), lines };
    const { tagIds: _ignored, ...body } = draft;
    void _ignored;
    return { kind: 'expense', draft, live: { path: '/api/v1/transactions', body: { ...body, txnType: 'expense', txnDate: '2026-05-15' } } };
  },
  deposit: (r) => {
    const lines = Array.from({ length: 1 + Math.floor(r() * 3) }, () => ({
      accountId: pick(r, accountsOf()), amount: money(r), tagId: r() < 0.5 ? c.tag : null,
      ...(r() < 0.3 ? { contactId: c.customer } : {}),
    }));
    // A fee line now and then (negative), smaller than the rest.
    if (r() < 0.4) lines.push({ accountId: c.expense2, amount: `-${money(r, 1)}`, tagId: null });
    const cashBack = optional(r, { accountId: c.expense, amount: money(r, 1) });
    const draft = { depositToAccountId: c.bank, lines, ...(cashBack ? { cashBack } : {}) };
    return { kind: 'deposit', draft, live: { path: '/api/v1/transactions', body: { ...draft, txnType: 'deposit', txnDate: '2026-05-15', strictAmounts: true } } };
  },
  transfer: (r) => {
    const draft = { fromAccountId: c.bank, toAccountId: c.savings, amount: money(r), ...(r() < 0.5 ? { memo: 'Sweep' } : {}) };
    return { kind: 'transfer', draft, live: { path: '/api/v1/transactions', body: { ...draft, txnType: 'transfer', txnDate: '2026-05-15' } } };
  },
  journal_entry: (r) => {
    const debits = Array.from({ length: 1 + Math.floor(r() * 3) }, () => ({
      accountId: pick(r, [c.expense, c.expense2]), debit: money(r), credit: '0', tagId: r() < 0.5 ? c.tag : null,
    }));
    const lines = [...debits, { accountId: c.bank, debit: '0', credit: sumStrings(debits.map((d) => d.debit)), tagId: null }];
    const draft = { basis: pick(r, ['cash', 'accrual', 'both']), lines, ...(r() < 0.5 ? { memo: 'Accrual' } : {}) };
    return { kind: 'journal_entry', draft, live: { path: '/api/v1/transactions', body: { ...draft, txnType: 'journal_entry', txnDate: '2026-05-15' } } };
  },
};

describe('replay equals a live create of the draft', () => {
  for (const [kind, gen] of Object.entries(gens)) {
    it(`${kind}: ${PER_KIND} random drafts`, { timeout: 120_000 }, async () => {
      const r = rng(0x5eed + kind.length * 7919);
      for (let i = 0; i < PER_KIND; i++) {
        const g = gen(r, i);
        const tpl = await srv.request('POST', '/api/v1/templates', c.token, { name: `${kind} ${i}`, kind: g.kind, draft: g.draft }, c.companyId);
        expect(tpl.status, JSON.stringify(tpl.json)).toBe(201);
        const entered = await srv.request('POST', `/api/v1/templates/${tpl.json.template.id}/enter`, c.token, { occurrenceDate: '2026-05-15' }, c.companyId);
        expect(entered.status, JSON.stringify(entered.json)).toBe(201);
        const live = await srv.request('POST', g.live.path, c.token, g.live.body, c.companyId);
        expect(live.status, JSON.stringify(live.json)).toBe(201);
        const liveId = (live.json.transaction ?? live.json.check ?? live.json).id as string;
        const a = await gl(entered.json.transaction.id);
        const b = await gl(liveId);
        expect(a.lines.length).toBeGreaterThanOrEqual(2);
        expect(a.lines, `${kind} #${i}`).toEqual(b.lines);
        expect(a.header, `${kind} #${i}`).toEqual(b.header);
        if (kind === 'expense') expect(a.headerTags).toEqual(expect.arrayContaining((g.draft['tagIds'] as string[])));
        else expect(a.headerTags, `${kind} #${i}`).toEqual(b.headerTags);
      }
    });
  }
});
