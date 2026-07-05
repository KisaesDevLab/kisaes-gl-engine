// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

// Statement-driven bank reconciliation — bank_statements as first-class
// records (migration 0115).
//
// A row is captured whenever a parsed statement is imported into the bank
// feed (the parse result lives on the ocr_statement ai_jobs row), and
// backfilled from historical completed parse jobs. Statements then drive
// reconciliation: one-click start (period_end → statement date,
// closing_balance → ending balance), opening-balance continuity checks,
// readiness counts (imported items not yet posted), and auto-clearing the
// statement's items on the reconciliation worksheet.

import { eq, and, desc, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  bankStatements, bankStatementLines, bankFeedItems, bankConnections, reconciliations, accounts, aiJobs,
} from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import { log } from '../utils/logger.js';
import { parseCheckNumber } from '../utils/check-number.js';

// Subset of StatementParseResult (ai-statement-parser.service.ts) that the
// capture path reads off ai_jobs.output_data. Kept structural so old job
// payloads (missing the newer institutionName / accountTypeHint fields)
// still capture.
export interface StatementParseMetadata {
  statementPeriod?: { start?: string | null; end?: string | null } | null;
  openingBalance?: string | null;
  closingBalance?: string | null;
  accountNumberMasked?: string | null;
  institutionName?: string | null;
  accountTypeHint?: string | null;
  reconciliation?: { status?: string; deltaCents?: number } | null;
  transactions?: Array<{ date: string; description: string; amount: string; type?: string; balance?: string }>;
  // Check-image payees (STATEMENT_CHECK_PAYEE_V1) — checkNumber preserves
  // leading zeros; amount is a positive magnitude string.
  checks?: Array<{ checkNumber: string; payee: string; amount?: string }>;
}

