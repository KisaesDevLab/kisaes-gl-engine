// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

// Sensitive accounts (U-33, capability sensitive-accounts-v1).
//
// An Admin marks an account sensitive (accounts.is_sensitive). That account
// and all its sub-accounts are hidden from any viewer without the
// `sensitive_accounts` right. The viewer is the authenticated request:
// `authenticate` runs everything after it inside this AsyncLocalStorage, so
// any service a request reaches can ask which accounts are hidden without a
// parameter threaded through it. Code that runs without a viewer (jobs,
// schedulers, backups, tenant export, the transfer file) hides nothing.
//
// Read paths leave hidden accounts out at the account join (`andVisible`,
// `visibleAccount`). Write paths and single-transaction reads refuse with 403
// SENSITIVE_ACCOUNT (`assertNoHiddenLines`). Report families not yet
// converted refuse with 403 SENSITIVE_HIDDEN (`refuseUnconvertedReport`), so a
// report added later fails closed until someone converts it.
//
// With no account marked, the hidden set is empty and every helper returns
// the exact SQL it did before (byte-identical), so nothing changes for a
// company until an Admin marks an account.

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Request, Response, NextFunction } from 'express';
import { notInArray, sql, type SQL, type AnyColumn } from 'drizzle-orm';
import { can } from '@kis-books/shared';
import { db } from '../db/index.js';
import { AppError } from '../utils/errors.js';
import { resolvePermissionsForRequest } from '../middleware/permission.js';

interface ViewerStore {
  req: Request;
}

const storage = new AsyncLocalStorage<ViewerStore>();
const hiddenCache = new WeakMap<Request, Promise<string[]>>();

/** Runs `fn` (the rest of the request) with `req` as the viewer. */
export function runAsViewer<T>(req: Request, fn: () => T): T {
  return storage.run({ req }, fn);
}

/** Runs `fn` with no viewer: it sees every account (jobs started from a request). */
export function runWithoutViewer<T>(fn: () => T): T {
  return storage.exit(fn);
}

/** The request whose viewer is in effect, if any. */
export function currentViewer(): Request | undefined {
  return storage.getStore()?.req;
}

/**
 * Re-enters the viewer after middleware that calls `next` from an event
 * emitter (multipart parsers), where the async context can be lost. Mount
 * after the upload middleware on routes that read or post ledger data.
 */
export function reenterViewer(req: Request, _res: Response, next: NextFunction): void {
  if (req.userId && req.tenantId) {
    runAsViewer(req, next);
    return;
  }
  next();
}

/** The tenant's sensitive accounts plus all their sub-accounts. */
export async function sensitiveAccountIds(tenantId: string): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(sql`
    WITH RECURSIVE hidden AS (
      SELECT id FROM accounts WHERE tenant_id = ${tenantId} AND is_sensitive = true
      UNION
      SELECT a.id FROM accounts a JOIN hidden h ON a.parent_id = h.id WHERE a.tenant_id = ${tenantId}
    )
    SELECT id::text AS id FROM hidden ORDER BY id`);
  return rows.rows.map((r) => r.id);
}

async function resolveHidden(req: Request): Promise<string[]> {
  if (!req.tenantId) return [];
  const perms = await resolvePermissionsForRequest(req);
  if (can(perms, 'sensitive_accounts', 'read')) return [];
  return sensitiveAccountIds(req.tenantId);
}

/** Hidden set of an explicit request (cached per request). */
export function hiddenAccountIdsFor(req: Request): Promise<string[]> {
  let cached = hiddenCache.get(req);
  if (!cached) {
    cached = resolveHidden(req);
    hiddenCache.set(req, cached);
  }
  return cached;
}

/**
 * Account ids hidden from the current viewer: [] when the viewer has the
 * `sensitive_accounts` right, when nothing is marked, or when there is no
 * viewer. Resolved once per request.
 */
export function hiddenAccountIds(): Promise<string[]> {
  const req = currentViewer();
  if (!req) return Promise.resolve([]);
  return hiddenAccountIdsFor(req);
}

function uuidArray(ids: readonly string[]): SQL {
  return sql`ARRAY[${sql.join(ids.map((id) => sql`${id}`), sql`, `)}]::uuid[]`;
}

