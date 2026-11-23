// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

/**
 * Verify Data (U-12, capability integrity-v1; migration 0290_integrity_runs).
 *
 * Company-scoped integrity checks with typed findings and exact amounts
 * (every figure is computed and compared in SQL numeric and travels as a
 * decimal string), stored runs (the newest 20 per company), and one kind
 * of fix: recomputing an account's cached balance from its posted journal
 * lines. A fix never writes journal_lines or transactions, so it never
 * moves the ledger version and needs no closing-date password. Each fix is
 * re-checked under a row lock inside its transaction (idempotent), and the
 * whole request is refused with 409 INTEGRITY_STALE when the ledger version
 * moved since the run.
 *
 * Check catalogue v1 (level, severity, fix):
 *   UNBALANCED_TRANSACTION      quick  error    report  posted entry, debits <> credits
 *   ACCOUNT_BALANCE_DRIFT       quick  warning  recompute_account_balance  accounts.balance <> posted lines
 *   DRAFT_AFFECTS_BOOKS         quick  error    report  a live (not converted, not discarded) document draft
 *                                                       already linked to a posted entry: converting it again
 *                                                       would post the document twice
 *   LINE_ACCOUNT_SCOPE          full   error    report  a line's account is in another tenant or company
 *   AR_CONTROL_DIFFERENCE       full   warning  report  open A/R items vs the A/R control accounts
 *   AP_CONTROL_DIFFERENCE       full   warning  report  open A/P items vs the A/P control accounts
 *   INVENTORY_VALUE_DIFFERENCE  full   warning  report  stock valuation vs the inventory asset accounts
 *                                                       (skipped while inventory is off)
 */

import { sql, type SQL } from 'drizzle-orm';
import { db, type DbOrTx, type Tx } from '../db/index.js';
import { AppError } from '../utils/errors.js';
import { auditLog } from '../middleware/audit.js';
import { arOpenItemsAsOf } from './ar-open-items.js';
import { apOpenItemsAsOf } from './ap-open-items.js';
import { valuationSummary } from './inventory-report.service.js';
import { ZERO_COMPANY_UUID } from './ledger-version.service.js';

export type IntegrityLevel = 'quick' | 'full';
export type FindingCode =
  | 'UNBALANCED_TRANSACTION' | 'ACCOUNT_BALANCE_DRIFT' | 'DRAFT_AFFECTS_BOOKS'
  | 'LINE_ACCOUNT_SCOPE' | 'AR_CONTROL_DIFFERENCE' | 'AP_CONTROL_DIFFERENCE' | 'INVENTORY_VALUE_DIFFERENCE';

export const QUICK_CHECKS: readonly FindingCode[] = ['UNBALANCED_TRANSACTION', 'ACCOUNT_BALANCE_DRIFT', 'DRAFT_AFFECTS_BOOKS'];
export const FULL_CHECKS: readonly FindingCode[] = [
  ...QUICK_CHECKS, 'LINE_ACCOUNT_SCOPE', 'AR_CONTROL_DIFFERENCE', 'AP_CONTROL_DIFFERENCE', 'INVENTORY_VALUE_DIFFERENCE',
];
/** Findings listed per run; checks[].found stays exact beyond it. */
export const MAX_FINDINGS = 500;
/** Runs kept per company. */
export const KEEP_RUNS = 20;
/** Time budget of one check run (every statement of it together), in ms. */
export const CHECK_BUDGET_MS = 120_000;

/** Test seams: a hook before each check (inside the run's snapshot) and a shorter budget. */
export const _integrityTestHooks: {
  beforeCheck?: (code: FindingCode, ex: DbOrTx) => Promise<void>;
  budgetMs?: number;
} = {};

function timeoutError(): AppError {
  return new AppError(503, 'Checking the books took too long. Try the quick check, or try again later.', 'INTEGRITY_TIMEOUT');
}

