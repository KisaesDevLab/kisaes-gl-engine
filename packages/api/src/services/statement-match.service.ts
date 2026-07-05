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
} from '@kis-books/shared';
import { db } from '../db/index.js';
import { reconciliations, bankStatements, bankStatementLines } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import { nameSimilarityFuzzy } from '../utils/string-similarity.js';

// Either the outer db client or a transaction handle — both expose the
// query surface the engine needs.
type DbOrTx = Pick<typeof db, 'execute'>;

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

export interface StatementMatchSuggestion {
  statementLine: StatementLineSummary;
  candidates: StatementMatchCandidate[];
}

export interface StatementMatchResult {
  autoCleared: number;
  suggestions: StatementMatchSuggestion[];
  unmatchedLines: StatementLineSummary[];
  /** Uncleared worksheet lines no statement line accounts for (timing items). */
  outstandingCount: number;
  /** Statement lines skipped because they were already auto/confirmed/rejected. */
  skippedLines: number;
}

// Persisted into bank_statement_lines.score_breakdown so the UI can render
// the picker after a reload without re-running the engine.
interface PersistedBreakdown {
  tier: 'auto' | 'suggested';
  candidates: StatementMatchCandidate[];
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
  const stmtCheck = line.checkNumber != null ? Number.parseInt(line.checkNumber, 10) : null;
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
        const best = o.candidates[0]!;
        const breakdown: PersistedBreakdown = { tier: 'suggested', candidates: o.candidates.slice(0, STATEMENT_MATCH_MAX_CANDIDATES) };
        await tx.execute(sql`
          UPDATE bank_statement_lines
          SET match_status = 'suggested', matched_journal_line_id = ${best.journalLineId}::uuid,
              match_score = ${best.composite.toFixed(4)}, score_breakdown = ${JSON.stringify(breakdown)}::jsonb,
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
    for (const o of suggestOutcomes) accountedJl.add(o.candidates[0]!.journalLineId);
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
            lines: outcomes.map((o) => ({
              statementLineId: o.line.id,
              tier: o.tier,
              journalLineId: o.candidates[0]?.journalLineId ?? null,
              score: o.candidates[0]?.composite ?? null,
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
      })),
      unmatchedLines: unmatchedOutcomes.map((o) => ({
        ...summaryOf(o.line),
        matchStatus: opts.apply ? 'unmatched' : o.line.matchStatus,
      })),
      outstandingCount,
      skippedLines,
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
      suggestions.push({
        statementLine: summaryOf(line),
        candidates: Array.isArray(breakdown?.candidates) ? breakdown.candidates : [],
      });
    } else if (line.matchStatus === 'unmatched' || line.matchStatus === 'rejected') {
      unmatchedLines.push(summaryOf(line));
    }
  }

  let outstandingCount = 0;
  for (const row of worksheet) {
    if (!row.is_cleared && !accountedJl.has(row.journal_line_id)) outstandingCount += 1;
  }

  return { statementId: statement.id, counts, suggestions, unmatchedLines, outstandingCount };
}

// ─── Confirm / reject ──────────────────────────────────────────────

export async function confirmStatementLine(
  tenantId: string,
  statementLineId: string,
  journalLineId: string,
  userId?: string,
): Promise<StatementLineSummary> {
  return await db.transaction(async (tx) => {
    const [line] = await tx.select().from(bankStatementLines)
      .where(and(eq(bankStatementLines.tenantId, tenantId), eq(bankStatementLines.id, statementLineId)))
      .for('update')
      .limit(1);
    if (!line) throw AppError.notFound('Statement line not found');
    if (line.matchStatus === 'confirmed' || line.matchStatus === 'auto') {
      throw AppError.conflict('This statement line is already matched. Un-clear it from the worksheet first.', 'STATEMENT_LINE_ALREADY_MATCHED');
    }

    const [statement] = await tx.select().from(bankStatements)
      .where(and(eq(bankStatements.tenantId, tenantId), eq(bankStatements.id, line.statementId)))
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

    // The journal line must be on this reconciliation's worksheet (any
    // worksheet line may be chosen explicitly, not just persisted candidates).
    const rl = await tx.execute(sql`
      SELECT rl.id, rl.is_cleared FROM reconciliation_lines rl
      WHERE rl.reconciliation_id = ${recon.id} AND rl.journal_line_id = ${journalLineId}
      LIMIT 1
    `);
    const rlRow = (rl.rows as Array<{ id: string; is_cleared: boolean }>)[0];
    if (!rlRow) throw AppError.badRequest('That transaction is not on this reconciliation worksheet.');

    // One-statement-line-per-journal-line uniqueness.
    const dup = await tx.execute(sql`
      SELECT id FROM bank_statement_lines
      WHERE tenant_id = ${tenantId} AND matched_journal_line_id = ${journalLineId}
        AND match_status IN ('auto', 'confirmed') AND id <> ${statementLineId}
      LIMIT 1
    `);
    if ((dup.rows as unknown[]).length > 0) {
      throw AppError.conflict('Another statement line is already matched to that transaction.', 'JOURNAL_LINE_ALREADY_MATCHED');
    }

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
    const [line] = await tx.select().from(bankStatementLines)
      .where(and(eq(bankStatementLines.tenantId, tenantId), eq(bankStatementLines.id, statementLineId)))
      .for('update')
      .limit(1);
    if (!line) throw AppError.notFound('Statement line not found');
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

// Exposed for unit tests.
export const _internal = { scoreCandidates, statementDateScore, dayDiff, toCents };
