// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.
/**
 * Log-line helpers that keep personal and financial data out of logs.
 *
 *   accessLogUrl()      the URL morgan prints. Credential query parameters
 *                       and path-segment tokens are always redacted; in
 *                       desktop mode the whole query string is dropped
 *                       (search terms, emails and amounts travel there and
 *                       the log file sits on the owner's disk).
 *   errorSummaryForLog() one compact line for an unhandled error: name,
 *                       code and a short message, plus the cause's, plus
 *                       stack frames. Never the drizzle `params:` list, the
 *                       pg `detail`/`where`/`parameters`, or a quoted input
 *                       value — those carry amounts, names and memo text.
 *                       An AppError with a code prints only its code,
 *                       status and the ids in its details, never its
 *                       message (written for the owner; it can hold amounts).
 *
 * Env-free and dependency-free.
 */

const CREDENTIAL_PARAMS = /([?&](?:token|_dl|code|state|access_token|refresh_token|passphrase|claimToken|claim_token)=)[^&#]*/gi;
const PATH_TOKENS = /^(\/api\/(?:v1\/public\/invoices|reports\/public|w9|bank-connect)\/)[^/?#]+/i;

export function accessLogUrl(raw: string, desktop: boolean): string {
  const base = desktop ? raw.split(/[?#]/, 1)[0]! : raw;
  return base.replace(CREDENTIAL_PARAMS, '$1[redacted]').replace(PATH_TOKENS, '$1[redacted]');
}

const MAX_MESSAGE = 200;
const MAX_FRAMES = 12;

function shortMessage(message: unknown): string {
  if (typeof message !== 'string' || message === '') return '';
  // Drizzle: "Failed query: <sql>\nparams: <values>". The SQL text uses
  // placeholders, but keep the line short and never reach the params.
  if (message.startsWith('Failed query:')) return 'Failed query';
  let first = message.split(/\r?\n/, 1)[0]!;
  // pg echoes rejected input: `invalid input syntax for type numeric: "12x"`.
  first = first.replace(/:\s*"[^"]*"\s*$/, ': "[value]"');
  return first.length > MAX_MESSAGE ? `${first.slice(0, MAX_MESSAGE)}…` : first;
}

const ID_KEY = /^(?:id|ids|.+Id|.+Ids)$/;
const ID_VALUE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The uuid-valued `id` / `…Id` / `ids` / `…Ids` entries of an app error's details, as `key=value`. */
function idParts(details: unknown): string[] {
  if (!details || typeof details !== 'object' || Array.isArray(details)) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(details as Record<string, unknown>)) {
    if (!ID_KEY.test(k)) continue;
    const vals = (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === 'string' && ID_VALUE.test(x));
    if (vals.length > 0) out.push(`${k}=${vals.slice(0, 10).join(',')}${vals.length > 10 ? ',…' : ''}`);
  }
  return out;
}

function describe(e: unknown): string {
  if (e === null || e === undefined) return String(e);
  if (typeof e !== 'object') return typeof e === 'string' ? shortMessage(e) : typeof e;
  const o = e as { name?: unknown; code?: unknown; message?: unknown; statusCode?: unknown; details?: unknown };
  const parts: string[] = [typeof o.name === 'string' ? o.name : 'Error'];
  // An app error with a code (AppError: statusCode + code): the code, its
  // status and the ids in its details only. Its message is written for the
  // owner and can carry amounts and names (SPLITS_DONT_BALANCE,
  // FEED_ITEM_MISMATCH); the code says what happened.
  if (typeof o.statusCode === 'number' && typeof o.code === 'string' && o.code !== '') {
    parts.push(`code=${o.code}`, `status=${o.statusCode}`, ...idParts(o.details));
    return parts.join(' ');
  }
  if (typeof o.code === 'string' || typeof o.code === 'number') parts.push(`code=${o.code}`);
  const msg = shortMessage(o.message);
  if (msg) parts.push(msg);
  return parts.join(' ');
}

export function errorSummaryForLog(err: unknown): string {
  let line = describe(err);
  const cause = (err as { cause?: unknown } | null)?.cause;
  if (cause !== undefined && cause !== null) line += ` (cause: ${describe(cause)})`;
  const stack = (err as { stack?: unknown } | null)?.stack;
  if (typeof stack === 'string') {
    const frames = stack.split(/\r?\n/).filter((l) => /^\s+at /.test(l)).slice(0, MAX_FRAMES);
    if (frames.length > 0) line += `\n${frames.join('\n')}`;
  }
  return line;
}
