# Codex Provider Implementation Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Add a "Codex" provider to hexos that proxies OpenAI Chat Completions requests through ChatGPT's free Codex Responses API, with multi-account load balancing based on rate limit windows, OAuth PKCE login, and automatic token refresh with rotating refresh tokens.

**Architecture:** Client sends standard OpenAI Chat Completions request → hexos translates to Responses API format → forwards to chatgpt.com/backend-api/codex/responses (SSE) → translates SSE events back to Chat Completions delta format → returns to client. Multi-account: pick connection with lowest rate limit usage. Token refresh: proactive (before expiry) + reactive (on 401), with mutex for rotating refresh tokens.

**Tech Stack:** Bun + Hono (existing), TypeScript, lowdb (existing), OAuth PKCE with auth.openai.com

**Model prefix:** `cx/`

---

### Task 1: Add Codex provider config

**Objective:** Register Codex as a new provider in the provider registry.

**Files:**
- Modify: `src/config/providers.ts`

**Steps:**

1. Add `"codex"` to the `ProviderFormat` union type
2. Add codex entry to `PROVIDERS` object:

```typescript
// In ProviderFormat union:
export type ProviderFormat = "openai" | "anxthxropic" | "gemini" | "kiro" | "qoder" | "codex";

// In PROVIDERS:
codex: {
  id: "codex",
  name: "Codex",
  format: "codex",
  baseUrl: "https://chatgpt.com/backend-api/codex/responses",
  authType: "oauth",
  authFormat: "bearer",
  headers: {
    "Content-Type": "application/json",
    "Accept": "text/event-stream",
    "User-Agent": "codex-cli/0.124.0",
  },
},
```

---

### Task 2: Add Codex model catalog

**Objective:** Register all 6 Codex models with cx/ prefix.

**Files:**
- Modify: `src/config/models.ts`

**Steps:**

Add after the last provider's models block:

```typescript
// Codex models (prefix: cx/) — ChatGPT Codex Responses API
"cx/gpt-5.5":             { provider: "codex", model: "gpt-5.5",            info: { id: "cx/gpt-5.5",             name: "GPT-5.5",             contextWindow: 272000 } },
"cx/gpt-5.4":             { provider: "codex", model: "gpt-5.4",            info: { id: "cx/gpt-5.4",             name: "GPT-5.4",             contextWindow: 272000 } },
"cx/gpt-5.4-mini":        { provider: "codex", model: "gpt-5.4-mini",       info: { id: "cx/gpt-5.4-mini",        name: "GPT-5.4 Mini",        contextWindow: 272000 } },
"cx/gpt-5.3-codex":       { provider: "codex", model: "gpt-5.3-codex",      info: { id: "cx/gpt-5.3-codex",       name: "GPT-5.3 Codex",       contextWindow: 272000 } },
"cx/gpt-5.2":             { provider: "codex", model: "gpt-5.2",            info: { id: "cx/gpt-5.2",             name: "GPT-5.2",             contextWindow: 272000 } },
"cx/codex-auto-review":   { provider: "codex", model: "codex-auto-review",  info: { id: "cx/codex-auto-review",   name: "Codex Auto Review",   contextWindow: 272000 } },
```

---

### Task 3: Create Codex stream transformer

**Objective:** Create module that transforms Responses API SSE events into OpenAI Chat Completions SSE chunks, and transforms Chat Completions request body into Responses API request body.

**Files:**
- Create: `src/proxy/codex-stream.ts`

**Steps:**

Create the file with two main exports:

1. `buildCodexRequestBody(openaiBody)` — transforms Chat Completions request to Responses API format
2. `createCodexStreamTransformer(model, requestId)` — returns a TransformStream that converts Responses API SSE to Chat Completions SSE

Key transformations:
- Request: `messages[]` → `input[]` (role mapping), `model`, `stream:true`, `store:false`
- Response SSE: `response.output_text.delta` → `choices[0].delta.content`, `response.completed` → `[DONE]`

The SSE from Codex uses named events (`event: response.output_text.delta\ndata: {...}`) while OpenAI Chat Completions uses only `data:` lines. The transformer must parse the named events and emit standard `data: {...}\n\n` chunks.

