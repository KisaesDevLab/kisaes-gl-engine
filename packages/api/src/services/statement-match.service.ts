// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// Statement Match Engine (wave 1): score parsed bank-statement lines
// (bank_statement_lines, migration 0116) against a reconciliation
// worksheet's uncleared journal lines and auto-clear / suggest / flag.
//
// SIGN ORIENTATION (verified — see bank-statements.service.ts):
//   bank_statement_lines.amount is signed with money-in POSITIVE, so a
//   statement line matches the worksheet journal line whose
//   `debit - credit` equals it exactly: deposits on the statement match
//   jl.debit > 0 lines; withdrawals/checks match jl.credit > 0 lines.
//   (bank_feed_items.amount is the OPPOSITE sign: spend positive.)
//
// Tier rules (safety REQUIREMENTS, not heuristics):
//   AUTO    — exact amount to the cent AND the ONLY exact-amount candidate
//             in the date window (2+ exact-amount candidates are NEVER
//             auto-cleared) AND (check number exact OR composite ≥ 0.90).
//             A journal line may be AUTO-matched by at most one statement
//             line — conflicts demote both to SUGGEST. Statement lines
//             whose imported feed item already carries a
//             matchedTransactionId resolve as AUTO through that id link
//             directly (no scoring).
//   SUGGEST — any surviving candidate: ambiguous exact amounts, near
//             amounts (≤1%, flagged with the delta, never auto), or a
//             scored exact match below the auto bar. (With the exact/near
//             amount precondition and the 0.4 date floor, every pool-A
//             candidate's composite is ≥ 0.65, so the ≥ 0.60 suggest floor
//             is always met; pool B qualifies by rule.)
//   UNMATCHED — no candidate at all.

import { and, eq, sql } from 'drizzle-orm';
import DecimalLib from 'decimal.js';
const Decimal = DecimalLib.default || DecimalLib;
import {
  STATEMENT_MATCH_WEIGHTS,
  STATEMENT_MATCH_DATE_WINDOW,
  STATEMENT_MATCH_DATE_BANDS,
  STATEMENT_MATCH_DATE_FLOOR_SCORE,
  STATEMENT_MATCH_NEAR_AMOUNT_PCT,
  STATEMENT_MATCH_NEAR_AMOUNT_SCORE,
  STATEMENT_MATCH_AUTO_THRESHOLD,
  STATEMENT_MATCH_MAX_CANDIDATES,
  STATEMENT_MATCH_GROUP_DATE_WINDOW,
  STATEMENT_MATCH_GROUP_POOL_CAP,
  STATEMENT_MATCH_GROUP_MIN_SIZE,
  STATEMENT_MATCH_GROUP_MAX_SIZE,
  STATEMENT_MATCH_GROUP_MAX_EXPANSIONS,
  STATEMENT_MATCH_GROUP_MAX_EXPANSIONS_TOTAL,
  STATEMENT_MATCH_GROUP_MAX_SETS,
  STATEMENT_MATCH_GROUP_MEMBER_SPAN_DAYS,
} from '@kis-books/shared';
import { db } from '../db/index.js';
import { reconciliations, reconciliationLines, bankStatements, bankStatementLines, transactions } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { log } from '../utils/logger.js';
import { auditLog } from '../middleware/audit.js';
import { nameSimilarityFuzzy } from '../utils/string-similarity.js';
import * as ledger from './ledger.service.js';

// Either the outer db client or a transaction handle — both expose the
// query surface the engine needs.
type DbOrTx = Pick<typeof db, 'execute'>;

// Full drizzle transaction handle (select/insert/update surface) for the
// confirm/create flows.
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// ─── Row shapes ────────────────────────────────────────────────────

interface WorksheetRow {
  rec_line_id: string;
  journal_line_id: string;
  is_cleared: boolean;
  debit: string;
  credit: string;
  line_description: string | null;
  transaction_id: string;
  txn_date: string;
  txn_type: string;
  txn_number: string | null;
  memo: string | null;
  check_number: number | null;
  payee_name_on_check: string | null;
  contact_name: string | null;
}

type StatementLineRow = typeof bankStatementLines.$inferSelect;

export interface StatementLineSummary {
  id: string;
  lineDate: string;
  description: string | null;
  amount: string;
  checkNumber: string | null;
  payee: string | null;
  matchStatus: string;
}

export interface StatementMatchCandidate {
  journalLineId: string;
  transactionId: string;
  txnDate: string;
  txnType: string;
  txnNumber: string | null;
  checkNumber: number | null;
  payee: string | null;
  /** Signed worksheet amount (debit - credit) — same orientation as the statement line. */
  amount: string;
  description: string | null;
  composite: number;
  amountScore: number;
  dateScore: number;
  nameScore: number;
  pool: 'A' | 'B';
  checkExact: boolean;
  /** Dollars: statementAmount - candidateAmount (pool B only, else 0). */
  amountDelta: number;
  /** txn_date minus statement line date, in days (negative = ledger first). */
  dateDiffDays: number;
  idLinked?: boolean;
}

// ─── Wave 2: grouped matches (SUGGEST-only, never auto) ────────────

/** One journal-line member of a group candidate. */
export interface StatementGroupLine {
  journalLineId: string;
  transactionId: string;
  txnDate: string;
  txnType: string;
  txnNumber: string | null;
  checkNumber: number | null;
  payee: string | null;
  /** Signed worksheet amount (debit - credit), statement orientation. */
  amount: string;
  description: string | null;
  /** txn_date minus the statement line date, in days. */
  dateDiffDays: number;
}

export interface StatementGroupCandidate {
  /**
   * 'one_to_many': one statement line ↔ 2..5 worksheet lines (journalLines
   * are the members). 'many_to_one': 2..5 statement lines ↔ one worksheet
   * line (journalLines has exactly one entry; memberStatementLines lists ALL
   * statement lines in the set, primary first).
   */
  kind: 'one_to_many' | 'many_to_one';
  journalLines: StatementGroupLine[];
  memberStatementLines: StatementLineSummary[];
  /** Signed exact sum of the set — equals the target amount to the cent. */
  sum: string;
  /** Days between the earliest and latest member date. */
  dateSpanDays: number;
}

export interface StatementMatchSuggestion {
  statementLine: StatementLineSummary;
  candidates: StatementMatchCandidate[];
  /** Wave 2: grouped-set proposals (present only when candidates is empty). */
  groupCandidates?: StatementGroupCandidate[];
}

export interface StatementMatchResult {
  autoCleared: number;
  suggestions: StatementMatchSuggestion[];
  unmatchedLines: StatementLineSummary[];
  /** Uncleared worksheet lines no statement line accounts for (timing items). */
  outstandingCount: number;
  /** Statement lines skipped because they were already auto/confirmed/rejected. */
  skippedLines: number;
  /** Wave 2: many-to-one sets skipped because 2+ distinct sets existed. */
  skippedAmbiguousGroups: number;
}

// Confirmed-group representation (no schema change): matched_journal_line_id
// holds the PRIMARY (first) journal line of the set; the full membership
// lives here in score_breakdown.group. Un-clearing ANY member resets the
// statement line (see reconciliation.service updateLines).
interface PersistedGroup {
  kind: 'one_to_many' | 'many_to_one' | 'many_to_one_member';
  /** one_to_many: every member journal line; many_to_one: the single line. */
  journalLineIds: string[];
  /** many_to_one primary: every member statement line id, primary first. */
  statementLineIds?: string[];
  /** many_to_one_member: back-pointer to the primary statement line. */
  primaryStatementLineId?: string;
}

// Persisted into bank_statement_lines.score_breakdown so the UI can render
// the picker after a reload without re-running the engine.
interface PersistedBreakdown {
  tier: 'auto' | 'suggested' | 'confirmed';
  candidates: StatementMatchCandidate[];
  groupCandidates?: StatementGroupCandidate[];
  group?: PersistedGroup;
  /** Feature B: the transaction created from this statement line. */
  createdTransactionId?: string;
}

// ─── Scoring helpers ───────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days of (a - b); both YYYY-MM-DD. */
function dayDiff(a: string, b: string): number {
  return Math.round(
    (new Date(a + 'T00:00:00Z').getTime() - new Date(b + 'T00:00:00Z').getTime()) / DAY_MS,
  );
}

function statementDateScore(absDays: number): number {
  for (const band of STATEMENT_MATCH_DATE_BANDS) {
    if (absDays <= band.days) return band.score;
  }
  return STATEMENT_MATCH_DATE_FLOOR_SCORE;
}

