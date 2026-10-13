// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

// Bank reconciliation proof — the standard professional bank-to-books
// reconciliation ("proof of cash to the GL") for one reconciliation as of its
// statement date D. Used by the Reconcile screen (live, while clearing), the
// Reconciliation Detail / Summary reports (screen, PDF, CSV) and the Report
// Pack's Bank Reconciliations section, so all of them show the same figures.
//
// Everything is computed in GL orientation (Σ debit − credit, the same
// convention reconciliations.statement_ending_balance / beginning_balance are
// stored in — liability statement balances are flipped on entry) and converted
// to the account's natural orientation (×−1 for liabilities) once at the end.
//
// Definitions (GL orientation, account A, statement date D):
//   B   book balance  = Σ posted lines on A dated ≤ D (cleared or not — the
//                       same rows the balance sheet sums; void txns excluded)
//   S   statement ending balance (stored)
//   beg beginning balance (stored: prior reconciliation's ending balance)
//   clr Σ lines cleared on THIS reconciliation (as the worksheet sums them)
//   O   outstanding = posted lines on A dated ≤ D NOT cleared on this
//       reconciliation or on any completed reconciliation dated before D
//       (lines cleared by a LATER reconciliation were still outstanding at D)
//   U   statement lines (in-progress, statement-driven) that pair with no
//       book line — interest, fees, NSF the books don't have yet
// Section A:  adjusted statement = S + O ;  adjusted books = B + U
//             unreconciled = (S + O) − (B + U) = (S − beg − clr) − U − disc
// Section D:  disc = B − (beg + clr + O), decomposed into
//   changes to prior-reconciled lines (cleared-now vs cleared-at-completion),
//   prior-reconciled lines now dated after D, lines cleared here that are dated
//   after D / voided / moved, and the residual beginning-balance variance.
//
// reconciliation_lines holds one row PER reconciliation a line appeared on
// (an item outstanding for months has one per month), so every "is it
// cleared?" test below goes through a DISTINCT journal_line_id set — never a
// direct join that would fan the amount out.

import { sql } from 'drizzle-orm';
import DecimalLib from 'decimal.js';
import {
  RECON_PROOF_TOLERANCE,
  reconAgeDays,
  reconItemFlag,
  reconLabels,
  type ReconDiscrepancyItem,
  type ReconDiscrepancyReason,
  type ReconOrientation,
  type ReconPriorChange,
  type ReconProof,
  type ReconScheduleItem,
  type ReconUnrecordedItem,
} from '@kis-books/shared';
import { db } from '../db/index.js';
import { AppError } from '../utils/errors.js';

const Decimal = DecimalLib.default || DecimalLib;
type Dec = InstanceType<typeof Decimal>;

const MAX_DISCREPANCY_ITEMS = 500;

