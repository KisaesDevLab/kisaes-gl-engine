// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
//
// feed-logs.scrubbed (U-167, S10): the bank feed, import post-processing
// and rules engine log an error code and an id, never a description, memo,
// payee, check payee or rule pattern (Drizzle errors carry the query
// params, which hold them). Two parts: every console call in the three
// files passes errors through errorSummaryForLog (a source check, so a new
// call site can't slip back), and failing paths seeded with a marker in
// every text field log no marker.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  tenants, users, sessions, companies, accounts, auditLog, bankConnections, bankFeedItems, bankRules, conditionalRules,
  conditionalRuleAudit, transactionClassificationState, transactions, journalLines, categorizationHistory, contacts,
} from '../db/schema/index.js';
import * as authService from './auth.service.js';
import * as bankFeedService from './bank-feed.service.js';
import { evaluateRules, contextFromFeedItem } from './conditional-rules-engine.service.js';
import { errorSummaryForLog } from '../utils/log-safe.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILES = ['bank-feed.service.ts', 'bank-import/post-process.ts', 'conditional-rules-engine.service.ts'];
const MARK = 'ZQMARK7731';

/** Each console.* call with its arguments (up to the closing parenthesis of the statement). */
function consoleCalls(src: string): string[] {
  const out: string[] = [];
  const re = /console\.(warn|error|log|info)\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < src.length && depth > 0) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')') depth--;
      i++;
    }
    out.push(src.slice(m.index, i));
  }
  return out;
}

describe('log lines carry codes and ids only (source check)', () => {
  for (const f of FILES) {
    it(`${f}: no error message, payee, description, memo or pattern in a console call`, () => {
      const calls = consoleCalls(readFileSync(path.join(HERE, f), 'utf8'));
      expect(calls.length).toBeGreaterThan(0);
      for (const c of calls) {
        expect(c, c).not.toMatch(/\.message\b/);
        // The [component] tag may name what it does (applyCheckImagePayees).
        expect(c.replace(/\[[^\]]*\]/g, ''), c).not.toMatch(/payee|pattern|description|memo|\.cause/i);
        // An error object is passed only through errorSummaryForLog.
        if (/\berr\b|\browErr\b/.test(c)) expect(c, c).toMatch(/errorSummaryForLog\(/);
      }
    });
  }

  it('errorSummaryForLog drops Drizzle params', () => {
    const err = Object.assign(new Error(`Failed query: update "bank_feed_items" set "description" = $1\nparams: ${MARK} COFFEE`), {
      cause: Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505', detail: `Key (x)=(${MARK})` }),
    });
    expect(errorSummaryForLog(err)).not.toContain(MARK);
  });
});

let tenantId = '';
let userId = '';
let connectionId = '';
let expenseId = '';
const logged: string[] = [];

beforeEach(async () => {
  logged.length = 0;
  for (const fn of ['warn', 'error', 'log', 'info'] as const) {
    vi.spyOn(console, fn).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    });
  }
  const { user } = await authService.register({
    email: `feed-logs-${Date.now()}-${Math.random().toString(36).slice(2, 6)}@example.com`,
    password: 'password123', displayName: 'Logs', companyName: 'Logs Co',
  });
  tenantId = user.tenantId;
  userId = user.id;
  const bank = await db.query.accounts.findFirst({ where: and(eq(accounts.tenantId, tenantId), eq(accounts.detailType, 'bank')) });
  expenseId = (await db.select().from(accounts).where(and(eq(accounts.tenantId, tenantId), eq(accounts.accountType, 'expense'))).limit(1))[0]!.id;
  const [conn] = await db.insert(bankConnections).values({ tenantId, accountId: bank!.id, provider: 'manual' }).returning();
  connectionId = conn!.id;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await new Promise((r) => setTimeout(r, 50));
  await db.delete(transactionClassificationState).where(eq(transactionClassificationState.tenantId, tenantId));
  await db.delete(conditionalRuleAudit).where(eq(conditionalRuleAudit.tenantId, tenantId));
  await db.delete(conditionalRules).where(eq(conditionalRules.tenantId, tenantId));
  await db.delete(bankRules).where(eq(bankRules.tenantId, tenantId));
  await db.delete(categorizationHistory).where(eq(categorizationHistory.tenantId, tenantId));
  await db.delete(bankFeedItems).where(eq(bankFeedItems.tenantId, tenantId));
  await db.delete(bankConnections).where(eq(bankConnections.tenantId, tenantId));
  await db.delete(journalLines).where(eq(journalLines.tenantId, tenantId));
  await db.delete(transactions).where(eq(transactions.tenantId, tenantId));
  await db.delete(contacts).where(eq(contacts.tenantId, tenantId));
  await db.delete(auditLog).where(eq(auditLog.tenantId, tenantId));
  await db.delete(accounts).where(eq(accounts.tenantId, tenantId));
  await db.delete(companies).where(eq(companies.tenantId, tenantId));
  await db.delete(sessions).where(eq(sessions.userId, userId));
  await db.delete(users).where(eq(users.tenantId, tenantId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
});

describe('failing paths log no marker (U-167)', () => {
  it('a refused stored regex logs its reason, never the pattern', () => {
    const rules = [{
      id: '00000000-0000-0000-0000-000000000001', name: 'r', priority: 1, active: true, continueAfterMatch: false,
      conditions: { type: 'leaf', field: 'descriptor', operator: 'matches_regex', value: `(a+)+${MARK}` },
      actions: [{ type: 'set_account', accountId: expenseId }],
    }];
    evaluateRules(rules as never, contextFromFeedItem({
      description: `aaaa ${MARK}`, originalDescription: null, amount: '10.0000', feedDate: '2026-06-15', bankConnectionAccountId: 'x',
    } as never));
    expect(logged.join('\n')).not.toContain(MARK);
  });

  it('a rule posting that fails (closed period, server mode) logs the code and the item id only', async () => {
    await db.insert(bankRules).values({
      tenantId, name: `Rule ${MARK}`, isActive: true, isGlobal: false, applyTo: 'both',
      descriptionContains: MARK, assignAccountId: expenseId, assignMemo: `memo ${MARK}`, autoConfirm: true, priority: 1,
    });
    await db.update(companies).set({ lockDate: '2026-12-31' } as never).where(eq(companies.tenantId, tenantId));
    const [row] = await db.insert(bankFeedItems).values({
      tenantId, bankConnectionId: connectionId, feedDate: '2026-06-15', amount: '25.0000', status: 'pending',
      description: `PAY ${MARK}`, originalDescription: `PAY ${MARK}`, memo: `memo ${MARK}`, payeeNameOnCheck: `Payee ${MARK}`,
    }).returning();
    await bankFeedService.reprocessRules(tenantId, { feedItemIds: [row!.id] }, userId);
    expect(logged.some((l) => l.includes('autoConfirm categorize failed') && l.includes(row!.id))).toBe(true);
    expect(logged.join('\n')).not.toContain(MARK);
  });
});
