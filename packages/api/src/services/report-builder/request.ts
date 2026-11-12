// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// See LICENSE and NOTICE.md for terms.

/**
 * Report Builder run requests (U-119, report-builder-v1): the body of
 * POST /report-builder/run and /run/detail, the fingerprint of a run's
 * parameters, and the opaque detail cursor.
 */

import crypto from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../../utils/errors.js';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const range = z.object({ from: day, to: day }).strict().refine((r) => r.from <= r.to, { message: 'from must not be after to' });
/** A row path: "n:<nodeId>" then up to 3 "<key>:<value>" segments. */
const path = z.array(z.string().min(1).max(80)).min(1).max(4);

export const MAX_PERIODS = 36;
export const MAX_PATHS = 1_000;

const refShape = {
  definition: z.unknown().optional().describe('an inline builder definition (schema v1); or definitionId + version'),
  definitionId: z.string().uuid().optional(),
  version: z.number().int().min(1).optional().describe('the saved version the caller has; another is 409 STALE_VERSION {current}'),
  dates: z.union([
    z.object({ from: day, to: day }).strict(),
    z.object({ asOf: day }).strict(),
  ]).describe('{from, to} for a range report, {asOf} for an as-of report (the definition\'s dates.mode)'),
  periodRanges: z.array(range).min(1).max(MAX_PERIODS).optional()
    .describe('the period columns (columns.periods), resolved by the client from its fiscal calendar; ascending, not overlapping; ≤ 36'),
  compareRanges: z.array(z.array(range).min(1).max(MAX_PERIODS)).max(2).optional()
    .describe('one array per columns.compare entry, parallel to periodRanges (or one range without periods)'),
  fiscalYearStarts: z.array(day).min(1).max(60)
    .describe('the starts of the fiscal years the report touches, ascending; each date uses the latest start on or before it (≤ 371 days)'),
  basis: z.enum(['accrual', 'cash']).optional().describe('overrides the definition; default the definition\'s, else accrual'),
  adjusting: z.enum(['include', 'exclude', 'only']).optional(),
};

export const runRequestSchema = z.object({
  ...refShape,
  open: z.array(path).max(MAX_PATHS).default([]).describe('expanded paths (≤ 1,000); sections with defaultExpanded need no entry'),
  collapsed: z.array(path).max(MAX_PATHS).default([]).describe('paths closed under a defaultExpanded section (≤ 1,000)'),
  expandAll: z.boolean().default(false).describe('every expandable row expanded (bounded by the row caps)'),
  purpose: z.enum(['screen', 'export']).default('screen').describe('export allows 100,000 detail rows instead of 5,000'),
}).strict();
export type RunRequest = z.infer<typeof runRequestSchema>;

export const detailRequestSchema = z.object({
  ...refShape,
  nodeId: z.string().regex(/^[a-z0-9_-]{1,32}$/),
  path,
  range: z.object({ from: day.nullable(), to: day }).strict().refine((r) => r.from === null || r.from <= r.to, { message: 'from must not be after to' }).optional()
    .describe('one column\'s range as the run gave it ({from: null, to} for an as-of column, which matches on to): rows and subtotal of that column only; a range of no column is 400 INVALID_PARAM'),
  cursor: z.string().max(2000).optional(),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  stamp: z.number().int().describe('the stamp of the run the rows were shown in'),
}).strict();
export type DetailRequest = z.infer<typeof detailRequestSchema>;

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, canonical((v as Record<string, unknown>)[k])]));
  }
  return v;
}

/** sha256 of every run parameter except open, collapsed, expandAll and purpose (ranges and compareRanges included). */
export function fingerprintOf(r: Pick<RunRequest, 'definition' | 'definitionId' | 'version' | 'dates' | 'periodRanges' | 'compareRanges' | 'fiscalYearStarts' | 'basis' | 'adjusting'>): string {
  const p = {
    definition: r.definition ?? null, definitionId: r.definitionId ?? null, version: r.version ?? null, dates: r.dates,
    periodRanges: r.periodRanges ?? null, compareRanges: r.compareRanges ?? null, fiscalYearStarts: r.fiscalYearStarts,
    basis: r.basis ?? null, adjusting: r.adjusting ?? null,
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical(p))).digest('hex');
}

/** A detail cursor: the keyset of the last row shown. */
export type Cursor =
  | { k: 'line'; d: string; c: string; t: string; v: string }
  | { k: 'open'; p: string; d: string; n: string; t: string };

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

export function decodeCursor(s: string): Cursor {
  const bad = () => AppError.badRequest('The page cursor is not valid. Run the report again.', 'CURSOR_INVALID');
  let v: unknown;
  try { v = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')); } catch { throw bad(); }
  const o = v as Record<string, unknown>;
  const str = (x: unknown) => typeof x === 'string' && x.length <= 200;
  if (o && o['k'] === 'line' && ['d', 'c', 't', 'v'].every((k) => str(o[k])) && /^\d{4}-\d{2}-\d{2}$/.test(o['d'] as string)) return o as Cursor;
  if (o && o['k'] === 'open' && ['p', 'd', 'n', 't'].every((k) => str(o[k])) && /^\d{4}-\d{2}-\d{2}$/.test(o['d'] as string)) return o as Cursor;
  throw bad();
}

export function runChanged(reason: 'params' | 'books'): AppError {
  return AppError.conflict(
    reason === 'books' ? 'The books changed since this report ran. Refresh the report.' : 'The report settings changed. Run it again.',
    'RUN_CHANGED', { reason },
  );
}
