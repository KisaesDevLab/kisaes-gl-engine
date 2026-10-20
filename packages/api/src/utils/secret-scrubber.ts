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

/**
 * Register an exact secret value. Values shorter than `minLength` (default
 * 8) are ignored: a very short value would redact ordinary text. The
 * JSON-escaped form (how the value appears inside a logged JSON body, e.g.
 * with `"` or `\` escaped) is registered too.
 */
export function registerSecret(value: string | null | undefined, minLength: number = MIN_SECRET_LENGTH): void {
  if (!value || value.length < Math.max(1, minLength)) return;
  if (registered.has(value)) return;
  registered.add(value);
  const escaped = JSON.stringify(value).slice(1, -1);
  if (escaped !== value) registered.add(escaped);
  rebuild();
}

/** Environment variable names whose values are treated as secrets. */
export const SECRET_ENV_NAME = /KEY|SECRET|PASS|TOKEN/i;

/**
 * Register the value of every environment variable whose name looks like
 * a credential (SECRET_ENV_NAME), e.g. a provider API key passed to the
 * engine. Plain numbers and booleans are skipped (TTLs, sizes, flags), so
 * amounts in log lines are never redacted by accident.
 */
export function registerEnvSecrets(env: NodeJS.ProcessEnv = process.env): void {
  for (const [name, value] of Object.entries(env)) {
    if (!value || !SECRET_ENV_NAME.test(name)) continue;
    const v = value.trim();
    if (/^-?\d+(\.\d+)?$/.test(v) || /^(true|false|yes|no|on|off)$/i.test(v)) continue;
    registerSecret(value);
  }
}

export function unregisterSecret(value: string | null | undefined): void {
  if (!value || !registered.delete(value)) return;
  registered.delete(JSON.stringify(value).slice(1, -1));
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
  // Authorization: Bearer <token> (any case: "bearer", "BEARER")
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, `$1${REDACTED}`],
  // Anthropic, then OpenAI-style keys. \b keeps "task-..." untouched.
  [/\bsk-ant-[A-Za-z0-9_-]+/g, REDACTED],
  [/\bsk-[A-Za-z0-9_-]{8,}/g, REDACTED],
  // Stripe secret / restricted keys.
  [/\b[rs]k_(?:live|test)_[A-Za-z0-9]{10,}/g, REDACTED],
  // Google API keys.
  [/\bAIza[0-9A-Za-z_-]{35}/g, REDACTED],
  // AWS access key ids (long-term and temporary).
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED],
  // Slack tokens.
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, REDACTED],
  // GitHub tokens (classic prefixes and fine-grained).
  [/\bgh[pousr]_[A-Za-z0-9]{36,}/g, REDACTED],
  [/\bgithub_pat_[A-Za-z0-9_]{22,}/g, REDACTED],
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