export type BankStatement = typeof bankStatements.$inferSelect;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Parse a "1234.56"-style balance string to a decimal(19,4) literal, or null.
function toDecimalString(value: string | null | undefined): string | null {
  if (value == null) return null;
  const n = parseFloat(String(value).replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n.toFixed(4) : null;
}

// ─── Statement lines (Statement Match Engine wave 1, migration 0116) ─
//
// SIGN ORIENTATION (verified against the whole chain — keep consistent):
//   * Parse output (StatementParseResult.transactions): POSITIVE magnitude +
//     type; 'credit' = money in, 'debit' = money out/spend. Credit-card
//     charge/payment signs were already normalized to this convention by
//     mapSignedCentsToFeed at extraction time.
//   * bank_feed_items.amount: spend POSITIVE, money-in NEGATIVE
//     (importStatementItems).
//   * journal_lines on the reconciliation GL account: money in = debit > 0
//     (asset account; on a credit-card liability a payment also debits it).
//   * bank_statement_lines.amount (this table): money in POSITIVE, money out
//     NEGATIVE — so a statement line's amount equals `jl.debit - jl.credit`
//     of its matching journal line, and equals -bank_feed_items.amount.
export function signedStatementAmount(amount: string, type?: string): string | null {
  const n = Math.abs(parseFloat(String(amount).replace(/[$,]/g, '')));
  if (!Number.isFinite(n)) return null;
  return (type === 'credit' ? n : -n).toFixed(4);
}

/**
 * Insert bank_statement_lines for a captured statement from its parse
 * metadata. Idempotent per statement: a statement that already has ANY lines
 * is skipped (parse output is immutable, so partial line sets can't occur).
 * Returns the number of lines inserted.
 */
export async function insertStatementLines(
  tenantId: string,
  statementId: string,
  meta: StatementParseMetadata,
): Promise<number> {
  const txns = Array.isArray(meta.transactions) ? meta.transactions : [];
  if (txns.length === 0) return 0;

  const existing = await db.execute(sql`
    SELECT 1 FROM bank_statement_lines
    WHERE tenant_id = ${tenantId} AND statement_id = ${statementId} LIMIT 1
  `);
  if ((existing.rows as unknown[]).length > 0) return 0;

  // Check-image payees keyed by numeric check number (checkNumber strings
  // may carry leading zeros — "0042" and 42 are the same check).
  const checksByNumber = new Map<number, { checkNumber: string; payee: string }>();
  for (const c of meta.checks ?? []) {
    const n = Number.parseInt(String(c.checkNumber), 10);
    if (Number.isFinite(n) && n > 0) checksByNumber.set(n, { checkNumber: String(c.checkNumber), payee: c.payee });
  }

  const rows: Array<typeof bankStatementLines.$inferInsert> = [];
  for (const t of txns) {
    const amount = signedStatementAmount(t.amount, t.type);
    if (!amount || !t.date || !DATE_RE.test(t.date)) continue;
    const parsedCheck = parseCheckNumber(t.description);
    const checkImage = parsedCheck != null ? checksByNumber.get(parsedCheck) : undefined;
    rows.push({
      tenantId,
      statementId,
      lineDate: t.date,
      description: t.description ?? null,
      amount,
      // Prefer the check-image number (preserves leading zeros) over the
      // one parsed out of the description.
      checkNumber: checkImage?.checkNumber ?? (parsedCheck != null ? String(parsedCheck) : null),
      payee: checkImage?.payee?.slice(0, 255) ?? null,
      runningBalance: toDecimalString(t.balance),
      matchStatus: 'unmatched',
    });
  }
  if (rows.length === 0) return 0;
  await db.insert(bankStatementLines).values(rows);
  return rows.length;
}

function goldenRuleOf(meta: StatementParseMetadata): { status: string; delta: string | null } {
  const rec = meta.reconciliation;
  if (rec?.status === 'verified') return { status: 'verified', delta: '0.0000' };
  if (rec?.status === 'discrepancy') {
    const delta = typeof rec.deltaCents === 'number' ? (rec.deltaCents / 100).toFixed(4) : null;
    return { status: 'discrepancy', delta };
  }
  return { status: 'unknown', delta: null };
}

/**
 * Create the bank_statements row for a statement import. Called from the
 * /ai/parse/statement/import route once the target GL account is resolved.
 *
 * Returns null (no capture) when the parse metadata is unusable — no job,
 * no output, or the period end / closing balance the schema requires are
 * missing. Idempotent per parse job: re-importing the same job reuses the
 * existing row instead of inserting a duplicate.
 */
export async function captureStatementOnImport(
  tenantId: string,
  opts: { jobId?: string | null; accountId?: string | null; bankConnectionId?: string | null; userId?: string },
): Promise<{ statement: BankStatement; duplicateWarning?: string } | null> {
  if (!opts.jobId) return null;

  const job = await db.query.aiJobs.findFirst({
    where: and(eq(aiJobs.tenantId, tenantId), eq(aiJobs.id, opts.jobId), eq(aiJobs.jobType, 'ocr_statement')),
  });
  if (!job || !job.outputData || typeof job.outputData !== 'object') return null;

  // Idempotency: an existing row for this parse job wins (a re-import of the
  // same statement must not create a second statement record). Lines are
  // still (idempotently) ensured — statements captured before migration 0116
  // gain their lines on the next import touch.
  const existingForJob = await db.query.bankStatements.findFirst({
    where: and(eq(bankStatements.tenantId, tenantId), eq(bankStatements.aiJobId, job.id)),
  });
  if (existingForJob) {
    await insertStatementLines(tenantId, existingForJob.id, job.outputData as StatementParseMetadata);
    return { statement: existingForJob };
  }

  const meta = job.outputData as StatementParseMetadata;
  const periodEnd = meta.statementPeriod?.end && DATE_RE.test(meta.statementPeriod.end) ? meta.statementPeriod.end : null;
  const periodStart = meta.statementPeriod?.start && DATE_RE.test(meta.statementPeriod.start) ? meta.statementPeriod.start : null;
  const closingBalance = toDecimalString(meta.closingBalance);
  if (!periodEnd || closingBalance == null) return null; // schema requires both

  // Resolve the GL account: explicit accountId, or via the bank connection.
  let accountId = opts.accountId ?? null;
  if (!accountId && opts.bankConnectionId) {
    const conn = await db.query.bankConnections.findFirst({
      where: and(eq(bankConnections.tenantId, tenantId), eq(bankConnections.id, opts.bankConnectionId)),
    });
    accountId = conn?.accountId ?? null;
  }
  if (!accountId) return null;

  // Duplicate detection — same period end, or an overlapping period, on the
  // same account. Import proceeds regardless; the warning surfaces in the UI.
  const dup = await db.execute(sql`
    SELECT id, period_start, period_end FROM bank_statements
    WHERE tenant_id = ${tenantId} AND account_id = ${accountId}
      AND (
        period_end = ${periodEnd}
        OR (${periodStart}::date IS NOT NULL AND period_start IS NOT NULL
            AND period_start <= ${periodEnd} AND period_end >= ${periodStart})
      )
    LIMIT 1
  `);
  const dupRow = (dup.rows as Array<{ period_start: string | null; period_end: string }>)[0];
  const duplicateWarning = dupRow
    ? `A statement covering ${dupRow.period_start ?? '?'} – ${dupRow.period_end} is already on file for this account. ` +
      'Importing again may duplicate transactions.'
    : undefined;

  const golden = goldenRuleOf(meta);
  const [statement] = await db.insert(bankStatements).values({
    tenantId,
    accountId,
    attachmentId: job.inputId ?? null,
    aiJobId: job.id,
    periodStart,
    periodEnd,
    openingBalance: toDecimalString(meta.openingBalance),
    closingBalance,
    maskedAccountNumber: meta.accountNumberMasked?.slice(0, 50) ?? null,
    institutionName: meta.institutionName?.slice(0, 255) ?? null,
    statementType: meta.accountTypeHint?.slice(0, 30) ?? null,
    goldenRuleStatus: golden.status,
    goldenRuleDelta: golden.delta,
  }).returning();
  if (!statement) throw AppError.internal('Failed to create bank statement record');

  // Statement Match Engine wave 1: persist each parsed transaction as a
  // bank_statement_lines row (both import modes).
  await insertStatementLines(tenantId, statement.id, meta);

  await auditLog(tenantId, 'create', 'bank_statement', statement.id, null, statement, opts.userId);

  return duplicateWarning ? { statement, duplicateWarning } : { statement };
}

/**
 * Account auto-suggest for the statement upload flow: given the parse's
 * masked account number, return the account of the most recent statement on
 * file with the same masked number.
 */
export async function suggestAccountForMasked(
  tenantId: string,
  masked: string,
): Promise<{ accountId: string; accountName: string } | null> {
  const trimmed = masked.trim();
  if (!trimmed) return null;
  const rows = await db.execute(sql`
    SELECT bs.account_id, a.name
    FROM bank_statements bs
    JOIN accounts a ON a.id = bs.account_id
    WHERE bs.tenant_id = ${tenantId} AND bs.masked_account_number = ${trimmed}
    ORDER BY bs.created_at DESC
    LIMIT 1
  `);
  const row = (rows.rows as Array<{ account_id: string; name: string }>)[0];
  return row ? { accountId: row.account_id, accountName: row.name } : null;
}

export interface BankStatementListRow {
  id: string;
  accountId: string;
  accountName: string;
  accountNumber: string | null;
  attachmentId: string | null;
  fileName: string | null;
  periodStart: string | null;
  periodEnd: string;
  openingBalance: string | null;
  closingBalance: string;
  maskedAccountNumber: string | null;
  institutionName: string | null;
  statementType: string | null;
  goldenRuleStatus: string;
  goldenRuleDelta: string | null;
  reconciliationId: string | null;
  /** Derived from the linked reconciliation's status. */
  status: 'reconciled' | 'in_progress' | 'not_reconciled';
  /** Imported feed items from this statement not yet posted (pending/categorizing). */
  unpostedCount: number;
  /** True when ANY reconciliation is in progress for this account (blocks one-click start). */
  accountHasInProgress: boolean;
  /** Opening balance vs prior completed reconciliation's ending balance. */
  continuityWarning: { expected: number; actual: number; delta: number } | null;
  createdAt: Date | null;
}

export interface StatementGapInfo {
  accountId: string;
  accountName: string;
  missingMonths: string[]; // 'YYYY-MM'
}

// Calendar months ('YYYY-MM') strictly between the earliest and latest
// statement months that have no statement whose period_end falls in them.
export function missingMonthsBetween(periodEnds: string[]): string[] {
  const months = [...new Set(periodEnds.map((d) => d.slice(0, 7)))].sort();
  if (months.length < 2) return [];
  const have = new Set(months);
  const missing: string[] = [];
  const [firstY, firstM] = months[0]!.split('-').map(Number) as [number, number];
  const [lastY, lastM] = months[months.length - 1]!.split('-').map(Number) as [number, number];
  let y = firstY; let m = firstM;
  while (y < lastY || (y === lastY && m < lastM)) {
    m += 1;
    if (m > 12) { m = 1; y += 1; }
    const key = `${y}-${String(m).padStart(2, '0')}`;
    if (!have.has(key) && !(y === lastY && m === lastM)) missing.push(key);
  }
  return missing;
}

export async function listStatements(
  tenantId: string,
  opts: { accountId?: string; limit?: number; offset?: number } = {},
): Promise<{ statements: BankStatementListRow[]; total: number; gaps: StatementGapInfo[] }> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  const accountCond = opts.accountId ? sql`AND bs.account_id = ${opts.accountId}` : sql``;

  const rows = await db.execute(sql`
    SELECT bs.*, a.name AS account_name, a.account_number, a.account_type,
      att.file_name,
      r.status AS rec_status,
      (SELECT count(*)::int FROM bank_feed_items bfi
        WHERE bfi.tenant_id = ${tenantId} AND bfi.statement_id = bs.id
          AND bfi.status IN ('pending', 'categorizing')) AS unposted_count
    FROM bank_statements bs
    JOIN accounts a ON a.id = bs.account_id
    LEFT JOIN attachments att ON att.id = bs.attachment_id
    LEFT JOIN reconciliations r ON r.id = bs.reconciliation_id
    WHERE bs.tenant_id = ${tenantId} ${accountCond}
    ORDER BY bs.period_end DESC, bs.created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `);

  const totalRes = await db.execute(sql`
    SELECT count(*)::int AS count FROM bank_statements bs
    WHERE bs.tenant_id = ${tenantId} ${accountCond}
  `);
  const total = Number((totalRes.rows as Array<{ count: number }>)[0]?.count ?? 0);

  // Per-account context: which accounts have an in-progress reconciliation,
  // and the latest completed reconciliation's ending balance (continuity).
  const recCtx = await db.execute(sql`
    SELECT account_id,
      bool_or(status = 'in_progress') AS has_in_progress,
      (ARRAY_AGG(statement_ending_balance ORDER BY statement_date DESC)
        FILTER (WHERE status = 'complete'))[1] AS last_complete_ending
    FROM reconciliations
    WHERE tenant_id = ${tenantId}
    GROUP BY account_id
  `);
  const ctxByAccount = new Map<string, { hasInProgress: boolean; lastEnding: string | null }>();
  for (const r of recCtx.rows as Array<{ account_id: string; has_in_progress: boolean; last_complete_ending: string | null }>) {
    ctxByAccount.set(r.account_id, { hasInProgress: !!r.has_in_progress, lastEnding: r.last_complete_ending });
  }

  interface RawRow {
    id: string; account_id: string; account_name: string; account_number: string | null;
    account_type: string;
    attachment_id: string | null; file_name: string | null;
    period_start: string | null; period_end: string;
    opening_balance: string | null; closing_balance: string;
    masked_account_number: string | null; institution_name: string | null; statement_type: string | null;
    golden_rule_status: string; golden_rule_delta: string | null;
    reconciliation_id: string | null; rec_status: string | null;
    unposted_count: number; created_at: Date | null;
  }

  const statements: BankStatementListRow[] = (rows.rows as unknown as RawRow[]).map((r) => {
    const status: BankStatementListRow['status'] =
      r.rec_status === 'complete' ? 'reconciled'
        : r.rec_status === 'in_progress' ? 'in_progress'
          : 'not_reconciled';
    const ctx = ctxByAccount.get(r.account_id);
    // Continuity only matters for a statement that hasn't been reconciled
    // yet and only when there is a prior completed reconciliation to chain
    // from (a first-ever statement has nothing to disagree with).
    let continuityWarning: BankStatementListRow['continuityWarning'] = null;
    if (status === 'not_reconciled' && r.opening_balance != null && ctx?.lastEnding != null) {
      const expected = parseFloat(ctx.lastEnding);
      // Liability statements print balances positive-owed; the stored
      // reconciliation balances are GL-oriented (credit-normal ⇒ negative),
      // so flip the statement side before comparing — same convention as
      // reconciliation.start() / glOrientedStatementBalance.
      const printed = parseFloat(r.opening_balance);
      const actual = r.account_type === 'liability' ? -printed : printed;
      const delta = Number((actual - expected).toFixed(4));
      if (Math.abs(delta) > 0.005) continuityWarning = { expected, actual, delta };
    }
    return {
      id: r.id,
      accountId: r.account_id,
      accountName: r.account_name,
      accountNumber: r.account_number,
      attachmentId: r.attachment_id,
      fileName: r.file_name,
      periodStart: r.period_start,
      periodEnd: r.period_end,
      openingBalance: r.opening_balance,
      closingBalance: r.closing_balance,
      maskedAccountNumber: r.masked_account_number,
      institutionName: r.institution_name,
      statementType: r.statement_type,
      goldenRuleStatus: r.golden_rule_status,
      goldenRuleDelta: r.golden_rule_delta,
      reconciliationId: r.reconciliation_id,
      status,
      unpostedCount: Number(r.unposted_count ?? 0),
      accountHasInProgress: ctx?.hasInProgress ?? false,
      continuityWarning,
      createdAt: r.created_at,
    };
  });

  // Statement coverage gaps per account — computed over ALL statements of
  // each account (not just the current page).
  const gapRows = await db.execute(sql`
    SELECT bs.account_id, a.name AS account_name, bs.period_end
    FROM bank_statements bs
    JOIN accounts a ON a.id = bs.account_id
    WHERE bs.tenant_id = ${tenantId} ${accountCond}
  `);
  const byAccount = new Map<string, { name: string; ends: string[] }>();
  for (const r of gapRows.rows as Array<{ account_id: string; account_name: string; period_end: string }>) {
    const entry = byAccount.get(r.account_id) ?? { name: r.account_name, ends: [] };
    entry.ends.push(r.period_end);
    byAccount.set(r.account_id, entry);
  }
  const gaps: StatementGapInfo[] = [];
  for (const [accountId, { name, ends }] of byAccount) {
    const missing = missingMonthsBetween(ends);
    if (missing.length > 0) gaps.push({ accountId, accountName: name, missingMonths: missing });
  }

  return { statements, total, gaps };
}

