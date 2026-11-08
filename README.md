# Kisaes GL Engine

Repository: `kisaes-gl-engine`
Copyright © 2026 Kisaes LLC, Monett, Missouri, USA

This repository ships three documents. Read all three.

| File | What it is |
| --- | --- |
| `LICENSE` | The source license for this repository: PolyForm Internal Use License 1.0.0, verbatim, as published at https://polyformproject.org/licenses/internal-use/1.0.0 |
| `ENGINE-GRANT.md` | The Kisaes Engine Product Grant (Part A): the perpetual grant under which the Engine ships inside official Kisaes products |
| `NOTICE.md` | The Kisaes Engine Notice (Part B): clarifications and the pointer to the OEM License for anyone who wants to distribute or host the Engine |

`LICENSE` and `NOTICE.md` govern this repository. Some source-file headers and the
workspace packages' `license` fields still name the PolyForm Small Business License;
they came over unchanged with the split and will be updated in a follow-up change.
Where they differ, `LICENSE` and `NOTICE.md` apply.

## What this is

The Kisaes GL Engine is the accounting engine: posting, balances, closing dates,
sales tax, inventory costing, bank feeds, reports and the audit trail, served as an
Express + Drizzle API on PostgreSQL 16.

| Path | Contents |
| --- | --- |
| `packages/api` (`@kis-books/api`) | The engine API: routes, services, migrations, seeds, tests |
| `packages/shared` (`@kis-books/shared`) | Shared types, schemas and calculation code, with golden fixtures |
| `openapi.json` | The API contract, generated from the route registrations |
| `features/tax-estimator/docs/reference-calc/` | Tax-estimator reference calculations and their expected outputs (golden files) |
| `docs/DESKTOP.md` | Notes for running the engine as a desktop sidecar |

## Consumers

Both products pin an engine commit as a git submodule at `engine/`:

- **MyBooks Online** ([Vibe-MyBooks](https://github.com/KisaesDevLab/Vibe-MyBooks)), the self-hosted web app, with its web client, worker, Docker images and appliance.
- **ClientLedger**, the offline desktop app, which runs the engine as a local sidecar.

Changes stay generic and backward compatible so both consumers benefit.

## History

This repository was split from Vibe-MyBooks at commit `1096b20d` with its history
kept (`git filter-repo`). The `packages/api` and `packages/shared` trees are
byte-identical to that commit. Pull request numbers in commit messages from before
the split (for example "Merge pull request #238") refer to
**Vibe-MyBooks** pull requests, not to this repository.

## Running it

Requires Node.js 24 or newer, PostgreSQL 16 and Redis 7 for the api tests.

```sh
npm ci
npm run build --workspace=@kis-books/shared
(cd packages/api && npx tsc --noEmit)       # typecheck
npm run openapi:check                       # openapi.json is current
(cd packages/shared && npm test)            # shared tests (no database)
npm run test:tax-oracle                     # reference calculations (python3)
```

The api tests need a test database and a test Redis, the same as CI:

```sh
# postgres 16 on localhost:5434 (user/password kisbooks, database kisbooks_test)
# redis 7 on localhost:6390
export DATABASE_URL=postgresql://kisbooks:kisbooks@localhost:5434/kisbooks_test
export REDIS_URL=redis://127.0.0.1:6390
export JWT_SECRET=test-secret-key-for-testing-only
npx tsx packages/api/src/migrate.ts
(cd packages/api && npx vitest run)
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security reports: [.github/SECURITY.md](.github/SECURITY.md).