function d(v: unknown): Dec {
  if (v === null || v === undefined || v === '') return new Decimal(0);
  return new Decimal(String(v));
}
function n2(v: Dec): number {
  return Number(v.toFixed(2));
}
function isZero(v: Dec): boolean {
  return v.abs().lessThan(RECON_PROOF_TOLERANCE);
}
function fmt(v: Dec): string {
  const x = Number(v.toFixed(2));
  const s = Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return x < 0 ? `(${s})` : s;
}
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
function isoOf(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

interface LineRow {
  journal_line_id: string;
  is_cleared?: boolean | null;
  debit: string;
  credit: string;
  account_id: string;
  description: string | null;
  transaction_id: string;
  status: string;
  txn_date: string;
  txn_type: string;
  txn_number: string | null;
  check_number: number | string | null;
  memo: string | null;
  payee: string | null;
}

function numberOf(r: { check_number: number | string | null; txn_number: string | null }): string | null {
  return r.check_number != null && String(r.check_number) !== '' ? String(r.check_number) : (r.txn_number ?? null);
}

export interface ReconciliationProofOptions {
  /** Override "today" (tests). Defaults to the current UTC date. */
  today?: string;
}

export async function buildReconciliationProof(
  tenantId: string,
  reconciliationId: string,
  opts: ReconciliationProofOptions = {},
): Promise<ReconProof> {
  const today = opts.today ?? todayIso();

  // ── Header ──────────────────────────────────────────────────────
  const recRes = await db.execute(sql`
    SELECT r.id, r.account_id, r.statement_date::text AS statement_date, r.beginning_balance,
      r.statement_ending_balance, r.status, r.completed_at,
      a.name AS account_name, a.account_number, a.account_type,
      u.display_name AS completed_by_name, u.email AS completed_by_email
    FROM reconciliations r
    JOIN accounts a ON a.id = r.account_id AND a.tenant_id = r.tenant_id
    LEFT JOIN users u ON u.id = r.completed_by
    WHERE r.tenant_id = ${tenantId} AND r.id = ${reconciliationId}
    LIMIT 1
  `);
  const rec = recRes.rows[0] as Record<string, unknown> | undefined;
  if (!rec) throw AppError.notFound('Reconciliation not found');

  const accountId = String(rec['account_id']);
  const D = String(rec['statement_date']);
  const accountType = String(rec['account_type']);
  const orientation: ReconOrientation = accountType === 'liability' ? 'liability' : 'asset';
  const sign = orientation === 'liability' ? -1 : 1;
  const nat = (v: Dec) => v.times(sign);
  const status = String(rec['status']);
  const isComplete = status === 'complete';
  const beg = d(rec['beginning_balance']);
  const S = d(rec['statement_ending_balance']);
  const labels = reconLabels(orientation);

  const stmtRes = await db.execute(sql`
    SELECT bs.id, bs.period_start::text AS period_start, bs.period_end::text AS period_end,
      bs.attachment_id, att.file_name
    FROM bank_statements bs
    LEFT JOIN attachments att ON att.id = bs.attachment_id AND att.tenant_id = bs.tenant_id
    WHERE bs.tenant_id = ${tenantId} AND bs.reconciliation_id = ${reconciliationId}
    LIMIT 1
  `);
  const stmt = stmtRes.rows[0] as Record<string, unknown> | undefined;

  // ── B: balance per books at D (every posted line, cleared or not) ──
  const bRes = await db.execute(sql`
    SELECT COALESCE(SUM(jl.debit - jl.credit), 0) AS bal
    FROM journal_lines jl
    JOIN transactions t ON t.id = jl.transaction_id AND t.tenant_id = jl.tenant_id
    WHERE jl.tenant_id = ${tenantId} AND jl.account_id = ${accountId}
      AND t.status = 'posted' AND t.txn_date <= ${D}
  `);
  const B = d((bRes.rows[0] as { bal: string } | undefined)?.bal);

  // ── Prior completed reconciliations (dated before D) ─────────────
  // cleared_now sums each prior rec's cleared lines from TODAY's ledger
  // (only lines still posted on this account count); the stored
  // cleared_balance − beginning_balance is what it cleared at completion.
  const priorRes = await db.execute(sql`
    SELECT r.id, r.statement_date::text AS statement_date, r.beginning_balance, r.cleared_balance,
      r.statement_ending_balance, r.completed_at,
      COALESCE(SUM(CASE WHEN jl.account_id = ${accountId} AND t.status = 'posted'
        THEN jl.debit - jl.credit ELSE 0 END), 0) AS cleared_now
    FROM reconciliations r
    LEFT JOIN reconciliation_lines rl ON rl.reconciliation_id = r.id AND rl.is_cleared = true
    LEFT JOIN journal_lines jl ON jl.id = rl.journal_line_id AND jl.tenant_id = ${tenantId}
    LEFT JOIN transactions t ON t.id = jl.transaction_id AND t.tenant_id = ${tenantId}
    WHERE r.tenant_id = ${tenantId} AND r.account_id = ${accountId} AND r.status = 'complete'
      AND r.statement_date < ${D} AND r.id <> ${reconciliationId}
    GROUP BY r.id
    ORDER BY r.statement_date
  `);
  const priorRows = priorRes.rows as Array<{
    id: string; statement_date: string; beginning_balance: string; cleared_balance: string | null;
    statement_ending_balance: string; completed_at: Date | null; cleared_now: string;
  }>;
  const priorChanges: ReconPriorChange[] = [];
  let changesGl = new Decimal(0);
  const changedRecIds = new Set<string>();
  for (const p of priorRows) {
    const atCompletion = (p.cleared_balance != null ? d(p.cleared_balance) : d(p.statement_ending_balance)).minus(d(p.beginning_balance));
    const now = d(p.cleared_now);
    const change = now.minus(atCompletion);
    changesGl = changesGl.plus(change);
    if (!isZero(change)) changedRecIds.add(p.id);
    priorChanges.push({
      reconciliationId: p.id,
      statementDate: p.statement_date,
      clearedAtCompletion: n2(nat(atCompletion)),
      clearedNow: n2(nat(now)),
      change: n2(nat(change)),
    });
  }

  // Distinct prior-cleared lines (current amounts), split at D.
  const pcRes = await db.execute(sql`
    SELECT
      COALESCE(SUM(CASE WHEN t.txn_date <= ${D} THEN jl.debit - jl.credit ELSE 0 END), 0) AS le,
      COALESCE(SUM(CASE WHEN t.txn_date > ${D} THEN jl.debit - jl.credit ELSE 0 END), 0) AS gt
    FROM journal_lines jl
    JOIN transactions t ON t.id = jl.transaction_id AND t.tenant_id = jl.tenant_id
    WHERE jl.tenant_id = ${tenantId} AND jl.account_id = ${accountId} AND t.status = 'posted'
      AND jl.id IN (
        SELECT DISTINCT rl.journal_line_id FROM reconciliation_lines rl
        JOIN reconciliations r ON r.id = rl.reconciliation_id
        WHERE r.tenant_id = ${tenantId} AND r.account_id = ${accountId} AND r.status = 'complete'
          AND r.statement_date < ${D} AND r.id <> ${reconciliationId} AND rl.is_cleared = true
      )
  `);
  const pcGt = d((pcRes.rows[0] as { gt: string } | undefined)?.gt);

  // ── This reconciliation's worksheet ──────────────────────────────
  const wsRes = await db.execute(sql`
    SELECT rl.journal_line_id, rl.is_cleared, jl.debit, jl.credit, jl.account_id, jl.description,
      t.id AS transaction_id, t.status, t.txn_date::text AS txn_date, t.txn_type, t.txn_number,
      t.check_number, t.memo, COALESCE(c.display_name, t.payee_name_on_check) AS payee
    FROM reconciliation_lines rl
    JOIN journal_lines jl ON jl.id = rl.journal_line_id
    JOIN transactions t ON t.id = jl.transaction_id
    LEFT JOIN contacts c ON c.id = t.contact_id AND c.tenant_id = t.tenant_id
    WHERE rl.reconciliation_id = ${reconciliationId}
    ORDER BY t.txn_date, t.created_at, jl.id
  `);
  const wsRows = wsRes.rows as unknown as LineRow[];
  let clr = new Decimal(0);
  let tcOut = new Decimal(0);
  let clearedInc = new Decimal(0); let clearedIncCount = 0;
  let clearedDec = new Decimal(0); let clearedDecCount = 0;
  const items: ReconDiscrepancyItem[] = [];
  for (const r of wsRows) {
    if (!r.is_cleared) continue;
    const amt = d(r.debit).minus(d(r.credit));
    clr = clr.plus(amt);
    const n = nat(amt);
    if (n.greaterThanOrEqualTo(0)) { clearedInc = clearedInc.plus(n); clearedIncCount += 1; }
    else { clearedDec = clearedDec.plus(n.abs()); clearedDecCount += 1; }
    const reasons: ReconDiscrepancyReason[] = [];
    if (r.status !== 'posted') reasons.push('voided');
    if (r.account_id !== accountId) reasons.push('moved_account');
    if (r.txn_date > D) reasons.push('dated_after_statement');
    if (reasons.length > 0) {
      tcOut = tcOut.plus(amt);
      items.push({
        reconciliationId, reconciliationDate: D, thisReconciliation: true,
        journalLineId: r.journal_line_id, transactionId: r.transaction_id,
        txnDate: r.txn_date, txnType: r.txn_type, number: numberOf(r),
        description: r.description || r.memo || r.payee || null,
        currentAmount: n2(n), reasons, editedAt: null,
      });
    }
  }
  const clearedBalance = beg.plus(clr);

  // ── O: outstanding as of D ───────────────────────────────────────
  const oRes = await db.execute(sql`
    SELECT jl.id AS journal_line_id, jl.debit, jl.credit, jl.account_id, jl.description,
      t.id AS transaction_id, t.status, t.txn_date::text AS txn_date, t.txn_type, t.txn_number,
      t.check_number, t.memo, COALESCE(c.display_name, t.payee_name_on_check) AS payee
    FROM journal_lines jl
    JOIN transactions t ON t.id = jl.transaction_id AND t.tenant_id = jl.tenant_id
    LEFT JOIN contacts c ON c.id = t.contact_id AND c.tenant_id = t.tenant_id
    WHERE jl.tenant_id = ${tenantId} AND jl.account_id = ${accountId}
      AND t.status = 'posted' AND t.txn_date <= ${D}
      AND jl.id NOT IN (
        SELECT DISTINCT rl.journal_line_id FROM reconciliation_lines rl
        JOIN reconciliations r ON r.id = rl.reconciliation_id
        WHERE r.tenant_id = ${tenantId} AND r.account_id = ${accountId} AND rl.is_cleared = true
          AND (r.id = ${reconciliationId}
            OR (r.status = 'complete' AND r.statement_date < ${D} AND r.id <> ${reconciliationId}))
      )
    ORDER BY t.txn_date, t.created_at, jl.id
  `);
  const oRows = oRes.rows as unknown as LineRow[];
  let O = new Decimal(0);
  const incItems: ReconScheduleItem[] = [];
  const decItems: ReconScheduleItem[] = [];
  let incTotal = new Decimal(0);
  let decTotal = new Decimal(0);
  const flagCounts = { stale: 0, staleDated: 0, investigate: 0 };
  for (const r of oRows) {
    const amt = d(r.debit).minus(d(r.credit));
    O = O.plus(amt);
    const n = nat(amt);
    if (n.isZero()) continue;
    const side = n.greaterThan(0) ? 'increase' : 'decrease';
    const ageDays = Math.max(0, reconAgeDays(r.txn_date, D));
    const f = reconItemFlag(orientation, side, ageDays);
    if (f.flag === 'stale') flagCounts.stale += 1;
    else if (f.flag === 'stale_dated') flagCounts.staleDated += 1;
    else if (f.flag === 'investigate') flagCounts.investigate += 1;
    const item: ReconScheduleItem = {
      journalLineId: r.journal_line_id,
      transactionId: r.transaction_id,
      txnDate: r.txn_date,
      txnType: r.txn_type,
      number: numberOf(r),
      payee: r.payee ?? null,
      description: r.description || r.memo || null,
      amount: n2(n.abs()),
      ageDays,
      flag: f.flag,
      flagLabel: f.label,
    };
    if (side === 'increase') { incItems.push(item); incTotal = incTotal.plus(n); }
    else { decItems.push(item); decTotal = decTotal.plus(n.abs()); }
  }

  // ── U: statement items with no book transaction (in-progress only) ──
  let unrecorded: ReconUnrecordedItem[] = [];
  let unrecordedAvailable = false;
  let unrecordedNote: string | null = null;
  let U = new Decimal(0);
  if (isComplete) {
    unrecordedNote = 'Not applicable: a completed reconciliation’s cleared balance equals the statement balance, so every statement item is recorded in the books.';
  } else if (!stmt) {
    unrecordedNote = 'No bank statement is linked to this reconciliation, so unrecorded bank items cannot be listed; any such items show up in the cleared-balance difference.';
  } else {
    const slRes = await db.execute(sql`
      SELECT id, line_date::text AS line_date, description, check_number, amount, match_status, matched_journal_line_id
      FROM bank_statement_lines
      WHERE tenant_id = ${tenantId} AND statement_id = ${String(stmt['id'])}
      ORDER BY line_date, id
    `);
    const sl = slRes.rows as Array<{
      id: string; line_date: string; description: string | null; check_number: string | null;
      amount: string; match_status: string; matched_journal_line_id: string | null;
    }>;
    if (sl.length === 0) {
      unrecordedNote = 'The linked statement has no stored statement lines, so unrecorded bank items cannot be listed; any such items show up in the cleared-balance difference.';
    } else {
      unrecordedAvailable = true;
      // Pool of book lines a statement line could correspond to: this
      // worksheet's lines plus anything outstanding at D, minus lines a
      // statement line is already matched to.
      const claimed = new Set(sl.filter((l) => (l.match_status === 'auto' || l.match_status === 'confirmed') && l.matched_journal_line_id)
        .map((l) => l.matched_journal_line_id!));
      const pool = new Map<string, { cents: number; date: string }>();
      for (const r of [...wsRows, ...oRows]) {
        if (claimed.has(r.journal_line_id)) continue;
        pool.set(r.journal_line_id, { cents: Math.round(d(r.debit).minus(d(r.credit)).times(100).toNumber()), date: r.txn_date });
      }
      for (const l of sl) {
        if (l.match_status === 'auto' || l.match_status === 'confirmed') continue;
        const cents = Math.round(d(l.amount).times(100).toNumber());
        let best: string | null = null;
        let bestGap = Infinity;
        for (const [id, p] of pool) {
          if (p.cents !== cents) continue;
          const gap = Math.abs(reconAgeDays(p.date, l.line_date));
          if (gap < bestGap) { best = id; bestGap = gap; }
        }
        if (best) { pool.delete(best); continue; }
        U = U.plus(d(l.amount));
        unrecorded.push({
          statementLineId: l.id,
          lineDate: l.line_date,
          description: l.description,
          checkNumber: l.check_number,
          amount: n2(nat(d(l.amount))),
        });
      }
    }
  }
  if (!unrecordedAvailable) unrecorded = [];

  // ── Book-side proof (Section D) ───────────────────────────────────
  const expected = beg.plus(clr).plus(O);
  const disc = B.minus(expected);
  const compChanges = changesGl;
  const compPriorAfter = pcGt.negated();
  const compClearedOut = tcOut.negated();
  const compBeginning = disc.minus(compChanges).minus(compPriorAfter).minus(compClearedOut);

  // Itemize prior-reconciled lines that changed. Hard evidence (deleted,
  // voided, moved, re-dated) always lists; an audit-log edit alone lists only
  // for a reconciliation whose cleared total actually moved — recategorizing
  // the income/expense side of a reconciled transaction is allowed and
  // doesn't touch the reconciled line.
  const discRes = await db.execute(sql`
    SELECT r.id AS rec_id, r.statement_date::text AS rec_date, rl.journal_line_id,
      jl.id AS jl_id, jl.account_id, jl.debit, jl.credit, jl.description,
      t.id AS transaction_id, t.status, t.txn_date::text AS txn_date, t.txn_type, t.txn_number,
      t.check_number, t.memo, ed.edited_at
    FROM reconciliation_lines rl
    JOIN reconciliations r ON r.id = rl.reconciliation_id
    LEFT JOIN journal_lines jl ON jl.id = rl.journal_line_id AND jl.tenant_id = ${tenantId}
    LEFT JOIN transactions t ON t.id = jl.transaction_id AND t.tenant_id = ${tenantId}
    LEFT JOIN LATERAL (
      SELECT max(al.created_at) AS edited_at FROM audit_log al
      WHERE al.tenant_id = ${tenantId} AND al.entity_type = 'transaction' AND al.entity_id = t.id
        AND al.action IN ('update', 'void', 'delete')
        AND r.completed_at IS NOT NULL AND al.created_at > r.completed_at
    ) ed ON true
    WHERE r.tenant_id = ${tenantId} AND r.account_id = ${accountId} AND r.status = 'complete'
      AND r.statement_date < ${D} AND r.id <> ${reconciliationId} AND rl.is_cleared = true
      AND (jl.id IS NULL OR t.id IS NULL OR t.status <> 'posted' OR jl.account_id <> ${accountId}
        OR t.txn_date > r.statement_date OR ed.edited_at IS NOT NULL)
    ORDER BY r.statement_date, t.txn_date NULLS FIRST
    LIMIT ${MAX_DISCREPANCY_ITEMS}
  `);
  for (const r of discRes.rows as Array<Record<string, unknown>>) {
    const reasons: ReconDiscrepancyReason[] = [];
    const exists = r['jl_id'] != null && r['transaction_id'] != null;
    if (!exists) reasons.push('deleted');
    else {
      if (r['status'] !== 'posted') reasons.push('voided');
      if (r['account_id'] !== accountId) reasons.push('moved_account');
      const td = String(r['txn_date']);
      if (td > String(r['rec_date'])) reasons.push('redated_after_reconciliation');
      if (td > D) reasons.push('dated_after_statement');
    }
    const editedAt = isoOf(r['edited_at']);
    if (reasons.length === 0) {
      if (!editedAt || !changedRecIds.has(String(r['rec_id']))) continue;
    }
    if (editedAt) reasons.push('edited_after_reconciliation');
    items.push({
      reconciliationId: String(r['rec_id']),
      reconciliationDate: String(r['rec_date']),
      thisReconciliation: false,
      journalLineId: String(r['journal_line_id']),
      transactionId: exists ? String(r['transaction_id']) : null,
      txnDate: exists ? String(r['txn_date']) : null,
      txnType: exists ? String(r['txn_type']) : null,
      number: exists ? numberOf({ check_number: r['check_number'] as number | null, txn_number: r['txn_number'] as string | null }) : null,
      description: exists ? ((r['description'] as string | null) || (r['memo'] as string | null) || null) : null,
      currentAmount: exists && r['status'] === 'posted' && r['account_id'] === accountId
        ? n2(nat(d(r['debit']).minus(d(r['credit'])))) : null,
      reasons,
      editedAt,
    });
  }

  const bookExplanations: string[] = [];
  const DD = D;
  if (!isZero(compChanges)) {
    bookExplanations.push(`Previously reconciled transactions were changed, voided or deleted after they were reconciled (net ${fmt(nat(compChanges))}). Review the items listed; restore the original entries, or undo and redo the affected reconciliation.`);
  }
  if (!isZero(compPriorAfter)) {
    bookExplanations.push(`Previously reconciled items are now dated after ${DD} (net ${fmt(nat(compPriorAfter))}) — they were re-dated after being reconciled.`);
  }
  if (!isZero(compClearedOut)) {
    bookExplanations.push(`Items cleared on this reconciliation are dated after ${DD}, voided or moved to another account (net ${fmt(nat(compClearedOut))}).`);
  }
  if (!isZero(compBeginning)) {
    bookExplanations.push(`The beginning balance (${fmt(nat(beg))}) is not supported by the prior reconciliations' cleared activity in the books (variance ${fmt(nat(compBeginning))}) — the opening balance doesn't match the books, or a prior reconciliation's balances were changed.`);
  }

  // ── Subsequent activity (Section C) ───────────────────────────────
  const subRes = await db.execute(sql`
    WITH cleared_any AS (
      SELECT DISTINCT rl.journal_line_id FROM reconciliation_lines rl
      JOIN reconciliations r ON r.id = rl.reconciliation_id
      WHERE r.tenant_id = ${tenantId} AND r.account_id = ${accountId} AND rl.is_cleared = true
        AND (r.status = 'complete' OR r.id = ${reconciliationId})
    )
    SELECT
      count(*) FILTER (WHERE t.txn_date <= ${today})::int AS after_count,
      COALESCE(SUM(jl.debit - jl.credit) FILTER (WHERE t.txn_date <= ${today}), 0) AS after_total,
      count(*) FILTER (WHERE t.txn_date <= ${today} AND ca.journal_line_id IS NULL)::int AS unc_count,
      COALESCE(SUM(jl.debit - jl.credit) FILTER (WHERE t.txn_date <= ${today} AND ca.journal_line_id IS NULL), 0) AS unc_total,
      count(*) FILTER (WHERE t.txn_date > ${today})::int AS fut_count,
      COALESCE(SUM(jl.debit - jl.credit) FILTER (WHERE t.txn_date > ${today}), 0) AS fut_total
    FROM journal_lines jl
    JOIN transactions t ON t.id = jl.transaction_id AND t.tenant_id = jl.tenant_id
    LEFT JOIN cleared_any ca ON ca.journal_line_id = jl.id
    WHERE jl.tenant_id = ${tenantId} AND jl.account_id = ${accountId}
      AND t.status = 'posted' AND t.txn_date > ${D}
  `);
  const sub = subRes.rows[0] as Record<string, unknown>;
  const afterTotal = d(sub['after_total']);
  const futTotal = d(sub['fut_total']);
  const registerToday = B.plus(afterTotal);

  // ── Section A ──────────────────────────────────────────────────────
  const Sn = nat(S);
  const adjustedStatement = Sn.plus(incTotal).minus(decTotal);
  const Bn = nat(B);
  const Un = nat(U);
  const adjustedBook = Bn.plus(Un);
  const unreconciled = adjustedStatement.minus(adjustedBook);
  const reconciledToBooks = isZero(unreconciled);
  const diffN = nat(S.minus(clearedBalance));
  const explanations: string[] = [];
  if (!reconciledToBooks) {
    const clearingGap = diffN.minus(Un);
    if (!isZero(clearingGap)) {
      explanations.push(isComplete
        ? `The cleared balance differs from the statement balance by ${fmt(diffN)}.`
        : `Clearing is not finished: the cleared balance differs from the statement balance by ${fmt(diffN)}${unrecordedAvailable && !isZero(Un) ? ` (${fmt(Un)} of it is statement items not yet recorded in the books)` : ''}. Keep clearing items (and record missing bank items) until the worksheet difference is 0.00.`);
    }
    if (!isZero(disc)) {
      explanations.push(`The books differ from the reconciled activity by ${fmt(nat(disc))} — see Reconciliation discrepancies.`);
    }
  }

  const proof: ReconProof = {
    reconciliationId,
    accountId,
    accountName: String(rec['account_name']),
    accountNumber: (rec['account_number'] as string | null) ?? null,
    accountType,
    orientation,
    status,
    statementDate: D,
    asOfToday: today,
    labels,
    summary: {
      statementBalance: n2(Sn),
      increases: { count: incItems.length, total: n2(incTotal) },
      decreases: { count: decItems.length, total: n2(decTotal) },
      adjustedStatementBalance: n2(adjustedStatement),
      bookBalance: n2(Bn),
      unrecorded: unrecordedAvailable ? { count: unrecorded.length, total: n2(Un) } : null,
      unrecordedNote,
      adjustedBookBalance: n2(adjustedBook),
      unreconciledDifference: n2(unreconciled),
      reconciledToBooks,
      explanations,
    },
    clearedRoll: {
      beginningBalance: n2(nat(beg)),
      clearedIncreases: { count: clearedIncCount, total: n2(clearedInc) },
      clearedDecreases: { count: clearedDecCount, total: n2(clearedDec) },
      clearedBalance: n2(nat(clearedBalance)),
      statementBalance: n2(Sn),
      difference: n2(diffN),
    },
    schedules: {
      increases: { label: labels.increases, count: incItems.length, total: n2(incTotal), items: incItems },
      decreases: { label: labels.decreases, count: decItems.length, total: n2(decTotal), items: decItems },
      unrecorded,
    },
    flagCounts,
    subsequent: {
      afterStatement: { count: Number(sub['after_count'] ?? 0), total: n2(nat(afterTotal)) },
      unclearedAfterStatement: { count: Number(sub['unc_count'] ?? 0), total: n2(nat(d(sub['unc_total']))) },
      registerBalanceToday: n2(nat(registerToday)),
      futureDated: { count: Number(sub['fut_count'] ?? 0), total: n2(nat(futTotal)) },
      endingRegisterBalance: n2(nat(registerToday.plus(futTotal))),
    },
    bookProof: {
      beginningBalance: n2(nat(beg)),
      clearedThisReconciliation: n2(nat(clr)),
      outstandingNet: n2(nat(O)),
      expectedBookBalance: n2(nat(expected)),
      bookBalance: n2(Bn),
      discrepancy: n2(nat(disc)),
      ties: isZero(disc),
      components: {
        changesToPriorReconciled: n2(nat(compChanges)),
        priorReconciledNowAfterStatement: n2(nat(compPriorAfter)),
        clearedOutOfPeriod: n2(nat(compClearedOut)),
        beginningBalanceVariance: n2(nat(compBeginning)),
      },
      priorChanges: priorChanges.filter((p) => Math.abs(p.change) >= RECON_PROOF_TOLERANCE),
      items,
      explanations: bookExplanations,
    },
    signOff: {
      preparedBy: isComplete
        ? ((rec['completed_by_name'] as string | null) || (rec['completed_by_email'] as string | null) || null)
        : null,
      preparedAt: isComplete ? isoOf(rec['completed_at']) : null,
      reviewedBy: null,
      reviewedAt: null,
      statementFileName: (stmt?.['file_name'] as string | null) ?? null,
      statementAttachmentId: (stmt?.['attachment_id'] as string | null) ?? null,
      statementPeriod: stmt
        ? `${stmt['period_start'] ? `${String(stmt['period_start'])} – ` : ''}${String(stmt['period_end'])}`
        : null,
    },
  };
  return proof;
}