export async function getStatement(tenantId: string, statementId: string): Promise<BankStatement> {
  const statement = await db.query.bankStatements.findFirst({
    where: and(eq(bankStatements.tenantId, tenantId), eq(bankStatements.id, statementId)),
  });
  if (!statement) throw AppError.notFound('Bank statement not found');
  return statement;
}

// ─── Backfill ────────────────────────────────────────────────────────
//
// Historical statement parses live on ai_jobs (job_type 'ocr_statement')
// with the extracted result in output_data — but before migration 0115
// nothing recorded WHICH GL account they were imported into. The import
// path only find-or-created a manual bank connection and inserted feed
// items. So the backfill recovers the account by matching the parse's
// transactions against bank_feed_items (feed_date + original_description +
// signed amount — the same tuple the importer's dedup uses): if every
// matched item points at connections of exactly ONE account, that's the
// statement's account. Jobs whose account can't be determined are skipped
// and counted. Idempotent: jobs that already have a bank_statements row
// (by ai_job_id) are never re-created.

export interface BackfillResult {
  examined: number;
  created: number;
  skippedNoData: number;
  skippedNoAccount: number;
}

// Signed amount exactly as importStatementItems persists it: credit
// (money in) → negative; debit/spend → positive.
function signedAmount(amount: string, type?: string): string {
  const n = Math.abs(parseFloat(amount));
  if (!Number.isFinite(n)) return '';
  return (type === 'credit' ? -n : n).toFixed(4);
}

