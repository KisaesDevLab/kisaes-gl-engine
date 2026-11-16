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

/**
 * Generic guard on ids named in the URL, for every router (document loaders,
 * their edits, voids, prints, attachments, sends): while the viewer has
 * hidden accounts,
 *   - a hidden account id in the path is 404 (no existence hint), and
 *   - a transaction id in the path or query string whose lines touch a
 *     hidden account is 403 SENSITIVE_ACCOUNT.
 * Costs nothing when no account is hidden from the viewer.
 */
export async function refuseHiddenIds(req: Request): Promise<void> {
  const [rawPath, rawQuery] = (req.originalUrl ?? req.url).split('?', 2) as [string, string | undefined];
  const pathIds = uuidsOf(segments(rawPath).map((s) => { try { return decodeURIComponent(s); } catch { return s; } }));
  const queryIds = rawQuery ? uuidsOf([...new URLSearchParams(rawQuery).values()].flatMap((v) => v.split(','))) : [];
  if (pathIds.length === 0 && queryIds.length === 0) return;
  const hidden = await hiddenAccountIdsFor(req);
  if (hidden.length === 0) return;
  if (pathIds.some((id) => hidden.includes(id))) throw AppError.notFound('Not found');
  const ids = [...new Set([...pathIds, ...queryIds])];
  const rows = await db.execute(sql`
    SELECT 1 FROM journal_lines
    WHERE tenant_id = ${req.tenantId} AND transaction_id = ANY(${uuidArray(ids)})
      AND account_id = ANY(${uuidArray(hidden)})
    LIMIT 1`);
  if (rows.rows.length > 0) throw sensitiveAccountError();
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
