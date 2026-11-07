// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Dedupe keys v1 for bank file import batches (U-06, bank-import-batch-v1).
 * The engine computes them; a client never sends a key. The rules are pinned
 * by `__fixtures__/dedupe_v1.json`, which this package's tests and the
 * ClientLedger desktop (through the engine submodule) both read, so a later
 * engine or client version can't silently change them. A changed rule is a
 * new version (`v2|…`, dedupe_version 2), never an edit of v1.
 *
 *   norm(s)    Unicode NFC; ASCII a-z upper-cased (nothing else changes
 *              case); every run of TAB, LF, VT, FF, CR, SPACE or NO-BREAK
 *              SPACE (U+00A0) becomes one space; trimmed; cut to 500 code
 *              points.
 *   amount     canonical wire amount: the decimal with exactly 2 places,
 *              feed sign (positive = money out), "-" only when negative.
 *   row_key    sha256 hex of "v1|row|" + date + "|" + amount + "|" +
 *              norm(description) + "|" + ordinal, where ordinal is the
 *              1-based position of the row among the request's rows with
 *              the same (date, amount, norm(description)). No running
 *              balance, no memo.
 *   fitid key  sha256 hex of "v1|fitid|" + fitid with surrounding ASCII
 *              whitespace removed.
 *   OFX description  NAME only, trimmed (owner Q-P25r, 2026-11-07); MEMO
 *              trimmed goes to the row memo and never joins the
 *              description, a key or the fuzzy match.
 */

import { createHash } from 'node:crypto';
import DecimalLib from 'decimal.js';

const BaseDecimal = DecimalLib.default || DecimalLib;
/** decimal.js with room for any sum of batch amounts (Σ < 10^15, 2 places). */
export const Decimal = BaseDecimal.clone({ precision: 40, rounding: BaseDecimal.ROUND_HALF_UP });
export type Decimal = InstanceType<typeof Decimal>;

export const DEDUPE_VERSION = 1;
export const NORM_MAX_CODE_POINTS = 500;

const WS_RUN = /[\t\n\v\f\r  ]+/g;
const ASCII_LOWER = /[a-z]/g;

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/** Trims ASCII whitespace (and U+00A0) only, the same set norm() collapses. */
function trimWs(s: string): string {
  return s.replace(/^[\t\n\v\f\r  ]+|[\t\n\v\f\r  ]+$/g, '');
}

export function norm(s: string): string {
  const collapsed = trimWs(s.normalize('NFC').replace(ASCII_LOWER, (c) => c.toUpperCase()).replace(WS_RUN, ' '));
  const cps = Array.from(collapsed);
  return cps.length > NORM_MAX_CODE_POINTS ? cps.slice(0, NORM_MAX_CODE_POINTS).join('') : collapsed;
}

/** The canonical wire amount: exactly 2 places. The caller validated the input. */
export function canonicalAmount(amount: string): string {
  return new Decimal(amount).toFixed(2);
}

export function rowKey(date: string, canonical: string, normDescription: string, ordinal: number): string {
  return sha256Hex(`v1|row|${date}|${canonical}|${normDescription}|${ordinal}`);
}

export function fitidKey(fitid: string): string {
  return sha256Hex(`v1|fitid|${trimWs(fitid)}`);
}

/** OFX/QFX description: NAME only, trimmed (owner Q-P25r). MEMO never joins it. */
export function ofxDescription(name: string | null | undefined): string {
  return trimWs(name ?? '');
}

/** OFX/QFX memo: MEMO trimmed, null when empty (owner Q-P25r). Not part of any key. */
export function ofxMemo(memo: string | null | undefined): string | null {
  const m = trimWs(memo ?? '');
  return m.length > 0 ? m : null;
}

export interface KeyedRow {
  canonicalAmount: string;
  normDescription: string;
  ordinal: number;
  rowKey: string;
}

/** Keys for every request row, in request order (ordinals count within the request). */
export function keyRows(rows: ReadonlyArray<{ date: string; amount: string; description: string }>): KeyedRow[] {
  const seen = new Map<string, number>();
  return rows.map((r) => {
    const canonical = canonicalAmount(r.amount);
    const d = norm(r.description);
    const group = `${r.date}|${canonical}|${d}`;
    const ordinal = (seen.get(group) ?? 0) + 1;
    seen.set(group, ordinal);
    return { canonicalAmount: canonical, normDescription: d, ordinal, rowKey: rowKey(r.date, canonical, d, ordinal) };
  });
}

/** Trimmed FITID, or null when absent or blank. */
export function cleanFitid(fitid: string | null | undefined): string | null {
  if (typeof fitid !== 'string') return null;
  const t = trimWs(fitid);
  return t.length > 0 ? t : null;
}