function pgCode(err: unknown): string | undefined {
  let e: unknown = err;
  for (let i = 0; i < 4 && e && typeof e === 'object'; i++) {
    const c = (e as { code?: unknown }).code;
    if (typeof c === 'string' && /^[0-9A-Z]{5}$/.test(c)) return c;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

export interface Finding {
  id: string;
  code: FindingCode;
  severity: 'error' | 'warning';
  subject: { type: 'account' | 'transaction' | 'document_draft' | 'item'; id: string; label: string };
  amounts?: { expectedExact: string; actualExact: string; differenceExact: string };
  fix: 'recompute_account_balance' | null;
}

export interface CheckResult { code: FindingCode; status: 'ok' | 'found' | 'skipped'; found: number }

export interface IntegrityRun {
  id: string;
  level: IntegrityLevel;
  companyId: string;
  startedAt: string;
  finishedAt: string;
  /** The company's ledger version when the checks ran (decimal string). */
  ledgerVersion: string;
  checks: CheckResult[];
  findings: Finding[];
  truncated: boolean;
}

interface Scope { tenantId: string; companyId: string }
type Found = { total: number; findings: Finding[] };

/** The company's ledger version (its counter plus the NULL-company bucket), as a decimal string. */
export async function ledgerVersionText(ex: DbOrTx, s: Scope): Promise<string> {
  const r = await ex.execute(sql`SELECT COALESCE(sum(counter), 0)::text AS v FROM gl_version_stamps
    WHERE tenant_id = ${s.tenantId} AND company_id IN (${s.companyId}::uuid, ${ZERO_COMPANY_UUID}::uuid)`);
  return (r.rows[0] as { v: string }).v;
}

const total = (rows: Array<{ n?: number | string }>): number => Number(rows[0]?.n ?? 0);
const LIMIT = MAX_FINDINGS + 1;

function txnLabel(r: { txn_type: string; txn_number: string | null; d: string }): string {
  return [r.txn_type.replace(/_/g, ' '), r.txn_number ? `#${r.txn_number}` : null, r.d].filter(Boolean).join(' ');
}

async function unbalanced(ex: DbOrTx, s: Scope): Promise<Found> {
  const r = await ex.execute(sql`
    SELECT t.id, t.txn_type, t.txn_number, to_char(t.txn_date, 'YYYY-MM-DD') AS d,
      SUM(jl.debit)::text AS dr, SUM(jl.credit)::text AS cr, (SUM(jl.debit) - SUM(jl.credit))::text AS diff,
      count(*) OVER () AS n
    FROM transactions t JOIN journal_lines jl ON jl.transaction_id = t.id AND jl.tenant_id = t.tenant_id
    WHERE t.tenant_id = ${s.tenantId} AND (t.company_id = ${s.companyId} OR t.company_id IS NULL) AND t.status = 'posted'
    GROUP BY t.id HAVING SUM(jl.debit) <> SUM(jl.credit)
    ORDER BY t.txn_date, t.id LIMIT ${LIMIT}`);
  const rows = r.rows as Array<{ id: string; txn_type: string; txn_number: string | null; d: string; dr: string; cr: string; diff: string; n: string }>;
  return {
    total: total(rows),
    findings: rows.map((x) => ({
      id: `UNBALANCED_TRANSACTION:${x.id}`, code: 'UNBALANCED_TRANSACTION', severity: 'error',
      subject: { type: 'transaction', id: x.id, label: txnLabel(x) },
      amounts: { expectedExact: x.cr, actualExact: x.dr, differenceExact: x.diff },
      fix: null,
    })),
  };
}

/** Same rule as validateTenantBalances (posted lines, tenant-wide per account), scoped to the company's accounts. */
const DRIFT_SQL = (s: Scope, onlyAccount?: string) => sql`
    SELECT a.id, a.name, a.account_number, COALESCE(a.balance, 0)::numeric::text AS stored,
      COALESCE(x.total, 0)::text AS ledger, (COALESCE(a.balance, 0)::numeric - COALESCE(x.total, 0))::text AS diff,
      count(*) OVER () AS n
    FROM accounts a
    LEFT JOIN LATERAL (
      SELECT SUM(jl.debit - jl.credit) AS total FROM journal_lines jl JOIN transactions t ON t.id = jl.transaction_id
      WHERE jl.tenant_id = ${s.tenantId} AND jl.account_id = a.id AND t.status = 'posted'
    ) x ON true
    WHERE a.tenant_id = ${s.tenantId} AND (a.company_id = ${s.companyId} OR a.company_id IS NULL)
      ${onlyAccount ? sql`AND a.id = ${onlyAccount}` : sql``}
      AND a.balance::numeric IS DISTINCT FROM COALESCE(x.total, 0)`;

async function drift(ex: DbOrTx, s: Scope): Promise<Found> {
  const r = await ex.execute(sql`${DRIFT_SQL(s)} ORDER BY a.account_number NULLS LAST, a.id LIMIT ${LIMIT}`);
  const rows = r.rows as Array<{ id: string; name: string; account_number: string | null; stored: string; ledger: string; diff: string; n: string }>;
  return {
    total: total(rows),
    findings: rows.map((x) => ({
      id: `ACCOUNT_BALANCE_DRIFT:${x.id}`, code: 'ACCOUNT_BALANCE_DRIFT', severity: 'warning',
      subject: { type: 'account', id: x.id, label: x.account_number ? `${x.account_number} ${x.name}` : x.name },
      amounts: { expectedExact: x.ledger, actualExact: x.stored, differenceExact: x.diff },
      fix: 'recompute_account_balance',
    })),
  };
}

async function draftsInBooks(ex: DbOrTx, s: Scope): Promise<Found> {
  const r = await ex.execute(sql`
    SELECT d.id, d.doc_reference, d.kind, count(*) OVER () AS n
    FROM document_drafts d JOIN transactions t ON t.id = d.converted_transaction_id AND t.tenant_id = d.tenant_id
    WHERE d.tenant_id = ${s.tenantId} AND d.company_id = ${s.companyId}
      AND d.status NOT IN ('converted', 'discarded') AND t.status = 'posted'
    ORDER BY d.created_at, d.id LIMIT ${LIMIT}`);
  const rows = r.rows as Array<{ id: string; doc_reference: string | null; kind: string; n: string }>;
  return {
    total: total(rows),
    findings: rows.map((x) => ({
      id: `DRAFT_AFFECTS_BOOKS:${x.id}`, code: 'DRAFT_AFFECTS_BOOKS', severity: 'error',
      subject: { type: 'document_draft', id: x.id, label: [x.kind, x.doc_reference].filter(Boolean).join(' ') },
      fix: null,
    })),
  };
}

async function lineScope(ex: DbOrTx, s: Scope): Promise<Found> {
  const r = await ex.execute(sql`
    SELECT t.id, t.txn_type, t.txn_number, to_char(t.txn_date, 'YYYY-MM-DD') AS d, count(*) OVER () AS n
    FROM transactions t
    WHERE t.tenant_id = ${s.tenantId} AND (t.company_id = ${s.companyId} OR t.company_id IS NULL)
      AND EXISTS (
        SELECT 1 FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
        WHERE jl.transaction_id = t.id
          AND (a.tenant_id <> jl.tenant_id OR jl.tenant_id <> t.tenant_id
            OR (a.company_id IS NOT NULL AND t.company_id IS NOT NULL AND a.company_id <> t.company_id)))
    ORDER BY t.txn_date, t.id LIMIT ${LIMIT}`);
  const rows = r.rows as Array<{ id: string; txn_type: string; txn_number: string | null; d: string; n: string }>;
  return {
    total: total(rows),
    findings: rows.map((x) => ({
      id: `LINE_ACCOUNT_SCOPE:${x.id}`, code: 'LINE_ACCOUNT_SCOPE', severity: 'error',
      subject: { type: 'transaction', id: x.id, label: txnLabel(x) }, fix: null,
    })),
  };
}

/**
 * Open items (exact strings) vs the control accounts' posted balance as of
 * `asOf`, compared in SQL numeric. A/R and A/P use one company scope, the
 * same as the other checks and the ledger version: the company's own
 * transactions plus company-less ones (posting stores company_id NULL when
 * a write names no company; those rows count for every company). The open
 * items are read with that same scope, so the two sides always match.
 */
async function control(ex: DbOrTx, s: Scope, kind: 'ar' | 'ap', asOf: string): Promise<Found> {
  const items = kind === 'ar'
    ? await arOpenItemsAsOf(ex, { tenantId: s.tenantId, companyId: s.companyId, asOf })
    : await apOpenItemsAsOf(ex, { tenantId: s.tenantId, companyId: s.companyId, asOf, includeCompanyless: true });
  // openExact: the exact open amount (4 places) of each item, A/R and A/P alike (open-balances-asof-v1).
  const opens = items.map((i) => {
    const text = i.openExact;
    if (!/^-?\d{1,30}(\.\d{1,10})?$/.test(text)) throw new Error('open item amount is not a decimal');
    return text;
  });
  const tag = kind === 'ar' ? 'accounts_receivable' : 'accounts_payable';
  const sign = kind === 'ar' ? sql`jl.debit - jl.credit` : sql`jl.credit - jl.debit`;
  const scope = sql`(t.company_id = ${s.companyId} OR t.company_id IS NULL)`;
  // One text[] parameter (an array literal of checked decimals; '{}' when none).
  const openArray = `{${opens.join(',')}}`;
  const r = await ex.execute(sql`
    WITH ctl AS (
      SELECT COALESCE(SUM(${sign}), 0) AS b FROM journal_lines jl
      JOIN transactions t ON t.id = jl.transaction_id AND t.tenant_id = jl.tenant_id
      JOIN accounts a ON a.id = jl.account_id AND a.tenant_id = jl.tenant_id
      WHERE jl.tenant_id = ${s.tenantId} AND t.status = 'posted' AND a.system_tag = ${tag} AND t.txn_date <= ${asOf}::date AND ${scope}
    ), open AS (
      SELECT COALESCE(SUM(v::numeric), 0) AS o FROM unnest(${openArray}::text[]) AS v
    ), acct AS (
      SELECT a.id, a.name, a.account_number FROM accounts a
      WHERE a.tenant_id = ${s.tenantId} AND a.system_tag = ${tag} AND (a.company_id = ${s.companyId} OR a.company_id IS NULL)
      ORDER BY a.account_number NULLS LAST, a.id LIMIT 1
    )
    SELECT o.o::text AS expected, c.b::text AS actual, (c.b - o.o)::text AS diff, (c.b = o.o) AS same,
      (SELECT id FROM acct) AS account_id, (SELECT name FROM acct) AS name, (SELECT account_number FROM acct) AS num
    FROM ctl c, open o`);
  const row = r.rows[0] as { expected: string; actual: string; diff: string; same: boolean; account_id: string | null; name: string | null; num: string | null };
  if (row.same || !row.account_id) return { total: 0, findings: [] };
  const code: FindingCode = kind === 'ar' ? 'AR_CONTROL_DIFFERENCE' : 'AP_CONTROL_DIFFERENCE';
  return {
    total: 1,
    findings: [{
      id: `${code}:${row.account_id}`, code, severity: 'warning',
      subject: { type: 'account', id: row.account_id, label: row.num ? `${row.num} ${row.name}` : (row.name ?? '') },
      amounts: { expectedExact: row.expected, actualExact: row.actual, differenceExact: row.diff },
      fix: null,
    }],
  };
}

const ZERO = /^-?0+(\.0+)?$/;

async function inventoryValue(ex: DbOrTx, s: Scope, asOf: string): Promise<Found | 'skipped'> {
  let summary;
  try {
    summary = await valuationSummary(s.tenantId, asOf, s.companyId, ex);
  } catch (err) {
    if (err instanceof AppError && err.code === 'INVENTORY_OFF') return 'skipped';
    throw err;
  }
  const off = summary.accounts.filter((a) => !ZERO.test(a.difference));
  return {
    total: off.length,
    findings: off.slice(0, LIMIT).map((a) => ({
      id: `INVENTORY_VALUE_DIFFERENCE:${a.accountId}`, code: 'INVENTORY_VALUE_DIFFERENCE', severity: 'warning',
      subject: { type: 'account', id: a.accountId, label: a.name },
      amounts: { expectedExact: a.valuation, actualExact: a.glBalance, differenceExact: a.difference },
      fix: null,
    })),
  };
}

/**
 * Runs every check of `level` and stores the run. All checks, the
 * inventory valuation included, read one READ ONLY REPEATABLE READ snapshot
 * (set as the transaction's first statement), together with the ledger
 * version they saw. The run has one deadline (CHECK_BUDGET_MS): before each
 * raw statement statement_timeout is set to the time left, and the time is
 * checked before each check. Query-builder reads inside a helper (the
 * inventory valuation's selects) run under the timeout set by the statement
 * before them, so they can overrun the deadline by at most that one
 * statement's time. 503 INTEGRITY_TIMEOUT when the deadline passes.
 */
export async function runChecks(s: Scope, level: IntegrityLevel, userId: string | null): Promise<IntegrityRun> {
  const startedAt = new Date().toISOString();
  const codes = level === 'full' ? FULL_CHECKS : QUICK_CHECKS;
  const deadline = Date.now() + (_integrityTestHooks.budgetMs ?? CHECK_BUDGET_MS);
  const left = () => {
    const ms = Math.floor(deadline - Date.now());
    if (ms <= 0) throw timeoutError();
    return ms;
  };
  let out: { ledgerVersion: string; checks: CheckResult[]; findings: Finding[] };
  try {
    out = await db.transaction(async (tx) => {
      // First statement of the transaction: one snapshot for every check and the ledger version they saw.
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
      const execute = async (q: SQL) => {
        await tx.execute(sql`SELECT set_config('statement_timeout', ${String(left())}, true)`);
        return tx.execute(q);
      };
      // Helpers that take a DbOrTx get the time left before each raw statement.
      const ex = new Proxy(tx, {
        get: (t, prop, recv) => (prop === 'execute' ? execute : Reflect.get(t, prop, recv)),
      }) as Tx;
      const asOf = ((await ex.execute(sql`SELECT to_char(now(), 'YYYY-MM-DD') AS d`)).rows[0] as { d: string }).d;
      const ledgerVersion = await ledgerVersionText(ex, s);
      const checks: CheckResult[] = [];
      const findings: Finding[] = [];
      for (const code of codes) {
        left();
        if (_integrityTestHooks.beforeCheck) await _integrityTestHooks.beforeCheck(code, ex);
        let f: Found | 'skipped';
        switch (code) {
          case 'UNBALANCED_TRANSACTION': f = await unbalanced(ex, s); break;
          case 'ACCOUNT_BALANCE_DRIFT': f = await drift(ex, s); break;
          case 'DRAFT_AFFECTS_BOOKS': f = await draftsInBooks(ex, s); break;
          case 'LINE_ACCOUNT_SCOPE': f = await lineScope(ex, s); break;
          case 'AR_CONTROL_DIFFERENCE': f = await control(ex, s, 'ar', asOf); break;
          case 'AP_CONTROL_DIFFERENCE': f = await control(ex, s, 'ap', asOf); break;
          case 'INVENTORY_VALUE_DIFFERENCE': f = await inventoryValue(ex, s, asOf); break;
        }
        if (f === 'skipped') {
          checks.push({ code, status: 'skipped', found: 0 });
          continue;
        }
        checks.push({ code, status: f.total > 0 ? 'found' : 'ok', found: f.total });
        findings.push(...f.findings);
      }
      return { ledgerVersion, checks, findings };
    });
  } catch (err) {
    // 57014 query_canceled: a statement ran past the time left.
    if (pgCode(err) === '57014') throw timeoutError();
    throw err;
  }
  const truncated = out.findings.length > MAX_FINDINGS || out.checks.some((c) => c.found > MAX_FINDINGS);
  const findings = out.findings.slice(0, MAX_FINDINGS);
  const summary = {
    checks: out.checks,
    counts: {
      error: out.checks.filter((c) => severityOf(c.code) === 'error').reduce((a, c) => a + c.found, 0),
      warning: out.checks.filter((c) => severityOf(c.code) === 'warning').reduce((a, c) => a + c.found, 0),
    },
    fixable: findings.filter((f) => f.fix !== null).length,
    truncated,
  };
  const ins = await db.execute(sql`
    INSERT INTO integrity_runs (tenant_id, company_id, level, started_at, ledger_version, summary, findings, created_by)
    VALUES (${s.tenantId}, ${s.companyId}, ${level}, ${startedAt}::timestamptz, ${out.ledgerVersion},
      ${JSON.stringify(summary)}::jsonb, ${JSON.stringify(findings)}::jsonb, ${userId})
    RETURNING id, to_char(finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS finished_at`);
  const row = ins.rows[0] as { id: string; finished_at: string };
  await db.execute(sql`
    DELETE FROM integrity_runs WHERE tenant_id = ${s.tenantId} AND company_id = ${s.companyId} AND id NOT IN (
      SELECT id FROM integrity_runs WHERE tenant_id = ${s.tenantId} AND company_id = ${s.companyId}
      ORDER BY finished_at DESC, id DESC LIMIT ${KEEP_RUNS})`);
  return {
    id: row.id, level, companyId: s.companyId, startedAt, finishedAt: row.finished_at,
    ledgerVersion: out.ledgerVersion, checks: out.checks, findings, truncated,
  };
}

function severityOf(code: FindingCode): 'error' | 'warning' {
  return code === 'UNBALANCED_TRANSACTION' || code === 'DRAFT_AFFECTS_BOOKS' || code === 'LINE_ACCOUNT_SCOPE' ? 'error' : 'warning';
}

interface RunRow {
  id: string; level: IntegrityLevel; company_id: string; started_at: string; finished_at: string;
  ledger_version: string; summary: { checks: CheckResult[]; counts: { error: number; warning: number }; fixable: number; truncated: boolean };
  findings: Finding[];
}

const RUN_COLUMNS = sql`id, level, company_id,
  to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS started_at,
  to_char(finished_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS finished_at,
  ledger_version, summary, findings`;

function parse<T>(v: unknown): T {
  return (typeof v === 'string' ? JSON.parse(v) : v) as T;
}

function toRun(r: RunRow): IntegrityRun {
  const summary = parse<RunRow['summary']>(r.summary);
  return {
    id: r.id, level: r.level, companyId: r.company_id, startedAt: r.started_at, finishedAt: r.finished_at,
    ledgerVersion: r.ledger_version, checks: summary.checks, findings: parse<Finding[]>(r.findings), truncated: summary.truncated,
  };
}

/** One stored run of the company, or 404 INTEGRITY_RUN_UNKNOWN. */
export async function getRun(s: Scope, id: string): Promise<IntegrityRun> {
  const r = await db.execute(sql`SELECT ${RUN_COLUMNS} FROM integrity_runs
    WHERE id = ${id}::uuid AND tenant_id = ${s.tenantId} AND company_id = ${s.companyId}`);
  const row = r.rows[0] as RunRow | undefined;
  if (!row) throw new AppError(404, 'That check is no longer stored; run it again.', 'INTEGRITY_RUN_UNKNOWN');
  return toRun(row);
}

export interface RunSummary { id: string; finishedAt: string; counts: { error: number; warning: number }; fixable: number }

/** The newest run of each level (Home's line, the weekly check's clock). */
export async function summary(s: Scope): Promise<{ lastQuick: RunSummary | null; lastFull: RunSummary | null }> {
  const pick = async (level: IntegrityLevel): Promise<RunSummary | null> => {
    const r = await db.execute(sql`SELECT ${RUN_COLUMNS} FROM integrity_runs
      WHERE tenant_id = ${s.tenantId} AND company_id = ${s.companyId} AND level = ${level}
      ORDER BY finished_at DESC, id DESC LIMIT 1`);
    const row = r.rows[0] as RunRow | undefined;
    if (!row) return null;
    const sm = parse<RunRow['summary']>(row.summary);
    return { id: row.id, finishedAt: row.finished_at, counts: sm.counts, fixable: sm.fixable };
  };
  return { lastQuick: await pick('quick'), lastFull: await pick('full') };
}

export interface FixRequest { runId: string; findingIds: string[]; expectedLedgerVersion: string; backupArchiveId?: string }
export interface FixResult {
  fixed: string[];
  skipped: Array<{ id: string; reason: 'NO_LONGER_FOUND' | 'NOT_FIXABLE' }>;
  ledgerVersion: string;
}

/**
 * Fixes the chosen findings of a stored run (v1: recompute_account_balance
 * only). 409 INTEGRITY_STALE when the ledger version moved since the run (or
 * the caller's expected version is not the current one). Each finding is
 * re-checked with its account row locked: one already right is skipped
 * (NO_LONGER_FOUND), so repeating a request is harmless. Writes only
 * accounts.balance and one integrity_fix audit row, in one transaction; the
 * audit row lists each fix as {findingId, accountId, before, after} with the
 * cached balance before and after as exact decimal strings.
 */
export async function fix(s: Scope, req: FixRequest, userId: string | null): Promise<FixResult> {
  const run = await getRun(s, req.runId);
  return db.transaction(async (tx) => {
    const current = await ledgerVersionText(tx, s);
    if (current !== req.expectedLedgerVersion || current !== run.ledgerVersion) {
      throw AppError.conflict('The books changed since this check. Check again before fixing.', 'INTEGRITY_STALE', {
        ledgerVersion: current,
      });
    }
    const byId = new Map(run.findings.map((f) => [f.id, f]));
    // Step 6 of the posting lock order (company-row-lock.ts): account rows, id
    // order, the lock an UPDATE of a non-key column takes. A posting to one of
    // them waits, then its lines are seen by the re-check below.
    const accountIds = [...new Set(req.findingIds.map((id) => byId.get(id))
      .filter((f): f is Finding => !!f && f.fix === 'recompute_account_balance' && f.subject.type === 'account')
      .map((f) => f.subject.id.toLowerCase()))].sort();
    if (accountIds.length > 0) {
      await tx.execute(sql`SELECT id FROM accounts WHERE tenant_id = ${s.tenantId}
        AND id = ANY(${`{${accountIds.join(',')}}`}::uuid[]) ORDER BY id FOR NO KEY UPDATE`);
    }
    const fixed: string[] = [];
    const skipped: FixResult['skipped'] = [];
    // The audit trail of each fix: the cached balance before and the one written, exact (numeric::text).
    const changes: Array<{ findingId: string; accountId: string; before: string; after: string }> = [];
    for (const id of [...new Set(req.findingIds)]) {
      const f = byId.get(id);
      if (!f || f.fix !== 'recompute_account_balance' || f.subject.type !== 'account') {
        skipped.push({ id, reason: 'NOT_FIXABLE' });
        continue;
      }

      const r = await tx.execute(DRIFT_SQL(s, f.subject.id));
      const row = r.rows[0] as { id: string; stored: string; ledger: string } | undefined;
      if (!row) {
        skipped.push({ id, reason: 'NO_LONGER_FOUND' });
        continue;
      }
      const upd = await tx.execute(sql`UPDATE accounts SET balance = ${row.ledger}::numeric
        WHERE id = ${f.subject.id} AND tenant_id = ${s.tenantId}
        RETURNING balance::numeric::text AS after`);
      const after = (upd.rows[0] as { after: string } | undefined)?.after ?? row.ledger;
      changes.push({ findingId: id, accountId: row.id, before: row.stored, after });
      fixed.push(id);
    }
    await auditLog(s.tenantId, 'update', 'integrity_fix', run.id, null, {
      runId: run.id, findingIds: fixed, skipped: skipped.map((k) => k.id), backupArchiveId: req.backupArchiveId ?? null,
      fixes: changes,
    }, userId ?? undefined, tx);
    return { fixed, skipped, ledgerVersion: await ledgerVersionText(tx, s) };
  });
}