function statementComposite(parts: { amount: number; date: number; name: number }): number {
  return (
    parts.amount * STATEMENT_MATCH_WEIGHTS.amount +
    parts.date * STATEMENT_MATCH_WEIGHTS.date +
    parts.name * STATEMENT_MATCH_WEIGHTS.name
  );
}

function toCents(value: string): number {
  return Math.round(parseFloat(value) * 100);
}

function summaryOf(line: StatementLineRow): StatementLineSummary {
  return {
    id: line.id,
    lineDate: line.lineDate,
    description: line.description,
    amount: line.amount,
    checkNumber: line.checkNumber,
    payee: line.payee,
    matchStatus: line.matchStatus,
  };
}

/**
 * Score one statement line against the available worksheet rows. Returns the
 * surviving candidates sorted by composite descending. Pure — exported (via
 * _internal) for unit tests.
 */
function scoreCandidates(
  line: StatementLineRow,
  worksheet: WorksheetRow[],
  unavailableJournalLineIds: ReadonlySet<string>,
): StatementMatchCandidate[] {
  const lineCents = toCents(line.amount);
  // A non-numeric parsed check number (defensive — capture normally stores
  // digits) must NOT NaN-disqualify every candidate that carries a check
  // number: treat it as absent instead.
  const stmtCheckRaw = line.checkNumber != null ? Number.parseInt(line.checkNumber, 10) : Number.NaN;
  const stmtCheck = Number.isFinite(stmtCheckRaw) ? stmtCheckRaw : null;
  const out: StatementMatchCandidate[] = [];

  for (const row of worksheet) {
    if (row.is_cleared) continue;
    if (unavailableJournalLineIds.has(row.journal_line_id)) continue;

    // Amount precondition — orientation-corrected signed compare (money in
    // on the statement ⇔ debit on the GL account).
    const candCents = toCents(row.debit) - toCents(row.credit);
    let pool: 'A' | 'B';
    if (candCents === lineCents) {
      pool = 'A';
    } else if (
      lineCents !== 0 &&
      Math.sign(candCents) === Math.sign(lineCents) &&
      Math.abs(candCents - lineCents) / Math.abs(lineCents) <= STATEMENT_MATCH_NEAR_AMOUNT_PCT
    ) {
      pool = 'B'; // near match — SUGGEST-only, never auto
    } else {
      continue;
    }

    // Asymmetric date window, anchored ledger-before-bank: the books are
    // written before the bank clears (checks can clear ~90 days later), but
    // a bank line rarely precedes the ledger by more than a few days.
    const diffDays = dayDiff(row.txn_date, line.lineDate);
    if (
      diffDays < -STATEMENT_MATCH_DATE_WINDOW.ledgerBeforeBankDays ||
      diffDays > STATEMENT_MATCH_DATE_WINDOW.ledgerAfterBankDays
    ) continue;

    // Check numbers: both present and different disqualifies the candidate
    // outright; both present and equal is near-certain identity.
    let checkExact = false;
    if (stmtCheck != null && row.check_number != null) {
      if (stmtCheck !== row.check_number) continue;
      checkExact = true;
    }

    const dScore = statementDateScore(Math.abs(diffDays));
    let nScore = 0;
    if (checkExact) {
      nScore = 1;
    } else {
      const stmtNames = [line.description, line.payee];
      const candNames = [row.contact_name, row.payee_name_on_check, row.memo, row.line_description];
      for (const s of stmtNames) {
        for (const c of candNames) {
          const v = nameSimilarityFuzzy(s, c);
          if (v > nScore) nScore = v;
        }
      }
    }
    const aScore = pool === 'A' ? 1 : STATEMENT_MATCH_NEAR_AMOUNT_SCORE;
    const composite = statementComposite({ amount: aScore, date: dScore, name: nScore });

    out.push({
      journalLineId: row.journal_line_id,
      transactionId: row.transaction_id,
      txnDate: row.txn_date,
      txnType: row.txn_type,
      txnNumber: row.txn_number,
      checkNumber: row.check_number,
      payee: row.contact_name ?? row.payee_name_on_check,
      amount: new Decimal(row.debit).minus(row.credit).toFixed(4),
      description: row.line_description ?? row.memo,
      composite: Number(composite.toFixed(4)),
      amountScore: aScore,
      dateScore: dScore,
      nameScore: Number(nScore.toFixed(4)),
      pool,
      checkExact,
      amountDelta: pool === 'B' ? Number(((lineCents - candCents) / 100).toFixed(2)) : 0,
      dateDiffDays: diffDays,
    });
  }

  return out.sort((a, b) => b.composite - a.composite);
}

// ─── Wave 2: bounded exact-sum set search ──────────────────────────

interface SumPoolItem {
  id: string;
  /** Absolute integer cents (same orientation as the target). */
  cents: number;
  /** YYYY-MM-DD — the member's date, used for the span constraint. */
  date: string;
  /** |date - anchor| in days: the pool's preference/sort key. */
  absDays: number;
}

/**
 * Bounded subset-sum: find sets of `minSize..maxSize` pool items whose cents
 * sum EXACTLY to `targetCents` (all positive). DFS in pool order (the caller
 * pre-sorts by date proximity, so earlier-found sets prefer near-dated,
 * contiguous groups), pruned by sum-overflow and a remaining-max bound, with
 * a global expansion budget.
 *
 * minimalOnly=true (one-to-many): sizes are tried ascending and the search
 * stops at the FIRST size that yields any set — returned sets are all of the
 * minimal size, up to maxSets of them (2+ sets ⇒ ambiguous, caller shows the
 * picker). minimalOnly=false (many-to-one): sets accumulate across all sizes
 * up to maxSets, so the caller can detect "more than one set exists".
 * maxSpanDays additionally requires all chosen members to be dated within
 * that many days of each other.
 */
function findExactSumSets<T extends SumPoolItem>(
  targetCents: number,
  pool: T[],
  opts: {
    minSize: number;
    maxSize: number;
    maxSets: number;
    maxExpansions: number;
    minimalOnly: boolean;
    maxSpanDays?: number;
    /**
     * Optional SHARED budget across many calls (one matchStatement run makes
     * one call per unmatched line / unaccounted worksheet row). Decremented
     * in place; when it runs out this call — and every later call handed the
     * same object — stops immediately.
     */
    budget?: { remaining: number };
  },
): T[][] {
  const out: T[][] = [];
  if (targetCents <= 0 || pool.length < opts.minSize) return out;
  if (opts.budget && opts.budget.remaining <= 0) return out;
  const n = pool.length;
  // suffixMax[i] = the largest cents value in pool[i..] — prune bound.
  const suffixMax: number[] = new Array<number>(n + 1).fill(0);
  for (let i = n - 1; i >= 0; i--) suffixMax[i] = Math.max(suffixMax[i + 1]!, pool[i]!.cents);

  let expansions = 0;
  for (let k = opts.minSize; k <= Math.min(opts.maxSize, n); k++) {
    const chosen: T[] = [];
    // Returns true to abort the whole size-k search (budget or maxSets hit).
    const dfs = (start: number, sum: number): boolean => {
      if (++expansions > opts.maxExpansions) return true;
      if (opts.budget && --opts.budget.remaining < 0) return true;
      const slotsLeft = k - chosen.length;
      if (slotsLeft === 0) {
        if (sum === targetCents) {
          out.push([...chosen]);
          if (out.length >= opts.maxSets) return true;
        }
        return false;
      }
      for (let i = start; i <= n - slotsLeft; i++) {
        const item = pool[i]!;
        const newSum = sum + item.cents;
        if (newSum > targetCents) continue;
        if (newSum + (slotsLeft - 1) * suffixMax[i + 1]! < targetCents) continue;
        if (opts.maxSpanDays != null && chosen.length > 0) {
          let mn = item.date;
          let mx = item.date;
          for (const c of chosen) {
            if (c.date < mn) mn = c.date;
            if (c.date > mx) mx = c.date;
          }
          if (dayDiff(mx, mn) > opts.maxSpanDays) continue;
        }
        chosen.push(item);
        const abort = dfs(i + 1, newSum);
        chosen.pop();
        if (abort) return true;
      }
      return false;
    };
    const aborted = dfs(0, 0);
    if (opts.minimalOnly && out.length > 0) break; // minimal size found
    if (aborted && out.length >= opts.maxSets) break;
    if (expansions > opts.maxExpansions) break;
    if (opts.budget && opts.budget.remaining <= 0) break;
  }
  return out;
}

/** Deterministic pool order: nearest-dated first, then date, amount, id. */
function sortSumPool<T extends SumPoolItem>(pool: T[]): T[] {
  return pool.sort(
    (a, b) =>
      a.absDays - b.absDays ||
      a.date.localeCompare(b.date) ||
      b.cents - a.cents ||
      a.id.localeCompare(b.id),
  );
}