```typescript
// src/proxy/codex-stream.ts

interface OpenAIMessage {
  role: string;
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
}

interface CodexInputItem {
  role: string;
  content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
}

/**
 * Transform OpenAI Chat Completions request body to Codex Responses API body.
 */
export function buildCodexRequestBody(
  openaiBody: {
    model: string;
    messages: OpenAIMessage[];
    stream?: boolean;
    temperature?: number;
    max_tokens?: number;
    top_p?: number;
    reasoning_effort?: string;
  },
  upstreamModel: string
): Record<string, unknown> {
  // Convert messages to Responses API input format
  const input: CodexInputItem[] = [];
  let instructions = "";

  for (const msg of openaiBody.messages) {
    if (msg.role === "system" || msg.role === "developer") {
      // System/developer messages become instructions
      const text = typeof msg.content === "string"
        ? msg.content
        : msg.content.filter(c => c.type === "text").map(c => c.text).join("\n");
      instructions += (instructions ? "\n" : "") + text;
    } else {
      input.push({
        role: msg.role === "assistant" ? "assistant" : "user",
        content: msg.content,
      });
    }
  }

  const body: Record<string, unknown> = {
    model: upstreamModel,
    input,
    stream: true,
    store: false,
  };

  if (instructions) body.instructions = instructions;
  if (openaiBody.temperature !== undefined) body.temperature = openaiBody.temperature;
  if (openaiBody.max_tokens !== undefined) body.max_output_tokens = openaiBody.max_tokens;
  if (openaiBody.top_p !== undefined) body.top_p = openaiBody.top_p;
  if (openaiBody.reasoning_effort) {
    body.reasoning = { effort: openaiBody.reasoning_effort };
  }

  return body;
}

/**
 * Rate limit info extracted from response headers.
 */
export interface CodexRateLimits {
  planType: string;
  primaryUsedPercent: number;
  secondaryUsedPercent: number;
  primaryWindowMinutes: number;
  secondaryWindowMinutes: number;
  primaryResetAt: number;
  secondaryResetAt: number;
}

/**
 * Extract rate limit info from Codex response headers.
 */
export function extractCodexRateLimits(headers: Headers): CodexRateLimits {
  return {
    planType: headers.get("x-codex-plan-type") || "unknown",
    primaryUsedPercent: parseInt(headers.get("x-codex-primary-used-percent") || "0", 10),
    secondaryUsedPercent: parseInt(headers.get("x-codex-secondary-used-percent") || "0", 10),
    primaryWindowMinutes: parseInt(headers.get("x-codex-primary-window-minutes") || "300", 10),
    secondaryWindowMinutes: parseInt(headers.get("x-codex-secondary-window-minutes") || "10080", 10),
    primaryResetAt: parseInt(headers.get("x-codex-primary-reset-at") || "0", 10),
    secondaryResetAt: parseInt(headers.get("x-codex-secondary-reset-at") || "0", 10),
  };
}

/**
 * Create a TransformStream that converts Codex Responses API SSE
 * into OpenAI Chat Completions SSE format.
 *
 * Codex SSE format:
 *   event: response.output_text.delta
 *   data: {"type":"response.output_text.delta","delta":"Hello",...}
 *
 * OpenAI Chat Completions SSE format:
 *   data: {"id":"chatcmpl-...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello"}}]}
 */
export function createCodexStreamTransformer(
  model: string,
  requestId: string
): TransformStream<Uint8Array, Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "";
  let usageData: { input_tokens?: number; output_tokens?: number; total_tokens?: number } | null = null;

  return new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (line.startsWith("event: ")) {
          currentEvent = line.slice(7).trim();
          continue;
        }

        if (!line.startsWith("data: ")) continue;

        const dataStr = line.slice(6);
        if (!dataStr || dataStr === "[DONE]") continue;

        try {
          const data = JSON.parse(dataStr);

          if (currentEvent === "response.output_text.delta" || data.type === "response.output_text.delta") {
            // Streaming text delta
            const chunk = formatChatCompletionChunk(requestId, model, {
              content: data.delta || "",
            });
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          } else if (currentEvent === "response.completed" || data.type === "response.completed") {
            // Extract usage from completed response
            if (data.response?.usage) {
              usageData = {
                input_tokens: data.response.usage.input_tokens,
                output_tokens: data.response.usage.output_tokens,
                total_tokens: data.response.usage.total_tokens,
              };
            }
            // Send final chunk with finish_reason
            const chunk = formatChatCompletionChunk(requestId, model, null, "stop", usageData);
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          } else if (currentEvent === "response.failed" || data.type === "response.failed") {
            const errorMsg = data.response?.error?.message || "Unknown error";
            const errorChunk = {
              error: { message: errorMsg, type: "server_error", code: "codex_error" },
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(errorChunk)}\n\n`));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          }
          // Ignore other events (response.created, response.in_progress, reasoning, etc.)
        } catch {
          // Skip unparseable lines
        }

        currentEvent = "";
      }
    },

    flush(controller) {
      // Process any remaining buffer
      if (buffer.trim()) {
        // Ignore incomplete data
      }
    },
  });
}

