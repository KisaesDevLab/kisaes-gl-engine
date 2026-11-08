# Contributing

Issues are welcome: bug reports, questions and feature requests.

Code contributions are accepted only under the Kisaes Contributor License Agreement
(`CLA.md`, see `NOTICE.md` B.4). The CLA is not published yet; see
[issue #1](https://github.com/KisaesDevLab/kisaes-gl-engine/issues/1). Until it is,
outside pull requests are not accepted.

For maintainers:

- Engine changes are generic and backward compatible, because MyBooks Online and ClientLedger both pin this repository.
- New migrations are additive (`npm run migrations:check`) and come with a `.rollback.sql` companion.
- Any route change updates `openapi.json` (`npm run openapi:export`); CI fails when it is stale.
- Do not add new `any` types (`npm run any:check`).
- Typecheck, the api test shards, the license audit, the secret scan and the dependency audit must pass before a merge.

Security issues: follow [.github/SECURITY.md](.github/SECURITY.md) instead of opening a public issue.
