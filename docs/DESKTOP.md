# Desktop mode (`CL_MODE=desktop`)

Desktop mode runs the engine as a local sidecar of a desktop app (ClientLedger) instead of as the server appliance. It needs only PostgreSQL. There is no Redis, no worker container, no web bundle, and no browser client.

Everything here is gated by `CL_MODE=desktop` or by an option that defaults to today's server behavior. With `CL_MODE` unset, the appliance behaves exactly as before:

- `env.ts` parses a server environment to the same values.
- The Express route table is identical.
- BullMQ stays the default queue backend, with the same queues, job options, workers and log lines.
- `/health` returns exactly the v1 body with the same 200/503 logic. The v2 fields are desktop-only.

The code lives in `packages/api/src/desktop/`, `middleware/desktop-gate.ts`, `routes/desktop.routes.ts`, `queue/` and `utils/health.ts`. The only schema change is the additive `tenants.is_workspace` column (migration `0216`), which the server never sets.

## Environment contract

| Variable | Desktop | Default / rule |
|---|---|---|
| `CL_MODE` | `desktop` | Unset or `server` means server mode. Any other value is a fatal `CL_MODE_INVALID`. |
| `CL_BIND` | required | `<ipv4>:<port>` or `[<ipv6>]:<port>`, IP literals only. Port `0` lets the OS pick; the real port is in the ready line. A non-loopback address is refused (`CL_BIND_NOT_LOOPBACK`). Loopback means 127.0.0.0/8 or `::1`. |
| `CL_TOKEN` | required | Launch token: at least 43 base64url characters or 64 hex (≥ 256 bits). Read once. Only its SHA-256 digest is kept for comparison, and it is deleted from `process.env`, so child processes (e.g. `pdftoppm`) never inherit it. Pass it in the environment, never on the command line. |
| `CL_DATA_DIR` | required | Absolute path (`CL_DATA_DIR_INVALID` otherwise). Defaults the following when they are not set explicitly: `DATA_DIR` (= `CL_DATA_DIR`), `UPLOAD_DIR` (`uploads`), `BACKUP_DIR` (`backups`), `CONFIG_DIR` (`config`), `STORAGE_CACHE_DIR` (`cache`), `CL_ARCHIVE_DIR` (`archives`). |
| `CL_LOG_FILE` | optional | Absolute path (`CL_LOG_FILE_INVALID` otherwise). Append scrubbed stdout/stderr to this file (see Logging). |
| `CL_LOG_MAX_BYTES` | optional | Rotation size. Default 10 MiB. |
| `CL_LOG_KEEP` | optional | Rotated files kept (`file.1` … `file.N`). Default 5. |
| `CL_OFFLINE` | optional | `auto` (default), `on` or `off`. How online-only features behave without a network (see Offline). Also reported by `/api/v1/desktop/info`. |
| `CL_EGRESS_ALLOW` | optional | Comma-separated `host[:port]` (IPv6 as `[addr]:port`) added to the outbound allowlist at launch, e.g. a LAN Ollama server. Invalid entries are a fatal `CL_EGRESS_ALLOW_INVALID`. See Outbound connections. |
| `CL_LAN` | optional | `1` is refused with a fatal `CL_LAN_UNSUPPORTED` until LAN mode gets TLS (ClientLedger P33). The engine speaks plain HTTP, so a LAN bind would send the launch token, passwords and books in clear text. P33 will accept only private literals (RFC 1918, IPv6 ULA `fc00::/7`, link-local), never `0.0.0.0`, `::` or a public address. Other values are ignored. |
| `CL_REQUIRE_NON_SUPERUSER` | optional | `1` refuses to start when the database role is a superuser (see Database role). Off by default: the engine only warns. |
| `QUEUE_BACKEND` | generic | `bullmq` (server default), `pgboss` or `none`. Desktop defaults to `pgboss`, and `bullmq` is refused there (see Background jobs). |
| `ENGINE_COMMIT` | generic | Source commit reported on `/health` (`null` when unset). Set it at build time. |
| `DATABASE_URL`, `JWT_SECRET`, `ENCRYPTION_KEY`, `PLAID_ENCRYPTION_KEY` | required | Unchanged. The desktop app supplies them from the OS keychain. In desktop mode the engine never writes them to disk: the routes that would are not mounted, and the recovery-file, sentinel and `.env` writers throw. |
| `REDIS_URL` | ignored | Required only when something uses Redis: `QUEUE_BACKEND=bullmq` (the server default), `RATE_LIMIT_REDIS=1` or `SHARE_ENABLED`. |

