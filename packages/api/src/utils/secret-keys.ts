// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Secret-looking object keys, for payloads that mirror table rows (the
 * audit log's before_data / after_data). One pattern serves both sides:
 * `stripSecretKeys` when auditLog() writes, and the SQL function
 * mybooks_strip_secret_keys (migration 0218) when a tenant archive is
 * exported, so the content digest of audit rows agrees on both ends.
 *
 * The pattern is the tenant-portability secret-column rule
 * (plan.ts SECRET_COLUMN_RE) applied to camelCase and snake_case keys,
 * minus LLM token counts (`inputTokens`, `output_tokens`), plus the
 * secret jsonb config column (`remote_backup_config` / `remoteBackupConfig`).
 * It must stay valid in both JavaScript and PostgreSQL ARE syntax.
 */

export const SECRET_KEY_PATTERN =
  '(secret|token(?!s$)|password|pass$|passwd|passphrase|api_?key|encrypted|hash|otp|refresh|credential|remote_?backup_?config)';

export const SECRET_KEY_RE = new RegExp(SECRET_KEY_PATTERN, 'i');

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_RE.test(key);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return Object.prototype.toString.call(v) === '[object Object]';
}

/**
 * Returns a deep copy of `value` without any key that matches
 * SECRET_KEY_RE, at every depth (objects inside arrays included). Scalars,
 * Dates, Buffers and other non-plain objects are returned as they are.
 */
export function stripSecretKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => stripSecretKeys(v)) as unknown as T;
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (isSecretKey(k)) continue;
    out[k] = stripSecretKeys(v);
  }
  return out as T;
}
