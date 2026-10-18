// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Per-session secrets for desktop mode (CL_MODE=desktop, U-09/U-11/U-13).
 *
 * The desktop app keeps the owner's AI keys and SMTP password in the OS
 * keychain and hands them to the engine for the lifetime of the process
 * through PUT /api/v1/desktop/session-secrets. They live only in this
 * module's Map: never in ai_config, companies.smtp_pass, settings, files
 * or logs. The process exit drops them; `clearAllSessionSecrets()` does the
 * same on graceful shutdown.
 *
 * Setting a secret has two side effects, both undone when it is deleted:
 *   - the value is registered with the secret scrubber (not the Ollama
 *     base URL, which is not a secret);
 *   - the feature's hosts are added to the egress allowlist, following
 *     docs/DESKTOP.md "Rules for features that open egress": cloud AI hosts
 *     come from a fixed table, an Ollama base URL is validated first, and
 *     the SMTP server the owner names with the password is validated
 *     (`allowSmtpEgress`) before it is allowed. A host the owner did not
 *     name stays blocked (EGRESS_BLOCKED), whatever the stored settings say.
 *
 * On the server this module is never populated: resolveCredential() and
 * the mail transport only consult it in desktop mode.
 */

import crypto from 'node:crypto';
import { AppError } from '../utils/errors.js';
import { registerSecret } from '../utils/secret-scrubber.js';
import { assertExternalUrlSafe, assertHostSafe, classifyIpLiteral } from '../utils/url-safety.js';
import net from 'node:net';
import { targetFromUrl, isLoopbackAddress } from '../utils/offline.js';
import { clearEgressAllowance, setEgressAllowance } from './egress-guard.js';

export const SESSION_SECRET_NAMES = ['ai.anthropic', 'ai.openai', 'ai.ollama.baseUrl', 'smtp.password'] as const;
export type SessionSecretName = (typeof SESSION_SECRET_NAMES)[number];

/**
 * Fixed hosts of the cloud AI providers the desktop edition offers. Never
 * taken from a request body or a stored setting (DESKTOP.md egress rules).
 */
export const CLOUD_AI_EGRESS: Readonly<Record<'anthropic' | 'openai', { host: string; port: number }>> = {
  anthropic: { host: 'api.anthropic.com', port: 443 },
  openai: { host: 'api.openai.com', port: 443 },
};

/** SMTP ports a session may open (DESKTOP.md egress rules). */
export const SMTP_EGRESS_PORTS: ReadonlySet<number> = new Set([25, 465, 587, 2525]);

export type SmtpSecurity = 'tls' | 'starttls' | 'none';

export interface SessionSmtpServer {
  host: string;
  port: number;
  security: SmtpSecurity;
}

const store = new Map<SessionSecretName, string>();
// Non-secret companion of ai.ollama.baseUrl: the model the owner picked.
let ollamaModel: string | null = null;
// Non-secret companion of smtp.password: the mail server the owner named.
let smtpServer: SessionSmtpServer | null = null;

/**
 * A host on this machine or the owner's own network: loopback, RFC 1918,
 * CGNAT (100.64/10), IPv6 ULA, exactly `localhost`, or a `.local` name.
 * Other names cannot be verified without DNS, so they do not count.
 */
export function isLocalNetworkHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.local')) return true;
  if (!net.isIP(h)) return false;
  const cls = classifyIpLiteral(h);
  return cls === 'loopback' || cls === 'private';
}

export function isSessionSecretName(name: string): name is SessionSecretName {
  return (SESSION_SECRET_NAMES as readonly string[]).includes(name);
}

export function getSessionSecret(name: SessionSecretName): string | null {
  return store.get(name) ?? null;
}

export function hasSessionSecret(name: SessionSecretName): boolean {
  return store.has(name);
}

/** The Ollama model chosen with the base URL, or null. */
export function getSessionOllamaModel(): string | null {
  return ollamaModel;
}

/** `sha256:` + the first 8 hex characters of SHA-256(value). Never the value. */
export function fingerprint(value: string): string {
  return `sha256:${crypto.createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 8)}`;
}

export interface SessionSecretStatus {
  present: boolean;
  fingerprint?: string;
}

/** Status of every known name; values never leave the store. */
export function sessionSecretStatus(): Record<SessionSecretName, SessionSecretStatus> {
  const out = {} as Record<SessionSecretName, SessionSecretStatus>;
  for (const name of SESSION_SECRET_NAMES) {
    const v = store.get(name);
    out[name] = v === undefined ? { present: false } : { present: true, fingerprint: fingerprint(v) };
  }
  return out;
}

function setCloudKey(name: 'ai.anthropic' | 'ai.openai', apiKey: string): void {
  const provider = name === 'ai.anthropic' ? 'anthropic' : 'openai';
  registerSecret(apiKey);
  store.set(name, apiKey);
  setEgressAllowance(name, [CLOUD_AI_EGRESS[provider]]);
}

export function setAnthropicKey(apiKey: string): void {
  setCloudKey('ai.anthropic', apiKey);
}

export function setOpenaiKey(apiKey: string): void {
  setCloudKey('ai.openai', apiKey);
}

