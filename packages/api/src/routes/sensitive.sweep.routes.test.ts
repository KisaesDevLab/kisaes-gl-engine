// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// Sensitive accounts (U-33) canary sweep. Walks every GET route of the REAL
// app (app._router.stack) as a bookkeeper without the sensitive_accounts
// right, after the owner marked "Canary Wages" (and so its sub-account)
// sensitive. Every response must either be 403 SENSITIVE_HIDDEN on a route
// not in CONVERTED, or contain no canary: the hidden accounts' names or
// ids, or 1234.57 (an amount only a hidden line carries). Converted routes
// never answer SENSITIVE_HIDDEN. The owner run proves the seed is live.
//
// Path parameters are filled in turn with a visible bank account id, a
// hidden account id and the id of a transaction with a hidden line. The
// bank side of a paycheck (amount and payee) is an accepted leak (§3), so
// the paycheck amount is not a canary; the mixed entry's hidden line is.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// The sweep sends well over the 300/min global budget; throttling is not what it tests.
vi.mock('express-rate-limit', async (orig) => {
  const real = await orig<typeof import('express-rate-limit')>();
  const pass = () => (_req: unknown, _res: unknown, next: () => void) => next();
  return { ...real, default: pass, rateLimit: pass };
});
import type { Express } from 'express';
import * as ledger from '../services/ledger.service.js';
import { isConvertedRoute } from '../services/visibility.js';
import { startSensitiveHarness, type SensitiveHarness } from './sensitive.test-fixtures.js';

let h: SensitiveHarness;
let hiddenTxn = '';
let mixedTxn = '';

interface Route { method: string; path: string }

// Express 4 mount regexp -> literal path ('' for '/'), or null for a mount
// we can't reproduce (parameterized or regexp mounts).
function mountPath(layer: { regexp: RegExp & { fast_slash?: boolean }; keys?: unknown[] }): string | null {
  if (layer.regexp.fast_slash) return '';
  if (layer.keys && layer.keys.length > 0) return null;
  const m = /^\^(.*)\\\/\?\(\?=\\\/\|\$\)$/.exec(layer.regexp.source);
  if (!m) return null;
  const p = m[1]!.replace(/\\\//g, '/').replace(/\\\./g, '.').replace(/\\-/g, '-');
  return /[\\()[\]*+?^$]/.test(p) ? null : p;
}

function collect(stack: any[], prefix: string, out: Route[]): void {
  for (const layer of stack) {
    if (layer.route) {
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      for (const p of paths) {
        if (typeof p !== 'string') continue;
        for (const m of Object.keys(layer.route.methods)) out.push({ method: m.toUpperCase(), path: prefix + p });
      }
    } else if (layer.handle?.stack && Array.isArray(layer.handle.stack)) {
      const mp = mountPath(layer);
      if (mp !== null) collect(layer.handle.stack, prefix + mp, out);
    }
  }
}

// Families with nothing to sweep here: sign-in, platform admin, the
// desktop supervisor channel, OAuth and third-party connectors.
const SKIP = ['/api/v1/auth', '/api/v1/admin', '/api/v1/desktop', '/api/v1/plaid', '/oauth', '/api/v1/bank-connect', '/api/v1/portal', '/api/portal'];
const RANGE = 'start_date=2026-01-01&end_date=2026-12-31&startDate=2026-01-01&endDate=2026-12-31&from=2026-01-01&to=2026-12-31&as_of_date=2026-12-31&limit=500';

beforeAll(async () => {
  h = await startSensitiveHarness('sens-sweep');
  const post = (memo: string, txnType: string, lines: Array<{ accountId: string; debit: string; credit: string }>) =>
    ledger.postTransaction(h.tenantId, { txnType: txnType as never, txnDate: '2026-03-01', memo, lines }, h.ownerId, h.companyId);
  await post('sale', 'deposit', [{ accountId: h.acct.bank, debit: '1000.00', credit: '0' }, { accountId: h.acct.sales, debit: '0', credit: '1000.00' }]);
  await post('paper', 'expense', [{ accountId: h.acct.supplies, debit: '10.00', credit: '0' }, { accountId: h.acct.bank, debit: '0', credit: '10.00' }]);
  hiddenTxn = (await post('payroll', 'check', [{ accountId: h.acct.wagesSub, debit: '4321.09', credit: '0' }, { accountId: h.acct.bank, debit: '0', credit: '4321.09' }])).id;
  mixedTxn = (await post('mixed', 'journal_entry', [
    { accountId: h.acct.wages, debit: '1234.57', credit: '0' },
    { accountId: h.acct.supplies, debit: '5.00', credit: '0' },
    { accountId: h.acct.bank, debit: '0', credit: '1239.57' },
  ])).id;
  await h.markWages();
}, 120_000);

afterAll(async () => { await h.close(); });

function canariesIn(text: string): string[] {
  const c = ['Canary Wages', h.acct.wages, h.acct.wagesSub, '1234.57'];
  return c.filter((x) => text.includes(x));
}

describe('sensitive accounts canary sweep', () => {
  it('no GET route leaks a hidden account to the bookkeeper', async () => {
    const { app } = await import('../app.js');
    const routes: Route[] = [];
    collect(((app as Express & { _router: { stack: any[] } })._router).stack, '', routes);
    const gets = routes.filter((r) => r.method === 'GET' && r.path.startsWith('/api/') && !SKIP.some((s) => r.path.startsWith(s)));
    expect(gets.length).toBeGreaterThan(200);

    const fills = [h.acct.bank, h.acct.wages, hiddenTxn, mixedTxn];
    const leaks: string[] = [];
    let refused = 0;
    let checked = 0;
    const seen = new Set<string>();
    for (const r of gets) {
      const variants = r.path.includes(':') ? fills.map((id) => r.path.replace(/:[A-Za-z_]+(\([^)]*\))?\??/g, id)) : [r.path];
      for (const path of variants) {
        if (seen.has(path)) continue;
        seen.add(path);
        const res = await Promise.race([
          h.call('bk', 'GET', `${path}?${RANGE}`),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 20_000)),
        ]);
        if (res === null) continue; // a stream or long poll; nothing returned
        checked++;
        if (res.status === 429) { leaks.push(`${path}: 429 (rate limited, not checked)`); continue; }
        const converted = isConvertedRoute('GET', path);
        if (res.status === 403 && res.json?.error?.code === 'SENSITIVE_HIDDEN') {
          refused++;
          if (converted) leaks.push(`${path}: converted route refused`);
          continue;
        }
        const found = canariesIn(res.text);
        if (found.length > 0) leaks.push(`${path} (${res.status}): ${found.join(', ')}`);
      }
    }
    // eslint-disable-next-line no-console
    if (leaks.length > 0) console.log(`sweep leaks:\n${leaks.join('\n')}`);
    expect(refused).toBeGreaterThan(10);
    expect(checked).toBeGreaterThan(200);
    expect(leaks).toEqual([]);
  }, 900_000);

  it('the seed is live: the owner sees the canaries', async () => {
    const accts = await h.call('owner', 'GET', '/api/v1/accounts?limit=500');
    expect(canariesIn(accts.text)).toEqual(expect.arrayContaining(['Canary Wages', h.acct.wages, h.acct.wagesSub]));
    const tl = await h.call('owner', 'GET', `/api/v1/reports/transaction-list?${RANGE}`);
    expect(tl.text).toContain('1234.57');
  });
});
