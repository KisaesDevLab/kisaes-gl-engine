# Desktop mode (`CL_MODE=desktop`)

Desktop mode runs the engine as a local sidecar of a desktop app (ClientLedger) instead of as the server appliance. It needs only PostgreSQL. There is no Redis, no worker container, no web bundle, and no browser client.

Everything here is gated by `CL_MODE=desktop` or by an option that defaults to today's server behavior. With `CL_MODE` unset, the appliance behaves exactly as before:

- `env.ts` parses a server environment to the same values.
- The Express route table is identical.
- BullMQ stays the default queue backend.
- `/health` keeps every field and its 200/503 logic.

The code lives in `packages/api/src/desktop/`, `middleware/desktop-gate.ts`, `routes/desktop.routes.ts`, `queue/none.adapter.ts` and `utils/health.ts`.

## Environment contract

| Variable | Desktop | Default / rule |
|---|---|---|
| `CL_MODE` | `desktop` | Unset or `server` means server mode. Any other value is a fatal `CL_MODE_INVALID`. |
| `CL_BIND` | required | `<ipv4>:<port>` or `[<ipv6>]:<port>`, IP literals only. Port `0` lets the OS pick; the real port is in the ready line. Without `CL_LAN=1`, a non-loopback address is refused (`CL_BIND_NOT_LOOPBACK`). Loopback means 127.0.0.0/8 or `::1`. |
| `CL_TOKEN` | required | Launch token: at least 43 base64url characters or 64 hex (≥ 256 bits). Read once. Only its SHA-256 digest is kept for comparison, and it is deleted from `process.env`, so child processes (e.g. `pdftoppm`) never inherit it. Pass it in the environment, never on the command line. |
| `CL_DATA_DIR` | required | Defaults the following when they are not set explicitly: `DATA_DIR` (= `CL_DATA_DIR`), `UPLOAD_DIR` (`uploads`), `BACKUP_DIR` (`backups`), `CONFIG_DIR` (`config`), `STORAGE_CACHE_DIR` (`cache`), `CL_ARCHIVE_DIR` (`archives`). |
| `CL_LOG_FILE` | optional | Append scrubbed stdout/stderr to this file (see Logging). |
| `CL_LOG_MAX_BYTES` | optional | Rotation size. Default 10 MiB. |
| `CL_LOG_KEEP` | optional | Rotated files kept (`file.1` … `file.N`). Default 5. |
| `CL_OFFLINE` | optional | `auto` (default), `on` or `off`. Recorded in the profile and in `/api/v1/desktop/info`. Connectivity probing comes in a later change, so for now `online` on `/health` is always `null`. |
| `CL_LAN` | optional | `1` allows a non-loopback `CL_BIND`. No TLS yet. |
| `CL_REQUIRE_NON_SUPERUSER` | optional | `1` refuses to start when the database role is a superuser (see Database role). Off by default: the engine only warns. |
| `QUEUE_BACKEND` | generic | `bullmq` (server default) or `none`. Desktop defaults to `none`, and `bullmq` is refused there. |
| `ENGINE_COMMIT` | generic | Source commit reported on `/health` (`null` when unset). Set it at build time. |
| `DATABASE_URL`, `JWT_SECRET`, `ENCRYPTION_KEY`, `PLAID_ENCRYPTION_KEY` | required | Unchanged. The desktop app supplies them from the OS keychain. In desktop mode the engine never writes them to disk. |
| `REDIS_URL` | ignored | Required only when something uses Redis: `QUEUE_BACKEND=bullmq` (the server default), `RATE_LIMIT_REDIS=1` or `SHARE_ENABLED`. |

Desktop mode also forces `HIBP_DISABLED=1`, `EXPECT_WORKER=false`, `SHARE_ENABLED=false`, `QUEUE_BACKEND=none` and `PORT=<CL_BIND port>`. It refuses `RATE_LIMIT_REDIS=1` and `VIBE_AI_MODE=router` (`CL_ENV_CONFLICT`). Set `NODE_ENV=production`.

## Startup sequence

1. `desktop/profile.ts` validates the contract and applies the defaults above, before `config/env.ts` or anything that reads directory variables is imported.
2. The launch token, `JWT_SECRET`, `ENCRYPTION_KEY`, `PLAID_ENCRYPTION_KEY` and the `DATABASE_URL` password are registered with the secret scrubber. Then the log tee is installed.
3. The required variables are checked, then `env.ts` validates.
4. Desktop preflight runs the same migration step as the server (`MIGRATIONS_AUTO` is honored), then checks the database role. It skips the appliance's sentinel and host-id checks, because the desktop app owns install identity and restores its own database cluster.
5. The normal app starts and listens on `CL_BIND`. Once listening, it prints exactly one ready line on stdout:

   ```
   {"event":"listening","host":"127.0.0.1","port":54321}
   ```

