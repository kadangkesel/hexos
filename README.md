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
hexos start [options]             Start the proxy server
  -p, --port <port>               Port (default: 8080)
  --host <host>                   Host (default: 127.0.0.1)

hexos auth connect <provider>     Connect provider via OAuth
  --label <label>                 Account label (default: "Account 1")
hexos auth list                   List all connections
hexos auth remove <id>            Remove a connection

hexos key create                  Generate new API key
hexos key list                    List all API keys
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

## Notes

- CodeBuddy API only supports `stream: true` — Hexos forces this automatically
- System message is auto-injected if missing
- Token auto-refreshes on 401
- No API key required by default (open mode)
- Data stored at `~/.hexos/db.json`

## License

MIT
