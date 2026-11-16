// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// Sensitive accounts (U-33), security review S2: a transaction id in a JSON
// request body (any key: transactionId, checkIds, invoiceId, keepId,
// attachableId...) is refused like one in the path, before the route runs,
// when the transaction touches an account hidden from the viewer. Uploads
// (multipart, parsed after authenticate) are refused at the attach target.
// Then a sweep over every write route of the real app with such a body.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

vi.mock('express-rate-limit', async (orig) => {
  const real = await orig<typeof import('express-rate-limit')>();
  const pass = () => (_req: unknown, _res: unknown, next: () => void) => next();
  return { ...real, default: pass, rateLimit: pass };
});

import type { Express } from 'express';
import { randomUUID } from 'node:crypto';
import * as ledger from '../services/ledger.service.js';
import { bodyUuids } from '../services/visibility.js';
import { startSensitiveHarness, type SensitiveHarness } from './sensitive.test-fixtures.js';

let h: SensitiveHarness;
let paycheck = '';
let paper = '';

beforeAll(async () => {
  h = await startSensitiveHarness('sens-body');
  const post = (memo: string, lines: Array<Record<string, unknown>>) =>
    ledger.postTransaction(h.tenantId, { txnType: 'expense' as never, txnDate: '2026-03-01', memo, lines: lines as never }, h.ownerId, h.companyId);
  paycheck = (await post('payroll', [{ accountId: h.acct.wagesSub, debit: '4321.09', credit: '0' }, { accountId: h.acct.bank, debit: '0', credit: '4321.09' }])).id;
  paper = (await post('paper', [{ accountId: h.acct.supplies, debit: '10.00', credit: '0' }, { accountId: h.acct.bank, debit: '0', credit: '10.00' }])).id;
}, 120_000);

afterAll(async () => { await h.close(); });

const sensitive = (r: { status: number; json: any }) => r.status === 403 && r.json?.error?.code === 'SENSITIVE_ACCOUNT';

