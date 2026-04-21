# Cline Account API

Hasil reverse engineering Cline CLI v2.15.0 — endpoint, auth format, dan model list.

## Overview

Cline Account adalah layanan hosted Cline Bot Inc. yang menjadi proxy ke OpenRouter.
Endpoint utama: `https://api.cline.bot/api/v1`

Request format: **OpenAI-compatible** (`/v1/chat/completions`)
Auth format: `Bearer workos:<JWT_access_token>`

---

## Authentication

### OAuth Flow (manual, VPS headless)

1. Buka URL ini di browser:
   ```
   https://api.cline.bot/api/v1/auth/authorize?client_type=extension&callback_url=http%3A%2F%2F127.0.0.1%3A48801%2Fauth&redirect_uri=http%3A%2F%2F127.0.0.1%3A48801%2Fauth
   ```

2. Login via WorkOS (Google/GitHub/Email). Browser redirect ke:
   ```
   http://127.0.0.1:48801/auth?code=<base64_token_data>&provider=cline
   ```
   Browser akan error (connection refused) — **normal**.

3. Decode `code` parameter (base64 URL-safe) → JSON berisi:
   ```json
   {
     "accessToken": "eyJhbG...",
     "refreshToken": "XkpHvs...",
     "email": "user@example.com",
     "firstName": "...",
     "lastName": "...",
     "expiresAt": "2026-04-21T17:36:52Z"
   }
   ```

4. Token disimpan di `~/.cline/data/secrets.json` dengan key `cline:clineAccountId`.

### Token Format

Semua request ke `api.cline.bot` menggunakan:
```
Authorization: Bearer workos:<accessToken>
```

Token JWT, expire ~1 jam. Refresh via:
```
POST https://api.cline.bot/api/v1/auth/refresh
Body: { "refreshToken": "...", "grantType": "refresh_token" }
```

---

## API Endpoints

### Chat Completions

```
POST https://api.cline.bot/api/v1/chat/completions
```

**Headers:**
```
Authorization:    Bearer workos:<token>
Content-Type:     application/json
User-Agent:       Cline/3.79.0
HTTP-Referer:     https://cline.bot
X-Title:          Cline
X-Task-ID:        <ulid>
X-Platform:       Cline CLI - Node.js
X-Client-Type:    CLI
X-Core-Version:   3.79.0
```

**Body (OpenAI format):**
```json
{
  "model": "anthropic/claude-sonnet-4.6",
  "temperature": 0,
  "stream": true,
  "stream_options": { "include_usage": true },
  "parallel_tool_calls": false,
  "messages": [
    {
      "role": "system",
      "content": [{ "type": "text", "text": "You are Cline..." }]
    },
    {
      "role": "user",
      "content": "<task>\nuser prompt here\n</task>"
    }
  ],
  "tools": [ ... ]
}
```

Response: OpenRouter-style SSE stream.

### Model List

```
GET https://api.cline.bot/api/v1/ai/cline/models
Authorization: Bearer workos:<token>
```

Returns 343 models (via OpenRouter).

### Recommended Models

```
GET https://api.cline.bot/api/v1/ai/cline/recommended-models
Authorization: Bearer workos:<token>
```

### User Info

```
GET https://api.cline.bot/api/v1/users/me
Authorization: Bearer workos:<token>
```

---

## Active Models (tested April 2026)

### Paid — Working ✅

| Model ID | Name |
|----------|------|
| `anthropic/claude-opus-4.7` | Claude Opus 4.7 |
| `anthropic/claude-sonnet-4.6` | Claude Sonnet 4.6 |
| `anthropic/claude-opus-4.6` | Claude Opus 4.6 |
| `anthropic/claude-opus-4.6-fast` | Claude Opus 4.6 Fast |
| `anthropic/claude-haiku-4.5` | Claude Haiku 4.5 |
| `x-ai/grok-4` | Grok 4 |
| `x-ai/grok-4.20` | Grok 4.20 |
| `x-ai/grok-4.1-fast` | Grok 4.1 Fast |
| `google/gemini-3.1-pro-preview` | Gemini 3.1 Pro Preview |
| `google/gemini-2.5-pro` | Gemini 2.5 Pro |
| `google/gemini-2.5-flash` | Gemini 2.5 Flash |
| `deepseek/deepseek-v3.2` | DeepSeek V3.2 |
| `deepseek/deepseek-r1` | DeepSeek R1 |
| `moonshotai/kimi-k2.6` | Kimi K2.6 |
| `minimax/minimax-m2.7` | MiniMax M2.7 |
| `qwen/qwen3-235b-a22b` | Qwen3 235B |
| `meta-llama/llama-4-maverick` | Llama 4 Maverick |
| `mistralai/devstral-medium` | Devstral Medium |

### Paid — Failed ❌

| Model ID | Error |
|----------|-------|
| `openai/gpt-5.4`, `gpt-5.3-codex`, `gpt-5.2`, `gpt-5.1`, `gpt-5`, `o3`, `o4-mini` | `failed to invoke model from Vercel` |
| `moonshotai/kimi-k2.5` | `generateText is not implemented` |

### Free — Working ✅

| Model ID | Name |
|----------|------|
| `google/gemma-4-26b-a4b-it:free` | Gemma 4 26B |
| `google/gemma-4-31b-it:free` | Gemma 4 31B |
| `minimax/minimax-m2.5:free` | MiniMax M2.5 |
| `nvidia/nemotron-3-super-120b-a12b:free` | Nemotron 3 Super 120B |
| `openai/gpt-oss-120b:free` | GPT OSS 120B |
| `openai/gpt-oss-20b:free` | GPT OSS 20B |
| `liquid/lfm-2.5-1.2b-instruct:free` | LFM 2.5 1.2B |
| `google/gemma-3-4b-it:free` | Gemma 3 4B |
| `google/gemma-3-12b-it:free` | Gemma 3 12B |
| `google/gemma-3-27b-it:free` | Gemma 3 27B |
| `google/gemma-3n-e2b-it:free` | Gemma 3n 2B |
| `google/gemma-3n-e4b-it:free` | Gemma 3n 4B |

### Free — Failed ❌

| Model ID | Error |
|----------|-------|
| `arcee-ai/trinity-large-preview:free` | OpenRouter invoke failed |
| `meta-llama/llama-3.3-70b-instruct:free` | OpenRouter invoke failed |
| `qwen/qwen3-coder:free` | OpenRouter invoke failed |
| `bytedance/seed-2-0-pro` | not implemented |
| `nvidia/nemotron-nano-*:free` | empty response |
| `z-ai/glm-4.5-air:free` | empty response |

---

## Intercept / Redirect

Untuk intercept request Cline ke `api.cline.bot`, buat file `~/.cline/endpoints.json`:

```json
{
  "appBaseUrl": "https://app.cline.bot",
  "apiBaseUrl": "http://localhost:8899",
  "mcpBaseUrl": "https://api.cline.bot/v1/mcp"
}
```

Cline akan mengirim semua request ke `http://localhost:8899` — bisa dipakai untuk proxy, logging, atau redirect ke provider lain.

---

## Cline CLI Usage

```bash
# Install
npm i -g cline

# Login (manual OAuth, VPS headless)
python3 ~/scripts/cline_manual_auth.py

# Run task
cline -y "your task here"

# Ganti model
cline -m "anthropic/claude-opus-4.7" -y "your task"

# Plan mode
cline -p "review this code"

# ACP mode (untuk integrasi editor)
cline --acp
```

Config tersimpan di `~/.cline/data/`. Provider diset via `globalState.json` (`actModeApiProvider: "cline"`).