The env-missing and diagnostic fallback apps of the appliance are never started in desktop mode.

### Startup failures

Any startup problem produces one JSON line on stderr and an exit code:

```
{"event":"fatal","code":"CL_BIND_NOT_LOOPBACK","message":"..."}
```

| Exit | Meaning | Codes |
|---|---|---|
| 78 (`EX_CONFIG`) | Configuration or preflight problem. Restarting will not help. | `CL_MODE_INVALID`, `CL_TOKEN_REQUIRED`, `CL_TOKEN_INVALID`, `CL_BIND_REQUIRED`, `CL_BIND_INVALID`, `CL_BIND_NOT_LOOPBACK`, `CL_DATA_DIR_REQUIRED`, `CL_ENV_INVALID`, `CL_ENV_CONFLICT`, `QUEUE_BACKEND_INVALID`, `ENV_MISSING`, `ENV_INVALID`, `MIGRATIONS_PENDING`, `DATABASE_AHEAD`, `UNKNOWN` (migration failure), `DB_ROLE_UNREADABLE`, `DB_SUPERUSER_FORBIDDEN` |
| 1 | Runtime failure. A retry may help. | `BIND_FAILED` (e.g. port in use), `STARTUP_FAILED` |

Messages are scrubbed and name variables, never values.

## Transport security: the desktop gate

`middleware/desktop-gate.ts` is the first middleware in `app.ts`. It runs before helmet, CORS, the raw-body webhook routers and every route. It has no exemptions: `/health`, `/ping`, `OPTIONS` and `/api/setup/status` all need the token.

| Check (in order) | Result |
|---|---|
| Any `Origin` header | 403 `ORIGIN_NOT_ALLOWED` (no browser clients; blocks CSRF and DNS rebinding) |
| `Host` is not the bound `host:port` or `localhost:port` | 421 `HOST_NOT_ALLOWED`. With `CL_LAN=1` bound to all interfaces, only the port is checked. |
| `X-CL-Token` missing or wrong | 401 `DESKTOP_TOKEN_REQUIRED` (same body for both cases; constant-time compare of SHA-256 digests) |

The token proves only "this is the desktop app". User identity is unchanged: log in with `POST /api/v1/auth/login` and send the JWT as `Authorization: Bearer …` alongside `X-CL-Token`. Roles, per-route auth and the per-route rate limiters all apply. Only the global per-IP limiter is skipped for gated requests, because every desktop request comes from 127.0.0.1.

## Desktop endpoints

Mounted at `/api/v1/desktop` in desktop mode only. On the server they return 404 `NOT_FOUND`.

| Method | Path | Body / response |
|---|---|---|
| POST | `/initialize` | Body: `{"admin":{"email","displayName","password"(≥12)},"company":{"name","businessType"?,"entityType"?,"industry"?}}`. Response: 201 `{"tenantId","userId"}`. Creates the owner (super admin) and the first company, with the chart of accounts from `businessType` (default `default`). Writes no `.env` and no sentinel; only the non-secret `CONFIG_DIR/.initialized` marker. Errors: 409 `ALREADY_INITIALIZED` once a user exists, 409 `TENANTS_WITHOUT_USERS` for restored data with no users, 409 `SETUP_BUSY` while another run holds the setup lock, 400 `VALIDATION_ERROR`. |
| GET | `/info` | `{"mode","version","engineCommit","queueBackend","offline","lan","dataDirExists","dbSuperuser","initialized"}` |

`/api/setup/*` is not available in desktop mode, except `GET /api/setup/status`.

## Feature profile

`desktop/features.ts` is the single source of truth. `app.ts` mounts these families through `serverOnly()`, which refuses any path missing from the table.

**Route families not mounted.** Requests to them get 404 `NOT_AVAILABLE_IN_DESKTOP`:

| Prefix | Why |
|---|---|
| `/api/v1/stripe` | Stripe webhooks (online payments) |
| `/api/v1/plaid` (incl. `/webhooks`) | Plaid bank feeds (online) |
| `/api/sms/inbound` | Inbound SMS webhooks |
| `/api/setup` (except `/status`) | Appliance setup wizard; replaced by `/api/v1/desktop/initialize` |
| `/api/v1/public/invoices` | Public invoice payment links |
| `/api/reports/public` | Public report share links |
| `/api/portal` | Client portal |
| `/api/w9` | Public W-9 links |
| `/api/bank-connect` | Public bank-connect links |
| `/api/peer/pm` | Vibe Practice Management peer API |
| `/mcp` | MCP server |
| `/oauth` | OAuth provider for third-party apps |
| `/api/v1/share` | Peer screen share (needs Redis) |
| `/api/v1/admin/tailscale` | Tailscale remote access |
| `/api/v1/remote-backup` | Cloud backup targets; the desktop app owns backups |
| `/api/v1/settings/storage` | Cloud file storage providers |
| `/api/docs` | Swagger UI |

