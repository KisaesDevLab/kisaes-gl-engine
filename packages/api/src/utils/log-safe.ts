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

function describe(e: unknown): string {
  if (e === null || e === undefined) return String(e);
  if (typeof e !== 'object') return typeof e === 'string' ? shortMessage(e) : typeof e;
  const o = e as { name?: unknown; code?: unknown; message?: unknown };
  const parts: string[] = [typeof o.name === 'string' ? o.name : 'Error'];
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