/**
 * ` AND <column> <> ALL(hidden)` for raw SQL, or an empty fragment when
 * nothing is hidden (the query text is then exactly what it was before).
 * `column` is a raw reference such as sql`a.id` or sql.raw('jl.account_id').
 */
export function andVisible(hidden: readonly string[], column: SQL): SQL {
  if (hidden.length === 0) return sql``;
  return sql` AND ${column} <> ALL(${uuidArray(hidden)})`;
}

/** `<column> = ANY(hidden)`; only call with a non-empty set. */
export function isHiddenSql(hidden: readonly string[], column: SQL): SQL {
  return sql`${column} = ANY(${uuidArray(hidden)})`;
}

/** Drizzle condition form of `andVisible`: undefined (no condition) when nothing is hidden. */
export function visibleAccount(hidden: readonly string[], column: AnyColumn): SQL | undefined {
  if (hidden.length === 0) return undefined;
  return notInArray(column, [...hidden]);
}

/** `hiddenNotice` for a response: true when the viewer has any hidden account, else null. */
export function hiddenNotice(hidden: readonly string[]): true | null {
  return hidden.length > 0 ? true : null;
}

export const SENSITIVE_ACCOUNT_MESSAGE = 'This transaction uses an account hidden for your role';

export function sensitiveAccountError(): AppError {
  return AppError.forbidden(SENSITIVE_ACCOUNT_MESSAGE, 'SENSITIVE_ACCOUNT');
}

/**
 * Refuses (403 SENSITIVE_ACCOUNT) when any of `accountIds` is hidden from the
 * current viewer. Used on every transaction read and write choke point, so a
 * transaction that touches a hidden account is read-only and unopenable for
 * that viewer. Runs before the closed-period check.
 */
export async function assertNoHiddenLines(accountIds: Iterable<string | null | undefined>): Promise<void> {
  const hidden = await hiddenAccountIds();
  if (hidden.length === 0) return;
  const set = new Set(hidden);
  for (const id of accountIds) {
    if (id && set.has(id)) throw sensitiveAccountError();
  }
}

/** Whether `accountId` is hidden from the current viewer. */
export async function isHiddenAccount(accountId: string): Promise<boolean> {
  const hidden = await hiddenAccountIds();
  return hidden.includes(accountId);
}

// ─── Fail-closed table for the reporting family ───────────────────────────

/**
 * Path prefixes whose routes read account amounts in bulk. While the viewer
 * has any hidden account, every request under them that is not listed in
 * CONVERTED is refused with 403 SENSITIVE_HIDDEN. One table instead of a
 * guard per router: several routers share /api/v1/reports, and a router-level
 * guard also runs for requests meant for a sibling router.
 */
export const REFUSE_PREFIXES: readonly string[] = [
  '/api/v1/reports',
  '/api/v1/report-builder',
  '/api/v1/dashboard',
  '/api/v1/budgets',
  '/api/v1/export',
  '/api/v1/chat',
  '/api/v1/ai',
  // Found by the canary sweep: the integration API (its own account and
  // report reads) and the 1099 account mappings.
  '/api/v2',
  '/api/v1/practice/1099',
];

/**
 * Routes under REFUSE_PREFIXES that leave hidden accounts out (converted).
 * Method plus a path pattern; `:x` matches one path segment.
 */