function groupLineOf(row: WorksheetRow, statementDate: string): StatementGroupLine {
  return {
    journalLineId: row.journal_line_id,
    transactionId: row.transaction_id,
    txnDate: row.txn_date,
    txnType: row.txn_type,
    txnNumber: row.txn_number,
    checkNumber: row.check_number,
    payee: row.contact_name ?? row.payee_name_on_check,
    amount: new Decimal(row.debit).minus(row.credit).toFixed(4),
    description: row.line_description ?? row.memo,
    dateDiffDays: dayDiff(row.txn_date, statementDate),
  };
}

function dateSpanOf(dates: string[]): number {
  if (dates.length === 0) return 0;
  let mn = dates[0]!;
  let mx = dates[0]!;
  for (const d of dates) {
    if (d < mn) mn = d;
    if (d > mx) mx = d;
  }
  return dayDiff(mx, mn);
}

/**
 * A1 pool: uncleared, unclaimed worksheet rows in the same orientation as
 * the statement line, strictly smaller in magnitude (a set needs ≥2
 * members), within the tighter group date window — capped at the
 * STATEMENT_MATCH_GROUP_POOL_CAP nearest-dated candidates.
 */
function buildGroupPool(
  line: Pick<StatementLineRow, 'amount' | 'lineDate'>,
  worksheet: WorksheetRow[],
  unavailableJournalLineIds: ReadonlySet<string>,
): Array<SumPoolItem & { row: WorksheetRow }> {
  const lineCents = toCents(line.amount);
  if (lineCents === 0) return [];
  const sign = Math.sign(lineCents);
  const pool: Array<SumPoolItem & { row: WorksheetRow }> = [];
  for (const row of worksheet) {
    if (row.is_cleared) continue;
    if (unavailableJournalLineIds.has(row.journal_line_id)) continue;
    const candCents = toCents(row.debit) - toCents(row.credit);
    if (candCents === 0 || Math.sign(candCents) !== sign) continue;
    if (Math.abs(candCents) >= Math.abs(lineCents)) continue;
    const diffDays = dayDiff(row.txn_date, line.lineDate);
    if (
      diffDays < -STATEMENT_MATCH_GROUP_DATE_WINDOW.ledgerBeforeBankDays ||
      diffDays > STATEMENT_MATCH_GROUP_DATE_WINDOW.ledgerAfterBankDays
    ) continue;
    pool.push({
      id: row.journal_line_id,
      cents: Math.abs(candCents),
      date: row.txn_date,
      absDays: Math.abs(diffDays),
      row,
    });
  }
  return sortSumPool(pool).slice(0, STATEMENT_MATCH_GROUP_POOL_CAP);
}

/**
 * A1: one statement line ↔ many worksheet lines. Returns up to
 * STATEMENT_MATCH_GROUP_MAX_SETS minimal-size exact-sum sets (2+ sets =
 * ambiguous, shown as a picker) as group candidates, or [] when none exist.
 */
function findOneToManySets(
  line: StatementLineRow,
  worksheet: WorksheetRow[],
  unavailableJournalLineIds: ReadonlySet<string>,
  budget?: { remaining: number },
): StatementGroupCandidate[] {
  const pool = buildGroupPool(line, worksheet, unavailableJournalLineIds);
  const sets = findExactSumSets(Math.abs(toCents(line.amount)), pool, {
    minSize: STATEMENT_MATCH_GROUP_MIN_SIZE,
    maxSize: STATEMENT_MATCH_GROUP_MAX_SIZE,
    maxSets: STATEMENT_MATCH_GROUP_MAX_SETS,
    maxExpansions: STATEMENT_MATCH_GROUP_MAX_EXPANSIONS,
    minimalOnly: true,
    ...(budget ? { budget } : {}),
  });
  return sets.map((set) => {
    const rows = set
      .map((item) => item.row)
      .sort((a, b) => a.txn_date.localeCompare(b.txn_date) || a.journal_line_id.localeCompare(b.journal_line_id));
    let sum = new Decimal(0);
    for (const r of rows) sum = sum.plus(r.debit).minus(r.credit);
    return {
      kind: 'one_to_many' as const,
      journalLines: rows.map((r) => groupLineOf(r, line.lineDate)),
      memberStatementLines: [],
      sum: sum.toFixed(4),
      dateSpanDays: dateSpanOf(rows.map((r) => r.txn_date)),
    };
  });
}

// ─── Shared loaders ────────────────────────────────────────────────

async function loadWorksheet(tx: DbOrTx, tenantId: string, reconciliationId: string): Promise<WorksheetRow[]> {
  const rows = await tx.execute(sql`
    SELECT rl.id AS rec_line_id, rl.journal_line_id, rl.is_cleared,
      jl.debit, jl.credit, jl.description AS line_description,
      t.id AS transaction_id, t.txn_date, t.txn_type, t.txn_number, t.memo,
      t.check_number, t.payee_name_on_check, c.display_name AS contact_name
    FROM reconciliation_lines rl
    JOIN journal_lines jl ON jl.id = rl.journal_line_id
    JOIN transactions t ON t.id = jl.transaction_id
    LEFT JOIN contacts c ON c.id = t.contact_id
    WHERE rl.reconciliation_id = ${reconciliationId} AND jl.tenant_id = ${tenantId}
    ORDER BY t.txn_date, t.created_at
  `);
  return rows.rows as unknown as WorksheetRow[];
}

