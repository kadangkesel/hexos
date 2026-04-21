# Hexos — Lightweight AI API Proxy

Lightweight AI API proxy with CodeBuddy (Tencent) OAuth support. Routes requests through CodeBuddy's API to access Claude, GPT, Gemini, and more — all via a single OpenAI-compatible endpoint.

Built with [Bun](https://bun.sh) + [Hono](https://hono.dev) + [lowdb](https://github.com/typicode/lowdb).

## Install

```bash
git clone https://github.com/kadangkesel/hexos
cd hexos && bun install
```

## Quick Start

```bash
# 1. Connect CodeBuddy (one-time)
bun run src/index.ts auth connect codebuddy

# 2. Start server
bun run src/index.ts start --port 8080

# 3. (Optional) Create API key
bun run src/index.ts key create
```

## CLI Commands

```
hexos start [options]                   Start the proxy server
  -p, --port <port>                     Port (default: 8080)
  --host <host>                         Host (default: 127.0.0.1)

hexos auth connect <provider>           Connect provider via OAuth (manual browser)
  --label <label>                       Account label (default: "Account 1")
hexos auth auto-connect                 Connect via browser automation (Camoufox)
  --email <email>                       Google email address (required)
  --password <password>                 Google password (required)
  --label <label>                       Account label (defaults to email)
hexos auth batch-connect                Batch connect multiple accounts from file
  --file <path>                         Path to accounts file (required)
  --concurrency <n>                     Max concurrent logins (default: 2)
hexos auth setup-automation             Setup Python env for browser automation
hexos auth list                         List all connections with usage stats
hexos auth remove <id>                  Remove a connection

hexos key create                        Generate new API key
hexos key list                          List all API keys
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/chat/completions` | Chat completions (OpenAI-compatible, SSE stream) |
| `GET` | `/v1/models` | List available models |
| `GET` | `/health` | Health check |

## Available Models (19)

| Model ID | Name | Provider |
|----------|------|----------|
| `cb/default-model` | CodeBuddy Default | Tencent |
| `cb/claude-opus-4.6` | Claude Opus 4.6 | Anthropic via CodeBuddy |
| `cb/claude-haiku-4.5` | Claude Haiku 4.5 | Anthropic via CodeBuddy |
| `cb/gpt-5.4` | GPT-5.4 | OpenAI via CodeBuddy |
| `cb/gpt-5.2` | GPT-5.2 | OpenAI via CodeBuddy |
| `cb/gpt-5.1` | GPT-5.1 | OpenAI via CodeBuddy |
| `cb/gpt-5.1-codex` | GPT-5.1 Codex | OpenAI via CodeBuddy |
| `cb/gpt-5.1-codex-mini` | GPT-5.1 Codex Mini | OpenAI via CodeBuddy |
| `cb/gemini-3.1-pro` | Gemini 3.1 Pro | Google via CodeBuddy |
| `cb/gemini-3.0-flash` | Gemini 3.0 Flash | Google via CodeBuddy |
| `cb/gemini-2.5-pro` | Gemini 2.5 Pro | Google via CodeBuddy |
| `cb/gemini-2.5-flash` | Gemini 2.5 Flash | Google via CodeBuddy |
| `cb/kimi-k2.5` | Kimi K2.5 | Moonshot via CodeBuddy |
| `cb/glm-5.0` | GLM 5.0 | Zhipu via CodeBuddy |

## Usage Examples

### PowerShell

```powershell
curl.exe -X POST http://localhost:8080/v1/chat/completions `
  -H "Content-Type: application/json" `
  -d "{""model"":""cb/claude-opus-4.6"",""messages"":[{""role"":""user"",""content"":""Hello""}]}"
```

### Bash / Linux

```bash
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"cb/claude-opus-4.6","messages":[{"role":"user","content":"Hello"}]}'
```

### With API Key

```bash
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer hx-your-key-here" \
  -d '{"model":"cb/gpt-5.4","messages":[{"role":"user","content":"Hello"}]}'
```

## Connect to AI Tools

Use Hexos as a backend for any OpenAI-compatible tool:

| Setting | Value |
|---------|-------|
| Endpoint | `http://localhost:8080/v1` |
| API Key | Run `hexos key create` |
| Model | `cb/claude-opus-4.6` (or any from list above) |

Works with: **Hermes Agent**, **OpenCode**, **Cline**, **Continue**, **Cursor** (custom endpoint), and any tool that supports custom OpenAI endpoints.

## Multi-Account & Browser Automation

Hexos supports managing 20+ CodeBuddy accounts with automatic load balancing. Accounts are added via browser automation using [Camoufox](https://github.com/nichochar/camoufox) (anti-detect Firefox browser).

### Prerequisites

- **Python 3.10+** installed on your system
- **Google accounts** with email/password login (used to sign in to CodeBuddy)

### Step 1: Setup Automation Environment

Run this once to create a Python virtual environment and install Camoufox + Playwright:

```bash
hexos auth setup-automation
```

This will:
- Find Python 3.10+ on your system
- Create a venv at `src/automation/.venv/`
- Install `camoufox`, `playwright`, `aiohttp`
- Download the Firefox browser binary

### Step 2: Add Accounts

**Single account:**

```bash
hexos auth auto-connect --email user@gmail.com --password "mypassword"
```

**Batch from file:**

Create a file `accounts.txt` with one account per line (format: `email|password` or `email|password|label`):

```
user1@gmail.com|password123
user2@gmail.com|secretpass
user3@gmail.com|p@ssw0rd|My Custom Label
```

Lines starting with `#` are ignored (comments).

Then run:

```bash
hexos auth batch-connect --file accounts.txt --concurrency 2
```

The `--concurrency` flag controls how many browsers run simultaneously (default: 2). For 20+ accounts, keep this at 2-3 to avoid Google rate limiting.

### Step 3: Verify Accounts

```bash
hexos auth list
```

Output shows each account with status, usage count, and last used time:

```
Connections (3):
  a1b2c3d4 codebuddy — user1@gmail.com  [active]  used: 0  last: never
  e5f6g7h8 codebuddy — user2@gmail.com  [active]  used: 0  last: never
  i9j0k1l2 codebuddy — My Custom Label  [active]  used: 0  last: never
```

### Step 4: Start Proxy

```bash
hexos start
```

Hexos automatically uses **least-used load balancing**: each request goes to the account with the lowest usage count. If an account fails (401/429/5xx), it automatically fails over to the next least-used account.

### How Load Balancing Works

```
Client Request
    ↓
Pick account with lowest usage count
    ↓
Forward request → Success? → Increment counter → Return response
    ↓ (failure: 401/429/5xx)
Try token refresh (if 401)
    ↓ (still fails)
Pick next least-used account (max 3 failover attempts)
    ↓ (all exhausted)
Return 502 error
```

**Account statuses:**
- `active` — Working normally
- `expired` — Token expired and refresh failed (will be skipped)
- `disabled` — 3+ consecutive failures (will be skipped)

Re-running `auto-connect` or `batch-connect` for an existing account resets it to `active`.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `HEXOS_HEADLESS` | `true` | Run browser without GUI (`false` to see the browser) |
| `HEXOS_DEBUG` | `false` | Enable verbose debug logging from automation |
| `HEXOS_PROXY_URL` | — | Proxy for browser (e.g. `socks5://host:port`) |

### Troubleshooting

**"Automation not set up"**
→ Run `hexos auth setup-automation` first.

**"Google blocked: captcha" or "unusual traffic"**
→ Google detected bot activity. Try:
- Set `HEXOS_HEADLESS=false` to watch the browser and solve captcha manually
- Use a proxy: `HEXOS_PROXY_URL=socks5://host:port`
- Reduce concurrency: `--concurrency 1`
- Wait a few hours before retrying

**"Token refresh failed" / account shows `[expired]`**
→ Re-add the account: `hexos auth auto-connect --email ... --password ...`

**"All connections failed"**
→ All accounts are disabled/expired. Check `hexos auth list` and re-add working accounts.

**Browser automation is slow**
→ Each login takes ~15-30 seconds. For 20 accounts at concurrency 2, expect ~5-10 minutes total.

## Notes

- CodeBuddy API only supports `stream: true` — Hexos forces this automatically
- System message is auto-injected if missing
- Token auto-refreshes on 401, with automatic failover to next account
- No API key required by default (open mode)
- Data stored at `~/.hexos/db.json`
- Python venv stored at `src/automation/.venv/` (gitignored)

## License

MIT