Desktop mode skips Cloudflare Turnstile verification (no browser widget, no outbound call). It removes proxy variables from the environment (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`, `NODE_USE_ENV_PROXY`, `FTP_PROXY`, `GLOBAL_AGENT_HTTP_PROXY`, any letter case), because a loopback proxy would carry traffic past the egress guard. It also forces `HIBP_DISABLED=1`, `EXPECT_WORKER=false`, `SHARE_ENABLED=false`, `QUEUE_BACKEND=<pgboss unless none was asked for>` and `PORT=<CL_BIND port>`. It refuses `RATE_LIMIT_REDIS=1` and `VIBE_AI_MODE=router` (`CL_ENV_CONFLICT`). Set `NODE_ENV=production`.

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
| 78 (`EX_CONFIG`) | Configuration or preflight problem. Restarting will not help. | `CL_MODE_INVALID`, `CL_TOKEN_REQUIRED`, `CL_TOKEN_INVALID`, `CL_BIND_REQUIRED`, `CL_BIND_INVALID`, `CL_BIND_NOT_LOOPBACK`, `CL_LAN_UNSUPPORTED`, `CL_DATA_DIR_REQUIRED`, `CL_DATA_DIR_INVALID`, `CL_LOG_FILE_INVALID`, `CL_ENV_INVALID`, `CL_ENV_CONFLICT`, `QUEUE_BACKEND_INVALID`, `ENV_MISSING`, `ENV_INVALID`, `MIGRATIONS_PENDING`, `DATABASE_AHEAD`, `UNKNOWN` (migration failure), `DB_ROLE_UNREADABLE`, `DB_SUPERUSER_FORBIDDEN` |
| 1 | Runtime failure. A retry may help. | `BIND_FAILED` (e.g. port in use), `STARTUP_FAILED` |

Messages are scrubbed and name variables, never values.

## Transport security: the desktop gate

`middleware/desktop-gate.ts` is the first middleware in `app.ts`. It runs before helmet, CORS, the raw-body webhook routers and every route. It has no exemptions: `/health`, `/ping`, `OPTIONS` and `/api/setup/status` all need the token.

| Check (in order) | Result |
|---|---|
| Any `Origin` header | 403 `ORIGIN_NOT_ALLOWED` (no browser clients; blocks CSRF and DNS rebinding) |
| `Host` is not the bound `host:port` or `localhost:port` | 421 `HOST_NOT_ALLOWED`. |
| `X-CL-Token` missing or wrong | 401 `DESKTOP_TOKEN_REQUIRED` (same body for both cases; constant-time compare of SHA-256 digests) |

The token proves only "this is the desktop app". User identity is unchanged: log in with `POST /api/v1/auth/login` and send the JWT as `Authorization: Bearer …` alongside `X-CL-Token`. Roles, per-route auth and the per-route rate limiters all apply. Only the global per-IP limiter is skipped for gated requests, because every desktop request comes from 127.0.0.1.

## Desktop endpoints

Mounted at `/api/v1/desktop` in desktop mode only. On the server they return 404 `NOT_FOUND`.

| Method | Path | Body / response |
|---|---|---|
| POST | `/initialize` | Body: `{"admin":{"email","displayName","password"(12 characters to 72 UTF-8 bytes; bcrypt ignores anything longer)},"company"?:{"name","businessType"?,"entityType"?,"industry"?}}`. Response: 201 `{"workspaceTenantId","userId","companyTenantId"(or null),"warnings":[]}`; see "First run" below. Writes no `.env` and no sentinel; only the non-secret `CONFIG_DIR/.initialized` marker (`{"via","workspaceTenantId"}`). Errors: 409 `ALREADY_INITIALIZED` once a user exists, 409 `TENANTS_WITHOUT_USERS` for restored data with no users, 409 `SETUP_BUSY` while another run holds the setup lock, 400 `VALIDATION_ERROR`, 400 for an unknown `businessType` (nothing is written). |
| GET | `/info` | `{"mode","version","engineCommit","queueBackend","offline","lan","dataDirExists","dbSuperuser","dbRole":{"dangerous","warnings"},"initialized","workspaceTenantId"}`. `workspaceTenantId` is `null` before first run. |

`/api/setup/*` is not available in desktop mode, except `GET /api/setup/status`.

`/info` answers any holder of the launch token, before and without a user login. Besides the version it reveals `dataDirExists`, `dbSuperuser`/`dbRole` and `workspaceTenantId`. That is acceptable because the token holder is the desktop app itself, but the host must treat the token as the key to the whole engine (see Host requirements).

### First run

In one transaction (under the setup lock), `/initialize` creates:

1. the **workspace tenant**: name `Workspace`, slug `workspace-<8 hex>`, `is_workspace = true`;
2. the owner: homed in the workspace (`users.tenant_id`), email trimmed and lower-cased, role `owner`, super admin;
3. the owner's active workspace access row, role `owner`.

It creates no firm rows (`firms`, `firm_users`, `tenant_firm_assignments`). When `company` is given, the first company is created afterwards as an ordinary tenant: the company row, the chart of accounts from `businessType` (default `default`) and an `owner` access row, with no firm join. If that fails, the workspace and the owner stay (zero companies is a valid state), any half-built company is removed, and the response is still 201 with `"companyTenantId": null, "warnings": ["COMPANY_NOT_CREATED"]`. Retry with `POST /api/v1/auth/create-tenant`.

## Workspace tenant

The workspace holds every user row (the owner and any later users) and no company or books. Each user has an active access row to it: `owner` for the owner, `readonly` for everyone else. Real companies are ordinary tenants reached through `user_tenant_access`. Deleting the last company is allowed; the user is then in the workspace with zero companies. A partial unique index (`uniq_tenants_workspace`) allows at most one workspace.

**Login.** Login prefers the user's home tenant, so a session starts in the workspace. Login, `/auth/me` and switch-tenant still list the workspace in `accessibleTenants`; clients recognize it by `GET /api/v1/desktop/info` -> `workspaceTenantId` and hide it. Open a company with `POST /api/v1/auth/switch-tenant`. Switching to a tenant id that does not exist is 404 `TENANT_NOT_FOUND`.

**Write fence.** `authenticate` (session JWT, API key and download token alike) checks the request path (`req.originalUrl` without the query string) when the request's tenant is the workspace. Only these prefixes pass:

| Prefix | Matches |
|---|---|
| `/api/v1/auth/` | everything below (login, me, preferences, switch-tenant, create-tenant, passkeys, ...) |
| `/api/v1/tenants` | the path and whole segments below it |
| `/api/v1/tenant-archives` | the path and whole segments below it |
| `/api/v1/desktop/` | everything below |

Everything else, reads included, is 409 `WORKSPACE_TENANT` ("Open a company first."). `GET /api/v1/attachments/:id/download`, which authenticates by hand, applies the same fence. A refresh in the workspace issues the workspace access row's role (`readonly` for everyone but the owner), as login does, never the company role stored in `users.role`. Paths with dot segments, encoded separators or backslashes never match. `/health`, `/openapi.json` and `/api/v1/desktop/*` do not run `authenticate`. The list is a constant in `desktop/workspace.ts` and changes only with an engine change. `desktop/app-gate.test.ts` lists every handler mounted under these prefixes; a new one (including the first route under `/api/v1/tenants` or `/api/v1/tenant-archives`) fails it until reviewed.

**Users.** Every desktop user-creation path homes the new user in the workspace:

| Path | Desktop behavior |
|---|---|
| `POST /api/v1/desktop/initialize` | the owner, as above |
| `POST /api/v1/company/invite-user` (new user) | homed in the workspace with a `readonly` workspace row plus the company row with the requested role. Inviting into the workspace is 409 `WORKSPACE_TENANT`. Existing users only get the company row, as before. |
| `POST /api/v1/admin/users/create` | same homing; `tenantId` must be a company (workspace: 409 `WORKSPACE_TENANT`) |
| `POST /api/v1/auth/register`, `POST /api/v1/auth/create-client` | 404 `NOT_AVAILABLE_IN_DESKTOP` (no self-registration, no practice firms) |
| `setup.service` `createAdminUser` / `adoptRestoredTenants` | throw (unreachable: `/api/setup` is not mounted) |

A static test (`desktop/users-insert-sites.test.ts`) lists every place that inserts into `users`; a new one fails it until it is reviewed for desktop mode.

`POST /api/v1/auth/create-tenant` creates a company with an `owner` access row and no firm. On desktop the owner (super admin) is always eligible: the self-service toggle and cap do not apply.

**Admin tenant routes** (`/api/v1/admin/tenants/:id...`). Every one of them refuses the workspace as `:id` (409 `WORKSPACE_TENANT`), and so does `users/create` with the workspace as `tenantId`. For companies:

| Route | Desktop |
|---|---|
| `DELETE /tenants/:id`, `POST /tenants/:id/disable` | 409 `USE_SAFE_DELETE` (they take no backup, and disable deactivates every user homed in the tenant) |
| `DELETE /tenants/:id/chart-of-accounts`, `/transactions`, `/companies/:companyId`, `/payroll-import-history`; `POST /tenants/:id/delete-transactions-range` | 404 `NOT_AVAILABLE_IN_DESKTOP` |
| every other `/tenants/:id...` route | unchanged |

**Boot check.** After migrations, once there is a user, the engine checks that there is exactly one workspace and that every user is homed there with an active workspace access row. A violation logs one `{"event":"warning","code":"WORKSPACE_INVARIANT",...}` line with counts and user ids only. It is not fatal.

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
| `/api/v1/admin/security` | Appliance recovery key, recovery file, installation id and credential re-encryption. They write or rotate boot secrets on disk. |
| `/api/v1/admin/updates` | GitHub release check; the desktop app has its own update check |
| `/api/v1/remote-backup` | Cloud backup targets; the desktop app owns backups |
| `/api/v1/backup` (except `/passphrase-strength`) | The desktop app owns backups; this restore writes into the current tenant without taking a backup first |
| `/api/v1/tenant-export` | `.vmx` export and import; the desktop app uses tenant archives |
| `/api/v1/settings/storage` | Cloud file storage providers |
| `/api/docs` | Swagger UI |
| `/api/v1/auth/magic-link` | Email magic-link sign-in |
| `/api/v1/firms`, `/api/v1/firm-invites` | Accounting-firm management; there are no firms on desktop |
| `/api/v1/practice/portal` (incl. `/questions`, `/reminders`) | Client portal contacts, questions and reminders |
| `/api/v1/admin/plaid` (incl. `/test`, `/webhooks/*`) | Plaid configuration, connections and webhooks |
| `/api/v1/admin/backup/remote-config`, `remote-test`, `remote-connect`, `remote-callback` | Cloud backup targets and their OAuth |
| `/api/v1/admin/storage/system-config`, `system-test`, `system-migrate` | Cloud file storage providers |
| `/api/v1/admin/updates/check` | Online update check; the desktop app has its own |
| `/api/v1/admin/tunnel-config`, `/api/v1/admin/cloudflared` | Cloudflare Tunnel |
| `/api/v1/admin/mcp` | MCP server configuration and log |
| `/api/v1/admin/tfa/sms-test` | Sends an SMS |
| `/api/v1/admin/create-client` | Practice client creation (no firms) |

The static web bundle and SPA fallback are never served. Any non-API path returns a JSON 404.

**Every other mount is listed too.** `DESKTOP_KEPT` in `desktop/features.ts` names every app-level mount that stays in desktop mode. `desktop/app-gate.test.ts` reads the real route table in both modes and fails on any mount that is in neither list, so a new route family must be reviewed for desktop mode before it ships. It also checks that the online and appliance-only admin routes are all covered.

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
| Balance validation (worker-only) | on | Database only, advisory-locked, daily |
| Report-pack artifact sweep (worker-only) | on | Deletes expired pack files through the tenant's storage provider (local on desktop, under `CL_DATA_DIR`) |
| Classification-state backfill (worker-only, one-shot) | on | Database only, advisory-locked |
| Tag backfill sweep (worker-only, one-shot) | on | Database only, advisory-locked |
| Plaid sync (worker-only) | off | Online bank feeds; Plaid is not mounted |
| Portal recurring requests (worker-only) | off | Portal is not mounted; sends email/SMS |
| Portal reminders (worker-only) | off | Same |

The worker package is not part of desktop mode. The engine runs its job consumers and the enabled worker-only schedulers in-process (`queue/in-process-worker.ts`, see Background jobs). Every scheduler is an interval loop under a Postgres advisory lock; none of them uses the job queue.

## Background jobs

The six background job types (`doc-render`, `doc-extract`, `statement-parse`, `bill-capture`, `report-pack`, `tax-param-ai-check`) go through one `JobQueue` interface (`queue/job-queue.ts`) with three backends:

| `QUEUE_BACKEND` | Where | Behavior |
|---|---|---|
| `bullmq` | server default | Redis-backed BullMQ, exactly as before: the worker container consumes, one BullMQ worker per queue. |
| `pgboss` | desktop default; optional on a server | Postgres-backed [pg-boss](https://github.com/timgit/pg-boss) (MIT) in its own schema `pgboss`, created and migrated by pg-boss on start. Needs only `CREATE` on the database (the owner role), no superuser and no extension. Own pool of 3 connections. Jobs survive an engine restart. |
| `none` | optional | No queue. Every enqueue rejects at once with `QueueUnavailableError` and producers run the work in-process. |

Per-job retries, retention and concurrency come from one table, `queue/specs.ts`, which every backend maps (BullMQ job options; pg-boss `retryLimit`/`retryDelay`/`retryBackoff`/`expireInSeconds`). pg-boss keeps finished jobs for 7 days instead of BullMQ's newest-N counts. What each job does lives in `queue/handlers.ts`, shared by the worker package and the in-process worker.

Enqueue is idempotent on every backend: the producer's job id (`stmt-<id>`, `pack-<id>`, …) maps to a fixed pg-boss UUID (UUIDv5), and sending an id that still exists is a no-op, like BullMQ. A pg-boss enqueue that cannot reach Postgres fails within the connect timeout (5 s) with `QUEUE_UNAVAILABLE`, so the producer falls back to in-process work; it never waits forever the way a BullMQ producer without Redis can.

In desktop mode, `startInProcessWorker()` runs after the HTTP server listens. It consumes all six job types (`doc-render`/`doc-extract` only with `DOCUMENT_EXTRACTION_V1`, as in the worker container) and starts the worker-only schedulers enabled above. Shutdown order: stop HTTP, stop the in-process worker (in-flight jobs finish, up to 20 s), stop the schedulers, close the job queue, close the DB pool.

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
| `services/extraction/queue` | Enqueues go to pg-boss (desktop default) or, with `QUEUE_BACKEND=none`, reject immediately with `QueueUnavailableError` so producers run their in-process fallback. The BullMQ module is loaded only for `QUEUE_BACKEND=bullmq`, so no BullMQ queue is ever built. |

## `/health` v2 (desktop only)

`/health`, `/api/health` and `/api/v1/health` (token required). The server appliance answers anonymous callers, so it keeps the exact v1 body (the first seven fields, `checks.db` without `superuser` and `role`) and never reveals the version, commit, schema or database role.

```jsonc
{
  "status": "ok" | "degraded",
  "db": "ok" | "fail",
  "redis": "ok" | "fail" | "disabled",
  "queue": "ok" | "fail",          // bullmq: mirrors redis; pgboss: its schema answers; none: "ok"
  "workers": "ok" | "fail",
  "timestamp": "ISO-8601",
  "checks": { "db": { "ok", "latencyMs", "superuser", "role": { "dangerous": [], "warnings": [] } }, "redis": {}, "queue": {}, "workers": {} },
  "mode": "server" | "desktop",
  "version": "v0.9.231" | "unknown", // VIBE_MYBOOKS_VERSION, VIBE_MYBOOKS_TAG
  "engineCommit": "13ebd2ba…" | null,
  "schemaVersion": 216 | null,       // applied migrations
  "schemaTag": "0215_…" | null,      // newest applied migration (journal tag)
  "queueBackend": "bullmq" | "pgboss" | "none",
  "online": true | false | null,     // last connectivity probe (see Offline); null = never probed
  "lastOnlineCheck": "ISO-8601" | null
}
```

The v1 fields come first and are unchanged. A `"disabled"` Redis never degrades the status. On desktop, `/health` returns 200 when the database is up.

## Outbound connections (egress guard)

In desktop mode, `bootstrap.ts` installs `desktop/egress-guard.ts` right after the profile loads, before any other engine module. It denies every outbound connection by default:

- `net.Socket#connect` (covers `net`, `tls`, `http`, `https`, `http2` and global `fetch`);
- `dns.lookup`, `dns.lookupService`, every `dns.resolve*` and `reverse`, in their callback, promise and `Resolver` forms, so a blocked name is never sent to a DNS server;
- UDP (`dgram`) `send` and `connect`;
- worker threads: `worker_threads.Worker` is replaced so every worker runs the same guard code before its own code (a file worker is started as an `eval` worker that first installs the guard and then loads the file). A worker gets the allowlist as it was when the worker started; later changes do not reach running workers. Workers started by workers are guarded the same way. `data:` and other non-`file:` worker URLs are refused.

Allowed destinations:

| Destination | How |
|---|---|
| Loopback | `127.0.0.0/8`, `::1`, `::ffff:127.0.0.0/104`, exactly `localhost` (not `localhost.`, a DNS name) |
| Local IPC | Unix sockets and Windows named pipes |
| The database | `DATABASE_URL` host, on its port |
| Launch allowlist | `CL_EGRESS_ALLOW` |
| Features the owner turned on | Registered at runtime with `setEgressAllowance(source, [{host, port}])`, e.g. an AI provider or SMTP server once its key or password is supplied for the session |

With `CL_OFFLINE=on` only loopback, IPC and the database are allowed: `CL_EGRESS_ALLOW` and runtime allowances are ignored (in worker threads too).

Matching is by host (and port when the entry has one), never by request context, because connection pools open sockets from any context. IP literals are matched exactly; an allowed name does not allow its IP address or other spellings of it.

A blocked connection fails like a refused one: the socket gets an `EGRESS_BLOCKED` error on the next tick, before any DNS query or packet. The guard logs `{"component":"egress-guard","event":"blocked","host":…}` at warn level, at most once a minute per host, with no port or payload. Removing an allowance stops new connections; an open keep-alive socket can be reused until it idles out.

Not covered:

- worker threads in the single-executable (SEA) build: the guard prelude is tested from source on Windows only; treat it as unverified in the SEA runtime until the 4-OS engine smoke covers it;
- child processes (`pdftoppm`, Chromium for PDFs, CLI tools). Desktop mode does not run the features that start network tools (tunnels, Tailscale). The PDF renderers block network requests from the page (invoices and portal: `data:`, `about:`, `file:`; report export: `data:` and `about:` only, with JavaScript off and `--disable-background-networking`).

The server appliance never installs the guard.

### Rules for features that open egress (session secrets, E6)

`setEgressAllowance()` is the only way a feature reaches the network. Code that calls it must follow these rules (security review of the guard, 2026-10-15):

- **AI hosts come from a fixed provider table** (Anthropic → `api.anthropic.com:443`, OpenAI → `api.openai.com:443`), never from a URL in a request body or a stored setting.
- **SMTP:** the host must pass `assertHostSafe` (no loopback, link-local or metadata names or addresses) before it is allowed, and only ports 25, 465, 587 and 2525 may be allowed.
- **Ollama / OpenAI-compatible base URLs** (local or LAN) must be validated before their host is allowed: `http`/`https` only, no credentials in the URL, no link-local or metadata addresses, and a host other than loopback only by an explicit owner choice. Not validated yet (review item L-6).
- **Only the owner role** may add an allowance, and it is removed when the feature is turned off or its secret is cleared.
- **Never widen the guard for everyone** with `CL_EGRESS_ALLOW` to make a feature work; that variable is for launch-time, install-specific hosts chosen by the desktop app.
- Removing an allowance stops new connections; a keep-alive socket that is already open may be reused until it idles out (review item L-8, accepted and documented above).

### OCR language data (no download)

tesseract.js downloads `eng.traineddata` from `cdn.jsdelivr.net` by default. The engine never lets it in desktop mode:

| Setting | Meaning |
|---|---|
| `OCR_LANG_PATH` | Directory with `eng.traineddata` (or `eng.traineddata.gz`). Any mode; on the server it is opt-in, and without it nothing changes. |
| desktop default | `<CL_DATA_DIR>/tessdata`; cache in `<CL_DATA_DIR>/cache/tesseract` |
| `OCR_WORKER_PATH` | Optional path to the tesseract.js worker script (`tesseract.js/src/worker-script/node/index.js`) when `node_modules` is not next to the engine. |

When the data file is missing, OCR fails with 503 `OCR_DATA_MISSING` and no worker is started, so nothing is downloaded (and the guard would block it anyway).

**Packaging (ClientLedger xtask / installer):** ship `eng.traineddata` (tessdata `4.0.0_best_int`, LSTM; license Apache-2.0, list it in ATTRIBUTION.md) and point `OCR_LANG_PATH` at it, or copy it to `<CL_DATA_DIR>/tessdata` on first run. The SEA bundle does not contain the tesseract.js worker script or the `tesseract.js-core` WASM files; ship `tesseract.js` and `tesseract.js-core` on disk next to the engine and set `OCR_WORKER_PATH`, or OCR is unavailable. A corrupt data file makes tesseract.js throw from its own worker event handler (an upstream tesseract.js behavior); keep the shipped file checksum-verified.

## Offline

Online-only features (cloud AI, sending email) check the network before they connect, through `utils/offline.ts`. When the computer is offline they fail within 2 seconds with HTTP 503:

```json
{ "error": { "code": "OFFLINE_UNAVAILABLE", "message": "…needs an internet connection…", "feature": "ai:anthropic" } }
```

`feature` is `ai:<provider>` or `smtp`. `CL_OFFLINE` decides how the check works:

| `CL_OFFLINE` | Behavior |
|---|---|
| `auto` (default) | Before the first use, and again after 30 s, open a TCP connection to the feature's own host (the one the owner turned on; DNS lookup included) with a 1.5 s budget, then close it without sending anything. A failure is remembered for 5 s, so a retry or a fallback provider does not wait again. Network errors from the real call (`ENOTFOUND`, `EAI_AGAIN`, `ENETUNREACH`, `EHOSTUNREACH`, `ECONNREFUSED` off loopback, connect timeouts) are mapped the same way. |
| `on` | Online features fail at once. Nothing is probed. `/health` shows `online: false`. |
| `off` | No checks; errors pass through unchanged. |

**AI.** In desktop mode the Anthropic and OpenAI providers are wrapped (`ai-providers/index.ts`): every `complete`, `completeWithImage`, `testConnection` and `listModels` call checks the provider's host first (`ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL`, else the public API host) and maps network errors. Offline errors are not retried. In a fallback chain, once one cloud provider is offline the other cloud providers are skipped, and local Ollama is still tried; if nothing else failed, the caller gets 503 `OFFLINE_UNAVAILABLE` instead of `ai_all_providers_failed`. The per-function AI test returns the 503 too.

**Email.** Every SMTP transport is built by `utils/mail-transport.ts` (`createMailTransport`). In desktop mode it requires TLS (`requireTLS`: STARTTLS on ports other than 465) unless the server is on loopback, sets connection and greeting timeouts of 10 s and a socket timeout of 30 s (a caller's own values win), and `sendMail`/`verify` run the check above first. The SMTP test endpoints answer 503 `OFFLINE_UNAVAILABLE` instead of `{success:false}` when offline. On the server the factory is plain `nodemailer.createTransport` with nodemailer's default timeouts.

Loopback targets (a local mail relay, Ollama on this machine) are never probed and never make the machine "offline", even with `CL_OFFLINE=on`. A probe that ends in anything other than a timeout or a no-network error (for example a refused connection on a name that resolves to this machine) is inconclusive: nothing is recorded or cached and the real call reports its own error. The SMTP test runs the SMTP host safety check (no loopback, link-local or metadata hosts) before any probe.

There is no general "is the internet up" check and nothing is contacted on a timer: the only probe goes to the host the feature is about to use. `/health` reports `online` (`null` until the first probe) and `lastOnlineCheck`. The server appliance never probes: there, `CL_OFFLINE` is always `off`, these fields stay `null`, and errors are unchanged.

## Database role

The engine only needs to own its database: no migration creates extensions or needs superuser rights, and pg-boss creates its `pgboss` schema with the owner's `CREATE` privilege. Run it as a `NOSUPERUSER NOCREATEDB NOCREATEROLE` role that owns the database; `desktop/pgboss-owner-role.test.ts` boots the engine that way, pg-boss schema and a job round trip included.

Desktop preflight checks `current_user` (`startup/db-role.ts`):

| Finding | Kind |
|---|---|
| `superuser`: the role has `rolsuper` | dangerous |
| `member_of_superuser`: the role is a member, directly or through other roles, of a superuser role | dangerous |
| `pg_execute_server_program`, `pg_read_server_files`, `pg_write_server_files`: membership (also transitive) | dangerous |
| `createrole`, `replication`, `bypassrls` | warning |

Any dangerous finding logs `{"event":"warning","code":"DB_SUPERUSER",…}` naming the findings. With `CL_REQUIRE_NON_SUPERUSER=1` it is a fatal `DB_SUPERUSER_FORBIDDEN` (exit 78) instead. Warning-only attributes log `DB_ROLE_ATTRIBUTES` and never stop the engine. `/health` (`checks.db.superuser`, `checks.db.role`) and `/api/v1/desktop/info` (`dbSuperuser`, `dbRole`) report the result; `superuser` is true for `rolsuper` or superuser membership.

## Logging

In desktop mode, `desktop/log-tee.ts` wraps stdout and stderr. Every chunk goes through `utils/secret-scrubber.ts` before it is written anywhere, both to the console and to the file. The scrubber removes:

- registered values: the launch token, the boot secrets and the value of every environment variable whose name contains `KEY`, `SECRET`, `PASS` or `TOKEN` (plain numbers and booleans skipped), each also in its JSON-escaped form;
- `Bearer …` tokens (any case);
- `sk-…` / `sk-ant-…`, Stripe `sk_live_`/`rk_live_`, Google `AIza…`, AWS `AKIA…`/`ASIA…`, Slack `xox?-…` and GitHub `ghp_…`/`github_pat_…` keys;
- JWTs;
- passwords in `scheme://user:password@` URLs;
- `X-CL-Token` header dumps;
- email addresses (replaced with `[email]`).

It never touches plain numbers, so amounts in log lines survive. To keep personal and financial data out of the log in the first place, desktop mode also:

- logs request paths without the query string (morgan);
- logs unhandled errors as name, code, a short message and stack frames, never the full error object (which carries drizzle's `params:` and PostgreSQL's `detail`, i.e. amounts, names and memo text).

With `CL_LOG_FILE` set, the scrubbed text is appended synchronously and rotated by size. Retention by age or total size is the desktop app's job: it deletes closed rotated files.

## Host requirements

What the desktop app (ClientLedger's `cl-host`) must do, because the engine cannot enforce it:

- Pass absolute paths for `CL_DATA_DIR` and `CL_LOG_FILE` (the engine refuses relative ones) inside a directory only the owner's account can read.
- Open, rotate and delete the log files with share-delete semantics on Windows (`FILE_SHARE_DELETE`), and never hold a rotated file open, so the engine's rename-based rotation keeps working while the host tails the log.
- Keep the launch token secret: environment only, never the command line, a file or a log. Anyone holding it can call `/api/v1/desktop/info` and `/initialize`.
- **P04 requirement (not implemented):** the host should verify it is talking to its own engine, not to another process that grabbed the port, before sending the token or credentials. Planned: the host sends a random challenge and the engine answers with an HMAC of it keyed by the launch token (e.g. a header on `/health`), so the token itself never has to be sent first.
- Helper processes started by the engine (poppler `pdftoppm`, `pdftotext`, `pdfimages`) get a minimal environment in desktop mode (`PATH`, temp and locale variables, library and font paths; nothing credential-named), so boot secrets and API keys are not inherited. If the host bundles poppler, its libraries must be findable through `PATH` / `LD_LIBRARY_PATH` / `DYLD_*` or an rpath.

## Not in desktop mode yet

These come as separate changes:

- the OpenAPI export;
- tenant archives (`/api/v1/tenants`, `/api/v1/tenant-archives`);
- per-session AI and SMTP secrets.
