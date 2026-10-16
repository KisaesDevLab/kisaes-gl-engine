// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Secret scrubber for text that leaves the process (log lines, fatal
 * messages). Two layers:
 *   1. exact values registered at runtime (the desktop launch token, the
 *      boot secrets, later per-session secrets), longest first;
 *   2. shape-based patterns for credentials that were never registered
 *      (bearer tokens, provider API keys, JWTs, URL userinfo passwords,
 *      the X-CL-Token header).
 *
 * The patterns are deliberately narrow: they only match credential
 * shapes, never plain numbers, so amounts and ids in log lines survive.
 * Env-free and dependency-free so bootstrap can use it before env.ts.
 */

const REDACTED = '[redacted]';
const MIN_SECRET_LENGTH = 8;

const registered = new Set<string>();
let ordered: string[] = [];

function rebuild(): void {
  ordered = [...registered].sort((a, b) => b.length - a.length);
}

/** Register an exact secret value. Values shorter than 8 chars are ignored. */
export function registerSecret(value: string | null | undefined): void {
  if (!value || value.length < MIN_SECRET_LENGTH) return;
  if (registered.has(value)) return;
  registered.add(value);
  rebuild();
}

export function unregisterSecret(value: string | null | undefined): void {
  if (!value || !registered.delete(value)) return;
  rebuild();
}

/** Register the password part of a connection URL (postgres://u:PASS@h/db). */
export function registerUrlPassword(url: string | null | undefined): void {
  if (!url) return;
  try {
    const pw = new URL(url).password;
    if (pw) {
      registerSecret(pw);
      registerSecret(decodeURIComponent(pw));
    }
  } catch {
    /* not a URL — nothing to register */
  }
}

const PATTERNS: Array<[RegExp, string]> = [
  // X-CL-Token: <value> / x-cl-token=<value> (headers dumped into logs)
  [/(x-cl-token["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi, `$1${REDACTED}`],
  // Authorization: Bearer <token>
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/g, `$1${REDACTED}`],
  // Anthropic, then OpenAI-style keys. \b keeps "task-..." untouched.
  [/\bsk-ant-[A-Za-z0-9_-]+/g, REDACTED],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, REDACTED],
  // JWTs (header.payload.signature, header always starts eyJ)
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, REDACTED],
  // scheme://user:password@host
  [/\b([a-z][a-z0-9+.-]*:\/\/[^:/\s@]*:)[^@\s/]+@/gi, `$1${REDACTED}@`],
  // Email addresses (personal data; e.g. SMTP errors echo the recipient).
  // Needs a dot and a letter TLD, so user@127.0.0.1 style strings survive.
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g, '[email]'],
];

export function scrubSecrets(text: string): string {
  let out = text;
  for (const secret of ordered) {
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  }
  for (const [re, replacement] of PATTERNS) {
    out = out.replace(re, replacement);
  }
  return out;
}

/** Test hook. */
export function _resetSecretScrubberForTests(): void {
  registered.clear();
  ordered = [];
}