export async function backfillBankStatements(tenantId: string): Promise<BackfillResult> {
  const result: BackfillResult = { examined: 0, created: 0, skippedNoData: 0, skippedNoAccount: 0 };

  const jobs = await db.execute(sql`
    SELECT j.id, j.input_id, j.output_data
    FROM ai_jobs j
    WHERE j.tenant_id = ${tenantId} AND j.job_type = 'ocr_statement' AND j.status = 'complete'
      AND j.output_data IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM bank_statements bs WHERE bs.ai_job_id = j.id)
    ORDER BY j.created_at ASC
  `);

  for (const job of jobs.rows as Array<{ id: string; input_id: string | null; output_data: unknown }>) {
    result.examined += 1;
    const meta = (job.output_data ?? {}) as StatementParseMetadata;
    const periodEnd = meta.statementPeriod?.end && DATE_RE.test(meta.statementPeriod.end) ? meta.statementPeriod.end : null;
    const periodStart = meta.statementPeriod?.start && DATE_RE.test(meta.statementPeriod.start) ? meta.statementPeriod.start : null;
    const closingBalance = toDecimalString(meta.closingBalance);
    const txns = Array.isArray(meta.transactions) ? meta.transactions : [];
    if (!periodEnd || closingBalance == null || txns.length === 0) {
      result.skippedNoData += 1;
      continue;
    }

    // Recover the account by matching the parse's transactions to imported
    // feed items. A small sample is enough to identify the connection.
    const accountIds = new Set<string>();
    const connectionIds = new Set<string>();
    for (const t of txns.slice(0, 25)) {
      const amt = signedAmount(t.amount, t.type);
      if (!amt || !t.date || !t.description) continue;
      const matches = await db.execute(sql`
        SELECT DISTINCT bc.account_id, bfi.bank_connection_id
        FROM bank_feed_items bfi
        JOIN bank_connections bc ON bc.id = bfi.bank_connection_id
        WHERE bfi.tenant_id = ${tenantId}
          AND bfi.feed_date = ${t.date}
          AND bfi.original_description = ${t.description}
          AND bfi.amount = ${amt}
      `);
      for (const m of matches.rows as Array<{ account_id: string; bank_connection_id: string }>) {
        accountIds.add(m.account_id);
        connectionIds.add(m.bank_connection_id);
      }
      if (accountIds.size > 1) break; // ambiguous — stop early
    }

    if (accountIds.size !== 1) {
      result.skippedNoAccount += 1;
      continue;
    }
    const accountId = [...accountIds][0]!;

    const golden = goldenRuleOf(meta);
    const [statement] = await db.insert(bankStatements).values({
      tenantId,
      accountId,
      attachmentId: job.input_id,
      aiJobId: job.id,
      periodStart,
      periodEnd,
      openingBalance: toDecimalString(meta.openingBalance),
      closingBalance,
      maskedAccountNumber: meta.accountNumberMasked?.slice(0, 50) ?? null,
      institutionName: meta.institutionName?.slice(0, 255) ?? null,
      statementType: meta.accountTypeHint?.slice(0, 30) ?? null,
      goldenRuleStatus: golden.status,
      goldenRuleDelta: golden.delta,
    }).returning();
    if (!statement) continue;
    result.created += 1;
    await insertStatementLines(tenantId, statement.id, meta);
    await auditLog(tenantId, 'create', 'bank_statement', statement.id, null, { ...statement, backfilled: true });

    // Stamp the statement's imported feed items (needed by readiness counts
    // and auto-clear). One UPDATE per statement via a VALUES join.
    const tuples = txns
      .map((t) => ({ date: t.date, description: t.description, amount: signedAmount(t.amount, t.type) }))
      .filter((t) => t.amount && t.date && t.description);
    if (tuples.length > 0 && connectionIds.size > 0) {
      const valuesSql = sql.join(
        tuples.map((t) => sql`(${t.date}::date, ${t.description}, ${t.amount}::numeric)`),
        sql`, `,
      );
      const connList = sql.join([...connectionIds].map((id) => sql`${id}::uuid`), sql`, `);
      await db.execute(sql`
        UPDATE bank_feed_items bfi SET statement_id = ${statement.id}
        FROM (VALUES ${valuesSql}) AS v(feed_date, original_description, amount)
        WHERE bfi.tenant_id = ${tenantId}
          AND bfi.bank_connection_id IN (${connList})
          AND bfi.statement_id IS NULL
          AND bfi.feed_date = v.feed_date
          AND bfi.original_description = v.original_description
          AND bfi.amount = v.amount
      `);
    }
  }

  return result;
}