export const CONVERTED: ReadonlyArray<{ method: string; path: string }> = [
  // Statements (E7): every variant on these paths (compare, by_tag, exact,
  // csv, pdf) composes the filtered builders.
  { method: 'GET', path: '/api/v1/reports/profit-loss' },
  { method: 'GET', path: '/api/v1/reports/balance-sheet' },
  { method: 'GET', path: '/api/v1/reports/trial-balance' },
  // Ledger drills (E8).
  { method: 'GET', path: '/api/v1/reports/general-ledger' },
  { method: 'POST', path: '/api/v1/reports/general-ledger' },
  { method: 'GET', path: '/api/v1/reports/transaction-list' },
  { method: 'POST', path: '/api/v1/reports/transaction-list' },
  // Report Builder (E14-E17, PR 2): runs and drills leave hidden lines out at
  // the outer accounts join (both bases, earnings and opening rows included);
  // a drill keyed on a hidden account is 404; saved reports naming one are
  // listed with canEdit false and hiddenRefs, and can't be changed (403
  // SENSITIVE_DEFINITION); a hidden id in a definition sent is NOT_IN_COMPANY.
  { method: 'POST', path: '/api/v1/report-builder/run' },
  { method: 'POST', path: '/api/v1/report-builder/run/detail' },
  { method: 'GET', path: '/api/v1/report-builder/definitions' },
  { method: 'POST', path: '/api/v1/report-builder/definitions' },
  { method: 'GET', path: '/api/v1/report-builder/definitions/:id' },
  { method: 'PUT', path: '/api/v1/report-builder/definitions/:id' },
  { method: 'DELETE', path: '/api/v1/report-builder/definitions/:id' },
  { method: 'GET', path: '/api/v1/report-builder/definition-groups' },
  { method: 'POST', path: '/api/v1/report-builder/definition-groups' },
  { method: 'PUT', path: '/api/v1/report-builder/definition-groups/:id' },
  { method: 'DELETE', path: '/api/v1/report-builder/definition-groups/:id' },
  { method: 'GET', path: '/api/v1/report-builder/fields' },
  { method: 'GET', path: '/api/v1/report-builder/starters' },
  // Report files (E18-E19): a hidden account is exported as {kind, missing:
  // true}; the import preview never matches, offers or accepts one.
  { method: 'POST', path: '/api/v1/report-builder/definitions/export' },
  { method: 'POST', path: '/api/v1/report-builder/definitions/import/preview' },
  // A/R and A/P reports (E10): they read documents, never a per-account
  // split; a document's total on its control account is an accepted limit.
  { method: 'GET', path: '/api/v1/reports/ar-aging-summary' },
  { method: 'GET', path: '/api/v1/reports/ar-aging-detail' },
  { method: 'GET', path: '/api/v1/reports/ap-aging-summary' },
  { method: 'GET', path: '/api/v1/reports/ap-aging-detail' },
  { method: 'GET', path: '/api/v1/reports/unpaid-bills' },
  { method: 'GET', path: '/api/v1/reports/invoice-list' },
  { method: 'GET', path: '/api/v1/reports/customer-balance-summary' },
  { method: 'GET', path: '/api/v1/reports/customer-balance-detail' },
  { method: 'GET', path: '/api/v1/reports/vendor-balance-summary' },
  { method: 'GET', path: '/api/v1/reports/bill-payment-history' },
  { method: 'GET', path: '/api/v1/reports/vendor-statement' },
  { method: 'GET', path: '/api/v1/reports/transaction-list-by-vendor' },
  // E8/E9: their SQL leaves hidden accounts out at the accounts join.
  { method: 'GET', path: '/api/v1/reports/expense-by-category' },
  { method: 'GET', path: '/api/v1/reports/sales-by-customer' },
  { method: 'GET', path: '/api/v1/reports/sales-by-item' },
  { method: 'GET', path: '/api/v1/reports/journal-entry-report' },
  { method: 'GET', path: '/api/v1/reports/account-report' },
  { method: 'GET', path: '/api/v1/reports/check-register' },
  // Bank accounts can't be marked.
  { method: 'GET', path: '/api/v1/reports/bank-balances' },
  // Dashboard (E11): revenue and expenses leave hidden accounts out; budget
  // performance leaves their budget lines out; cash, card and control
  // accounts can't be marked.
  { method: 'GET', path: '/api/v1/dashboard/summary' },
  { method: 'GET', path: '/api/v1/dashboard/snapshot' },
  { method: 'GET', path: '/api/v1/dashboard/trend' },
  { method: 'GET', path: '/api/v1/dashboard/cash-position' },
  { method: 'GET', path: '/api/v1/dashboard/account-balances' },
  { method: 'GET', path: '/api/v1/dashboard/receivables' },
  { method: 'GET', path: '/api/v1/dashboard/payables' },
  { method: 'GET', path: '/api/v1/dashboard/action-items' },
  { method: 'GET', path: '/api/v1/dashboard/budget-performance' },
  { method: 'GET', path: '/api/v1/dashboard/banking-health' },
  // AI draft and Ask (E20): hidden names are never sent, resolved or kept.
  { method: 'POST', path: '/api/v1/report-builder/draft' },
  { method: 'POST', path: '/api/v1/reports/ask' },
  // P29 review B2 (sensitive-accounts-doors-v1). AI status and consent read no account; the categorize preview
  // offers the model (and so the reply) only visible accounts.
  { method: 'GET', path: '/api/v1/ai/status' },
  { method: 'GET', path: '/api/v1/ai/consent' },
  { method: 'GET', path: '/api/v1/ai/consent/:id/disclosure' },
  { method: 'POST', path: '/api/v1/ai/consent/:id/accept' },
  { method: 'POST', path: '/api/v1/ai/consent/:id/revoke' },
  { method: 'POST', path: '/api/v1/ai/categorize/preview' },
  // Budgets: the header reads and writes name no account; lines and their totals leave hidden accounts out, and a
  // line on one can't be saved (403 SENSITIVE_ACCOUNT; hidden lines are kept). Fill, copy, adjust, Budget vs.
  // Actual, overview and tag actuals stay refused.
  { method: 'GET', path: '/api/v1/budgets' },
  { method: 'POST', path: '/api/v1/budgets' },
  { method: 'GET', path: '/api/v1/budgets/:id' },
  { method: 'PUT', path: '/api/v1/budgets/:id' },
  { method: 'DELETE', path: '/api/v1/budgets/:id' },
  { method: 'GET', path: '/api/v1/budgets/:id/lines' },
  { method: 'PUT', path: '/api/v1/budgets/:id/lines' },
  // Customer statements read only the A/R control account's lines (documents, as the A/R reports: E10's limit).
  { method: 'GET', path: '/api/v1/reports/customer-statement' },
  { method: 'GET', path: '/api/v1/reports/customer-statements' },
  // Closing Date Exceptions: rows about a transaction touching a hidden account are left out (and out of total).
  { method: 'GET', path: '/api/v1/reports/closing-date-exceptions' },
];