The static web bundle and SPA fallback are never served. Any non-API path returns a JSON 404.

**Schedulers.** Each `start*` function was checked for outbound calls and `DATA_DIR` use:

| Scheduler | Desktop | Notes |
|---|---|---|
| Recurring transactions (+ session prune) | on | Database only, advisory-locked |
| DB fingerprint | on | Writes `DATA_DIR/.db-fingerprint` (= `CL_DATA_DIR`) |
| AI retention purge | on | Database only |
| Backup scheduler | off | The desktop app owns backups |
| Backup verifier | off | Same |
| Cloudflared alerter | off | Tunnel health is appliance only |
| Share sweeper | off | Screen share is off |
| Recurring document requests | off | Portal feature; sends email/SMS to portal contacts |

The worker package is not part of desktop mode. Worker-only schedulers and durable background jobs arrive with the Postgres-backed queue backend.

## No Redis

Every Redis touchpoint checks `redisEnabled()`. That function is always true for the server's default configuration. It is false in desktop mode, and for a server with `QUEUE_BACKEND=none` and no `REDIS_URL`.

| Module | Without Redis |
|---|---|
| `utils/health-redis` | `{ok:true, disabled:true}`; `/health` shows `redis: "disabled"` |
| `utils/worker-heartbeat` | No-op |
| `utils/rate-limit-store` | In-memory |
| `services/passkey-challenge-store` | In-memory map (exact for one process) |
| `utils/peer-jti-store` | Fails closed |
| `services/tb/tb-redis` | Cache off |
| `services/share/share-redis` | Refuses |
| `services/extraction/queue` | With `QUEUE_BACKEND=none`, every `enqueue*` rejects immediately with `QueueUnavailableError` (`queue/none.adapter.ts`), so producers run their in-process fallback. No BullMQ queue is ever built. |

## `/health` v2 (all modes)

`/health`, `/api/health` and `/api/v1/health` (token required in desktop mode):

```jsonc
{
  "status": "ok" | "degraded",
  "db": "ok" | "fail",
  "redis": "ok" | "fail" | "disabled",
  "queue": "ok" | "fail",          // bullmq: mirrors redis; none: "ok"
  "workers": "ok" | "fail",
  "timestamp": "ISO-8601",
  "checks": { "db": { "ok", "latencyMs", "superuser" }, "redis": {}, "queue": {}, "workers": {} },
  "mode": "server" | "desktop",
  "version": "v0.9.231" | "unknown", // VIBE_MYBOOKS_VERSION, VIBE_MYBOOKS_TAG
  "engineCommit": "13ebd2ba…" | null,
  "schemaVersion": 216 | null,       // applied migrations
  "schemaTag": "0215_…" | null,      // newest applied migration (journal tag)
  "queueBackend": "bullmq" | "none",
  "online": null,                    // no connectivity probe yet
  "lastOnlineCheck": null
}
```

The v1 fields come first and are unchanged. A `"disabled"` Redis never degrades the status. On desktop, `/health` returns 200 when the database is up.

## Database role

The engine only needs to own its database: no migration creates extensions or needs superuser rights. Run it as a `NOSUPERUSER NOCREATEDB NOCREATEROLE` role that owns the database.

Desktop preflight reads `rolsuper` for `current_user`. A superuser role logs `{"event":"warning","code":"DB_SUPERUSER",…}`. With `CL_REQUIRE_NON_SUPERUSER=1`, it is a fatal `DB_SUPERUSER_FORBIDDEN` instead. `/health` (`checks.db.superuser`) and `/api/v1/desktop/info` report the value.

## Logging

In desktop mode, `desktop/log-tee.ts` wraps stdout and stderr. Every chunk goes through `utils/secret-scrubber.ts` before it is written anywhere, both to the console and to the file. The scrubber removes:

- registered values: the launch token and the boot secrets;
- `Bearer …` tokens;
- `sk-…` / `sk-ant-…` API keys;
- JWTs;
- passwords in `scheme://user:password@` URLs;
- `X-CL-Token` header dumps.

It never touches plain numbers, so amounts in log lines survive.

With `CL_LOG_FILE` set, the scrubbed text is appended synchronously and rotated by size. Retention by age or total size is the desktop app's job: it deletes closed rotated files.

## Not in desktop mode yet

These come as separate changes:

- a durable Postgres-backed queue backend and in-process worker;
- the connectivity probe and outbound-connection guard (`online`, `OFFLINE_UNAVAILABLE`);
- the OpenAPI export;
- tenant archives;
- per-session AI and SMTP secrets.
