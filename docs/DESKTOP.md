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
| GET | `/info` | `{"mode","version","engineCommit","queueBackend","offline","lan","dataDirExists","dbSuperuser","dbRole":{"dangerous","warnings"},"initialized","workspaceTenantId","capabilities"}`. `workspaceTenantId` is `null` before first run. `capabilities` is the append-only list of contracts this engine advertises (`desktop/capabilities.ts`): `tenants-list-v1`, `tenant-archive-v1`, `session-secrets-v1`, `ai-desktop-v1`, `smtp-session-v1`, `ai-token-cap-v1`, `register-exact-v1`, `closing-password-v1`, `txn-delete-v1`, `check-edit-v1`, `line-billable-v1`, `rules-evaluate-v1`, `deposit-grouping-v1`, `deposit-cashback-v1`, `vendor-refund-v1`, `equity-roles-v1`, `feed-deposit-groupings-v1`, `daily-sales-lock-v1`, `je-names-v1`, `je-number-v1`, `je-adjusting-v1`, `je-reversing-v1`, `balance-exact-v1`, `recurring-guard-v1`; a client gates a feature on the name and treats a missing array as none. See "Capabilities" below. |
| PUT | `/session-secrets` | Launch token **and** a signed-in super admin (the owner; a workspace session works). Body: `{"ai"?:{"anthropic"?:{"apiKey"},"openai"?:{"apiKey"},"ollama"?:{"baseUrl","model"?}},"smtp"?:{"password"?,"host"?,"port"?,"security"?:"tls"|"starttls"|"none"}}` (strict; keys 8–512 characters, password 1–512, `smtp` needs `password` or `host`). Partial: only the named entries change. Response: the GET body. Errors: 400 `VALIDATION_ERROR` (names the key, never the value), 400 `OLLAMA_URL_INVALID`, 400 `OLLAMA_HOST_NOT_LOCAL`, 400 `SMTP_HOST_BLOCKED`, 400 `SMTP_SECURITY_REQUIRED`, 429 `TOO_MANY_REQUESTS` (more than 30 calls a minute per user to the three `/session-secrets` routes); a refused body applies nothing. See "Session secrets". |
| GET | `/session-secrets` | Same auth. `{"ai.anthropic":{"present","fingerprint"?},"ai.openai":{…},"ai.ollama.baseUrl":{…},"smtp.password":{…}}`; `fingerprint` is `sha256:` + 8 hex of HMAC-SHA256 of the value under a key drawn at process start: stable for the life of the engine (a client can tell "changed" from "same"), different after a restart, and no use for guessing a short password. Values are never returned. |
| DELETE | `/session-secrets/{name}` | Same auth. Forgets one value and removes its egress allowance; 404 for an unknown name; 200 with the GET body otherwise (also when it was absent). |

`/api/setup/*` is not available in desktop mode, except `GET /api/setup/status`.

### Session secrets (AI keys, Ollama endpoint, SMTP password)

The desktop app keeps the owner's AI keys and SMTP password in the OS keychain and hands them to the engine for the life of the process (`desktop/session-secrets.ts`, U-09/U-11/U-13). They live in one in-memory map: never in `ai_config`, `companies.smtp_pass`, `system_settings`, files or logs; graceful shutdown clears them. Each value is registered with the secret scrubber when set (and stays registered after a delete, so a late error is still redacted); the SMTP password from 4 characters (other values from 8), because mail passwords are often short. The store keeps at most 64 of its values registered: past that, the oldest value no longer in the store is dropped, never one still in use. The Ollama base URL is not a secret and is not registered.

What setting each name does:

| Name | Stored as | Egress opened (source) | Used by |
|---|---|---|---|
| `ai.anthropic` | the key | `api.anthropic.com:443` (`ai.anthropic`), from a fixed table | `resolveCredential('anthropic')` |
| `ai.openai` | the key | `api.openai.com:443` (`ai.openai`) | `resolveCredential('openai')` |
| `ai.ollama.baseUrl` (+ `model`) | normalized server root (trailing `/` and `/v1` removed) | the URL's host and port (`ai.ollama`) when it is not loopback; nothing for loopback | `resolveCredential('ollama')`; the session endpoint and model stand in for the provider default, a caller's explicit model still wins. `ai_config.ollama_base_url` is never used in desktop mode: with no session endpoint (or after `DELETE`), Ollama means this computer (`http://localhost:11434`) |
| `smtp.password` (+ `host`, `port`, `security`) | the password | `host:port` (`smtp`) after the SMTP host check; `port` defaults to 587, `security` to `tls` on 465 and `starttls` otherwise | every mail transport (`utils/mail-transport.ts`): for that server `tls` = TLS from the first byte (`secure`), `starttls` = STARTTLS required, `none` = clear text |

Validation before anything is allowed: an Ollama base URL must be `http`/`https`, carry no credentials and point at this computer or the owner's own network, i.e. `localhost`, a loopback, RFC 1918 or IPv6 ULA address, or a `.local` name that resolves (at PUT time, past the egress guard) only to such addresses; CGNAT (100.64/10) is carrier space and does not count (`OLLAMA_URL_INVALID` for a malformed, credentialed, link-local or metadata URL, `OLLAMA_HOST_NOT_LOCAL` for any other host: an Ollama elsewhere is a cloud provider that would bypass consent, the token cap and the redaction backstop; the same rule applies to `ollamaBaseUrl` in `PUT /ai/admin/config`); `security: "none"` (clear-text SMTP) is accepted only for such a local-network mail server (`SMTP_SECURITY_REQUIRED` otherwise); an SMTP host must pass `assertHostSafe` (no loopback, link-local or metadata names or addresses; LAN relays allowed) and the port must be 25, 465, 587 or 2525. A loopback relay needs no allowance and is accepted as-is. A mail server the owner did not name in this request stays `EGRESS_BLOCKED`, whatever `/company/smtp` or the system settings say. One mail server per session: a new `host` replaces the previous allowance.

**AI in desktop mode** (`ai-providers/index.ts`, `ai-config.service.ts`):