function segments(p: string): string[] {
  return p.split('/').filter((s) => s.length > 0);
}

function matchesPattern(pattern: string, path: string): boolean {
  const ps = segments(pattern);
  const xs = segments(path);
  if (ps.length !== xs.length) return false;
  return ps.every((s, i) => s.startsWith(':') || s === xs[i]);
}

/** Whether METHOD path is a converted route. HEAD counts as GET. */
export function isConvertedRoute(method: string, path: string): boolean {
  const m = method === 'HEAD' ? 'GET' : method;
  return CONVERTED.some((c) => c.method === m && matchesPattern(c.path, path));
}

/** Whether `path` lies under one of the refuse prefixes. */
export function underRefusePrefix(path: string): boolean {
  return REFUSE_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

export const SENSITIVE_HIDDEN_MESSAGE = 'This needs access to sensitive accounts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidsOf(values: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const v of values) if (UUID_RE.test(v)) out.add(v.toLowerCase());
  return [...out];
}

/** Bounds of the request-body walk: nesting depth and how many string values are read. */
const BODY_MAX_DEPTH = 12;
const BODY_MAX_VALUES = 5000;

/**
 * Every UUID string value in a parsed JSON body (keys of any name: payment
 * applications name invoices and bills `invoiceId` / `billId`, merges
 * `keepId` / `voidId`, links `attachableId`), bounded by depth and count.
 */
export function bodyUuids(body: unknown): string[] {
  const out = new Set<string>();
  let seen = 0;
  const walk = (v: unknown, depth: number): void => {
    if (seen >= BODY_MAX_VALUES || depth > BODY_MAX_DEPTH || v === null || v === undefined) return;
    if (typeof v === 'string') {
      seen++;
      if (v.length === 36 && UUID_RE.test(v)) out.add(v.toLowerCase());
      return;
    }
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    if (typeof v === 'object') { for (const x of Object.values(v as Record<string, unknown>)) walk(x, depth + 1); }
  };
  walk(body, 0);
  return [...out];
}

/** Whether any of `ids` is a transaction of `tenantId` with a line on one of `hidden`. */
async function anyHiddenTransaction(tenantId: string, ids: readonly string[], hidden: readonly string[]): Promise<boolean> {
  if (ids.length === 0 || hidden.length === 0) return false;
  const rows = await db.execute(sql`
    SELECT 1 FROM journal_lines
    WHERE tenant_id = ${tenantId} AND transaction_id = ANY(${uuidArray(ids)})
      AND account_id = ANY(${uuidArray(hidden)})
    LIMIT 1`);
  return rows.rows.length > 0;
}

