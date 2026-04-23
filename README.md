# Hexos — Multi-Provider AI API Proxy

Multi-provider AI API proxy with multi-account management, browser automation, and a Next.js dashboard. Routes requests through CodeBuddy, Cline, and Kiro to access Claude, GPT, Gemini, DeepSeek, and more — all via a single OpenAI-compatible endpoint.

Built with [Bun](https://bun.sh) + [Hono](https://hono.dev) + [lowdb](https://github.com/typicode/lowdb). Dashboard with [Next.js 16](https://nextjs.org) + [Tailwind v4](https://tailwindcss.com) + [shadcn/ui](https://ui.shadcn.com).

## Features

- **3 Providers**: CodeBuddy (Tencent), Cline, Kiro (AWS CodeWhisperer)
- **35+ Models**: Claude Opus/Sonnet/Haiku, GPT-5.x, Gemini, DeepSeek, Kimi, GLM, MiniMax, Qwen, Grok
- **Multi-Account**: Manage 200+ accounts with automatic least-used load balancing
- **Worker Pool Concurrency**: Batch login without waiting for slow accounts
- **Auto Failover**: 401 → token refresh → next account. Tries ALL accounts before failing
- **Credit Monitoring**: Per-account credit check after each request (dosage-notify API)
- **Browser Automation**: Camoufox (anti-detect Firefox) for Google OAuth login
- **Dashboard**: Real-time monitoring, account management, batch operations, usage charts
- **Tool Integration**: Auto-bind to Claude Code, OpenCode, Open Claw, Cline, Hermes
- **Context Window**: Per-model context length exposed via `/v1/models` (up to 1M tokens)

## Install

```bash
git clone https://github.com/kadangkesel/hexos
cd hexos && bun install
```

## Quick Start

```bash
# 1. Setup automation (one-time)
bun run src/index.ts auth setup-automation

# 2. Connect accounts
bun run src/index.ts auth auto-connect --email user@gmail.com --password "pass"

# 3. Start server
bun run src/index.ts start --port 8080

# 4. (Optional) Start dashboard
cd dashboard && bun install && bun dev
```

## Providers & Models

### CodeBuddy (prefix: `cb/`)

| Model ID | Context |
|----------|---------|
| `cb/claude-opus-4.6` | 1M |
| `cb/claude-haiku-4.5` | 200K |
| `cb/gpt-5.4` | 1M |
| `cb/gpt-5.2` | 200K |
| `cb/gpt-5.1` / `cb/gpt-5.1-codex` | 1M |
| `cb/gpt-5.1-codex-mini` | 200K |
| `cb/gemini-2.5-pro` / `cb/gemini-2.5-flash` | 1M |
| `cb/gemini-3.1-pro` / `cb/gemini-3.0-flash` | 1M |
| `cb/kimi-k2.5` | 131K |
| `cb/glm-5.0` | 128K |

### Cline (prefix: `cl/`)

| Model ID | Context |
|----------|---------|
| `cl/claude-opus-4.7` / `cl/claude-opus-4.6` | 1M |
| `cl/claude-sonnet-4.6` | 1M |
| `cl/claude-haiku-4.5` | 200K |
| `cl/grok-4` | 256K |
| `cl/gemini-2.5-pro` / `cl/gemini-2.5-flash` | 1M |
| `cl/deepseek-v3.2` / `cl/deepseek-r1` | 128K |
| `cl/kimi-k2.6` | 131K |
| `cl/gemma-4-26b:free` / `cl/minimax-m2.5:free` / `cl/gpt-oss-120b:free` | Free tier |

### Kiro (prefix: `kr/`)

| Model ID | Context |
|----------|---------|
| `kr/claude-sonnet-4.5` / `kr/claude-sonnet-4` | 200K |
| `kr/claude-haiku-4.5` | 200K |
| `kr/deepseek-3.2` | 128K |
| `kr/qwen3-coder-next` | 131K |
| `kr/glm-5` | 128K |
| `kr/minimax-m2.1` | 1M |

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/chat/completions` | Chat completions (OpenAI-compatible, SSE stream) |
| `POST` | `/v1/messages` | Messages API (Anthropic-compatible) |
| `GET` | `/v1/models` | List models with context lengths |
| `GET` | `/health` | Health check |

## Dashboard

```bash
cd dashboard && bun install && bun dev
# Open http://localhost:3000
```

### Pages

- **Dashboard**: Credit summary (3 providers), usage charts, model/account breakdown
- **Accounts**: Paginated table with search/filter, batch add, filter unconnected, batch logs
- **Models**: Full model catalog with context windows
- **Logs**: Request logs with filtering
- **Integration**: Auto-bind to AI coding tools (Claude Code, OpenCode, Open Claw, Cline, Hermes)

### Account Management

- **Pagination**: Server-side with search, provider filter, status filter
- **Credit Check**: Manual bulk check or per-account after each proxy request
- **Batch Add**: Paste `email|password` list, select providers (CB/CL/KR), set concurrency
- **Filter Unconnected**: Paste account list, find which aren't connected to a provider
- **Batch Logs**: Live log panel shared between batch operations

## Tool Integration

Hexos auto-binds to AI coding tools via the Integration page:

| Tool | Config File | Format |
|------|-------------|--------|
| Claude Code | `~/.claude/settings.json` | JSON (env vars) |
| OpenCode | `~/.config/opencode/opencode.json` | JSON (provider block) |
| Open Claw | `~/.openclaw/openclaw.json` | JSON5 (models.providers) |
| Cline | `~/.cline/endpoints.json` | JSON (apiBaseUrl) |
| Hermes | `~/.hermes/config.yaml` | YAML (custom_providers) |

## Multi-Account & Load Balancing

```
Client Request → Pick least-used account → Forward to upstream
  ↓ (401)        → Refresh token → Retry
  ↓ (still fails) → Next least-used account (tries ALL before giving up)
  ↓ (429 credit)  → Mark disabled → Next account
  ↓ (success)     → Increment usage → Check credit (async, non-blocking)
```

### Worker Pool Concurrency

Batch connect uses a worker pool — each worker grabs the next account as soon as it finishes. No waiting for slow/stuck accounts.

```
Worker 1: account1 → done → account3 → done → account5 → ...
Worker 2: account2 → stuck 90s → account4 → ...
```

### Credit Monitoring

- **CodeBuddy**: `get-dosage-notify` API (Bearer token) — detects exhausted (code 14001/14018) vs active (code 0). Default display: 250/250 credits.
- **Cline**: `/api/v1/users/{uid}/balance` (Bearer token) — exact balance.
- **Kiro**: `getUsageLimits` API — usage limits with remaining count.
- Credits updated per-account after each successful proxy request (non-blocking).
- No auto-polling — manual "Check Credits" button available.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `HEXOS_HEADLESS` | `true` | Run browser without GUI |
| `HEXOS_DEBUG` | `false` | Verbose debug logging |
| `HEXOS_PROXY_URL` | — | Proxy for browser (`socks5://host:port`) |

## Data Storage

- Connections & API keys: `~/.hexos/db.json` (lowdb)
- Usage records: `~/.hexos/usage.json`
- Python venv: `src/automation/.venv/` (gitignored)

## License

MIT
