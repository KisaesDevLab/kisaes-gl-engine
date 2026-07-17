// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Small Business License 1.0.0.
// Free for small businesses; see LICENSE for terms.

/**
 * Well-known keys for the `system_settings` k/v table. Prefer these constants
 * over string literals so refactors are typecheck-safe.
 */
export const SystemSettingsKeys = {
  /**
   * The installation UUID generated during first-run setup. Written once and
   * never changed (rotation is a Phase B feature). Authoritative source for
   * "this DB has been set up" — used by installation-validator.ts to detect
   * database-reset scenarios where the encrypted sentinel file at
   * /data/.sentinel survived.
   */
  INSTALLATION_ID: 'installation_id',
  /**
   * Cloudflare Turnstile keys set via the admin UI. When present, they take
   * precedence over the TURNSTILE_SITE_KEY / TURNSTILE_SECRET_KEY env vars
   * — lets operators rotate keys via the admin panel without editing .env
   * and restarting. See CLOUDFLARE_TUNNEL_PLAN Phase 9.
   *
   * Secret is stored as-is (the values are low-risk — CF publishes the site
   * key publicly, and the secret key is scoped to a single Turnstile widget
   * that's already bounded by the firm's domain allowlist on the CF side).
   * Future hardening can wrap this with the existing encrypt() helper.
   */
  TURNSTILE_SITE_KEY: 'turnstile_site_key',
  TURNSTILE_SECRET_KEY: 'turnstile_secret_key',
  /**
   * Whether public sign-up via POST /api/v1/auth/register is allowed.
   * Default `'true'` (preserves the open-registration behavior the app
   * shipped with). When set to `'false'`, the API rejects /register
   * with 403 REGISTRATION_DISABLED and the LoginPage hides the "Don't
   * have an account? Sign up" link.
   *
   * Note: the first-run flow (POST /api/setup/install) is unaffected —
   * that endpoint creates the bootstrap admin via a separate router and
   * doesn't consult this setting. So an operator can safely flip this
   * off on a fresh install before any admin exists; the wizard still
   * works.
   *
   * Stored as the literal strings `'true'` / `'false'` to match the
   * other settings in this k/v table.
   */
  REGISTRATION_ENABLED: 'registration_enabled',
  /**
   * Whether a non-firm user may create additional tenants for themselves
   * via POST /api/v1/auth/create-tenant ("New Business (separate books)"
   * in the company switcher). Default OFF — only the literal `'true'`
   * enables it: unlike REGISTRATION_ENABLED this is a new capability, so
   * absent-row and degraded-DB scenarios must not silently grant it.
   * Staff create-client flows (/auth/create-client) are unaffected.
   */
  SELF_SERVICE_TENANT_CREATION: 'self_service_tenant_creation',
  /**
   * Cap on the TOTAL number of tenants a user may own (active 'owner'
   * rows in user_tenant_access, so the signup home tenant counts).
   * Stored as a decimal string; `'0'` means unlimited; absent → '3'.
   */
  SELF_SERVICE_TENANT_LIMIT: 'self_service_tenant_limit',
} as const;

export type SystemSettingsKey = (typeof SystemSettingsKeys)[keyof typeof SystemSettingsKeys];