describe('transaction ids in request bodies (S2)', () => {
  it('bodyUuids reads every key and nesting level, bounded', () => {
    const a = randomUUID();
    const b = randomUUID();
    expect(bodyUuids({ x: { checkIds: [a] }, deep: [[{ keepId: b.toUpperCase() }]], n: 5, s: 'not-a-uuid' }).sort()).toEqual([a, b].sort());
    let deep: unknown = a;
    for (let i = 0; i < 40; i++) deep = { d: deep };
    expect(bodyUuids(deep)).toEqual([]);
  });

  // The doors the review named, with the bodies the desktop sends.
  const doors = (txn: string): Array<[string, string, unknown]> => [
    ['POST', '/api/v1/checks/print', { bankAccountId: h.acct.bank, checkIds: [txn], startingCheckNumber: 1001, format: 'voucher' }],
    ['PUT', `/api/v1/banking/feed/${randomUUID()}/match`, { transactionId: txn }],
    ['POST', `/api/v1/attachments/${randomUUID()}/link`, { attachableType: 'expense', attachableId: txn }],
    ['POST', `/api/v1/payments/${randomUUID()}/apply`, { applications: [{ invoiceId: txn, amount: '1.00' }] }],
    ['POST', '/api/v1/payments/unapply', { paymentId: txn }],
    ['POST', '/api/v1/duplicates/merge', { keepId: paper, voidId: txn }],
    ['POST', '/api/v1/templates/from-transaction', { transactionId: txn, name: 'Copy' }],
    ['POST', '/api/v1/recurring', { templateTransactionId: txn, frequency: 'monthly', startDate: '2026-04-01' }],
  ];

  it('with nothing marked nothing is refused', async () => {
    for (const [method, path, body] of doors(paycheck)) {
      const r = await h.call('bk', method, path, body);
      expect([path, sensitive(r)]).toEqual([path, false]);
    }
  });

  it('once marked, every door is refused for the paycheck and none for a plain expense', async () => {
    await h.markWages();
    for (const [method, path, body] of doors(paycheck)) {
      const r = await h.call('bk', method, path, body);
      expect([method, path, r.status, r.json?.error?.code]).toEqual([method, path, 403, 'SENSITIVE_ACCOUNT']);
    }
    for (const [method, path, body] of doors(paper)) {
      if (path.includes('duplicates')) continue; // names the paycheck as keepId's pair
      const r = await h.call('bk', method, path, body);
      expect([path, sensitive(r)]).toEqual([path, false]);
    }
    // The owner is never refused.
    for (const [method, path, body] of doors(paycheck)) {
      const r = await h.call('owner', method, path, body);
      expect([path, sensitive(r)]).toEqual([path, false]);
    }
  });

  it('a multipart upload filed on the paycheck is refused at the attach target', async () => {
    const boundary = '----sens' + Date.now();
    const parts = [
      `--${boundary}\r\nContent-Disposition: form-data; name="attachableType"\r\n\r\nexpense\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="attachableId"\r\n\r\n${paycheck}\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="r.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.4\n%%EOF\n\r\n`,
      `--${boundary}--\r\n`,
    ].join('');
    const r = await h.raw('bk', 'POST', '/api/v1/attachments?autoOcr=0', parts, `multipart/form-data; boundary=${boundary}`);
    expect([r.status, r.json?.error?.code]).toEqual([403, 'SENSITIVE_ACCOUNT']);
  });

  it('sweep: no write route of the app accepts a body naming the paycheck', async () => {
    const { app } = await import('../app.js');
    const routes: Array<{ method: string; path: string }> = [];
    const collect = (stack: any[], prefix: string) => {
      for (const layer of stack) {
        if (layer.route) {
          for (const p of (Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path])) {
            if (typeof p !== 'string') continue;
            for (const m of Object.keys(layer.route.methods)) if (m !== 'get' && m !== 'head' && m !== 'options' && m !== '_all') routes.push({ method: m.toUpperCase(), path: prefix + p });
          }
        } else if (layer.handle?.stack && Array.isArray(layer.handle.stack)) {
          if (layer.regexp.fast_slash) { collect(layer.handle.stack, prefix); continue; }
          if (layer.keys && layer.keys.length > 0) continue;
          const mm = /^\^(.*)\\\/\?\(\?=\\\/\|\$\)$/.exec(layer.regexp.source);
          if (!mm) continue;
          const p = mm[1]!.replace(/\\\//g, '/').replace(/\\\./g, '.').replace(/\\-/g, '-');
          if (/[\\()[\]*+?^$]/.test(p)) continue;
          collect(layer.handle.stack, prefix + p);
        }
      }
    };
    collect(((app as Express & { _router: { stack: any[] } })._router).stack, '');
    // Sign-in, platform admin, the desktop channel, OAuth, connectors and webhooks: no ledger write with a viewer.
    const SKIP = ['/api/v1/auth', '/api/v1/admin', '/api/v1/desktop', '/api/v1/plaid', '/oauth', '/api/v1/bank-connect', '/api/v1/portal', '/api/portal', '/api/v1/stripe', '/api/v1/webhooks',
      // Public routes (no sign-in, so no viewer): inbound SMS, CSP reports, first-run setup, public invoice and W-9 links.
      '/api/sms', '/api/v1/csp-report', '/api/setup', '/api/v1/public', '/api/w9', '/api/bank-connect'];
    const writes = routes.filter((r) => r.path.startsWith('/api/') && !SKIP.some((s) => r.path.startsWith(s)));
    expect(writes.length).toBeGreaterThan(200);
    const misses: string[] = [];
    const seen = new Set<string>();
    for (const r of writes) {
      // Path parameters get a fresh id (no transaction), so only the body can name the paycheck.
      const path = r.path.replace(/:[A-Za-z_]+(\([^)]*\))?\??/g, randomUUID());
      const key = `${r.method} ${r.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const res = await h.call('bk', r.method, path, { transactionId: paycheck, ids: [paycheck], nested: { invoiceId: paycheck } });
      if (sensitive(res)) continue;
      // Unconverted report routes refuse first (403 SENSITIVE_HIDDEN); routes without authenticate never see a viewer.
      if (res.status === 403 && res.json?.error?.code === 'SENSITIVE_HIDDEN') continue;
      if (res.status === 401) continue;
      misses.push(`${key}: ${res.status} ${res.text.slice(0, 100)}`);
    }
    // eslint-disable-next-line no-console
    if (misses.length > 0) console.log(`body sweep misses:\n${misses.join('\n')}`);
    expect(misses).toEqual([]);
  }, 600_000);
});
