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
import { clearEgressAllowance, exemptDnsLookup, setEgressAllowance } from './egress-guard.js';

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

const CGNAT_V4 = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;

/** A loopback, RFC 1918 or IPv6 ULA address (not CGNAT, which is carrier space). */
export function isLocalNetworkAddress(address: string): boolean {
  const a = address.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!net.isIP(a)) return false;
  if (CGNAT_V4.test(a)) return false;
  const cls = classifyIpLiteral(a);
  return cls === 'loopback' || cls === 'private';
}

/**
 * A host on this machine or the owner's own network by its spelling:
 * exactly `localhost`, a `.local` name (resolved and checked by
 * assertLocalNetworkHost before it is accepted), or a local address.
 * Other names cannot be verified without DNS, so they do not count.
 */
export function isLocalNetworkHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.local')) return true;
  return isLocalNetworkAddress(h);
}

// Resolver for owner-named hosts (bypasses the guard; see exemptDnsLookup).
let dnsLookup: (host: string) => Promise<Array<{ address: string }>> = exemptDnsLookup;

/** Test hook: replace the resolver (null restores the default). */
export function _setDnsLookupForTests(fn: ((host: string) => Promise<Array<{ address: string }>>) | null): void {
  dnsLookup = fn ?? exemptDnsLookup;
}

/**
 * Accept `host` as local-network: `localhost` and local addresses as they
 * are; a `.local` name only when it resolves (every answer loopback or
 * private, none CGNAT); anything else is refused with `code`.
 */
async function assertLocalNetworkHost(host: string, code: string, message: string): Promise<void> {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || isLocalNetworkAddress(h)) return;
  if (h.endsWith('.local')) {
    const answers = await dnsLookup(h).catch(() => [] as Array<{ address: string }>);
    if (answers.length > 0 && answers.every((a) => isLocalNetworkAddress(a.address))) return;
  }
  throw AppError.badRequest(message, code);
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
 * credentials in the URL, no link-local or metadata addresses, and a host
 * on this machine or the owner's own network (a `.local` name is resolved
 * and every address checked). Returns the normalized server root.
 */
export async function validateOllamaBaseUrl(raw: string): Promise<string> {
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
  await assertLocalNetworkHost(
    u.hostname,
    'OLLAMA_HOST_NOT_LOCAL',
    'Ollama base URL must point at this computer or your own network (localhost, a private address or a .local name that resolves to one).',
  );
  return trimmed.replace(/\/+$/, '').replace(/\/v1$/i, '');
}

/** Set the session Ollama endpoint; validated before its host is allowed. */
export async function setOllamaBaseUrl(raw: string, model?: string | null): Promise<string> {
  const baseUrl = await validateOllamaBaseUrl(raw);
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
  // Clear-text SMTP (no TLS at all) only to this machine or the owner's
  // own network; the password would otherwise cross the internet in clear.
  if (security === 'none') {
    await assertLocalNetworkHost(
      target.host,
      'SMTP_SECURITY_REQUIRED',
      'Sending without TLS is only allowed to a mail server on this computer or your own network. Choose TLS or STARTTLS.',
    );
  }
  if (!isLoopbackAddress(target.host)) {
    if (!SMTP_EGRESS_PORTS.has(target.port)) {
      throw AppError.badRequest(`SMTP port ${target.port} is not allowed (use 25, 465, 587 or 2525)`, 'SMTP_HOST_BLOCKED');
    }
    try {
      // A name is resolved past the guard (it is not allowed yet) and must
      // yield at least one address; link-local, metadata, reserved and
      // loopback answers are refused like literals.
      await assertHostSafe(target.host, 'SMTP host', { allowPrivate: true, lookup: dnsLookup, failClosed: true });
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
