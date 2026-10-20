// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Deposit suggestions for a bank-feed item (U-56,
// feed-deposit-groupings-v1). A deposit on the bank statement is usually
// several customer payments banked together; this finds sets of items
// waiting in Payments Clearing whose amounts add up to the feed amount
// EXACTLY (4-place decimals compared as integers, never floats).
//
// Read-only. Bounded: items within ±10 days of the feed date, at most
// MAX_ITEMS of them (nearest dates first), a node budget and a time budget
// for the subset-sum search, at most `limit` sets. `truncated` says when a
// bound cut the search short, so "no sets" is not read as "none exist".

import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { bankFeedItems } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { listPendingDepositItems, type PendingDepositRow } from './payment.service.js';

export const DEPOSIT_GROUPING_LIMITS = {
  windowDays: 10,
  maxItems: 40,
  maxSetsDefault: 5,
  maxSetsCap: 20,
  maxNodes: 250_000,
  timeBudgetMs: 250,
} as const;

/** 4-place decimal string → integer ten-thousandths (exact). */
function toUnits(amount: string): bigint {
  const neg = amount.startsWith('-');
  const [whole = '0', frac = ''] = (neg ? amount.slice(1) : amount).split('.');
  const units = BigInt(whole) * 10_000n + BigInt((frac + '0000').slice(0, 4));
  return neg ? -units : units;
}

function unitsToString(units: bigint): string {
  const neg = units < 0n;
  const abs = neg ? -units : units;
  const whole = abs / 10_000n;
  const frac = (abs % 10_000n).toString().padStart(4, '0');
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

function shiftDate(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function dayDistance(a: string, b: string): number {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;
}

export interface DepositGrouping {
  total: string;
  itemCount: number;
  items: PendingDepositRow[];
}

export async function findDepositGroupings(
  tenantId: string,
  companyId: string,
  feedItemId: string,
  opts: { limit?: number } = {},
) {
  const [item] = await db.select({
    id: bankFeedItems.id,
    companyId: bankFeedItems.companyId,
    feedDate: bankFeedItems.feedDate,
    amount: bankFeedItems.amount,
  }).from(bankFeedItems)
    .where(and(eq(bankFeedItems.tenantId, tenantId), eq(bankFeedItems.id, feedItemId)))
    .limit(1);
  // Another company's item reads as missing.
  if (!item || (item.companyId && item.companyId !== companyId)) throw AppError.notFound('Feed item not found');

  const feedDate = String(item.feedDate).slice(0, 10);
  const windowStart = shiftDate(feedDate, -DEPOSIT_GROUPING_LIMITS.windowDays);
  const windowEnd = shiftDate(feedDate, DEPOSIT_GROUPING_LIMITS.windowDays);
  const maxSets = Math.min(Math.max(opts.limit ?? DEPOSIT_GROUPING_LIMITS.maxSetsDefault, 1), DEPOSIT_GROUPING_LIMITS.maxSetsCap);

  // Feed sign: negative = money in (a deposit), positive = money out.
  const feedUnits = toUnits(Number.isNaN(Number(item.amount)) ? '0' : String(item.amount));
  const target = -feedUnits;
  const base = { feedItemId: item.id, windowStart, windowEnd };
  if (target <= 0n) {
    return { ...base, targetAmount: unitsToString(target < 0n ? -target : target), candidates: [] as DepositGrouping[], truncated: false, itemsConsidered: 0 };
  }

  const pending = await listPendingDepositItems(tenantId, { companyId, from: windowStart, to: windowEnd });
  let truncated = false;
  let pool = pending
    .map((p) => ({ row: p, units: toUnits(p.amount), dist: dayDistance(p.date, feedDate) }))
    .filter((p) => p.units > 0n && p.units <= target);
  if (pool.length > DEPOSIT_GROUPING_LIMITS.maxItems) {
    truncated = true;
    pool = [...pool].sort((a, b) => a.dist - b.dist || a.row.transactionId.localeCompare(b.row.transactionId))
      .slice(0, DEPOSIT_GROUPING_LIMITS.maxItems);
  }
  // Largest first prunes fastest; ties broken by id for a stable answer.
  pool.sort((a, b) => (a.units === b.units ? a.row.transactionId.localeCompare(b.row.transactionId) : (b.units > a.units ? 1 : -1)));

  // suffix[i] = sum of pool[i..]; lets a branch stop when even everything
  // left can't reach the target.
  const suffix: bigint[] = new Array(pool.length + 1).fill(0n);
  for (let i = pool.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1]! + pool[i]!.units;

  const found: number[][] = [];
  const chosen: number[] = [];
  const started = Date.now();
  let nodes = 0;
  // Collect a few more than asked so the best (fewest items, nearest dates)
  // can be picked; stop when the budget is spent.
  const collect = maxSets * 4;

  const search = (start: number, remaining: bigint): boolean => {
    if (remaining === 0n) {
      found.push([...chosen]);
      return found.length >= collect;
    }
    for (let i = start; i < pool.length; i++) {
      if (++nodes > DEPOSIT_GROUPING_LIMITS.maxNodes
        || (nodes % 1024 === 0 && Date.now() - started > DEPOSIT_GROUPING_LIMITS.timeBudgetMs)) {
        truncated = true;
        return true;
      }
      if (suffix[i]! < remaining) return false;
      const u = pool[i]!.units;
      if (u > remaining) continue;
      // Skip an equal amount already tried at this depth (same sums).
      if (i > start && pool[i - 1]!.units === u) continue;
      chosen.push(i);
      const stop = search(i + 1, remaining - u);
      chosen.pop();
      if (stop) return true;
    }
    return false;
  };
  search(0, target);

  // The equal-amount skip above hides sets that differ only in which of two
  // same-amount items they use; the first such set stands for them.
  const candidates = found
    .map((idx) => ({
      idx,
      dist: idx.reduce((s, i) => s + pool[i]!.dist, 0) / idx.length,
    }))
    .sort((a, b) => a.idx.length - b.idx.length || a.dist - b.dist)
    .slice(0, maxSets)
    .map(({ idx }): DepositGrouping => {
      const items = idx.map((i) => pool[i]!.row)
        .sort((a, b) => a.date.localeCompare(b.date) || a.transactionId.localeCompare(b.transactionId));
      return { total: unitsToString(target), itemCount: items.length, items };
    });

  return { ...base, targetAmount: unitsToString(target), candidates, truncated, itemsConsidered: pool.length };
}