/**
 * Validate an Ollama base URL for the session: http/https only, no
 * credentials in the URL, no link-local or metadata addresses (loopback
 * and LAN addresses are allowed: the owner chose them). Returns the
 * normalized server root.
 */
export function validateOllamaBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    throw AppError.badRequest('Ollama base URL is not a valid URL', 'OLLAMA_URL_INVALID');
  }
  if (u.username || u.password) {
    throw AppError.badRequest('Ollama base URL must not contain credentials', 'OLLAMA_URL_INVALID');
  }
  try {
    assertExternalUrlSafe(trimmed, 'Ollama base URL', { allowPrivate: true });
  } catch (err) {
    throw AppError.badRequest(err instanceof Error ? err.message : 'Ollama base URL is not allowed', 'OLLAMA_URL_INVALID');
  }
  // An Ollama elsewhere is a cloud provider, not a local model: it would
  // bypass consent, the token cap and the redaction backstop. Desktop mode
  // only accepts this machine or the owner's own network.
  if (!isLocalNetworkHost(u.hostname)) {
    throw AppError.badRequest(
      'Ollama base URL must point at this computer or your own network (localhost, a private address or a .local name).',
      'OLLAMA_HOST_NOT_LOCAL',
    );
  }
  return trimmed.replace(/\/+$/, '').replace(/\/v1$/i, '');
}

/** Set the session Ollama endpoint; validated before its host is allowed. */
export function setOllamaBaseUrl(raw: string, model?: string | null): string {
  const baseUrl = validateOllamaBaseUrl(raw);
  store.set('ai.ollama.baseUrl', baseUrl);
  ollamaModel = model && model.trim() !== '' ? model.trim() : null;
  const target = targetFromUrl(baseUrl);
  // Loopback is always allowed by the guard; a LAN box is the owner's
  // explicit choice (this call) and is allowed on that port only.
  if (isLoopbackAddress(target.host)) clearEgressAllowance('ai.ollama');
  else setEgressAllowance('ai.ollama', [target]);
  return baseUrl;
}

export function setSmtpPassword(password: string): void {
  registerSecret(password);
  store.set('smtp.password', password);
  // The mail server is allowed separately (allowSmtpEgress, from the same
  // PUT); clearing the password removes that allowance.
}

/** The mail server named with the session password, or null. */
export function getSessionSmtpServer(): SessionSmtpServer | null {
  return smtpServer;
}

/**
 * Allow outbound SMTP to `host:port` for this session: the owner's
 * explicit choice, made in the same request as the password. The host
 * must pass the SMTP host safety check (no loopback, link-local or
 * metadata names or addresses; LAN relays allowed) and the port must be
 * a mail port. Loopback relays need no allowance and are accepted as-is.
 * Replaces any previous SMTP allowance (one mail server per session).
 */
export async function allowSmtpEgress(target: { host: string; port: number; security?: SmtpSecurity }): Promise<void> {
  const security: SmtpSecurity = target.security ?? (target.port === 465 ? 'tls' : 'starttls');
  const local = isLocalNetworkHost(target.host);
  // Clear-text SMTP (no TLS at all) only to this machine or the owner's
  // own network; the password would otherwise cross the internet in clear.
  if (security === 'none' && !local) {
    throw AppError.badRequest(
      'Sending without TLS is only allowed to a mail server on this computer or your own network. Choose TLS or STARTTLS.',
      'SMTP_SECURITY_REQUIRED',
    );
  }
  if (!isLoopbackAddress(target.host)) {
    if (!SMTP_EGRESS_PORTS.has(target.port)) {
      throw AppError.badRequest(`SMTP port ${target.port} is not allowed (use 25, 465, 587 or 2525)`, 'SMTP_HOST_BLOCKED');
    }
    try {
      await assertHostSafe(target.host, 'SMTP host', { allowPrivate: true });
    } catch (err) {
      throw AppError.badRequest(err instanceof Error ? err.message : 'SMTP host is not allowed', 'SMTP_HOST_BLOCKED');
    }
    setEgressAllowance('smtp', [{ host: target.host, port: target.port }]);
  } else {
    clearEgressAllowance('smtp');
  }
  smtpServer = { host: target.host.trim(), port: target.port, security };
}

/**
 * Remove one secret and its egress allowance. The scrubber keeps the
 * value registered: a late error mentioning it must still be redacted.
 */
export function deleteSessionSecret(name: SessionSecretName): boolean {
  const existed = store.delete(name);
  switch (name) {
    case 'ai.anthropic':
    case 'ai.openai':
      clearEgressAllowance(name);
      break;
    case 'ai.ollama.baseUrl':
      ollamaModel = null;
      clearEgressAllowance('ai.ollama');
      break;
    case 'smtp.password':
      smtpServer = null;
      clearEgressAllowance('smtp');
      break;
  }
  return existed;
}

/** Drop every secret and allowance (graceful shutdown, tests). */
export function clearAllSessionSecrets(): void {
  for (const name of SESSION_SECRET_NAMES) deleteSessionSecret(name);
}
