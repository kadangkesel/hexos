# AGENTS.md — Hexos

Multi-provider AI API proxy. Bun + Hono server with a Next.js 16 dashboard.

## Commands

```bash
# Dev (hot-reload server)
bun dev                          # runs: bun run --watch src/index.ts start

# Dashboard dev (separate terminal, proxies API to :7470)
cd dashboard && bun install && bun dev   # Next.js on :7471

# Build standalone binary (current platform)
bun scripts/build.ts             # outputs dist/<platform>/hexos[.exe]
bun scripts/build.ts --all       # all 5 platforms
bun scripts/build.ts --skip-dashboard  # server only, no Next.js export

# Dashboard lint
cd dashboard && bun run lint     # eslint (next core-web-vitals + typescript)
```

No test framework is configured. No linter/formatter for the server `src/`.

## Architecture

**Entrypoint**: `src/index.ts` — Commander CLI. Parses subcommands (`start`, `auth`, `key`, `usage`, `service`, `update`, `uninstall`, `mitm`).

**Server**: `src/server.ts` — `createApp()` returns a Hono app. Single file, ~1450 lines. Handles:
- `/v1/*` — OpenAI-compatible proxy endpoints (auth middleware, chat completions, messages, models)
- `/api/*` — Dashboard REST API (connections, batch-connect, credits, usage, integrations, proxies, scraper, filters, export/import)
- `/*` — Static file serving for dashboard from `~/.hexos/dashboard/`

**Module layout** (`src/`):
| Directory | Purpose |
|-----------|---------|
| `config/` | `providers.ts` (upstream API configs), `models.ts` (model catalog + aliases), `filters.ts` (request filtering) |
| `proxy/` | `handler.ts` (request routing + failover), `AI Provider.ts` (format translation), `kiro-stream.ts`/`kiro-transform.ts` (Kiro protocol), `qoder-auth.ts`/`qoder-stream.ts` (Qoder protocol), `pool.ts` (HTTP proxy pool), `scraper.ts` (proxy scraper) |
| `auth/` | `oauth.ts` (OAuth flows, browser automation, batch connect, token checks), `store.ts` (lowdb persistence for connections + API keys) |
| `tracking/` | `tracker.ts` (usage recording, stats aggregation) |
| `integration/` | `tools.ts` (auto-bind to AI Assistant, OpenCode, Cline, Hermes configs) |
| `utils/` | `logger.ts`, `transform.ts` (message augmentation), `crypto.ts` |
| `automation/` | Python scripts for Camoufox browser automation (`login.py`, `cline_login.py`, `kiro_login.py`, `qoder_login.py`, `setup.py`) |
| `mitm/` | MITM proxy: `server.ts` (child process HTTPS on :443), `manager.ts` (lifecycle), `config.ts` (hosts/patterns), `cert/` (Root CA + leaf certs), `dns/` (hosts file), `handlers/` (per-tool intercept) |

## Providers

4 upstream providers, each with different auth and stream formats:
- **Service** — OpenAI-compatible, Bearer token, model prefix `cb/`
- **Cline** — OpenAI-compatible, WorkOS auth (`Bearer workos:<token>`), model prefix `cl/`
- **Kiro** — AWS CodeWhisperer eventstream protocol, custom auth, model prefix `kr/`
- **Qoder** — Custom SSE protocol, Bearer COSY token, model prefix `qd/`

Model IDs use provider prefixes: `cb/opus-4.6`, `cl/sonnet-4.6`, `kr/haiku-4.5`, `qd/auto`.

## Data files

All persisted to `~/.hexos/` via lowdb (JSON files):
- `db.json` — connections (tokens, credentials) + API keys
- `usage.json` — request tracking records
- `proxies.json` — HTTP proxy pool
- `proxy-settings.json` — proxy configuration

**Never commit these files.** They contain secrets.

## Dashboard (`dashboard/`)

Separate Next.js 16 app (React 19, Tailwind v4, shadcn/ui base-nova style, zustand state).

- Dev: `bun dev` on port 7471, proxies `/api/*` and `/v1/*` to `:7470`
- Production: static export (`NEXT_STATIC_EXPORT=true`) → `dashboard/out/`, served by Hono
- Path alias: `@/*` → `./src/*`
- Pages: `src/app/{accounts,api-key,docs,filters,integration,logs,models,providers,proxy}/`
- Components: `src/components/`, UI primitives in `src/components/ui/`
- State: `src/stores/` (zustand)
- Hooks: `src/hooks/`

**Next.js 16 warning**: This uses Next.js 16 which has breaking changes from training data. Read `node_modules/next/dist/docs/` before modifying dashboard code.

## Build & Release

- CI: `.github/workflows/release.yml` — triggered by `v*` tags or manual dispatch
- Builds 5 platform binaries via `bun build --compile --target <bun-target>`
- Dashboard is statically exported and bundled alongside the binary
- Python automation scripts are copied into the archive
- Archives: `.tar.gz` (Unix) / `.zip` (Windows) with SHA256 checksums
- Releases published to GitHub, installer scripts fetch from `hexos.kadangkesel.net`

## Deploy (VPS)

`deploy/` contains nginx config and setup script for `hexos.kadangkesel.net` (installer hosting site, not the proxy itself). The proxy runs locally on user machines.

## Gotchas

- **`server.ts` is massive** (~1450 lines). All API routes live in one file — no route splitting.
- **No tests exist.** `.gitignore` excludes `test_*.ts` files, but none are committed.
- **No server-side linter/formatter.** Only the dashboard has eslint.
- **TypeScript strict mode** is on for both server and dashboard.
- **`src/automation/` contains Python** — Camoufox browser automation. Has its own `.venv/` and `requirements.txt`. Set up via `hexos auth setup-automation`.
- **Model name obfuscation**: `src/config/models.ts` constructs certain provider name strings from hex to avoid text-replacement in source code (see `CLINE_PROVIDER_PREFIX` and `assistant_NAME`).
- **Stream format translation**: Requests arrive as OpenAI format, get translated per-provider (Kiro uses AWS eventstream, Qoder uses custom SSE). Response streams are translated back.
- **`bun dev` requires `start` subcommand** — the dev script runs `bun run --watch src/index.ts start`, not just the file.
- **Dashboard static export is conditional** — `next.config.ts` only enables `output: "export"` when `NEXT_STATIC_EXPORT=true` env var is set.
- **CORS** is configured for `localhost:7471` only (dashboard dev server).
- **MITM server runs as root** — `src/mitm/server.ts` is a standalone child process spawned via `sudo`. It must NOT import from `src/auth/store.ts` (top-level await). It reads `db.json` directly via `fs`.
- **MITM certs stored in `~/.hexos/mitm/`** — `rootCA.key`, `rootCA.crt`, and `.mitm.pid`.
- **`node-forge` dependency** — used for X.509 certificate generation (Root CA + per-domain leaf certs).