- `resolveCredential(provider, config)` is the only credential source. Desktop: the session store; the `ai_config` key columns are ignored even when a database restored from a server holds them. Server: the stored, encrypted columns, unchanged.
- Providers offered: `anthropic`, `openai`, `ollama` (Q-33). Any other provider name — in a provider field, a fallback chain, task options, `/ai/admin/test/{provider}` or `/ai/admin/models/{provider}` — is 400 `AI_PROVIDER_NOT_AVAILABLE`; fallback chains are filtered to the three at run time and in `GET /ai/admin/config`.
- `PUT /ai/admin/config` refuses every credential field (`anthropicApiKey`, `openaiApiKey`, `geminiApiKey`, `openaiCompatApiKey`, `digitaloceanApiKey`, `glmOcrApiKey`, `routerToken`) with 400 `DESKTOP_KEYS_NOT_STORED`; `''` is still the "no change" sentinel. Provider choices, models, toggles and budgets are stored as before. `hasAnthropicKey`/`hasOpenaiKey` report the session store; `hasGeminiKey` is always false.
- Without a session key, `hasCredentials()` is false: no SDK client is built and no call is made. Cloud calls still require `isEnabled`, the system disclosure and company consent exactly as on the server.
- Egress backstop: text sent to a cloud provider passes the strict PII sanitizer on top of the caller's own sanitization (`complete()` and the text of `completeWithImage()`), so a caller cannot send bank, card or tax-id data off the machine by omission. Images cannot be text-redacted; the cloud-vision gate (`cloud_vision_enabled` + permissive mode) remains the control. Only the detected PII types are logged, at debug.
- Provider errors are scrubbed of registered and key-shaped secrets before the fallback aggregate, the warn line, `ai_jobs.error_message` and HTTP bodies (`/ai/admin/test/*`, `/ai/admin/models/*`, `/ai/admin/test-function/*`). This also applies on the server.
- The tax-parameter AI check (`/admin/tax-param-ai-checks`) reports `available: false` in desktop mode.
- Usage: `POST /ai/categorize`, `POST /ai/ocr/receipt` and `POST /ai/classify` responses carry `usage: {provider, model, inputTokens, outputTokens}`; `GET /ai/usage/summary?from&to` (tenant session with the right that edits company settings, `company_settings: full`; read-only users and users restricted by a permission template get 403 `PERMISSION_DENIED`; ISO dates or date-times, `to` exclusive, default the current month to now) returns `{from, to, totals:{calls,inputTokens,outputTokens}, rows:[{provider,model,jobType,calls,inputTokens,outputTokens}]}`. Tokens are integers end to end; no dollar figures.
- Monthly token cap (U-29): `ai_config.monthly_token_limit` (`monthlyTokenLimit` in the config API; migration 0219) is an integer per-tenant cap on input + output tokens per calendar month, checked in `createJob` beside the dollar cap; `0` blocks every call, `null` is off. Exceeding it is 400 `ai_token_limit_exceeded`.
  - Migration order: `0217_tenant_archive_imports` and `0218_strip_secret_keys` (PR #151) come before this change's `0219_ai_config_monthly_token_limit`, and PR #153's `0220_companies_closing_password` after it. The migrator applies only journal entries whose `when` is later than the last migration a database has run, so numbers and `when` values must rise together; a later PR whose migration was numbered before this one landed takes the next free number and keeps a later `when`.
- Consent audit rows (`ai_config_system_disclosure`, `company_ai_consent_accepted`) record `provider`, `providers` and `disclosureVersion` (U-30).

**SMTP in desktop mode** (U-13): whenever a mail server needs a login (`smtp_user` set), the transport uses the `smtp.password` session secret and answers 400 `SMTP_NOT_CONFIGURED` when there is none; a stored `companies.smtp_pass`, a system `smtp_pass` setting or the password in a `/smtp/test` body is never used. `PUT /company/smtp` and `PUT /admin/settings` refuse to store or clear a password (400 `DESKTOP_KEYS_NOT_STORED`); `passwordConfigured` reflects the session store. A server without a login needs no password. The SMTP test and sends answer 400 `SMTP_HOST_BLOCKED`, 400 `SMTP_HOST_MISMATCH`, 503 `EGRESS_BLOCKED` or 503 `OFFLINE_UNAVAILABLE` as before. A failed SMTP test's `error` text is scrubbed (a mail server may quote the credentials it rejected); this also applies on the server.

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
- **Ollama base URLs** (local or LAN) must be validated before their host is allowed: `http`/`https` only, no credentials in the URL, only this computer or the owner's own network (loopback, RFC 1918, IPv6 ULA, `localhost`, a `.local` name resolved to one of those; not CGNAT), and a host other than loopback only by an explicit owner choice. Implemented by `session-secrets.validateOllamaBaseUrl` (review item L-6, closed); `openai_compat` is not offered in desktop mode.
- **Only the owner role** may add an allowance (the session-secrets routes require a super admin), and it is removed when the feature is turned off or its secret is cleared. An allowance is never derived from a stored setting at send time: the owner names the mail server together with the password.
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

**AI.** In desktop mode the Anthropic and OpenAI providers are wrapped (`ai-providers/index.ts`; the same wrapper applies the strict sanitizer backstop and scrubs errors, see "Session secrets"): every `complete`, `completeWithImage`, `testConnection` and `listModels` call checks the provider's host first (`ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL`, else the public API host) and maps network errors. Offline errors are not retried. In a fallback chain, once one cloud provider is offline the other cloud providers are skipped, and local Ollama is still tried; if nothing else failed, the caller gets 503 `OFFLINE_UNAVAILABLE` instead of `ai_all_providers_failed`. The per-function AI test returns the 503 too.

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

## Capabilities

| Name | Contract |
|---|---|
| `tenants-list-v1` | `GET /api/v1/tenants` (above). |
| `tenant-archive-v1` | Tenant archive export job, download, import and rename (below). |
| `session-secrets-v1` | `PUT`/`GET`/`DELETE /api/v1/desktop/session-secrets` (above). |
| `ai-desktop-v1` | Per-session AI credentials, provider allowlist and usage summary. |
| `smtp-session-v1` | SMTP password from the session store. |
| `ai-token-cap-v1` | Integer monthly token cap on every AI call in desktop mode. |
| `register-exact-v1` | `?exact=1` on the account register and register summary: money as decimal strings (below). |
| `closing-password-v1` | The closing-date password: `closingPassword` on postings and closing-date changes, `/company/closing-password` and the owner reset `/company/closing-password/reset` (below). |
| `txn-delete-v1` | `DELETE /api/v1/transactions/:id`: soft delete with reversing lines, status `deleted` hidden from registers, reports, balances and lists (below). |
| `check-edit-v1` | `PUT /api/v1/checks/:id` (create body; `printLater` optional; `printedCheckChange` for printed checks); check amount > 0 and lines summing exactly to it on create and edit (below). |
| `line-billable-v1` | `contactId` and `isBillable` per line on checks and expenses; `isBillable` / `billedStatus` on transaction lines (below). |
| `rules-evaluate-v1` | `POST /api/v1/practice/conditional-rules/evaluate`: what the active rules would set for one entry, read-only (below). |
| `deposit-grouping-v1` | Deposit lines take `sourceTransactionId` (an item in Payments Clearing, exact amount, deposited once); `GET /payments/pending-deposits?exact=1` (below). |
| `deposit-cashback-v1` | Deposit `cashBack {accountId, amount, memo?}`; negative line amounts post as debits; total > 0; `cashBack` on `GET /transactions/:id` (below). |
| `vendor-refund-v1` | A deposit line whose `sourceTransactionId` is a vendor credit refunds it (A/P line, at most the open balance) (below). |
| `equity-roles-v1` | Equity role system tags seeded by entity type; `GET /api/v1/company/equity-roles` (below). |
| `feed-deposit-groupings-v1` | `GET /api/v1/banking/feed/:id/deposit-groupings`: Payments Clearing sets adding up exactly to a feed deposit (below). |
| `daily-sales-lock-v1` | Daily-sales post/void honour the closing date and `closingPassword`; templates and entries company-scoped; amounts as strings only (below). |
| `je-names-v1` | Journal entry lines take `contactId`; an A/R or A/P line needs one, at most one such line per entry (below). |
| `je-number-v1` | Journal entry `txnNumber` (at most 20 characters); `GET /api/v1/journal-entries/next-number` (below). |
| `je-adjusting-v1` | `isAdjusting` on journal entries; `adjusting=include|exclude|only` on the main reports and `GET /transactions` (below). |
| `je-reversing-v1` | Journal entry `reverseOn`: an automatic reversing entry, voided / deleted with the original; on edit kept (omitted), removed (`null`) or moved (a date) (below). |
| `balance-exact-v1` | Every posting's debits must equal its credits exactly at 4 places; no tolerance (below). |
| `recurring-guard-v1` | Recurring copies keep line names and billable marks; `PUT /recurring/:id` takes `expectedUpdatedAt` (409 `STALE_SCHEDULE`) (below). |
| `ledger-guards-v1` | `PUT /transactions/:id`: a deposit edit that sends a linked line back without its `sourceTransactionId` while keeping an unlinked line on that account is 409 `DEPOSIT_LINKS_DROPPED` (`details.sourceTransactionIds`); an expense edit that changes a printed check's face is 409 `CHECK_PRINTED` (`details.checkNumber`, `printedAt`, `changedFields`; edit it with `PUT /checks/:id`); a check keeps its own header tags with `TAGS_SPLIT_LEVEL_V2` on. Void reversal lines keep the line contact. `PATCH /checks/:id/memo`, `POST /checks/print`, `/checks/requeue` and `/checks/reprint/:batchId` honour the closing date and `closingPassword` (423 / 403) (U-80, U-81). |
| `merge-closing-date-v1` | `POST /contacts/merge` and `POST /tags/merge` honour the closing date and `closingPassword`; the audit row is written in the merge's transaction and lists the transaction ids (below). |

## Account register

`GET /api/v1/accounts/:id/register` (permission `accounts`). Query: `start_date`, `end_date` (YYYY-MM-DD; send both, the defaults are the last 90 days by server UTC), `txn_type`, `payee`, `search`, `reconciled` (`cleared`, `reconciled`, `uncleared` match the line's `reconciliationStatus` exactly; `all` or absent is no filter), `tag_id` (a tag on any line of the transaction; not a uuid: 400 `VALIDATION_ERROR`), `min_amount`, `max_amount`, `include_void=true`, `sort_by` (`date`, `amount`, `type`, `ref_no`), `sort_dir`, `page`, `per_page` (at most 200), `exact=1`.

Response: `{"account":{"id","name","accountType","detailType","accountNumber"},"balanceForward","endingBalance","filtersApplied","pagination":{"page","perPage","totalRows","totalPages"},"allowedEntryTypes":[],"lines":[{"lineId","transactionId","txnType","txnNumber","checkNumber","txnDate","payeeName","contactId","accountName","accountId","categoryName","categoryAccountId","memo","payment","deposit","runningBalance","reconciliationStatus","hasAttachments","hasSplits","isEditable","status"}]}`.

**Balances do not depend on filters.** `runningBalance` is the account's balance after the line: a window over every line of the account through `end_date` in ledger order (date, entry time, line id), computed before any filter, sort or page. `balanceForward` is the balance before `start_date`; `endingBalance` is the balance at `end_date`, also unfiltered. Only posted transactions move a balance. Drafts are listed but carry their predecessor's balance, and so do void lines with `include_void=true`. A filter only chooses rows.

**Money shape.** By default money fields are JSON numbers as before: balances rounded to cents, `payment`/`deposit` as stored. With `exact=1` (or `exact=true`) every money field (`balanceForward`, `endingBalance`, `payment`, `deposit`, `runningBalance`) is a decimal string with four decimals, e.g. `"-12.0456"`, computed without floating point. `GET /api/v1/accounts/:id/register/summary?exact=1` sends its money fields the same way.

**Register summary (footer).** `GET /api/v1/accounts/:id/register/summary` (query `end_date`, `exact=1`): `{"currentBalance","endingBalance","clearedBalance","asOfDate","unclearedCount","lastReconciliationDate","transactionsThisPeriod"}`. `currentBalance` is the stored account balance, as before. `endingBalance` is the posted balance through `end_date` (all dates when absent; `asOfDate` echoes it or is `null`) in the register's sign, unfiltered, so it equals the register's `endingBalance` for the same `end_date`. `clearedBalance` is the part of it whose lines are cleared in any reconciliation, open or complete (reconciled lines included). A malformed `end_date` is 400 `VALIDATION_ERROR`.

## Closing-date password

An optional per-company password guarding the closed period (`companies.closing_password_hash`, bcrypt; migration `0220`, additive). Without one, every closed-period rule is exactly as before. The password is never stored in plain text, logged, audited, exported or sent back; `closingPassword` is removed from the request body before validation, so it reaches no service input or audit row. Every route that accepts it (or `currentPassword` / `accountPassword` below) counts failed attempts per user: 10 failures in 15 minutes, then 429 `CLOSING_PASSWORD_RATE_LIMIT` (requests without a password and successful ones are not counted). The counters live in the engine's memory in the desktop edition (and on a server without `RATE_LIMIT_REDIS=1`), so an engine restart resets them; this limit, like the engine's other rate limits, slows guessing but is not a lockout. On a server with `RATE_LIMIT_REDIS=1` they are kept in Redis and survive a restart. Every wrong closing-date password (on a posting, `PUT /company/closing-password`, a closing-date change through `/company/settings` or `/tb/closing-date`) and every reset by someone who is not the owner writes an audit row `entity_type: "closing_password_failed"`, `entity_id` = the company, the acting user, after `{"context":"posting"|"change_password"|"closing_date"|"reset_not_owner","transactionId"?,"txnDate"?}`; it is written on its own connection, so it stays although the request changes nothing, and it never holds a password or hash.

| Method | Path | Body / response |
|---|---|---|
| GET | `/api/v1/company/closing-password` | `{"closingDate"(YYYY-MM-DD or null),"setBy","setAt","closingPasswordSet"}` |
| PUT | `/api/v1/company/closing-password` | Body `{"currentPassword"?,"newPassword"(string or null to clear)}`, response `{"closingPasswordSet"}`. With a password set, `currentPassword` must match (else 403 `CLOSING_PASSWORD_INVALID`). With none set, only the owner or a super admin may set one (else 403 `CLOSING_PASSWORD_OWNER_REQUIRED`). New passwords are 8 characters to 72 UTF-8 bytes (else 400 `VALIDATION_ERROR`); one set before this rule keeps working until it is changed. Needs `company_settings` update. Audited as `closing_password` with only a set/not-set flag (`closingDateProtected`). |
| POST | `/api/v1/company/closing-password/reset` | Owner reset of a forgotten password. Body `{"accountPassword","newPassword"(string or null to clear)}`, response `{"closingPasswordSet"}`. The old closing password is not needed; instead the caller re-enters their own sign-in password (checked against their user row): wrong or none 403 `ACCOUNT_PASSWORD_INVALID` (audited as `closing_password_reset_failed`, no secrets). Only the owner or a super admin (else 403 `CLOSING_PASSWORD_OWNER_REQUIRED`); needs `company_settings` update; same length rule (400 `VALIDATION_ERROR`); counted by the same rate limit. Audited as `closing_password_reset` with before `{"closingDateProtected"}` and after `{"closingDateProtected","method":"account_password"}` (audit images use `closingDateProtected` because `auditLog()` strips keys that look like secrets, `password` included). |
| PUT | `/api/v1/company/settings` | Optional `closingPassword` next to `lockDate`. Changing `lockDate` stamps `lockDateSetBy`/`lockDateSetAt` (as `/tb/closing-date` does). With a password set, a change needs it: missing 403 `CLOSING_PASSWORD_REQUIRED`, wrong 403 `CLOSING_PASSWORD_INVALID`. A `closingPassword` given while none is set becomes the company's password ("set or confirm"; owner or super admin). An unchanged `lockDate` and the other settings need nothing. |
| PUT | `/api/v1/tb/closing-date` | Same rule on the server-only TB route (`closingPassword` in the body); `GET` adds `closingPasswordSet`. |

**Postings.** `POST /api/v1/transactions`, `PUT /api/v1/transactions/:id`, `POST /api/v1/transactions/:id/void` and `POST /api/v1/checks` accept `closingPassword` in the body. A date on or before the closing date (for an update, the old or the new date) is then allowed when the password matches; wrong is 403 `CLOSING_PASSWORD_INVALID` and nothing changes. Without it the answer stays 423 `TB_PERIOD_LOCKED`, whose `details` now carry `{"lockDate","canOverride","closingPasswordRequired"}`. Once a company has a password, staff `overrideConfirmed` alone no longer opens its closed period (`canOverride: false`, `closingPasswordRequired: true`); without a password it works as before. Each allowed closed-period change writes one audit row `action: "override"`, `entity_type: "closing_date_override"`, `entity_id` = the transaction, the acting user, before `{"lockDate","lockDateSetBy","lockDateSetAt"}`, after `{"txnDate","method":"password"|"confirmed","overrideConfirmed","transactionId","oldDate","newDate","companyId"}` (create: `oldDate` null; void: `newDate` null). AJEs stay exempt (TB rule TB5) while the company has no closing password; once it has one, creating, editing, voiding, reversing or duplicating an AJE dated in its closed period (`/api/v1/tb/ajes…`, or `POST /transactions/:id/void`) needs `closingPassword` like any other posting, under the same rate limit. `POST /transactions/:id/void` refuses an AJE with 400 `TB_AJE_ROUTE` when `TRIAL_BALANCE_V1` is off. Importers and jobs have no request context and keep the hard 423.

**Audit before-image.** Update, void and delete audit rows on `transaction` keep the header and every journal line as they stood before the change (`before_data.lines`).

## Transaction delete

`DELETE /api/v1/transactions/:id` (capability `txn-delete-v1`; same permission as void: `transactions` write). Optional JSON body `{"reason"?(at most 500 chars),"closingPassword"?,"overrideConfirmed"?}`; no body is fine. Response 200 `{"transaction":{…,"status":"deleted","lines":[…]}}` (the same detail shape as `GET /transactions/:id`).

A soft delete: nothing is physically removed. A posted transaction gets reversing journal lines (debit and credit swapped, same amounts and tags, `is_void_reversal`) and its account balances move back exactly; a draft or void one is only marked. The header becomes `status: "deleted"`. Registers (rows and every balance), the register summary, reports (they read posted transactions only), account balances, the checks list and print queue, duplicate detection and the transactions list leave it out. `GET /transactions` shows deleted transactions only with `status=deleted` or `includeDeleted=true`; `GET /transactions/:id` still returns one (status `deleted`). It can no longer be edited or voided (404) or deleted again (409 `TXN_ALREADY_DELETED`).

Guards, in order: unknown id 404 (not a uuid: 400); already deleted 409 `TXN_ALREADY_DELETED`; an AJE 400 `TB_AJE_ROUTE`; a type other than `journal_entry`, `expense` (checks), `transfer`, `deposit`, `cash_sale` 409 `TXN_DELETE_UNSUPPORTED` (`details.txnType`; invoices, bills, payments and credits keep their own void paths); the closing date exactly as for void (423 `TB_PERIOD_LOCKED`, 403 `CLOSING_PASSWORD_INVALID`, 429 `CLOSING_PASSWORD_RATE_LIMIT`; an allowed one writes the `closing_date_override` row with `newDate` null); lines cleared in a completed reconciliation 409 `RECONCILED_TRANSACTION`; a deposit of undeposited payments, or a payment grouped into one, 409 `TXN_DELETE_LINKED`; another record pointing at it, 409 `TXN_DELETE_LINKED` with `details.links` naming the kinds: `bank_feed_match` (a bank-feed item matched to it; unmatch it first), `accrual` (an accrual entry or schedule), `payroll` (a payroll import session or check-register row), `portal_receipt` (a matched portal receipt), `category_suggestion` (a pending client suggestion on it, or the one that posted it), `recurring_template`, `daily_sales`, `estimated_tax_payment`. Informational links (findings, rule audit, dismissals, portal questions) don't block.

Audit: one row `action: "delete"`, `entity_type: "transaction"`, before = the header and every journal line as they stood (`lines`), after `{"status":"deleted","reason"}`, the acting user.

## Checks: edit, line customers, billable lines

**Exact amounts.** `POST /api/v1/checks` and `PUT /api/v1/checks/:id`: `amount` must be greater than zero, and the line amounts must add up exactly to it (decimal arithmetic, no tolerance; the old float check let a cent through), else 400 `VALIDATION_ERROR`. Check and expense amounts (`POST`/`PUT /transactions` with `txnType: "expense"`) must be plain decimal strings, optionally negative, with at most 4 decimal places (`"12"`, `"-3.5"`, `"0.0001"`); exponents, thousands separators, currency signs or a fifth place are 400 `VALIDATION_ERROR`. An expense's payment-side credit is the exact sum of its lines.

**Line customer and billable (`line-billable-v1`).** Check lines (`lines[].contactId`, `lines[].isBillable`) and expense lines (same names) take an optional customer and a billable mark. The customer is stored on the line (`journal_lines.contact_id`) and must be a contact of the tenant that is tenant-wide or the active company's (else 400 `VALIDATION_ERROR`); `isBillable: true` needs it (else 400 `VALIDATION_ERROR`). A billable line is stored with `is_billable = true`, `billed_status = 'unbilled'`; every other line has `false` / `null` (migration `0221`, additive, CHECK `journal_lines_billed_status_chk` keeps the pair consistent; `'billed'` is reserved for invoicing the cost later). An edit (`PUT /checks/:id`, `PUT /transactions/:id`) carries a `'billed'` line over when a billable input line has the same account, debit, credit and customer (description and tag may change); changing or removing a billed line is 409 `LINE_BILLED` (`details {lineId, accountId}`). Void and delete clear a transaction's billable lines to `false` / `null` (the audit before-image keeps them) and refuse with 409 `LINE_BILLED` while a line is `'billed'`. `GET /transactions/:id` returns each line's `contactId`, `contactName`, `isBillable` and `billedStatus`. Tenant archives carry both columns (the archive plan reads the live schema).

**Edit (`check-edit-v1`).** `PUT /api/v1/checks/:id`, the `POST /checks` body without `draftAttachmentId`, except that `printLater` is optional with no default (absent keeps the current print state), plus `printedCheckChange?: "reprint" | "keep_number"` and `closingPassword?`; permission `checks`. Response 200 `{"check":{…transaction header,"lines":[…],"checkNumber","printStatus","payeeNameOnCheck"}}`. The ledger side is `PUT /transactions/:id`'s update: lines and balances replaced, the closing date for the old and the new date (423 `TB_PERIOD_LOCKED`, 403 `CLOSING_PASSWORD_INVALID`, 429 `CLOSING_PASSWORD_RATE_LIMIT`, one `closing_date_override` row when allowed), the reconciled-line guard (400), a void check 400, and the `transaction` audit row with the before-image lines. The check fields are written in the same database transaction and audited as `entity_type: "check"` with before `{"checkNumber","printStatus","printedAt","payeeNameOnCheck","payeeAddress","printedMemo"}` and after `{"checkNumber","printStatus","payeeNameOnCheck","payeeAddress","printedMemo","printedCheckChange"(+ "changedFields" when set)}`.

*Printed checks.* When the check is `printed` and the edit changes its printed face — amount, payee `contactId`, `payeeNameOnCheck`, `payeeAddress`, the memo line (`printedMemo`, or `memo` when no printed memo is set, as check printing picks it), bank account, date, or a different `checkNumber` — or sends `printLater: true`, the body must carry `printedCheckChange`: `"reprint"` puts it back in the print queue (number, print time, batch and signature cleared); `"keep_number"` keeps it numbered as `hand_written` (print time, batch and signature cleared; `printLater: true` needs `"reprint"`). Without it: 409 `CHECK_PRINTED`, `details {checkNumber, printedAt, changedFields}`, nothing changes. Edits that leave the face alone (line accounts, descriptions, tags, customers, billable marks with the same amount) need no flag and keep the check `printed`. `printedCheckChange` is ignored on checks that have not printed.

*Numbering (checks not printed).* `printLater: true` puts it back in the print queue (number, print time, batch and signature cleared); `checkNumber` given: the number must be free on the bank account (409) and the status becomes `hand_written`, the counter advancing past it, as on create; otherwise a numbered check keeps its number and status (still checked for duplicates on the bank account), a queued check stays queued — unless `printLater: false`, which takes the next number from the counter.

*Header tags.* `tagIds` must be tags of the tenant that are tenant-wide or the active company's (400 `VALIDATION_ERROR`, also on `POST /checks`); on edit a sent `tagIds` replaces the check's header tags (`[]` clears them), absent leaves them as the ledger edit does. Only checks are edited here: a transaction without a print status, a deleted one, another company's or tenant's is 404; a check that pays bills (`bill_payment`) is 400 `CHECK_NOT_EDITABLE`.

## Conditional rules: evaluate

`POST /api/v1/practice/conditional-rules/evaluate` (capability `rules-evaluate-v1`; the conditional-rules router exists only under `/practice`, so the same gate applies: not a client user, not read-only, tenant flag `CONDITIONAL_RULES_V1` on, else 404/403). Body `{"description"(≤1000 chars),"amount"(signed decimal string, negative = money out, as on bank feed items),"bankAccountId","contactId"?,"txnDate"?(YYYY-MM-DD, default today UTC)}`. Response 200 `{"match":null}` or `{"match":{"ruleId","ruleName","accountId","tagId","contactId"}}`. The tenant's active rules are evaluated exactly as for a bank-feed item (the same rule list, tier order when `RULES_TIERED_V1` is on, symbol resolution and action aggregation): `bankAccountId` is the rules' `account_source_id`, the contact's display name is appended to the description as a check's payee is, `ruleId`/`ruleName` name the first rule that matched, and `accountId`/`tagId`/`contactId` are the aggregated `set_account`/`set_tag`/`set_vendor` results (null when no rule sets them). Read-only: nothing is staged, no fire is recorded, no audit row. `bankAccountId` and `contactId` must belong to the tenant and be tenant-wide or the active company's (`X-Company-Id`, as on company routes; else 400 `VALIDATION_ERROR`). No network use.

## Deposits: grouping, cash back, vendor refunds

`POST /transactions` / `PUT /transactions/:id` with `txnType: "deposit"` (body in `openapi.json`). Journal shape: DR the deposit-to account for the line total less cash back; each line CR its account (a negative amount is a DR, for fees taken out of the deposit); the cash-back account DR with `line_role = 'cash_back'`. The header `total` is the amount the bank gets and must be greater than zero (400 `DEPOSIT_TOTAL_NOT_POSITIVE`). Lines without `sourceTransactionId` post as before (any decimal, rounded to 4 places by the column; non-numeric is 400 `VALIDATION_ERROR`), unless the body has `strictAmounts: true`: then every line amount must be a decimal string with at most 4 places and no exponent or separators (400 `VALIDATION_ERROR`). The desktop app always sends `strictAmounts: true`; the web pages, MCP, batch entry and API v2 keep the lenient form. The response is `{transaction, clearingWouldGoNegative}` (201 on create, 200 on edit): `clearingWouldGoNegative` is true when, after this posting, Payments Clearing holds a net credit for the active company (its items and those without a company), i.e. more was deposited from it than ever came in; it is only computed when the deposit has a Payments Clearing line, else false. `PUT /transactions/:id` with `txnType: "deposit"` on a transaction that is not a deposit is 404.

**Grouping (`deposit-grouping-v1`).** A line with `sourceTransactionId` deposits that item: a posted transaction of the tenant and the active company (or without a company) that holds a net debit in Payments Clearing (customer payment, sales receipt, daily sales, journal entry…). The line account must be Payments Clearing (400 `DEPOSIT_SOURCE_ACCOUNT`) and the amount, a decimal string with at most 4 places, must equal the item's net clearing debit exactly (400 `DEPOSIT_SOURCE_AMOUNT_MISMATCH`, `details.expected`); a missing, foreign, other-company, void or deleted item is 400 `DEPOSIT_SOURCE_INVALID`; the same item twice in one deposit is 400 `DEPOSIT_SOURCE_DUPLICATE`; an item another posted deposit holds is 409 `ALREADY_DEPOSITED` (`details.depositId`). The source rows are locked `FOR UPDATE` inside the posting transaction, so two deposits racing for one item serialize and the second gets the 409. The link is written to `deposit_lines` and to `journal_lines.source_transaction_id` (migration `0223`) in the same transaction, and `GET /transactions/:id` returns each line's `sourceTransactionId` and `lineRole`. Void and delete of the deposit release its items (audit `releasedDepositLinks`); an edit replaces them. A deposited item can't be voided (409 `TXN_DEPOSITED`), deleted (409 `TXN_DELETE_LINKED`) or edited so its clearing amount changes (409 `TXN_DEPOSITED`).

Grouping trusts the links. A Payments Clearing line without `sourceTransactionId` clears no particular item, so the items it was meant for stay on the pending list and can be deposited again with their links; nothing can tell which items an unlinked line covered. The engine's web Bank Deposit page sends the links for the items picked; other callers that deposit plain clearing lines (MCP, batch entry, API v2) should be treated as unlinked. `clearingWouldGoNegative` is the signal that an item was deposited twice that way: a client should warn and offer to edit or void one of the deposits.

`GET /api/v1/payments/pending-deposits` lists the items waiting in Payments Clearing for the active company: one row per transaction `{transactionId, txnType, date (YYYY-MM-DD), customerName, contactId, refNo, paymentMethod, memo, amount}` and `paymentsClearingBalance`; void, deleted and deposited items are left out. Amounts are numbers by default (the web page) and 4-place decimal strings with `?exact=1`.

**Cash back (`deposit-cashback-v1`).** `cashBack: {accountId, amount, memo?}` (amount a decimal string > 0, else 400 `VALIDATION_ERROR`). The account may not be the deposit-to account or a control account (Payments Clearing, Accounts Receivable, Accounts Payable, Sales Tax Payable): 400 `VALIDATION_ERROR`. `GET /transactions/:id` on a deposit returns `cashBack: {accountId, amount, memo} | null`.

**Vendor refund (`vendor-refund-v1`).** A line whose `sourceTransactionId` is a posted vendor credit refunds it: the account must be Accounts Payable (400 `VENDOR_REFUND_ACCOUNT`), the line contact is set to the credit's vendor (another contact is 400 `VENDOR_REFUND_CONTACT`), and the amount may not exceed the credit's open balance, i.e. its total less bill-payment applications and other posted refunds (409 `VENDOR_CREDIT_EXCEEDED`, `details.openBalance`). The credit's `balance_due` / `credits_applied` / `bill_status` follow (refunds count as applied); voiding the refund restores them; the credit can't be voided while a refund stands (409 `TXN_DEPOSITED`). The vendor statement (`/reports/vendor-statement`) lists a deposit's A/P lines that name the vendor as a charge (the refund puts the amount back on the vendor's balance), in the opening balance and the activity alike. Rolling back migration `0223` is refused while a refund link exists (void or delete those deposits first).

**Deposit suggestions (`feed-deposit-groupings-v1`).** `GET /api/v1/banking/feed/:id/deposit-groupings?limit=1..20` (default 5; permissions `banking` and `receive_payment` read, else 403 `PERMISSION_DENIED`). For a feed deposit (negative feed amount) it returns `{feedItemId, targetAmount, windowStart, windowEnd, candidates: [{total, itemCount, items: [pending-deposit rows, amounts as strings]}], truncated, itemsConsidered}`: sets of pending items dated within ±10 days whose amounts add up to the feed amount exactly (compared as integers of 1/10000), fewest items first, then nearest dates. Bounded: 40 items (nearest dates), 250,000 search nodes, 250 ms; `truncated: true` when a bound cut the search. Money-out items return no candidates; another company's feed item is 404. Read-only.

## Equity roles

`accounts.system_tag` gains `owner_draw`, `owner_contribution`, `partner_draws`, `partner_contributions`, `shareholder_distributions`, `paid_in_capital` (catalog in `shared/constants/equity-roles.ts`; listed with the system roles, not required, re-pointed with the system-accounts repair tool). A new company gets the roles of its entity type (sole proprietor and single-member LLC: Owner's Draw, Owner's Contribution; partnership: Partner Draws, Partner Contributions; S corporation: Shareholder Distributions, Paid-in Capital; C corporation: Paid-in Capital, Dividends Paid), and an entity-type change adds the new type's roles. An untagged equity account with a known name or template number (30160 Owner Contribution, 30170 Owner Withdraw) is adopted instead of adding a twin; only names that can mean nothing but the role are known (generic ones such as Distributions, Dividends, Common Stock or Capital Stock are left alone), plus the exact name the tenant's entity type gives the role (a C corporation's Dividends Paid); otherwise an account is created (template number when free; `is_system` true like the other engine-made role accounts, renameable but not deletable; an adopted account keeps its flag). Seeding runs in one database transaction under a per-tenant advisory lock, so concurrent seeds make no twins. Migration `0223` does the same for existing tenants, idempotently; its rollback clears the role tags and `is_system` on the role accounts (the accounts stay). These accounts stay ordinary categories (bank-feed suggestions and suspense reclassification accept them). `GET /api/v1/company/equity-roles` → `{entityType, roles: {owner_draw, owner_contribution, partner_draws, partner_contributions, shareholder_distributions, paid_in_capital, retained_earnings: accountId | null}}`. `POST /api/v1/tenants` (and the other tenant-creation paths) now store a known `entityType` on the first company.

## Daily sales

`POST /daily-sales/entries/:id/post` and `/void` run under the closing date like every posting (`daily-sales-lock-v1`): a business date on or before it is 423 `TB_PERIOD_LOCKED`, `closingPassword` opens it (403 `CLOSING_PASSWORD_INVALID`, 429 `CLOSING_PASSWORD_RATE_LIMIT`, one `closing_date_override` audit row). Templates and entries are company-scoped (another company's are 404 and left out of lists; rows without a company stay visible). Entry amounts are decimal strings with at most 4 places; a JSON number is 400.

## Merges and the closing date

`POST /api/v1/contacts/merge` (`{"sourceId","targetId","closingPassword"?}`) and `POST /api/v1/tags/merge` (`{"sourceTagId","targetTagId","closingPassword"?}`) rewrite transactions of every date: the contact merge repoints `transactions.contact_id` and `journal_lines.contact_id` (and the bank-feed, rule and suggestion references), the tag merge moves header tags (`transaction_tags`), line tags (`journal_lines.tag_id`) and the default-tag references of items, contacts, bank rules and budgets, then deletes the source tag (`merge-closing-date-v1`). When any transaction the merge would change is dated on or before its company's closing date (a transaction without a company: the latest closing date of the tenant), the merge is a closed-period edit like any other: 423 `TB_PERIOD_LOCKED` (`details {lockDate, canOverride, closingPasswordRequired}`) without `closingPassword`, 403 `CLOSING_PASSWORD_INVALID` when wrong, 429 `CLOSING_PASSWORD_RATE_LIMIT`; nothing changes in any of these cases. A company without a closing-date password accepts the staff `overrideConfirmed: true` as on postings. The affected transaction rows are locked `FOR UPDATE` while the merge runs. Merging a contact or tag into itself is 400.

Audit, in the merge's own database transaction: contact merge `action: "update"`, `entity_type: "contact"`, tag merge `action: "delete"`, `entity_type: "tag"`; `entity_id` = the source, before = the source row, after `{"merged_into","moved":{<table>: rowCount},"transactions":{"count","ids","truncated"},"closedPeriodOverride":null | {"method":"password"|"confirmed","count","ids","truncated","lockDates":[{"companyId","lockDate"}]}}`. `ids` lists at most 500 transaction ids (`truncated` true when there were more; `count` is the full number); `closedPeriodOverride.ids` are the ones in a closed period. Each permitted closed-period merge also writes one `closing_date_override` row per company (`entity_id` = the company, after as on postings with `transactionId` null and `context: "contact_merge"|"tag_merge"`, `mergeSourceId`, `mergeTargetId`, `transactionCount`). No password is stored.

## Journal entries: names, numbers, adjusting, reversing

`POST /transactions` / `PUT /transactions/:id` with `txnType: "journal_entry"` (body in `openapi.json`; migration `0224`, additive).

**Names (`je-names-v1`).** `lines[].contactId` (optional, nullable) is stored on the line and returned on `GET /transactions/:id` with `contactName`. It must be a contact of the tenant that is tenant-wide or the active company's (400 `VALIDATION_ERROR`). Every line on an Accounts Receivable or Accounts Payable account (detail type or system tag `accounts_receivable` / `accounts_payable`) needs a `contactId` (400 `JE_AR_AP_NAME_REQUIRED`); an entry may have any number of such lines. This applies to the entry points that post a journal entry someone typed (`POST`/`PUT /transactions`, the web form, which has a Name column, API v2, MCP); accrual schedules and the batch journal-entry import, which have no name column, are exempt (their line names are still scope-checked). Lines posted by other documents are not affected. An entry posted before this rule (or by an exempt poster) that breaks it, for example an A/R line with no name, can't be edited (`PUT`) until the edit fixes it: the edit is held to the rule like a new entry and refused with the same 400. Voiding or deleting it still works; or edit it with the name added.

**Numbers (`je-number-v1`).** `txnNumber` (trimmed, at most 20 characters, free text, duplicates allowed). On an edit an omitted `txnNumber` keeps the stored number and `""` clears it. `GET /api/v1/journal-entries/next-number` (permission `transactions`) → `{"next": "<string>"}`: the highest all-digit journal entry number of the active company plus one (`"1"` when there is none); void and deleted entries count; AJEs (their own numbering) do not. Nothing is reserved.

**Adjusting (`je-adjusting-v1`).** `isAdjusting` (boolean; omitted on create is false, on edit unchanged) is stored on `transactions.is_adjusting` and returned on `GET /transactions/:id` and in `GET /transactions` rows (with `reversesTransactionId`). The TB module's AJEs are adjusting entries (`is_adjusting` true; migration `0224` marks the existing ones). The lens `adjusting=include|exclude|only` (default `include`; any other value is 400 `VALIDATION_ERROR`) is honoured by `GET /transactions` and by these reports, accrual and cash basis: `/reports/profit-loss` (the standard report, `compare=by_tag` and every `compare` mode: each column), `/reports/balance-sheet` (`compare` too; its retained-earnings and net-income rows too), `/reports/trial-balance` (its prior-years retained-earnings row too), `/reports/general-ledger` (beginning balances and lines), `/reports/transaction-list` and `/reports/journal-entry-report`. Other reports (cash flow, aging, TB workpapers, report packs, …) include every entry.

**Reversing (`je-reversing-v1`).** `reverseOn` (YYYY-MM-DD, after `txnDate`, else 400 `VALIDATION_ERROR`; `txnDate` of a journal entry is a YYYY-MM-DD calendar date too, a date-time or an impossible date is 400). Posting the entry also posts its reversal in the same database transaction: a journal entry dated `reverseOn` with every line's debit and credit swapped (same account, description, name and tag; not billable), memo `Reverses JE <txnNumber>` (or `Reverses JE of <txnDate>` without a number), no number of its own, the original's basis and adjusting flag, and `reversesTransactionId` = the original. Both dates go through the closing date (423 `TB_PERIOD_LOCKED`; one `closingPassword` opens both; one `closing_date_override` audit row per posting); when either is refused nothing is posted. The response, and `GET /transactions/:id` of the original, carry `reversalTransactionId` and `reverseOn` of the live reversal (both null without one); `GET` of the reversal carries `reversesTransactionId`.

Voiding (`POST /transactions/:id/void`) or deleting (`DELETE /transactions/:id`) the original voids or deletes its reversal in the same database transaction (the reversal's own closing-date check applies). Editing the original (`PUT`) treats `reverseOn` in three ways: omitted keeps the reversal on its stored date (an entry without one stays without one), `null` removes it, a date moves it there (or adds one). A reversal the edit leaves exactly as it would post it (same date, memo, basis, adjusting flag and swapped lines with descriptions) is kept as it is; otherwise the old one is deleted (soft delete, with reversing lines) and a new one posted from the edited lines on the kept or new date, in the same database transaction. So an edit of the lines with `reverseOn` omitted re-posts the reversal on its date; the stored date must still be after the edited `txnDate` (400 `VALIDATION_ERROR`). The engine web form sends back the `reverseOn` that `GET` returned. Replacing or removing a reversal (void and delete too) is refused with 409 `REVERSAL_EDITED` (`details {reversalTransactionId, reverseOn}`) when the reversal was changed after it was created: its header updated (any edit, payee change), its lines no longer the original's swapped (account, amounts, name, tag), or it is not posted. The owner voids or deletes the reversal first; a voided or deleted reversal is simply gone, and the original then voids, deletes or is edited alone. A reversal can be edited, voided or deleted directly like any journal entry. Rolling back `0224` drops the link (reversals stay as ordinary entries) and the adjusting flag.

**Exact balance (`balance-exact-v1`).** Every posting (`postTransaction`, `updateTransaction`: all documents, not just journal entries) must balance exactly at the stored scale: each line amount is rounded to 4 places the way `numeric(19,4)` stores it (half away from zero) and the debit and credit sums must be equal, else 400 `Transaction does not balance: debits (…) != credits (…)`. The old check allowed a difference up to 0.0001, which could store an unbalanced entry. The document builders round first and total the rounded values: an invoice, cash sale or credit memo rounds each line amount (quantity × rate) and each line's tax to 4 places and the A/R or deposit line is their sum (two lines of 1.5 × 0.3333 store 0.5000 + 0.5000 and A/R 1.0000); a bill, vendor credit or bill payment rounds each line or applied amount the same way before the A/P and bank totals.

## Recurring

The generic copy path (journal entries, expenses, checks, transfers, deposits…; bills and invoices go through their own services) copies each template line's `contactId` and billable mark (a billable line of the new occurrence is `unbilled`), a journal entry's `basis` and `isAdjusting`, and records `recurringScheduleId` and `source: "recurring"` (`sourceId` = the schedule id) on the posted transaction. A recurring bill copies the template's line amounts exactly (all 4 places; it used to round to cents). `PUT /api/v1/recurring/:id` takes `expectedUpdatedAt` (`recurring-guard-v1`; the schedule's `updatedAt` as last read, ISO 8601 with offset): the update applies only while the stored `updated_at`, to the millisecond, still equals it, else 409 `STALE_SCHEDULE` (`details.updatedAt`) and nothing changes. Omitted, the update applies as before.

## Host requirements

What the desktop app (ClientLedger's `cl-host`) must do, because the engine cannot enforce it:

- Pass absolute paths for `CL_DATA_DIR` and `CL_LOG_FILE` (the engine refuses relative ones) inside a directory only the owner's account can read.
- Open, rotate and delete the log files with share-delete semantics on Windows (`FILE_SHARE_DELETE`), and never hold a rotated file open, so the engine's rename-based rotation keeps working while the host tails the log.
- Keep the launch token secret: environment only, never the command line, a file or a log. Anyone holding it can call `/api/v1/desktop/info` and `/initialize`; with the owner's session it can also set the session secrets.
- **P04 requirement (not implemented):** the host should verify it is talking to its own engine, not to another process that grabbed the port, before sending the token or credentials. Planned: the host sends a random challenge and the engine answers with an HMAC of it keyed by the launch token (e.g. a header on `/health`), so the token itself never has to be sent first.
- Helper processes started by the engine (poppler `pdftoppm`, `pdftotext`, `pdfimages`) get a minimal environment in desktop mode (`PATH`, temp and locale variables, library and font paths; nothing credential-named), so boot secrets and API keys are not inherited. If the host bundles poppler, its libraries must be findable through `PATH` / `LD_LIBRARY_PATH` / `DYLD_*` or an rpath.

## Tenant lifecycle and archives

`/api/v1/tenants` and `/api/v1/tenant-archives` are mounted in every mode (they are the two tenant prefixes on the workspace allowlist). Every endpoint that names a tenant answers 409 `WORKSPACE_TENANT` for the workspace; writes need an interactive session and the `owner` (or `admin`) access role on the tenant (super admins pass).

| Method | Path | Body / response |
|---|---|---|
| GET | `/api/v1/tenants` | `[{id, name, createdAt, updatedAt, role}]` of the companies the user has an active access row to. In desktop mode a super admin (the owner) sees every company on the install (owner decision Q-244); a company without an access row for them reports `role: "owner"`, the role `auth/switch-tenant` issues there. On a server the list stays access-row only for everyone (super admins use the admin tenant routes). Never the workspace, never a scratch copy. |
| POST | `/api/v1/tenants` | `{name, businessType?, coaTemplate?, systemAccountsOnly?}` → 201 `{id, name, companyId}` (reuses `createOwnedTenant`: tenant + company + chart of accounts + `owner` access row, no firm join; `systemAccountsOnly` seeds only the required system accounts, as `auth/create-tenant` does). |
| PATCH | `/api/v1/tenants/:id` | `{name, expectedUpdatedAt}` → `{id, name, updatedAt}`; 409 `STALE` when `expectedUpdatedAt` no longer matches. Renames the tenant label only. |
| POST | `/api/v1/tenants/:id/archives` | `{passphrase, includeAttachments=true, includeAudit=true, host?}` → 202 `{jobId, archiveId}`. 400 `PASSPHRASE_TOO_WEAK` (floor 12 characters), 400 for a `host` object over 16 KiB. |
| GET | `/api/v1/tenant-archives/jobs/:jobId` | `{jobId, kind, status, progress, step, result?, error?}`. Jobs live in memory: after an engine restart the id is 404 `JOB_UNKNOWN` (failed → start again). Only the user who started a job (or a super admin) can read it. One job per kind runs at a time (a second export waits `queued` behind the first; an export and an import overlap); the passphrase key derivation runs off the event loop. After 5 wrong passphrases in 15 minutes a user's imports answer 429 `PASSPHRASE_RATE_LIMITED` (`details.retryAfterSec`) before any derivation; a right passphrase clears the counter. |
| GET | `/api/v1/tenant-archives/:fileName/download` | The encrypted archive bytes (`application/zip`); writes no audit row. |
| POST | `/api/v1/tenant-archives/import` | multipart `file` (any mode) or, on desktop without LAN, JSON `{path}` to a local `.zip`/`.clbackup` (absolute path to a regular file, opened read-only, never copied); `passphrase` always; `name?`; `scratch:true` → 400 `SCRATCH_NOT_AVAILABLE` until the safe-delete change lands. Permission, checked before any upload byte is accepted: desktop → super admin only (403 `SUPER_ADMIN_REQUIRED`); server → the tenant-creation eligibility of `POST /api/v1/tenants` (403 `TENANT_CREATION_NOT_ALLOWED`). User rows are created only when the caller is a super admin (decided from the caller's own row); any other caller gets the books, an `owner` access row, matched users keep their archived access rows, and unmatched archived users are skipped with the warning `USERS_NOT_CREATED:<n>`. Archived `role`, `user_type` and access roles must be in the engine's closed lists (`owner`, `accountant`, `bookkeeper`, `readonly`; `staff`, `client`) or the import is 422 `ARCHIVE_CORRUPT`. When a skipped user owns rows through a NOT NULL foreign key (a check-signature grant, for instance) the import is 403 `IMPORT_NEEDS_SUPER_ADMIN` and nothing is written. → 202 `{jobId}`; the job's `result` is `{tenantId, name, scratch, archiveId, sourceTenantId, verification, host, warnings}`, where `host` echoes the manifest's opaque object. |

**Archive format** (`mybooks-tenant-archive`, formatVersion 1): a zip with a plaintext `envelope.json` (format, `archiveId`, KDF and cipher parameters, key check) and encrypted entries: `manifest.json.enc`, `data/_tenant`, `data/_users`, `data/_user_tenant_access` (identity), one `data/<table>.ndjson.enc` per archived table (one `row_to_json` line per row), and `files/<table>/<column>/<rowId>.enc` for bundled files (attachments, logos, check signatures, payroll files, report PDFs). Encryption is PBKDF2-SHA512 (600,000 iterations) over the passphrase and chunked AES-256-GCM whose AAD binds every chunk to its archive, entry and position. The passphrase is a request field: never stored, logged (scrubber) or written into the archive. A ClientLedger `.clbackup` is this archive byte-for-byte; application metadata goes in `manifest.host`, never in extra entries.

**What travels.** The plan in `services/tenant-portability/plan.ts` is generated from the live schema and fails closed: every public table is `tenant` (has `tenant_id`), `child` (reached through a parent), `identity`, `global` (install reference data, mapped by natural key on import) or `excluded` with a closed category (`secret`, `session-token`, `job-bookkeeping`, `derived`, `provenance`, `server-feature`). Secrets other than user password hashes are redacted (`companies.smtp_pass`, Stripe and remote-backup credentials, TFA state); public link tokens are nulled; references into excluded tables are nulled. The audit log's `before_data` / `after_data` row images are exported through `mybooks_strip_secret_keys` (migration `0218`), which removes every secret-looking key (`utils/secret-keys.ts`: `secret`, `token`, `password`, `*pass`, `passphrase`, `api_key`, `encrypted`, `hash`, `otp`, `refresh`, `credential`, `remote_backup_config`, snake_case or camelCase, at every depth, inside the JSON-string images `auditLog()` writes too); `auditLog()` strips the same keys before it writes, so an archive carries the same image the live install keeps from now on. The manifest records the trial balance by company, an unbalanced-transaction count, a tenant fingerprint (`fp1`), redacted columns and warnings (`SERVER_FEATURE_ROWS`, `DANGLING_REFERENCE:…`, `FILE_MISSING:…` on a server). On desktop a missing or wrongly sized file fails the export (422 `FILE_MISSING` / `FILE_SIZE_MISMATCH`).

**Re-encrypted columns (M5).** `vendor_1099_profile.tin_encrypted` is ciphertext under the exporting install's `PLAID_ENCRYPTION_KEY`, unreadable anywhere else. The export decrypts it and the TIN travels in plaintext inside the passphrase-encrypted archive (never in the raw file); a value the install cannot decrypt travels as NULL with the warning `TIN_UNREADABLE:vendor_1099_profile.tin_encrypted:<rowId>`. The import encrypts it again under its own key and verifies it by decrypt-and-compare (`reencrypt(table.column)` on failure). The column is left out of the content digest (`SECRET_COLUMNS` action `reencrypt`, `plan.ts`).

**Password hashes (owner decision Q-234).** A backup contains everyone's sign-in data: the identity section carries the bcrypt password hash of every user with access to the company, super admins included, whoever makes the backup (owner, super admin or company admin), so every user can sign in with their own password after a restore on another computer. The archive is encrypted with the backup passphrase (at least 12 characters), which is what protects those hashes; a host should tell the person making the backup that it holds everyone's sign-in data and to keep the passphrase safe. On import users matched by email (the owner included) are never modified, and a created user is never a super admin, so a hash never grants more than its archived role.

**Export** holds a session-level shared advisory lock on the tenant and streams every table from one `REPEATABLE READ, READ ONLY` snapshot through server-side cursors; rows never pass through JavaScript as values. The file is written as `CL_ARCHIVE_DIR/<tenantId>/<archiveId>.partial` and renamed to `.zip`; one `tenant_archive` audit row (with the file's SHA-256) is written in the exported tenant on success and never on failure. `.partial` files, `.import-pending` upload directories and leftover `imports/*.upload.zip` files older than an hour are swept at boot and hourly; a sweep never touches a resource of a queued or running in-process job (tenant id, archive id, upload path) and skips every tenant whose advisory lock is held, so an export or import running in another process keeps its files.

**Import** verifies the whole archive before touching the database (passphrase, every part and file hash, schema compatibility: unknown tables or columns, retyped columns and missing NOT NULL columns fail closed unless `compat.ts` lists them), builds a fresh id map (every uuid pk gets a new id; global rows map by natural key; users match by normalized email and are never modified, unmatched users are created with the archived id, homed in the workspace with a `readonly` workspace row, never a super admin), then runs one transaction under an exclusive advisory lock: tenant row, identity, every table in FK order, files under a `.import-pending` marker, and a content verification (per-table counts, canonical digests with ids mapped back, the trial balance by company, file hashes, identity, and references: every row's `tenant_id` is written as the new id whatever the archive line says, and after the inserts every foreign key and classified soft reference of every imported row must point inside the new tenant's scope, at a user the archive named (matched, created, or a skipped user's ghost id) or the importing caller, at a global row, or be NULL; references into excluded tables must be NULL). Any difference rolls back with 422 `ARCHIVE_VERIFY_FAILED` and a report of table and check names only. After verification the import writes a `tenant_import` audit row, the tenant fingerprint and a `tenant_archive_imports` provenance row (migration `0217`). The importing user gets an `owner` access row unless the archive already grants one.

**File columns are never copied from the archive.** On import every file column (attachment keys and paths, logo URLs, check-signature and payroll paths) is derived from the new tenant and row id by its resolver, on every row and whatever the table's pk shape; `attachments.file_path` always mirrors the new `storage_key`. Only http(s) URLs pass through. A non-null value whose file is not bundled becomes NULL (or, on a NOT NULL column, a tenant-rooted name of a file that does not exist) with the warning `FILE_NOT_BUNDLED:<table>.<column>:<n>` when the manifest explains the absence (`includeAttachments:false`, or a `FILE_MISSING` / `FILE_SIZE_MISMATCH` / `EXTERNAL_FILE` export warning for that row); otherwise the archive is 422 `ARCHIVE_CORRUPT`. A manifest whose table `pk` or `bucket` differs from the live plan is `ARCHIVE_CORRUPT` too. Independently of archives, stored paths are treated as data everywhere they are read back: attachment paths must sit in the tenant's own folder, check-signature paths inside `UPLOAD_DIR/signatures/<tenant>`, payroll paths inside `UPLOAD_DIR/payroll`, and a storage provider obtained for a tenant refuses keys that name another tenant's folder or the `_system` root (`utils/contained-path.ts`, `storage/tenant-scoped.provider.ts`).

`POST /api/v1/auth/switch-tenant` and `/api/v2/tenants/switch` refuse a tenant whose `tenant_archive_imports.scratch` is true with 403 `SCRATCH_TENANT`, super admins included.

**`host` is opaque.** The manifest's `host` object is stored and echoed exactly as the exporting client sent it (≤ 16 KiB) and the engine never interprets it. On import it comes from the archive, so a client must treat it as untrusted input (validate shape and size before use), the same as the rest of a file an owner picked from disk.

**Path imports** (`{path}`, desktop without LAN) accept an absolute local path to a regular `.zip`/`.clbackup` file; UNC and other network paths are refused (400 `VALIDATION_ERROR`), and a missing file, a directory or a wrong extension all answer the same 400 `FILE_NOT_FOUND`. Import passphrases must be at least 12 characters (an export never accepts fewer). Before writing files the import checks the upload volume's free space against the bundled file bytes plus a 256 MiB margin (507 `INSUFFICIENT_STORAGE`). Archive files are created `0600` in `0700` directories, uploads are `0600`, and a zip with more than 1,000,000 entries is refused before its envelope is read. Job and download routes need an interactive session (no API key or download token).

### Known gaps

- **Audit rows written before `0218` keep their secrets in the live database.** The export strips them at read time and `auditLog()` strips new rows, but no migration rewrites existing `audit_log` rows: on a server appliance that is a full rewrite of a very large table. An operator who wants the live rows cleaned can run `UPDATE audit_log SET before_data = mybooks_strip_secret_keys(before_data, '<pattern>'), after_data = mybooks_strip_secret_keys(after_data, '<pattern>')` with the pattern from `utils/secret-keys.ts` during a maintenance window.
- **No free-space check before an export.** The archive size is not known until the snapshot has been streamed; a full disk fails the export (the `.partial` is removed) rather than being refused up front.
- **File modes are advisory on Windows.** `0600`/`0700` are applied where files are created; NTFS ignores them, so the host must keep the data directory readable by the owner's account only (see "Host requirements").
- **Polymorphic references are not verified on import.** `attachable_id`, `entity_id` and the other polymorphic uuid columns have no single target table; every engine lookup of them is tenant-scoped, so a crafted value is a dangling pointer, not a cross-tenant read.
- **A backup carries every user's password hash (Q-234).** Anyone who holds the archive and its passphrase can try to guess those passwords offline (bcrypt, cost 12). The archive encryption under a passphrase of at least 12 characters is the protection, so the archive and its passphrase must be kept like the passwords they contain.
- **Skipped users leave ghost references.** When a non-super-admin caller imports, rows of unmatched archived users (`created_by`, `audit_log.user_id`) keep a user id that has no `users` row until a super admin imports the same archive and creates the user with that id.

## Not in desktop mode yet

These come as separate changes:

- the OpenAPI export (the desktop-only routes are not in `openapi.json`, which is exported in server mode);
- safe delete of a company (`POST /api/v1/tenants/:id/delete`), scratch test-restores and their sweeps.