/**
 * Backfill bank_statement_lines for statements captured BEFORE migration
 * 0116 (they have an ai_job with parse output but no lines). Idempotent —
 * insertStatementLines skips statements that already have lines, and the
 * query only selects statements with zero lines. Returns per-run counts.
 */
export async function backfillStatementLines(
  tenantId: string,
): Promise<{ examined: number; statementsPopulated: number; linesCreated: number }> {
  const result = { examined: 0, statementsPopulated: 0, linesCreated: 0 };
  const rows = await db.execute(sql`
    SELECT bs.id, j.output_data
    FROM bank_statements bs
    JOIN ai_jobs j ON j.id = bs.ai_job_id
    WHERE bs.tenant_id = ${tenantId} AND j.output_data IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM bank_statement_lines bsl WHERE bsl.statement_id = bs.id
      )
  `);
  for (const row of rows.rows as Array<{ id: string; output_data: unknown }>) {
    result.examined += 1;
    const created = await insertStatementLines(tenantId, row.id, (row.output_data ?? {}) as StatementParseMetadata);
    if (created > 0) {
      result.statementsPopulated += 1;
      result.linesCreated += created;
    }
  }
  return result;
}

// ─── Reconciliation-only import (Statement Match Engine wave 1) ──────
//
// For books kept manually or via a live Plaid feed: the transactions are
// already entered, so importing statement rows into the bank feed would
// only create duplicates. Instead, capture the bank_statements record +
// bank_statement_lines (for the match engine) and import NOTHING into the
// feed.
export async function importReconcileOnly(
  tenantId: string,
  opts: { jobId: string; accountId?: string | null; bankConnectionId?: string | null; userId?: string },
): Promise<{ statementId: string; lineCount: number; duplicateWarning?: string }> {
  const capture = await captureStatementOnImport(tenantId, opts);
  if (!capture) {
    throw AppError.unprocessableEntity(
      'A reconciliation record could not be created from this parse — the statement period end, closing balance, ' +
        'or target account is missing. Re-parse the statement or import it into the bank feed instead.',
      'STATEMENT_CAPTURE_INCOMPLETE',
    );
  }
  const countRes = await db.execute(sql`
    SELECT count(*)::int AS count FROM bank_statement_lines
    WHERE tenant_id = ${tenantId} AND statement_id = ${capture.statement.id}
  `);
  const lineCount = Number((countRes.rows as Array<{ count: number }>)[0]?.count ?? 0);
  return {
    statementId: capture.statement.id,
    lineCount,
    ...(capture.duplicateWarning ? { duplicateWarning: capture.duplicateWarning } : {}),
  };
}

// Lazy backfill guard: run at most once per tenant per process (the
// function itself is idempotent, this just avoids re-scanning ai_jobs on
// every statements-list request).
const backfillAttempted = new Set<string>();

export async function ensureBackfill(tenantId: string): Promise<void> {
  if (backfillAttempted.has(tenantId)) return;
  backfillAttempted.add(tenantId);
  try {
    const result = await backfillBankStatements(tenantId);
    if (result.examined > 0) {
      log.info({ component: 'bank-statements', event: 'backfill', tenantId, ...result });
    }
    // Statement Match Engine wave 1: statements captured before migration
    // 0116 get their lines from the persisted parse output.
    const lines = await backfillStatementLines(tenantId);
    if (lines.examined > 0) {
      log.info({ component: 'bank-statements', event: 'backfill_lines', tenantId, ...lines });
    }
  } catch (err) {
    // Never let a backfill failure break the statements list.
    log.warn({
      component: 'bank-statements', event: 'backfill_failed', tenantId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