async function loadStatementLines(tx: DbOrTx, tenantId: string, statementId: string): Promise<StatementLineRow[]> {
  const rows = await tx.execute(sql`
    SELECT * FROM bank_statement_lines
    WHERE tenant_id = ${tenantId} AND statement_id = ${statementId}
    ORDER BY line_date, created_at
  `);
  interface Raw {
    id: string; tenant_id: string; statement_id: string; line_date: string;
    description: string | null; amount: string; check_number: string | null;
    payee: string | null; running_balance: string | null; match_status: string;
    matched_journal_line_id: string | null; match_score: string | null;
    score_breakdown: unknown; created_at: Date | null; updated_at: Date | null;
  }
  return (rows.rows as unknown as Raw[]).map((r) => ({
    id: r.id,
    tenantId: r.tenant_id,
    statementId: r.statement_id,
    lineDate: r.line_date,
    description: r.description,
    amount: r.amount,
    checkNumber: r.check_number,
    payee: r.payee,
    runningBalance: r.running_balance,
    matchStatus: r.match_status,
    matchedJournalLineId: r.matched_journal_line_id,
    matchScore: r.match_score,
    scoreBreakdown: r.score_breakdown,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

// ─── The engine ────────────────────────────────────────────────────

export async function matchStatement(
  tenantId: string,
  reconciliationId: string,
  opts: { apply: boolean; userId?: string },
): Promise<StatementMatchResult> {
  return await db.transaction(async (tx) => {
    // Row-lock like updateLines/autoClearStatement so concurrent toggles,
    // completes and match runs serialize.
    const [recon] = await tx.select().from(reconciliations)
      .where(and(eq(reconciliations.tenantId, tenantId), eq(reconciliations.id, reconciliationId)))
      .for('update')
      .limit(1);
    if (!recon) throw AppError.notFound('Reconciliation not found');
    if (recon.status === 'complete') throw AppError.badRequest('Reconciliation is already complete');

    const [statement] = await tx.select().from(bankStatements)
      .where(and(eq(bankStatements.tenantId, tenantId), eq(bankStatements.reconciliationId, reconciliationId)))
      .limit(1);
    if (!statement) throw AppError.badRequest('This reconciliation is not linked to a bank statement.');

    const stmtLines = await loadStatementLines(tx, tenantId, statement.id);
    if (stmtLines.length === 0) {
      throw AppError.badRequest(
        'This statement has no stored transaction lines to match. Re-open the statements list to backfill them, or re-import the statement.',
      );
    }
    const worksheet = await loadWorksheet(tx, tenantId, reconciliationId);

    // Feed-item id links (bank-feed-imported statements): a stamped feed
    // item that was matched/categorized already knows its transaction —
    // resolve those statement lines as AUTO without scoring. Feed rows are
    // correlated to statement lines by the importer's identity tuple
    // (feed_date, original_description, signed amount) — remembering the
    // feed sign convention is the OPPOSITE of the statement line's.
    const feedRows = await tx.execute(sql`
      SELECT feed_date, original_description, amount, matched_transaction_id
      FROM bank_feed_items
      WHERE tenant_id = ${tenantId} AND statement_id = ${statement.id}
        AND matched_transaction_id IS NOT NULL
    `);
    const feedByKey = new Map<string, string>(); // key → matched transaction id
    for (const r of feedRows.rows as Array<{ feed_date: string; original_description: string | null; amount: string; matched_transaction_id: string }>) {
      feedByKey.set(`${r.feed_date}|${r.original_description ?? ''}|${-toCents(r.amount)}`, r.matched_transaction_id);
    }

    // Journal lines that are off the table for scoring: already claimed by a
    // previously persisted auto/confirmed statement line.
    const claimed = new Set<string>();
    for (const l of stmtLines) {
      if (l.matchedJournalLineId && (l.matchStatus === 'auto' || l.matchStatus === 'confirmed')) {
        claimed.add(l.matchedJournalLineId);
      }
    }

    const worksheetByTxn = new Map<string, WorksheetRow[]>();
    for (const row of worksheet) {
      const list = worksheetByTxn.get(row.transaction_id) ?? [];
      list.push(row);
      worksheetByTxn.set(row.transaction_id, list);
    }

    // ── Pass 1: id-linked autos + scoring ─────────────────────────────
    interface Outcome {
      line: StatementLineRow;
      tier: 'auto' | 'suggested' | 'unmatched';
      candidates: StatementMatchCandidate[];
      /** Wave 2: grouped-set proposals (only on group-suggested outcomes). */
      groupCandidates?: StatementGroupCandidate[];
    }
    const outcomes: Outcome[] = [];
    let skippedLines = 0;

    for (const line of stmtLines) {
      // Re-runs never touch resolved lines; rejected lines stay rejected
      // (re-scoring would just resurrect the suggestion the user dismissed).
      if (line.matchStatus === 'auto' || line.matchStatus === 'confirmed' || line.matchStatus === 'rejected') {
        skippedLines += 1;
        continue;
      }

      // Highest priority: the imported feed item already knows its
      // transaction — no scoring needed.
      const linkedTxnId = feedByKey.get(`${line.lineDate}|${line.description ?? ''}|${toCents(line.amount)}`);
      if (linkedTxnId) {
        const lineCents = toCents(line.amount);
        const jlRow = (worksheetByTxn.get(linkedTxnId) ?? []).find(
          (r) => toCents(r.debit) - toCents(r.credit) === lineCents && !claimed.has(r.journal_line_id),
        );
        if (jlRow) {
          claimed.add(jlRow.journal_line_id);
          outcomes.push({
            line,
            tier: 'auto',
            candidates: [{
              journalLineId: jlRow.journal_line_id,
              transactionId: jlRow.transaction_id,
              txnDate: jlRow.txn_date,
              txnType: jlRow.txn_type,
              txnNumber: jlRow.txn_number,
              checkNumber: jlRow.check_number,
              payee: jlRow.contact_name ?? jlRow.payee_name_on_check,
              amount: new Decimal(jlRow.debit).minus(jlRow.credit).toFixed(4),
              description: jlRow.line_description ?? jlRow.memo,
              composite: 1,
              amountScore: 1,
              dateScore: 1,
              nameScore: 1,
              pool: 'A',
              checkExact: false,
              amountDelta: 0,
              dateDiffDays: dayDiff(jlRow.txn_date, line.lineDate),
              idLinked: true,
            }],
          });
          continue;
        }
      }

      const candidates = scoreCandidates(line, worksheet, claimed);
      if (candidates.length === 0) {
        outcomes.push({ line, tier: 'unmatched', candidates: [] });
        continue;
      }
      const poolA = candidates.filter((c) => c.pool === 'A');
      const best = candidates[0]!;
      // Ambiguity gate: 2+ exact-amount candidates → NEVER auto.
      const auto =
        poolA.length === 1 &&
        best.pool === 'A' &&
        (best.checkExact || best.composite >= STATEMENT_MATCH_AUTO_THRESHOLD);
      outcomes.push({ line, tier: auto ? 'auto' : 'suggested', candidates });
    }

    // ── Pass 2: reverse uniqueness — a journal line may be AUTO-matched by
    // at most one statement line; conflicts demote BOTH to SUGGEST. (Id
    // links can't conflict: `claimed` reserves each journal line as taken.)
    const autoByJl = new Map<string, Outcome[]>();
    for (const o of outcomes) {
      if (o.tier !== 'auto') continue;
      const jl = o.candidates[0]!.journalLineId;
      const list = autoByJl.get(jl) ?? [];
      list.push(o);
      autoByJl.set(jl, list);
    }
    for (const [, list] of autoByJl) {
      if (list.length > 1) for (const o of list) o.tier = 'suggested';
    }

    // ── Pass 3 (wave 2): grouped matches — SUGGEST-only, never auto ──
    let skippedAmbiguousGroups = 0;

    // One shared expansion budget for EVERY subset-sum search in this run
    // (A1 + A2). The per-call budget bounds one pathological pool; this
    // bounds the whole request. Exhaustion skips the remaining group
    // searches only — singles / autos above are unaffected.
    const groupBudget = { remaining: STATEMENT_MATCH_GROUP_MAX_EXPANSIONS_TOTAL };
    let groupBudgetLogged = false;
    const noteBudgetExhausted = () => {
      if (groupBudget.remaining > 0 || groupBudgetLogged) return false;
      groupBudgetLogged = true;
      log.warn({
        component: 'statement-match', event: 'group_budget_exhausted',
        tenantId, reconciliationId,
        message: 'Shared subset-sum budget exhausted — remaining grouped-match searches skipped.',
      });
      return true;
    };

    // Journal lines off the table for grouping: already claimed, plus the
    // ones this run is about to auto-clear.
    const groupUnavailable = new Set<string>(claimed);
    for (const o of outcomes) {
      if (o.tier === 'auto') groupUnavailable.add(o.candidates[0]!.journalLineId);
    }

    // A1 — one statement line ↔ many worksheet lines: for lines still
    // unmatched after singles, look for an exact-sum set of uncleared
    // worksheet lines. Multiple minimal sets → all returned for the picker.
    for (const o of outcomes) {
      if (o.tier !== 'unmatched') continue;
      if (noteBudgetExhausted()) break;
      const sets = findOneToManySets(o.line, worksheet, groupUnavailable, groupBudget);
      if (sets.length > 0) {
        o.tier = 'suggested';
        o.groupCandidates = sets;
      }
    }

    // A2 — many statement lines ↔ one worksheet line: for uncleared
    // worksheet lines nothing accounts for, look for a set of 2..5 still-
    // unmatched statement lines (same orientation, dated within
    // STATEMENT_MATCH_GROUP_MEMBER_SPAN_DAYS of each other) summing exactly.
    // Conservative: emitted only when EXACTLY ONE such set exists; the
    // suggestion attaches to the FIRST (earliest-dated) member, the others
    // are referenced through its group.
    const a2Accounted = new Set<string>(groupUnavailable);
    for (const o of outcomes) {
      if (o.tier !== 'suggested') continue;
      for (const c of o.candidates) a2Accounted.add(c.journalLineId);
      for (const g of o.groupCandidates ?? []) {
        for (const m of g.journalLines) a2Accounted.add(m.journalLineId);
      }
    }
    /** Non-primary statement lines referenced by a many-to-one suggestion. */
    const a2MemberLineIds = new Set<string>();
    const consumedStmt = new Set<string>();
    for (const row of worksheet) {
      if (row.is_cleared || a2Accounted.has(row.journal_line_id)) continue;
      if (noteBudgetExhausted()) break;
      const rowCents = toCents(row.debit) - toCents(row.credit);
      if (rowCents === 0) continue;
      const sign = Math.sign(rowCents);
      const pool: Array<SumPoolItem & { outcome: Outcome }> = [];
      for (const o of outcomes) {
        if (o.tier !== 'unmatched' || consumedStmt.has(o.line.id)) continue;
        const c = toCents(o.line.amount);
        if (c === 0 || Math.sign(c) !== sign || Math.abs(c) >= Math.abs(rowCents)) continue;
        // Same window expression as A1 (txn_date minus statement date).
        const diffDays = dayDiff(row.txn_date, o.line.lineDate);
        if (
          diffDays < -STATEMENT_MATCH_GROUP_DATE_WINDOW.ledgerBeforeBankDays ||
          diffDays > STATEMENT_MATCH_GROUP_DATE_WINDOW.ledgerAfterBankDays
        ) continue;
        pool.push({
          id: o.line.id,
          cents: Math.abs(c),
          date: o.line.lineDate,
          absDays: Math.abs(diffDays),
          outcome: o,
        });
      }
      const capped = sortSumPool(pool).slice(0, STATEMENT_MATCH_GROUP_POOL_CAP);
      const sets = findExactSumSets(Math.abs(rowCents), capped, {
        minSize: STATEMENT_MATCH_GROUP_MIN_SIZE,
        maxSize: STATEMENT_MATCH_GROUP_MAX_SIZE,
        maxSets: 2, // only need to know "one" vs "more than one"
        maxExpansions: STATEMENT_MATCH_GROUP_MAX_EXPANSIONS,
        minimalOnly: false,
        maxSpanDays: STATEMENT_MATCH_GROUP_MEMBER_SPAN_DAYS,
        budget: groupBudget,
      });
      if (sets.length === 0) continue;
      if (sets.length > 1) {
        skippedAmbiguousGroups += 1;
        continue;
      }
      const members = sets[0]!
        .map((item) => item.outcome)
        .sort((a, b) => a.line.lineDate.localeCompare(b.line.lineDate) || a.line.id.localeCompare(b.line.id));
      const primary = members[0]!;
      let sum = new Decimal(0);
      for (const m of members) sum = sum.plus(m.line.amount);
      primary.tier = 'suggested';
      primary.groupCandidates = [{
        kind: 'many_to_one',
        journalLines: [groupLineOf(row, primary.line.lineDate)],
        memberStatementLines: members.map((m) => summaryOf(m.line)),
        sum: sum.toFixed(4),
        dateSpanDays: dateSpanOf(members.map((m) => m.line.lineDate)),
      }];
      a2Accounted.add(row.journal_line_id);
      for (const m of members) consumedStmt.add(m.line.id);
      for (const m of members.slice(1)) a2MemberLineIds.add(m.line.id);
    }

    // ── Persist + clear (apply) ──────────────────────────────────────
    const autoOutcomes = outcomes.filter((o) => o.tier === 'auto');
    const suggestOutcomes = outcomes.filter((o) => o.tier === 'suggested');
    const unmatchedOutcomes = outcomes.filter((o) => o.tier === 'unmatched');

    if (opts.apply) {
      // Clear the AUTO journal lines on the worksheet (reuse the updateLines
      // mechanics — the reconciliation row is already locked FOR UPDATE).
      const jlIds = autoOutcomes.map((o) => o.candidates[0]!.journalLineId);
      if (jlIds.length > 0) {
        const idList = sql.join(jlIds.map((id) => sql`${id}::uuid`), sql`, `);
        await tx.execute(sql`
          UPDATE reconciliation_lines SET is_cleared = true, cleared_at = now()
          WHERE reconciliation_id = ${reconciliationId} AND journal_line_id IN (${idList})
            AND is_cleared = false
        `);
      }

      for (const o of autoOutcomes) {
        const best = o.candidates[0]!;
        const breakdown: PersistedBreakdown = { tier: 'auto', candidates: o.candidates.slice(0, STATEMENT_MATCH_MAX_CANDIDATES) };
        await tx.execute(sql`
          UPDATE bank_statement_lines
          SET match_status = 'auto', matched_journal_line_id = ${best.journalLineId}::uuid,
              match_score = ${best.composite.toFixed(4)}, score_breakdown = ${JSON.stringify(breakdown)}::jsonb,
              updated_at = now()
          WHERE id = ${o.line.id} AND tenant_id = ${tenantId}
        `);
      }
      for (const o of suggestOutcomes) {
        // Group-only suggestions (wave 2) have no single best candidate —
        // matched_journal_line_id stays NULL until the set is confirmed.
        const best = o.candidates[0] ?? null;
        const breakdown: PersistedBreakdown = {
          tier: 'suggested',
          candidates: o.candidates.slice(0, STATEMENT_MATCH_MAX_CANDIDATES),
          ...(o.groupCandidates ? { groupCandidates: o.groupCandidates } : {}),
        };
        await tx.execute(sql`
          UPDATE bank_statement_lines
          SET match_status = 'suggested',
              matched_journal_line_id = ${best ? sql`${best.journalLineId}::uuid` : sql`NULL`},
              match_score = ${best ? best.composite.toFixed(4) : null},
              score_breakdown = ${JSON.stringify(breakdown)}::jsonb,
              updated_at = now()
          WHERE id = ${o.line.id} AND tenant_id = ${tenantId}
        `);
      }
      for (const o of unmatchedOutcomes) {
        // Reset stale suggestions from earlier runs.
        if (o.line.matchStatus !== 'unmatched' || o.line.matchedJournalLineId) {
          await tx.execute(sql`
            UPDATE bank_statement_lines
            SET match_status = 'unmatched', matched_journal_line_id = NULL,
                match_score = NULL, score_breakdown = NULL, updated_at = now()
            WHERE id = ${o.line.id} AND tenant_id = ${tenantId}
          `);
        }
      }
    }

    // ── Outstanding: uncleared worksheet lines no statement line accounts
    // for — expected timing items (outstanding checks / deposits in transit).
    const accountedJl = new Set<string>(claimed);
    for (const o of autoOutcomes) accountedJl.add(o.candidates[0]!.journalLineId);
    for (const o of suggestOutcomes) {
      if (o.candidates[0]) accountedJl.add(o.candidates[0].journalLineId);
      for (const g of o.groupCandidates ?? []) {
        for (const m of g.journalLines) accountedJl.add(m.journalLineId);
      }
    }
    const autoClearedJl = new Set(autoOutcomes.map((o) => o.candidates[0]!.journalLineId));
    let outstandingCount = 0;
    for (const row of worksheet) {
      const clearedNow = row.is_cleared || (opts.apply && autoClearedJl.has(row.journal_line_id));
      if (!clearedNow && !accountedJl.has(row.journal_line_id)) outstandingCount += 1;
    }

    if (opts.apply) {
      // One summary audit entry with counts + per-line breakdowns.
      await auditLog(
        tenantId, 'update', 'reconciliation', reconciliationId, null,
        {
          statementMatch: {
            statementId: statement.id,
            autoCleared: autoOutcomes.length,
            suggested: suggestOutcomes.length,
            unmatched: unmatchedOutcomes.length,
            skipped: skippedLines,
            outstandingCount,
            skippedAmbiguousGroups,
            lines: outcomes.map((o) => ({
              statementLineId: o.line.id,
              tier: o.tier,
              journalLineId: o.candidates[0]?.journalLineId ?? null,
              score: o.candidates[0]?.composite ?? null,
              groupSets: o.groupCandidates?.length ?? 0,
              breakdown: o.candidates.slice(0, STATEMENT_MATCH_MAX_CANDIDATES).map((c) => ({
                journalLineId: c.journalLineId,
                composite: c.composite,
                amountScore: c.amountScore,
                dateScore: c.dateScore,
                nameScore: c.nameScore,
                pool: c.pool,
                checkExact: c.checkExact,
                amountDelta: c.amountDelta,
                idLinked: c.idLinked ?? false,
              })),
            })),
          },
        },
        opts.userId, tx,
      );
    }

    return {
      autoCleared: autoOutcomes.length,
      suggestions: suggestOutcomes.map((o) => ({
        statementLine: { ...summaryOf(o.line), matchStatus: opts.apply ? 'suggested' : o.line.matchStatus },
        candidates: o.candidates.slice(0, STATEMENT_MATCH_MAX_CANDIDATES),
        ...(o.groupCandidates ? { groupCandidates: o.groupCandidates } : {}),
      })),
      // Many-to-one member lines stay 'unmatched' in the DB but are
      // referenced through their primary's suggestion — don't double-list.
      unmatchedLines: unmatchedOutcomes
        .filter((o) => !a2MemberLineIds.has(o.line.id))
        .map((o) => ({
          ...summaryOf(o.line),
          matchStatus: opts.apply ? 'unmatched' : o.line.matchStatus,
        })),
      outstandingCount,
      skippedLines,
      skippedAmbiguousGroups,
    };
  });
}

// ─── Persisted-state view (worksheet reload) ───────────────────────

export interface StatementMatchesView {
  statementId: string;
  counts: { auto: number; confirmed: number; suggested: number; unmatched: number; rejected: number };
  suggestions: StatementMatchSuggestion[];
  unmatchedLines: StatementLineSummary[];
  outstandingCount: number;
}

export async function getStatementMatches(
  tenantId: string,
  reconciliationId: string,
): Promise<StatementMatchesView> {
  const recon = await db.query.reconciliations.findFirst({
    where: and(eq(reconciliations.tenantId, tenantId), eq(reconciliations.id, reconciliationId)),
  });
  if (!recon) throw AppError.notFound('Reconciliation not found');
  const statement = await db.query.bankStatements.findFirst({
    where: and(eq(bankStatements.tenantId, tenantId), eq(bankStatements.reconciliationId, reconciliationId)),
  });
  if (!statement) throw AppError.badRequest('This reconciliation is not linked to a bank statement.');

  const lines = await loadStatementLines(db, tenantId, statement.id);
  const worksheet = await loadWorksheet(db, tenantId, reconciliationId);

  const counts = { auto: 0, confirmed: 0, suggested: 0, unmatched: 0, rejected: 0 };
  const suggestions: StatementMatchSuggestion[] = [];
  const unmatchedLines: StatementLineSummary[] = [];
  const accountedJl = new Set<string>();

  // Wave 2: statement lines referenced as non-primary members of a
  // suggested many-to-one group — kept out of the unmatched list because
  // they surface through their primary's suggestion instead.
  const a2MemberLineIds = new Set<string>();

  for (const line of lines) {
    switch (line.matchStatus) {
      case 'auto': counts.auto += 1; break;
      case 'confirmed': counts.confirmed += 1; break;
      case 'suggested': counts.suggested += 1; break;
      case 'rejected': counts.rejected += 1; break;
      default: counts.unmatched += 1; break;
    }
    if (line.matchedJournalLineId) accountedJl.add(line.matchedJournalLineId);
    if (line.matchStatus === 'suggested') {
      const breakdown = (line.scoreBreakdown ?? null) as PersistedBreakdown | null;
      const groupCandidates = Array.isArray(breakdown?.groupCandidates) ? breakdown.groupCandidates : [];
      for (const g of groupCandidates) {
        for (const m of g.journalLines) accountedJl.add(m.journalLineId);
        if (g.kind === 'many_to_one') {
          for (const m of g.memberStatementLines) {
            if (m.id !== line.id) a2MemberLineIds.add(m.id);
          }
        }
      }
      suggestions.push({
        statementLine: summaryOf(line),
        candidates: Array.isArray(breakdown?.candidates) ? breakdown.candidates : [],
        ...(groupCandidates.length > 0 ? { groupCandidates } : {}),
      });
    } else if (line.matchStatus === 'unmatched' || line.matchStatus === 'rejected') {
      unmatchedLines.push(summaryOf(line));
    }
  }
  const visibleUnmatched = unmatchedLines.filter((l) => !a2MemberLineIds.has(l.id));

  let outstandingCount = 0;
  for (const row of worksheet) {
    if (!row.is_cleared && !accountedJl.has(row.journal_line_id)) outstandingCount += 1;
  }

  return { statementId: statement.id, counts, suggestions, unmatchedLines: visibleUnmatched, outstandingCount };
}

// ─── Confirm / reject ──────────────────────────────────────────────

/**
 * 409 when any of the journal lines is already claimed by another
 * auto/confirmed statement line — either as its direct
 * matched_journal_line_id or as a member of a confirmed group
 * (score_breakdown.group.journalLineIds).
 */
async function assertJournalLinesUnclaimed(
  tx: DbOrTx,
  tenantId: string,
  journalLineIds: string[],
  exceptStatementLineId: string,
): Promise<void> {
  const uuidList = sql.join(journalLineIds.map((id) => sql`${id}::uuid`), sql`, `);
  const textList = sql.join(journalLineIds.map((id) => sql`${id}::text`), sql`, `);
  const dup = await tx.execute(sql`
    SELECT id FROM bank_statement_lines
    WHERE tenant_id = ${tenantId} AND id <> ${exceptStatementLineId}
      AND match_status IN ('auto', 'confirmed')
      AND (matched_journal_line_id IN (${uuidList})
        OR jsonb_exists_any(COALESCE(score_breakdown->'group'->'journalLineIds', '[]'::jsonb), ARRAY[${textList}]))
    LIMIT 1
  `);
  if ((dup.rows as unknown[]).length > 0) {
    throw AppError.conflict('Another statement line is already matched to that transaction.', 'JOURNAL_LINE_ALREADY_MATCHED');
  }
}

export async function confirmStatementLine(
  tenantId: string,
  statementLineId: string,
  journalLineId: string,
  userId?: string,
): Promise<StatementLineSummary> {
  return await db.transaction(async (tx) => {
    // Reconciliation lock first, then the line lock (shared helper) — same
    // order as matchStatement / updateLines / undo, so concurrent confirms
    // of the same journal line serialize instead of double-claiming it.
    const { line, recon } = await lockLineAndReconciliation(tx, tenantId, statementLineId);
    if (line.matchStatus === 'confirmed' || line.matchStatus === 'auto') {
      throw AppError.conflict('This statement line is already matched. Un-clear it from the worksheet first.', 'STATEMENT_LINE_ALREADY_MATCHED');
    }

    // The journal line must be on this reconciliation's worksheet (any
    // worksheet line may be chosen explicitly, not just persisted candidates).
    const rl = await tx.execute(sql`
      SELECT rl.id, rl.is_cleared FROM reconciliation_lines rl
      WHERE rl.reconciliation_id = ${recon.id} AND rl.journal_line_id = ${journalLineId}
      LIMIT 1
    `);
    const rlRow = (rl.rows as Array<{ id: string; is_cleared: boolean }>)[0];
    if (!rlRow) throw AppError.badRequest('That transaction is not on this reconciliation worksheet.');

    // One-statement-line-per-journal-line uniqueness (direct link or wave-2
    // group membership).
    await assertJournalLinesUnclaimed(tx, tenantId, [journalLineId], statementLineId);

    await tx.execute(sql`
      UPDATE reconciliation_lines SET is_cleared = true, cleared_at = now()
      WHERE id = ${rlRow.id} AND is_cleared = false
    `);
    await tx.execute(sql`
      UPDATE bank_statement_lines
      SET match_status = 'confirmed', matched_journal_line_id = ${journalLineId}::uuid, updated_at = now()
      WHERE id = ${statementLineId} AND tenant_id = ${tenantId}
    `);

    await auditLog(
      tenantId, 'update', 'bank_statement_line', statementLineId,
      { matchStatus: line.matchStatus, matchedJournalLineId: line.matchedJournalLineId },
      { matchStatus: 'confirmed', matchedJournalLineId: journalLineId },
      userId, tx,
    );

    return { ...summaryOf(line), matchStatus: 'confirmed' };
  });
}

export async function rejectStatementLine(
  tenantId: string,
  statementLineId: string,
  userId?: string,
): Promise<StatementLineSummary> {
  return await db.transaction(async (tx) => {
    // Same lock order + status guards as confirm: a completed
    // reconciliation's match state is frozen (undo it first), and taking
    // the reconciliation lock serializes rejects against a concurrent
    // matchStatement apply that would otherwise overwrite the rejection
    // with a stale 'suggested'.
    const { line } = await lockLineAndReconciliation(tx, tenantId, statementLineId);
    if (line.matchStatus === 'confirmed' || line.matchStatus === 'auto') {
      // A cleared match is undone from the worksheet (un-clearing resets the
      // statement line) — rejecting here would leave the worksheet cleared
      // against a rejected line.
      throw AppError.badRequest('This line is already matched and cleared — un-clear it on the worksheet instead.');
    }

    await tx.execute(sql`
      UPDATE bank_statement_lines
      SET match_status = 'rejected', matched_journal_line_id = NULL, updated_at = now()
      WHERE id = ${statementLineId} AND tenant_id = ${tenantId}
    `);

    await auditLog(
      tenantId, 'update', 'bank_statement_line', statementLineId,
      { matchStatus: line.matchStatus, matchedJournalLineId: line.matchedJournalLineId },
      { matchStatus: 'rejected', matchedJournalLineId: null },
      userId, tx,
    );

    return { ...summaryOf(line), matchStatus: 'rejected' };
  });
}

// ─── Wave 2: grouped confirm ───────────────────────────────────────

// Shared prologue for the confirm/reject/create flows: resolve + lock the
// reconciliation, then lock the statement line, and refuse when the
// reconciliation is complete.
//
// LOCK ORDER — reconciliation FIRST, statement line second. Every other
// writer (matchStatement, updateLines' reset hook, undo) takes the
// reconciliation row lock before touching bank_statement_lines rows;
// locking the line first here would be a classic lock-order inversion and
// a live deadlock window against a concurrent matchStatement apply. The
// line is therefore peeked WITHOUT a lock (statement_id is immutable, so
// the reconciliation it resolves to can't change underneath us) and
// re-read FOR UPDATE only after the reconciliation lock is held.
async function lockLineAndReconciliation(
  tx: Tx,
  tenantId: string,
  statementLineId: string,
): Promise<{ line: StatementLineRow; recon: typeof reconciliations.$inferSelect }> {
  const [peek] = await tx.select().from(bankStatementLines)
    .where(and(eq(bankStatementLines.tenantId, tenantId), eq(bankStatementLines.id, statementLineId)))
    .limit(1);
  if (!peek) throw AppError.notFound('Statement line not found');

  const [statement] = await tx.select().from(bankStatements)
    .where(and(eq(bankStatements.tenantId, tenantId), eq(bankStatements.id, peek.statementId)))
    .limit(1);
  if (!statement?.reconciliationId) {
    throw AppError.badRequest('This statement is not linked to a reconciliation — start one from the statement first.');
  }
  const [recon] = await tx.select().from(reconciliations)
    .where(and(eq(reconciliations.tenantId, tenantId), eq(reconciliations.id, statement.reconciliationId)))
    .for('update')
    .limit(1);
  if (!recon) throw AppError.notFound('Reconciliation not found');
  if (recon.status === 'complete') throw AppError.badRequest('Reconciliation is already complete');

  // Re-read under the reconciliation lock — the authoritative row state.
  const [line] = await tx.select().from(bankStatementLines)
    .where(and(eq(bankStatementLines.tenantId, tenantId), eq(bankStatementLines.id, statementLineId)))
    .for('update')
    .limit(1);
  if (!line) throw AppError.notFound('Statement line not found');
  return { line, recon };
}

interface GroupWorksheetRow {
  rec_line_id: string;
  journal_line_id: string;
  is_cleared: boolean;
  debit: string;
  credit: string;
}

// Load + validate the requested journal lines on a reconciliation's
// worksheet: every id must be on the worksheet and uncleared.
async function loadGroupWorksheetRows(
  tx: DbOrTx,
  tenantId: string,
  reconciliationId: string,
  journalLineIds: string[],
): Promise<GroupWorksheetRow[]> {
  const idList = sql.join(journalLineIds.map((id) => sql`${id}::uuid`), sql`, `);
  const res = await tx.execute(sql`
    SELECT rl.id AS rec_line_id, rl.journal_line_id, rl.is_cleared, jl.debit, jl.credit
    FROM reconciliation_lines rl
    JOIN journal_lines jl ON jl.id = rl.journal_line_id
    WHERE rl.reconciliation_id = ${reconciliationId} AND jl.tenant_id = ${tenantId}
      AND rl.journal_line_id IN (${idList})
  `);
  const rows = res.rows as unknown as GroupWorksheetRow[];
  if (rows.length !== journalLineIds.length) {
    throw AppError.badRequest('One or more transactions are not on this reconciliation worksheet.');
  }
  const cleared = rows.filter((r) => r.is_cleared);
  if (cleared.length > 0) {
    throw AppError.conflict('One or more of those transactions is already cleared on the worksheet.', 'JOURNAL_LINE_ALREADY_CLEARED');
  }
  return rows;
}

/**
 * A1 confirm: one statement line ↔ 2..5 worksheet journal lines. Every line
 * must be on the worksheet, uncleared, unclaimed, in the statement line's
 * orientation, and the set must sum EXACTLY to the cent (409 otherwise).
 * All members are cleared; matched_journal_line_id records the first line
 * as primary with the full set in score_breakdown.group.
 */
export async function confirmStatementLineGroup(
  tenantId: string,
  statementLineId: string,
  journalLineIds: string[],
  userId?: string,
): Promise<StatementLineSummary> {
  const unique = [...new Set(journalLineIds)];
  if (unique.length !== journalLineIds.length) {
    throw AppError.badRequest('Duplicate journal line ids in the group.');
  }
  return await db.transaction(async (tx) => {
    const { line, recon } = await lockLineAndReconciliation(tx, tenantId, statementLineId);
    if (line.matchStatus === 'confirmed' || line.matchStatus === 'auto') {
      throw AppError.conflict('This statement line is already matched. Un-clear it from the worksheet first.', 'STATEMENT_LINE_ALREADY_MATCHED');
    }

    const rows = await loadGroupWorksheetRows(tx, tenantId, recon.id, journalLineIds);
    await assertJournalLinesUnclaimed(tx, tenantId, journalLineIds, statementLineId);

    // Orientation + EXACT sum to the cent.
    const lineCents = toCents(line.amount);
    const sign = Math.sign(lineCents);
    let sumCents = 0;
    for (const r of rows) {
      const cents = toCents(r.debit) - toCents(r.credit);
      if (cents === 0 || Math.sign(cents) !== sign) {
        throw AppError.conflict('All grouped transactions must be in the same direction as the statement line.', 'GROUP_ORIENTATION_MISMATCH');
      }
      sumCents += cents;
    }
    if (sumCents !== lineCents) {
      throw AppError.conflict(
        `The selected transactions sum to $${(sumCents / 100).toFixed(2)} but the statement line is $${(lineCents / 100).toFixed(2)} — a grouped match must sum exactly.`,
        'GROUP_SUM_MISMATCH',
      );
    }

    const recLineIds = sql.join(rows.map((r) => sql`${r.rec_line_id}::uuid`), sql`, `);
    await tx.execute(sql`
      UPDATE reconciliation_lines SET is_cleared = true, cleared_at = now()
      WHERE id IN (${recLineIds}) AND is_cleared = false
    `);

    const breakdown: PersistedBreakdown = {
      tier: 'confirmed',
      candidates: [],
      group: { kind: 'one_to_many', journalLineIds },
    };
    await tx.execute(sql`
      UPDATE bank_statement_lines
      SET match_status = 'confirmed', matched_journal_line_id = ${journalLineIds[0]!}::uuid,
          match_score = NULL, score_breakdown = ${JSON.stringify(breakdown)}::jsonb, updated_at = now()
      WHERE id = ${statementLineId} AND tenant_id = ${tenantId}
    `);

    await auditLog(
      tenantId, 'update', 'bank_statement_line', statementLineId,
      { matchStatus: line.matchStatus, matchedJournalLineId: line.matchedJournalLineId },
      { matchStatus: 'confirmed', group: { kind: 'one_to_many', journalLineIds } },
      userId, tx,
    );

    return { ...summaryOf(line), matchStatus: 'confirmed' };
  });
}

/**
 * A2 confirm: 2..5 statement lines ↔ one worksheet journal line, confirmed
 * from the primary statement line. Clears the single worksheet line and
 * marks EVERY member statement line 'confirmed' (primary carries
 * matched_journal_line_id + the member set; members carry a back-pointer).
 */
export async function confirmStatementLineManyToOne(
  tenantId: string,
  statementLineId: string,
  journalLineId: string,
  memberStatementLineIds: string[],
  userId?: string,
): Promise<StatementLineSummary> {
  const unique = [...new Set(memberStatementLineIds)];
  if (unique.length !== memberStatementLineIds.length || unique.includes(statementLineId)) {
    throw AppError.badRequest('Member statement lines must be distinct and different from the primary line.');
  }
  return await db.transaction(async (tx) => {
    const { line, recon } = await lockLineAndReconciliation(tx, tenantId, statementLineId);
    if (line.matchStatus === 'confirmed' || line.matchStatus === 'auto') {
      throw AppError.conflict('This statement line is already matched. Un-clear it from the worksheet first.', 'STATEMENT_LINE_ALREADY_MATCHED');
    }

    // Members: same statement, locked, and not already resolved.
    const memberList = sql.join(unique.map((id) => sql`${id}::uuid`), sql`, `);
    const memberRes = await tx.execute(sql`
      SELECT * FROM bank_statement_lines
      WHERE tenant_id = ${tenantId} AND id IN (${memberList}) AND statement_id = ${line.statementId}
      FOR UPDATE
    `);
    interface RawMember { id: string; amount: string; match_status: string; line_date: string; description: string | null; check_number: string | null; payee: string | null }
    const members = memberRes.rows as unknown as RawMember[];
    if (members.length !== unique.length) {
      throw AppError.badRequest('One or more member statement lines were not found on this statement.');
    }
    const resolved = members.filter((m) => m.match_status === 'confirmed' || m.match_status === 'auto');
    if (resolved.length > 0) {
      throw AppError.conflict('One or more member statement lines is already matched.', 'STATEMENT_LINE_ALREADY_MATCHED');
    }

    const [row] = await loadGroupWorksheetRows(tx, tenantId, recon.id, [journalLineId]);
    await assertJournalLinesUnclaimed(tx, tenantId, [journalLineId], statementLineId);

    // Orientation + EXACT sum: primary + members must equal the worksheet
    // line to the cent.
    const jlCents = toCents(row!.debit) - toCents(row!.credit);
    const sign = Math.sign(jlCents);
    let sumCents = 0;
    for (const amt of [line.amount, ...members.map((m) => m.amount)]) {
      const cents = toCents(amt);
      if (cents === 0 || Math.sign(cents) !== sign) {
        throw AppError.conflict('All statement lines in the group must be in the same direction as the transaction.', 'GROUP_ORIENTATION_MISMATCH');
      }
      sumCents += cents;
    }
    if (sumCents !== jlCents) {
      throw AppError.conflict(
        `The statement lines sum to $${(sumCents / 100).toFixed(2)} but the transaction is $${(jlCents / 100).toFixed(2)} — a grouped match must sum exactly.`,
        'GROUP_SUM_MISMATCH',
      );
    }

    await tx.execute(sql`
      UPDATE reconciliation_lines SET is_cleared = true, cleared_at = now()
      WHERE id = ${row!.rec_line_id} AND is_cleared = false
    `);

    const statementLineIds = [statementLineId, ...unique];
    const primaryBreakdown: PersistedBreakdown = {
      tier: 'confirmed',
      candidates: [],
      group: { kind: 'many_to_one', journalLineIds: [journalLineId], statementLineIds },
    };
    await tx.execute(sql`
      UPDATE bank_statement_lines
      SET match_status = 'confirmed', matched_journal_line_id = ${journalLineId}::uuid,
          match_score = NULL, score_breakdown = ${JSON.stringify(primaryBreakdown)}::jsonb, updated_at = now()
      WHERE id = ${statementLineId} AND tenant_id = ${tenantId}
    `);
    const memberBreakdown: PersistedBreakdown = {
      tier: 'confirmed',
      candidates: [],
      group: { kind: 'many_to_one_member', journalLineIds: [journalLineId], primaryStatementLineId: statementLineId },
    };
    await tx.execute(sql`
      UPDATE bank_statement_lines
      SET match_status = 'confirmed', matched_journal_line_id = NULL,
          match_score = NULL, score_breakdown = ${JSON.stringify(memberBreakdown)}::jsonb, updated_at = now()
      WHERE tenant_id = ${tenantId} AND id IN (${memberList})
    `);

    await auditLog(
      tenantId, 'update', 'bank_statement_line', statementLineId,
      { matchStatus: line.matchStatus, matchedJournalLineId: line.matchedJournalLineId },
      { matchStatus: 'confirmed', group: { kind: 'many_to_one', journalLineId, statementLineIds } },
      userId, tx,
    );

    return { ...summaryOf(line), matchStatus: 'confirmed' };
  });
}

// ─── Wave 2 Feature B: create a transaction from a statement line ──

export interface CreateFromStatementLineInput {
  accountId: string;
  contactId?: string;
  memo?: string;
}

/**
 * "Add to books": post a balanced transaction for an unmatched statement
 * line through the standard ledger path (lock-date + tenant/company scoping
 * enforced by ledger.postTransaction — never bypassed), then clear it on
 * the in-progress worksheet and confirm the statement line.
 *
 * Orientation mirrors bank-feed categorize: statement money-in (positive)
 * posts a deposit (bank debit + category credit); money-out posts an
 * expense (category debit + bank credit). Check number and payee carry
 * over onto the transaction like write-check / bank-feed categorize.
 */
export async function createTransactionFromStatementLine(
  tenantId: string,
  statementLineId: string,
  input: CreateFromStatementLineInput,
  userId?: string,
  companyId?: string,
): Promise<{ line: StatementLineSummary; transactionId: string }> {
  return await db.transaction(async (tx) => {
    const { line, recon } = await lockLineAndReconciliation(tx, tenantId, statementLineId);
    if (line.matchStatus === 'confirmed' || line.matchStatus === 'auto') {
      throw AppError.conflict('This statement line is already matched to a transaction.', 'STATEMENT_LINE_ALREADY_MATCHED');
    }
    const cents = toCents(line.amount);
    if (cents === 0) throw AppError.badRequest('This statement line has a zero amount — nothing to post.');
    if (input.accountId === recon.accountId) {
      throw AppError.badRequest('Choose an income or expense category account — not the bank account being reconciled.');
    }
    // Worksheet invariant: start() only pulls journal lines dated on or
    // before the statement date. A statement line dated AFTER it is parser
    // noise (or the wrong statement) — posting it would force-clear a
    // transaction the worksheet could never legitimately contain.
    if (line.lineDate > recon.statementDate) {
      throw AppError.badRequest(
        `This statement line is dated ${line.lineDate} — after the statement date ${recon.statementDate}. ` +
        'Check the parsed date; a transaction outside the statement period cannot be added to this reconciliation.',
      );
    }

    const isMoneyIn = cents > 0;
    const amount = (Math.abs(cents) / 100).toFixed(4);
    const bankLine = {
      accountId: recon.accountId,
      debit: isMoneyIn ? amount : '0',
      credit: isMoneyIn ? '0' : amount,
    };
    const categoryLine = {
      accountId: input.accountId,
      debit: isMoneyIn ? '0' : amount,
      credit: isMoneyIn ? amount : '0',
      description: line.description ?? undefined,
    };

    // Same posting machinery as bank-feed categorize (rule 22: the ledger
    // service enforces balance; checkLockDate runs inside postTransaction).
    const txn = await ledger.postTransaction(tenantId, {
      txnType: isMoneyIn ? 'deposit' : 'expense',
      txnDate: line.lineDate,
      contactId: input.contactId,
      memo: input.memo || line.description || undefined,
      total: amount,
      source: 'statement_line',
      sourceId: line.id,
      lines: isMoneyIn ? [bankLine, categoryLine] : [categoryLine, bankLine],
    }, userId, companyId, tx);

    // Carry the parsed check number + payee onto the transaction (mirrors
    // bank-feed categorize / write-check). Metadata only.
    const checkNumber = line.checkNumber != null ? Number.parseInt(line.checkNumber, 10) : null;
    if ((checkNumber != null && Number.isFinite(checkNumber)) || line.payee) {
      await tx.update(transactions).set({
        checkNumber: checkNumber != null && Number.isFinite(checkNumber) ? checkNumber : undefined,
        payeeNameOnCheck: line.payee ?? undefined,
      }).where(and(eq(transactions.tenantId, tenantId), eq(transactions.id, txn.id)));
    }

    const bankJl = txn.lines.find((l) => l.accountId === recon.accountId);
    if (!bankJl) throw AppError.internal('Posted transaction is missing its bank journal line');

    // The worksheet was loaded when the reconciliation started, before this
    // transaction existed — insert (or clear) its reconciliation_line so it
    // shows up cleared mid-session.
    const existingRl = await tx.select().from(reconciliationLines)
      .where(and(
        eq(reconciliationLines.reconciliationId, recon.id),
        eq(reconciliationLines.journalLineId, bankJl.id),
      ))
      .limit(1);
    if (existingRl.length > 0) {
      await tx.update(reconciliationLines)
        .set({ isCleared: true, clearedAt: new Date() })
        .where(eq(reconciliationLines.id, existingRl[0]!.id));
    } else {
      await tx.insert(reconciliationLines).values({
        reconciliationId: recon.id,
        journalLineId: bankJl.id,
        isCleared: true,
        clearedAt: new Date(),
      });
    }

    // No `group`: the single created journal line is linked directly via
    // matched_journal_line_id, so the wave-1 un-clear hook already covers it.
    const breakdown: PersistedBreakdown = {
      tier: 'confirmed',
      candidates: [],
      createdTransactionId: txn.id,
    };
    await tx.execute(sql`
      UPDATE bank_statement_lines
      SET match_status = 'confirmed', matched_journal_line_id = ${bankJl.id}::uuid,
          match_score = NULL, score_breakdown = ${JSON.stringify(breakdown)}::jsonb, updated_at = now()
      WHERE id = ${statementLineId} AND tenant_id = ${tenantId}
    `);

    await auditLog(
      tenantId, 'update', 'bank_statement_line', statementLineId,
      { matchStatus: line.matchStatus, matchedJournalLineId: line.matchedJournalLineId },
      { matchStatus: 'confirmed', matchedJournalLineId: bankJl.id, createdTransactionId: txn.id },
      userId, tx,
    );

    return { line: { ...summaryOf(line), matchStatus: 'confirmed' }, transactionId: txn.id };
  });
}

// Exposed for unit tests.
export const _internal = { scoreCandidates, statementDateScore, dayDiff, toCents, findExactSumSets, buildGroupPool, sortSumPool };
