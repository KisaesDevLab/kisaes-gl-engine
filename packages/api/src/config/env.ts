// Copyright 2026 Kisaes LLC
// Licensed under the PolyForm Internal Use License 1.0.0.
// You may not distribute this software. See LICENSE for terms.

import { z } from 'zod';

const envSchema = z.object({
  // Require the postgres(ql):// scheme explicitly. z.string().url() accepts
  // any valid URL (including http://), so a typo in the .env file would
  // pass validation and fail later with an opaque driver error.
  DATABASE_URL: z.string().url().refine(
    (v) => /^postgres(ql)?:\/\//i.test(v),
    { message: 'DATABASE_URL must start with postgres:// or postgresql://' },
  ),
  REDIS_URL: z.string().url().refine(
    (v) => /^rediss?:\/\//i.test(v),
    { message: 'REDIS_URL must start with redis:// or rediss://' },
  ),
  JWT_SECRET: z.string().min(20, 'JWT_SECRET must be at least 20 characters for security'),
  JWT_ACCESS_EXPIRY: z.string().default('15m'),
  JWT_REFRESH_EXPIRY: z.string().default('7d'),
  // CLOUDFLARE_TUNNEL_PLAN Phase 3 — idle timeout on admin routes.
  // requireSuperAdmin() rejects tokens older than this. Default 30m
  // means a super-admin who walks away from the appliance will need
  // to re-login before the admin-panel accepts their next click.
  // Normal staff access tokens are governed by JWT_ACCESS_EXPIRY and
  // are automatically refreshed via the refresh cookie; this is an
  // additional, tighter bound that applies only to the admin scope.
  JWT_ADMIN_MAX_AGE: z.string().default('30m'),
  ENCRYPTION_KEY: z.string().min(32, 'ENCRYPTION_KEY must be at least 32 hex characters (16 bytes) — the setup wizard generates a 64-char hex value by default'),
  // PLAID_ENCRYPTION_KEY is used by utils/encryption.ts to wrap Plaid,
  // Stripe, OAuth refresh tokens, TFA secrets, and any other data we
  // store encrypted. Validated here so the app fails at boot — not on
  // first encrypt() call — if the operator forgets to set it.
  PLAID_ENCRYPTION_KEY: z.string().min(32, 'PLAID_ENCRYPTION_KEY must be at least 32 chars (64 hex chars); generate one with crypto.randomBytes(32).toString("hex")'),
  PORT: z.coerce.number().default(3001),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  CORS_ORIGIN: z
    .string()
    .default('http://localhost:5173')
    // Refuse the combination of credentials:true with a wildcard origin.
    // Express allows it, modern browsers reject it, but the intent is so
    // clearly misconfigured that we'd rather fail startup than have the
    // app run with a confused CORS policy.
    .refine((v) => v !== '*', {
      message: 'CORS_ORIGIN must not be "*" because the app sends credentials.',
    }),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().default('noreply@example.com'),
  UPLOAD_DIR: z.string().default('/data/uploads'),
  MAX_FILE_SIZE_MB: z.coerce.number().default(10),
  BCRYPT_ROUNDS: z.coerce.number().default(12),
  TAILSCALE_SOCKET_PATH: z.string().default('/var/run/tailscale/tailscaled.sock'),
  TS_HOSTNAME: z.string().optional(),
  // ADR 0XX feature flag. When on, the ledger service treats
  // journal_lines.tag_id as the authoritative tag source and mirrors
  // the derived set into transaction_tags for legacy read paths. When
  // off (the default during rollout states 1–3), tag_id is written when
  // the caller supplies it but transaction_tags remains authoritative
  // and untouched by the ledger writes.
  TAGS_SPLIT_LEVEL_V2: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1')
    .default('false'),
  // ADR 0XW feature flag. Gates tag-scoped Budget vs. Actuals behavior.
  // When off, tag_id is still written on budget rows by the service
  // layer but report endpoints ignore the scope and return company-wide
  // actuals — matching pre-ADR behavior.
  TAG_BUDGETS_V1: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1')
    .default('false'),
  // CLOUDFLARE_TUNNEL_PLAN Phase 6 — staff IP allowlist. "1" enforces.
  STAFF_IP_ALLOWLIST_ENFORCED: z.enum(['0', '1']).optional().default('0'),
  // CLOUDFLARE_TUNNEL_PLAN Phase 7 — Stripe webhook IP allowlist. "1" enforces.
  STRIPE_WEBHOOK_IP_ALLOWLIST_ENFORCED: z.enum(['0', '1']).optional().default('0'),
  // CLOUDFLARE_TUNNEL_PLAN Phase 4 — opt-in Redis-backed rate limit store.
  RATE_LIMIT_REDIS: z.enum(['0', '1']).optional().default('0'),
  // CLOUDFLARE_TUNNEL_PLAN Phase 1 — disable HIBP breach lookup (tests/offline).
  HIBP_DISABLED: z.enum(['0', '1']).optional().default('0'),
  // Configurable HIBP client timeout (ms). Slow networks may need >3000.
  HIBP_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),
  // Cloudflare Tunnel — optional values come in via admin UI / DB; env
  // overrides cover the headless install case. Both keys are opaque
  // strings; the literal value "disabled" skips Turnstile verification
  // (dev + test only).
  TURNSTILE_SITE_KEY: z.string().optional(),
  TURNSTILE_SECRET_KEY: z.string().optional(),
  // cloudflared sidecar metrics endpoint for status.service. Default
  // matches the compose sidecar (--metrics 0.0.0.0:2000).
  CLOUDFLARED_METRICS_URL: z.string().url().optional(),
  // Minutes the tunnel may stay down before alert.service emits an
  // audit entry. Default 2 minutes.
  CLOUDFLARED_ALERT_THRESHOLD_MS: z.coerce.number().int().positive().default(2 * 60_000),
  // Opt-in: super-admin audit when rate-limit Redis silently fails.
  // When RATE_LIMIT_REDIS=1 but the store can't connect, the app
  // degrades to per-container in-memory counters. Flag defaults to "1"
  // (alert is on) so operators discover the degradation; flip to "0"
  // only if audit noise becomes a problem.
  RATE_LIMIT_REDIS_ALERT: z.enum(['0', '1']).optional().default('1'),
  // Trust-proxy setting — consumed in app.ts. Supports boolean, numeric
  // hop count, or comma-separated CIDR list; default (unset) is
  // "loopback" per Express semantics. Validated as a string so the
  // richer parser in app.ts can interpret it.
  TRUST_PROXY: z.string().optional(),
  // Scheduler observability — structured log level for pino logger.
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  // Backup-verification scheduler cadence. Default 30 days; operators
  // on regulated deployments may tighten.
  BACKUP_VERIFY_INTERVAL_MS: z.coerce.number().int().positive().default(30 * 24 * 60 * 60_000),
  // Version stamp baked into the image by CI (Dockerfile ARG VERSION).
  // Falls back to "dev" for local `docker compose build` and "unknown"
  // when the var is unset entirely (running via tsx from source).
  // Consumed by updates.service to tell operators what they're running.
  VIBE_MYBOOKS_VERSION: z.string().optional(),
  // vibe-distribution-plan §Vibe MyBooks env table.
  //
  // PUBLIC_URL is the canonical externally-visible URL of this app —
  // used to mint absolute links in emails / OAuth redirects / WebAuthn
  // origins. Single-app default points at the dev SPA; multi-app sets
  // it to e.g. https://vibe.local/mybooks. Does NOT need a trailing
  // slash; consumers add one if they need it.
  //
  // refine() restricts to http(s) — z.string().url() also accepts
  // file:// / ftp:// / chrome-extension:// which would produce
  // unusable absolute links if pasted into the env by mistake.
  PUBLIC_URL: z
    .string()
    .url()
    .refine((v) => /^https?:\/\//i.test(v), {
      message: 'PUBLIC_URL must use http:// or https://',
    })
    .default('http://localhost:5173'),
  // COOKIE_PATH narrows the Path attribute on every cookie this app
  // sets. Default '/' matches single-app mode. Multi-app mode sets
  // it to '/mybooks' so cookies don't leak into sibling apps on the
  // same origin (vibe-distribution-plan §multi-app cookie isolation).
  // Consumers append per-cookie sub-paths (e.g. '/api/v1/auth' for
  // the refresh cookie) after this prefix.
  COOKIE_PATH: z
    .string()
    .default('/')
    .transform((v) => (v === '' ? '/' : v))
    // Strip trailing slash so consumers can always concat with a
    // leading-slash sub-path without producing '//api/v1/auth'.
    .transform((v) => (v.length > 1 && v.endsWith('/') ? v.slice(0, -1) : v))
    // Reject anything that wouldn't form a valid Path attribute. Catches
    // typo'd `mybooks` (no leading slash — silently produces a relative
    // cookie path the browser drops) and pathological values containing
    // cookie-attribute separators (`;`), spaces, or non-ASCII. Allow
    // forward-slashes, alphanumerics, dash, underscore, dot.
    .refine((v) => /^\/[A-Za-z0-9_\-./]*$/.test(v), {
      message:
        'COOKIE_PATH must be an absolute path starting with "/" containing only [A-Za-z0-9_-./] (e.g. "/" or "/mybooks").',
    }),
  // COOKIE_SECURE toggles the Secure attribute. Defaults to NODE_ENV
  // production for backward compat with the old refresh-cookie code,
  // but the env var lets multi-app mode force Secure on regardless of
  // NODE_ENV (the front door is always HTTPS in multi-app, even when
  // NODE_ENV=development on the host).
  COOKIE_SECURE: z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v === '') return undefined;
      return v === 'true' || v === '1';
    }),
  // WEBAUTHN_RP_ID is the Relying Party identifier for passkeys.
  // Optional — falls back to URL(PUBLIC_URL).hostname, then 'localhost'.
  // Must match the host the browser is on at registration / sign-in
  // time, or the WebAuthn API will refuse the credential.
  WEBAUTHN_RP_ID: z.string().optional(),
  // License-token plumbing (vibe-distribution-plan D6). Single-app
  // installs and CI run with DISABLE_LICENSE_CHECK=1; production
  // appliances boot with both LICENSE_PUBLIC_KEY (PEM) and
  // LICENSE_TOKEN (RS256 JWT issued by licensing.kisaes.com).
  LICENSE_PUBLIC_KEY: z.string().optional(),
  LICENSE_TOKEN: z.string().optional(),
  // Accept the common boolean-string forms in addition to '0'/'1' so
  // operators can write DISABLE_LICENSE_CHECK=true and not hit a
  // cryptic Zod enum failure at boot. Normalizes to '0'|'1'.
  DISABLE_LICENSE_CHECK: z
    .string()
    .optional()
    .default('0')
    .transform((v) => {
      const lower = v.toLowerCase();
      if (lower === '1' || lower === 'true' || lower === 'yes' || lower === 'on') return '1';
      return '0';
    }),
  // Audience / issuer are env-driven so staging environments can
  // point at a mock licensing server without recompiling. Defaults
  // match the production licensing service.
  LICENSE_AUDIENCE: z.string().default('vibe-mybooks'),
  LICENSE_ISSUER: z.string().default('licensing.kisaes.com'),
  // Clock-skew tolerance in seconds passed to jwt.verify. Default
  // 60s covers normal NTP drift; ops on islanded networks may need
  // higher. Setting 0 reverts to strict.
  LICENSE_CLOCK_TOLERANCE_SECONDS: z.coerce.number().int().nonnegative().default(60),
  // vibe-mybooks-compatibility-addendum §3.4. Standalone keeps
  // auto-migrate on (default) so the existing first-boot story is
  // unchanged. Appliance mode sets MIGRATIONS_AUTO=false and runs
  // migrations as an explicit one-shot container before starting the
  // server, so a failed migration is visible in the appliance's
  // operator UI rather than silently restarting the api container.
  // When false: server refuses to start if pending migrations are
  // detected (operator must run `npm run migrate` first).
  MIGRATIONS_AUTO: z
    .string()
    .optional()
    .default('true')
    .transform((v) => {
      const lower = v.toLowerCase();
      return lower !== 'false' && lower !== '0' && lower !== 'no' && lower !== 'off';
    }),
  // vibe-mybooks-compatibility-addendum §3.6. When true (default),
  // /health includes a `workers` sub-check that fails if no worker
  // heartbeat has landed in Redis within the last 30s. Set to false
  // for deployments that intentionally run only the api container
  // (bare-bones single-tenant installs) so the missing heartbeat
  // doesn't degrade the health probe.
  EXPECT_WORKER: z
    .string()
    .optional()
    .default('true')
    .transform((v) => {
      const lower = v.toLowerCase();
      return lower !== 'false' && lower !== '0' && lower !== 'no' && lower !== 'off';
    }),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  // QA-R2 L3 — ALLOWED_ORIGIN alias. The appliance manifest declares
  // CORS_ORIGIN with `aliases: [ALLOWED_ORIGIN]`, but the appliance's
  // template engine may not honor manifest aliases. If the operator
  // (or an older appliance integration) writes the value as
  // ALLOWED_ORIGIN, accept it as a fallback so the app doesn't
  // silently fall through to the localhost default. Explicit
  // CORS_ORIGIN always wins.
  if (!process.env['CORS_ORIGIN'] && process.env['ALLOWED_ORIGIN']) {
    process.env['CORS_ORIGIN'] = process.env['ALLOWED_ORIGIN'];
  }

  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error('Invalid environment variables:', result.error.flatten().fieldErrors);
    process.exit(1);
  }
  return result.data;
}

export const env = loadEnv();
