// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// P29 review B2 (sensitive-accounts-doors-v1): budgets and the AI status,
// consent and categorize-preview routes serve a viewer with hidden accounts
// (leaving those accounts out) instead of refusing; GET /sensitive-doors
// tells a client which routes are still refused, by the engine's own rule.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '../db/index.js';
import { budgetLines, budgets } from '../db/schema/index.js';
import { isConvertedRoute, underRefusePrefix } from '../services/visibility.js';
import { startSensitiveHarness, type SensitiveHarness } from './sensitive.test-fixtures.js';

let h: SensitiveHarness;
let budgetId = '';
const months = (v: string) => Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`month${i + 1}`, v]));

beforeAll(async () => {
  h = await startSensitiveHarness('sens-doors');
  const [b] = await db.insert(budgets).values({ tenantId: h.tenantId, companyId: h.companyId, name: 'Plain Budget', fiscalYear: 2026, fiscalYearStart: '2026-01-01', isActive: true }).returning();
  budgetId = b!.id;
  await db.insert(budgetLines).values([
    { budgetId, accountId: h.acct.wages, ...months('777.71') },
    { budgetId, accountId: h.acct.supplies, ...months('100.00') },
  ] as never);
}, 120_000);

afterAll(async () => { await h.close(); });

describe('doors list and converted routes (B2)', () => {
  it('nothing marked: the list is empty and budgets show every line', async () => {
    const d = await h.call('bk', 'GET', '/api/v1/sensitive-doors');
    expect(d.status).toBe(200);
    expect(d.json).toEqual({ hidesSensitive: false, refusePrefixes: [], converted: [] });
    const lines = await h.call('bk', 'GET', `/api/v1/budgets/${budgetId}/lines`);
    expect(lines.text).toContain('777.71');
  });

  it('once marked: the list names the refused groups, and each door it calls refused is refused', async () => {
    await h.markWages();
    const own = await h.call('owner', 'GET', '/api/v1/sensitive-doors');
    expect(own.json.hidesSensitive).toBe(false);
    const d = await h.call('bk', 'GET', '/api/v1/sensitive-doors');
    expect(d.status).toBe(200);
    expect(d.json.hidesSensitive).toBe(true);
    expect(d.json.refusePrefixes).toContain('/api/v1/reports');
    expect(d.json.converted).toEqual(expect.arrayContaining([{ method: 'GET', path: '/api/v1/budgets/:id/lines' }]));
    // The list agrees with the engine: a refused report is refused, a converted one served.
    for (const [path, refused] of [
      ['/api/v1/reports/sales-tax-liability?start_date=2026-01-01&end_date=2026-12-31', true],
      [`/api/v1/budgets/${budgetId}/vs-actual?start_date=2026-01-01&end_date=2026-12-31`, true],
      ['/api/v1/reports/profit-loss?start_date=2026-01-01&end_date=2026-12-31', false],
      [`/api/v1/budgets/${budgetId}/lines`, false],
      ['/api/v1/ai/status', false],
    ] as Array<[string, boolean]>) {
      const p = path.split('?')[0]!.toLowerCase();
      expect([path, underRefusePrefix(p) && !isConvertedRoute('GET', p)]).toEqual([path, refused]);
      const r = await h.call('bk', 'GET', path);
      expect([path, r.status === 403 && r.json?.error?.code === 'SENSITIVE_HIDDEN']).toEqual([path, refused]);
    }
  });

  it('budgets: hidden lines are not shown, not in totals, not editable, and survive a save', async () => {
    const list = await h.call('bk', 'GET', '/api/v1/budgets');
    expect(list.status).toBe(200);
    const lines = await h.call('bk', 'GET', `/api/v1/budgets/${budgetId}/lines`);
    expect(lines.status).toBe(200);
    expect(lines.text).not.toContain('777.71');
    expect(lines.text).not.toContain('877.71');
    expect(lines.text).not.toContain(h.acct.wages);
    expect(lines.json.totalsExact.expenses.totalExact).toBe('1200.0000');
    const version = lines.json.version;
    const bad = await h.call('bk', 'PUT', `/api/v1/budgets/${budgetId}/lines`, { version, lines: [{ accountId: h.acct.wages, ...months('1.00') }] });
    expect([bad.status, bad.json?.error?.code]).toEqual([403, 'SENSITIVE_ACCOUNT']);
    const ok = await h.call('bk', 'PUT', `/api/v1/budgets/${budgetId}/lines`, { version, lines: [{ accountId: h.acct.supplies, ...months('110.00') }] });
    expect(ok.status, ok.text).toBe(200);
    expect(ok.text).not.toContain('777.71');
    const owner = await h.call('owner', 'GET', `/api/v1/budgets/${budgetId}/lines`);
    expect(owner.text).toContain('777.71');
    expect(owner.json.totalsExact.expenses.totalExact).toBe('10652.5200');
    const ren = await h.call('bk', 'PUT', `/api/v1/budgets/${budgetId}`, { name: 'Plain Budget 2', version: ok.json.version });
    expect(ren.status, ren.text).toBe(200);
  });

  it('AI status and consent answer the restricted viewer', async () => {
    expect((await h.call('bk', 'GET', '/api/v1/ai/status')).status).not.toBe(403);
    expect((await h.call('bk', 'GET', '/api/v1/ai/consent')).status).not.toBe(403);
  });
});