function formatChatCompletionChunk(
  id: string,
  model: string,
  delta: { role?: string; content?: string } | null,
  finishReason: string | null = null,
  usage: { input_tokens?: number; output_tokens?: number; total_tokens?: number } | null = null
) {
  const chunk: Record<string, unknown> = {
    id: `chatcmpl-${id}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: delta || {},
        finish_reason: finishReason,
      },
    ],
  };

  if (usage) {
    chunk.usage = {
      prompt_tokens: usage.input_tokens || 0,
      completion_tokens: usage.output_tokens || 0,
      total_tokens: usage.total_tokens || 0,
    };
  }

  return chunk;
}
```

---

### Task 4: Add Codex auth — token refresh with rotation

**Objective:** Add Codex token refresh function that handles rotating refresh tokens atomically.

**Files:**
- Modify: `src/auth/oauth.ts`

**Steps:**

Add the following functions:

```typescript
// ---------------------------------------------------------------------------
// Codex: Token refresh (ROTATING refresh tokens!)
// ---------------------------------------------------------------------------

const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";

// Mutex to prevent concurrent refresh of the same rotating token
const codexRefreshLocks = new Map<string, Promise<{ accessToken: string; refreshToken: string }>>();

export async function refreshCodex(
  refreshToken: string,
  connectionId: string
): Promise<{ accessToken: string; refreshToken: string }> {
  // Check if a refresh is already in progress for this connection
  const existing = codexRefreshLocks.get(connectionId);
  if (existing) {
    log.info(`[codex] Waiting for in-progress refresh for ${connectionId}`);
    return existing;
  }

  const refreshPromise = (async () => {
    try {
      const res = await fetch(CODEX_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: CODEX_CLIENT_ID,
          refresh_token: refreshToken,
        }),
      });

      if (!res.ok) {
        const error = await res.text();
        throw new Error(`Codex token refresh failed (${res.status}): ${error}`);
      }

      const data = await res.json() as {
        access_token: string;
        refresh_token: string;
        id_token: string;
        expires_in: number;
      };

      log.info(`[codex] Token refreshed successfully (expires in ${data.expires_in}s)`);

      return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token, // NEW token — old one is now invalid!
      };
    } finally {
      codexRefreshLocks.delete(connectionId);
    }
  })();

  codexRefreshLocks.set(connectionId, refreshPromise);
  return refreshPromise;
}

/**
 * Check if a Codex access token (JWT) is expired or near expiry.
 * Returns true if token should be refreshed.
 */
export function isCodexTokenExpired(accessToken: string, bufferSeconds = 86400): boolean {
  try {
    const parts = accessToken.split(".");
    if (parts.length !== 3) return true;
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    const exp = payload.exp || 0;
    return Date.now() / 1000 > exp - bufferSeconds;
  } catch {
    return true;
  }
}

/**
 * Extract email and plan type from Codex access token JWT.
 */
export function parseCodexToken(accessToken: string): { email?: string; planType?: string; userId?: string } {
  try {
    const parts = accessToken.split(".");
    if (parts.length !== 3) return {};
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    const auth = payload["https://api.openai.com/auth"] || {};
    const profile = payload["https://api.openai.com/profile"] || {};
    return {
      email: profile.email,
      planType: auth.chatgpt_plan_type,
      userId: auth.chatgpt_user_id,
    };
  } catch {
    return {};
  }
}
```

---

### Task 5: Add Codex OAuth PKCE login flow

**Objective:** Add browser-based OAuth PKCE login for Codex accounts, replicating the Codex CLI login flow.

**Files:**
- Modify: `src/auth/oauth.ts`

**Steps:**

Add the following function:

```typescript
// ---------------------------------------------------------------------------
// Codex: OAuth PKCE login (browser-based, port 1455)
// ---------------------------------------------------------------------------

import crypto from "crypto";

export async function oauthCodexLogin(): Promise<{
  accessToken: string;
  refreshToken: string;
  email: string;
  planType: string;
}> {
  // Generate PKCE
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  const state = crypto.randomBytes(32).toString("base64url");

  const CODEX_PORT = 1455;
  const redirectUri = `http://localhost:${CODEX_PORT}/auth/callback`;

  // Build auth URL
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CODEX_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: "codex_cli_rs",
    state,
  });
  const authUrl = `https://auth.openai.com/oauth/authorize?${params.toString()}`;

  // Start local server on port 1455
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      server.stop();
      reject(new Error("Codex OAuth timeout (5 minutes)"));
    }, 300000);

    const server = Bun.serve({
      port: CODEX_PORT,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/auth/callback") {
          const code = url.searchParams.get("code");
          const returnedState = url.searchParams.get("state");

          if (!code || returnedState !== state) {
            return new Response("Invalid callback", { status: 400 });
          }

          // Exchange code for tokens
          try {
            const tokenRes = await fetch(CODEX_TOKEN_URL, {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                grant_type: "authorization_code",
                client_id: CODEX_CLIENT_ID,
                code,
                redirect_uri: redirectUri,
                code_verifier: codeVerifier,
              }),
            });

            if (!tokenRes.ok) {
              throw new Error(`Token exchange failed: ${await tokenRes.text()}`);
            }

            const tokens = await tokenRes.json() as {
              access_token: string;
              refresh_token: string;
              id_token: string;
              expires_in: number;
            };

            const parsed = parseCodexToken(tokens.access_token);

            clearTimeout(timeout);
            server.stop();

            resolve({
              accessToken: tokens.access_token,
              refreshToken: tokens.refresh_token,
              email: parsed.email || "unknown",
              planType: parsed.planType || "unknown",
            });
          } catch (err) {
            clearTimeout(timeout);
            server.stop();
            reject(err);
          }

          return new Response(
            `<html><body style="font-family:system-ui;display:flex;justify-content:center;align-items:center;height:100vh;margin:0">
              <div style="text-align:center"><h1>✓ Codex Connected</h1><p>You can close this tab.</p></div>
              <script>setTimeout(()=>window.close(),2000)</script>
            </body></html>`,
            { headers: { "Content-Type": "text/html" } }
          );
        }
        return new Response("Not found", { status: 404 });
      },
    });

    log.info(`[codex] OAuth server started on port ${CODEX_PORT}`);
    log.info(`[codex] Auth URL: ${authUrl}`);
  });
}
```

---

### Task 6: Add Codex routing in proxy handler

**Objective:** Add Codex-specific request/response handling in the proxy handler, including rate-limit-aware connection selection.

**Files:**
- Modify: `src/proxy/handler.ts`

**Steps:**

1. Import codex modules at top:
```typescript
import { buildCodexRequestBody, createCodexStreamTransformer, extractCodexRateLimits } from "./codex-stream.ts";
import { refreshCodex, isCodexTokenExpired } from "../auth/oauth.ts";
```

2. Add `isCodex` detection alongside `isKiro`/`isQoder`:
```typescript
const isCodex = providerConfig.format === "codex";
```

3. In the connection selection section, add rate-limit-aware picking for Codex:
```typescript
// For Codex: pick connection with lowest rate limit usage
if (isCodex) {
  activeConns.sort((a, b) => {
    const aRate = (a.credit?.usedCredits || 0);
    const bRate = (b.credit?.usedCredits || 0);
    return aRate - bRate;
  });
}
```

4. In the request building section, add Codex body transformation:
```typescript
if (isCodex) {
  requestBody = JSON.stringify(buildCodexRequestBody(body, model));
  requestHeaders = buildHeaders(conn, providerConfig);
  // Proactive token refresh
  if (isCodexTokenExpired(conn.accessToken)) {
    const refreshed = await refreshCodex(conn.refreshToken!, conn.id);
    await updateConnection(conn.id, {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
    });
    conn.accessToken = refreshed.accessToken;
    requestHeaders = buildHeaders(conn, providerConfig);
  }
}
```

5. In the response handling section, add Codex SSE transformation:
```typescript
if (isCodex && res.ok && res.body) {
  // Extract rate limits from headers and update connection
  const rateLimits = extractCodexRateLimits(res.headers);
  await updateConnection(conn.id, {
    credit: {
      totalCredits: 100,
      remainingCredits: 100 - rateLimits.primaryUsedPercent,
      usedCredits: rateLimits.primaryUsedPercent,
      packageName: `ChatGPT ${rateLimits.planType}`,
      expiresAt: new Date(rateLimits.primaryResetAt * 1000).toISOString(),
      fetchedAt: Date.now(),
    },
  });

  // Transform SSE stream
  const transformer = createCodexStreamTransformer(model, crypto.randomUUID());
  const transformedStream = res.body.pipeThrough(transformer);

  return new Response(transformedStream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Hexos-Provider": "codex",
      "X-Hexos-Account": conn.label || conn.id,
    },
  });
}
```

6. In the 401 handler, add Codex refresh:
```typescript
// In the 401 handling block, add:
if (conn.provider === "codex") {
  const refreshed = await refreshCodex(conn.refreshToken!, conn.id);
  await updateConnection(conn.id, {
    accessToken: refreshed.accessToken,
    refreshToken: refreshed.refreshToken,
  });
}
```

---

### Task 7: Add Codex dashboard API endpoints

**Objective:** Add REST endpoints for Codex account management in the dashboard.

**Files:**
- Modify: `src/server.ts`

**Steps:**

Add these endpoints in the `/api/*` section:

```typescript
// POST /api/codex/connect — Start OAuth login flow
app.post("/api/codex/connect", async (c) => {
  try {
    const result = await oauthCodexLogin();
    const conn = await saveConnection({
      provider: "codex",
      label: result.email,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      uid: result.email,
      status: "active",
    });
    return c.json({ success: true, connection: { id: conn.id, email: result.email, plan: result.planType } });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// GET /api/codex/auth-url — Get OAuth URL for dashboard popup flow
app.get("/api/codex/auth-url", async (c) => {
  // Generate PKCE and return auth URL + server info for dashboard to handle
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  const state = crypto.randomBytes(32).toString("base64url");
  const redirectUri = "http://localhost:1455/auth/callback";

  const params = new URLSearchParams({
    response_type: "code",
    client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access",
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: "codex_cli_rs",
    state,
  });

  return c.json({
    authUrl: `https://auth.openai.com/oauth/authorize?${params.toString()}`,
    state,
    codeVerifier,
    redirectUri,
  });
});

// POST /api/codex/exchange — Exchange auth code for tokens (called by dashboard after callback)
app.post("/api/codex/exchange", async (c) => {
  const { code, codeVerifier, redirectUri } = await c.req.json();

  const tokenRes = await fetch("https://auth.openai.com/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }),
  });

  if (!tokenRes.ok) {
    return c.json({ error: `Token exchange failed: ${await tokenRes.text()}` }, 400);
  }

  const tokens = await tokenRes.json() as any;
  const parsed = parseCodexToken(tokens.access_token);

  const conn = await saveConnection({
    provider: "codex",
    label: parsed.email || "Codex Account",
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    uid: parsed.userId || parsed.email,
    expiresAt: Date.now() + (tokens.expires_in * 1000),
    status: "active",
  });

  return c.json({
    success: true,
    connection: { id: conn.id, email: parsed.email, plan: parsed.planType },
  });
});

// POST /api/codex/import — Import tokens from Codex CLI auth.json or manual paste
app.post("/api/codex/import", async (c) => {
  const { accessToken, refreshToken, source } = await c.req.json();

  if (!accessToken || !refreshToken) {
    return c.json({ error: "accessToken and refreshToken required" }, 400);
  }

  const parsed = parseCodexToken(accessToken);

  const conn = await saveConnection({
    provider: "codex",
    label: parsed.email || source || "Codex Import",
    accessToken,
    refreshToken,
    uid: parsed.userId || parsed.email,
    status: "active",
  });

  return c.json({
    success: true,
    connection: { id: conn.id, email: parsed.email, plan: parsed.planType },
  });
});
```

---

### Task 8: Add Codex to provider list endpoint and models endpoint

**Objective:** Ensure Codex appears in the /api/providers and /v1/models responses.

**Files:**
- Modify: `src/server.ts` (the existing providers and models endpoints)

**Steps:**

The existing code already iterates `PROVIDERS` and `MODEL_CATALOG`, so adding entries in Tasks 1-2 should automatically include Codex. Verify by checking:

1. `GET /api/providers` returns codex in the list
2. `GET /v1/models` returns cx/* models
3. `GET /api/connections` shows codex connections

No code changes needed if the existing iteration is generic — just verify after Tasks 1-2.

---
