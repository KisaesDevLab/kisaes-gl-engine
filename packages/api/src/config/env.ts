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
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error('Invalid environment variables:', result.error.flatten().fieldErrors);
    process.exit(1);
  }
  return result.data;
}

export const env = loadEnv();