/** Which of `ids` are transactions with a line on an account hidden from the current viewer (empty when none hidden). */
export async function transactionsTouchingHidden(tenantId: string, ids: Iterable<string | null | undefined>): Promise<Set<string>> {
  const list = uuidsOf([...ids].filter((x): x is string => typeof x === 'string'));
  const hidden = await hiddenAccountIds();
  if (list.length === 0 || hidden.length === 0) return new Set();
  const rows = await db.execute<{ id: string }>(sql`
    SELECT DISTINCT transaction_id::text AS id FROM journal_lines
    WHERE tenant_id = ${tenantId} AND transaction_id = ANY(${uuidArray(list)})
      AND account_id = ANY(${uuidArray(hidden)})`);
  return new Set(rows.rows.map((r) => r.id));
}

/**
 * 403 SENSITIVE_ACCOUNT when any of `ids` is a transaction touching an
 * account hidden from the current viewer. Service choke points whose ids
 * arrive where `refuseHiddenIds` can't read them (multipart fields) call it.
 */
export async function assertTransactionsVisible(tenantId: string, ids: Iterable<string | null | undefined>): Promise<void> {
  const list = uuidsOf([...ids].filter((x): x is string => typeof x === 'string'));
  if (list.length === 0) return;
  const hidden = await hiddenAccountIds();
  if (await anyHiddenTransaction(tenantId, list, hidden)) throw sensitiveAccountError();
}

/**
 * Generic guard on ids named in the request, for every router (document
 * loaders, their edits, voids, prints, attachments, sends, payment
 * applications, feed matches, merges): while the viewer has hidden accounts,
 *   - a hidden account id in the path is 404 (no existence hint), and
 *   - a transaction id in the path, the query string or anywhere in a JSON
 *     body whose lines touch a hidden account is 403 SENSITIVE_ACCOUNT.
 * Body ids get only the transaction check (a hidden account id in a body is
 * the route's own business: a report filter leaves it out, a write refuses).
 * Multipart bodies are not parsed yet here; their choke points call
 * `assertTransactionsVisible`. Costs nothing when no account is hidden from
 * the viewer.
 */
export async function refuseHiddenIds(req: Request): Promise<void> {
  const [rawPath, rawQuery] = (req.originalUrl ?? req.url).split('?', 2) as [string, string | undefined];
  const pathIds = uuidsOf(segments(rawPath).map((s) => { try { return decodeURIComponent(s); } catch { return s; } }));
  const queryIds = rawQuery ? uuidsOf([...new URLSearchParams(rawQuery).values()].flatMap((v) => v.split(','))) : [];
  const body: unknown = req.body;
  const hasBody = body !== null && typeof body === 'object' && Object.keys(body as object).length > 0;
  if (pathIds.length === 0 && queryIds.length === 0 && !hasBody) return;
  const hidden = await hiddenAccountIdsFor(req);
  if (hidden.length === 0) return;
  if (pathIds.some((id) => hidden.includes(id))) throw AppError.notFound('Not found');
  const ids = [...new Set([...pathIds, ...queryIds, ...(hasBody ? bodyUuids(body) : [])])];
  if (await anyHiddenTransaction(req.tenantId, ids, hidden)) throw sensitiveAccountError();
}

/**
 * Called by `authenticate` once the principal is known. Refuses an
 * unconverted reporting route while the viewer has any hidden account.
 */
export async function refuseUnconvertedReport(req: Request): Promise<void> {
  if (req.method === 'OPTIONS') return;
  // Express routes case-insensitively and ignores empty segments and a
  // trailing slash, so compare on that same normal form.
  const path = '/' + segments((req.originalUrl ?? req.url).split('?')[0]!.toLowerCase()).join('/');
  if (!underRefusePrefix(path) || isConvertedRoute(req.method, path)) return;
  const hidden = await hiddenAccountIdsFor(req);
  if (hidden.length > 0) throw AppError.forbidden(SENSITIVE_HIDDEN_MESSAGE, 'SENSITIVE_HIDDEN');
}
