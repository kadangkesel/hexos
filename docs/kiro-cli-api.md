# Kiro CLI / Kiro IDE (Amazon Q Developer)

Hasil reverse engineering Kiro CLI v2.0.1 + analisis noxa repo.

## Overview

Kiro adalah **Amazon Q Developer** (rebranded). Ada dua produk:
- **Kiro CLI** (`kiro-cli`) — terminal agent, binary Rust
- **Kiro IDE** — VS Code fork dengan AI features

Backend: AWS CodeWhisperer API.

- CLI Binary: `~/.local/bin/kiro-cli` (117MB), `kiro-cli-chat` (396MB)
- Data: `~/.local/share/kiro/data.sqlite3` (SQLite)
- Version: 2.0.1

## API Endpoint

```
POST https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse
X-Amz-Target: AmazonCodeWhispererStreamingService.GenerateAssistantResponse
Content-Type: application/json
Accept: application/vnd.amazon.eventstream
Authorization: Bearer <accessToken>
User-Agent: AWS-SDK-JS/3.0.0 kiro-ide/1.0.0
X-Amz-User-Agent: aws-sdk-js/3.0.0 kiro-ide/1.0.0
Amz-Sdk-Request: attempt=1; max=3
Amz-Sdk-Invocation-Id: <uuid>
```

Response format: **AWS EventStream binary** (not SSE/JSON).

## Request Format (Kiro native)

```json
{
  "conversationState": {
    "chatTriggerType": "MANUAL",
    "conversationId": "<uuid>",
    "currentMessage": {
      "userInputMessage": {
        "content": "[Context: Current time is 2026-...]\n\nuser prompt here",
        "modelId": "CLAUDE_SONNET_4_5",
        "origin": "AI_EDITOR",
        "userInputMessageContext": {
          "tools": [
            {
              "toolSpecification": {
                "name": "tool_name",
                "description": "...",
                "inputSchema": { "json": { "type": "object", "properties": {}, "required": [] } }
              }
            }
          ]
        }
      }
    },
    "history": [
      { "userInputMessage": { "content": "...", "modelId": "..." } },
      { "assistantResponseMessage": { "content": "..." } }
    ]
  },
  "profileArn": "arn:aws:codewhisperer:...",
  "inferenceConfig": {
    "maxTokens": 32000,
    "temperature": 0
  }
}
```

## Response Events (AWS EventStream)

Events parsed from binary stream:
- `assistantResponseEvent` — text content chunks
- `codeEvent` — code content chunks
- `toolUseEvent` — tool call (name, toolUseId, input)
- `messageStopEvent` — end of message
- `contextUsageEvent` — context usage percentage
- `meteringEvent` — billing/metering
- `metricsEvent` — token usage (inputTokens, outputTokens)

## Authentication Methods

Kiro supports 4 auth methods:

### 1. AWS Builder ID (Device Code Flow) — Free

```
Register client:
  POST https://oidc.us-east-1.amazonaws.com/client/register
  Body: { clientName, clientType: "public", scopes, grantTypes, issuerUrl }
  → { clientId, clientSecret }

Start device auth:
  POST https://oidc.us-east-1.amazonaws.com/device_authorization
  Body: { clientId, clientSecret, startUrl: "https://view.awsapps.com/start" }
  → { deviceCode, userCode, verificationUri, expiresIn, interval }

Poll for token:
  POST https://oidc.us-east-1.amazonaws.com/token
  Body: { clientId, clientSecret, deviceCode, grantType: "urn:ietf:params:oauth:grant-type:device_code" }
  → { accessToken, refreshToken, expiresIn }

Refresh:
  POST https://oidc.us-east-1.amazonaws.com/token
  Body: { clientId, clientSecret, refreshToken, grantType: "refresh_token" }
```

OAuth scopes: `codewhisperer:completions`, `codewhisperer:analysis`, `codewhisperer:conversations`
issuerUrl: `https://identitycenter.amazonaws.com/ssoins-722374e8c3c8e6c6`

### 2. AWS IAM Identity Center (Pro)

Same as Builder ID but with custom `startUrl` and `region`.

### 3. Google/GitHub Social Login

```
Auth URL: https://prod.us-east-1.auth.desktop.kiro.dev/login
  Params: idp=Google|Github, redirect_uri=kiro://kiro.kiroAgent/authenticate-success
          code_challenge, code_challenge_method=S256, state

Token exchange:
  POST https://prod.us-east-1.auth.desktop.kiro.dev/oauth/token
  Body: { code, code_verifier, redirect_uri: "kiro://kiro.kiroAgent/authenticate-success" }
  → { accessToken, refreshToken, profileArn, expiresIn }

Refresh:
  POST https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken
  Body: { refreshToken }
  → { accessToken, refreshToken, profileArn }
```

Note: redirect_uri uses `kiro://` custom protocol (AWS Cognito whitelist).

### 4. Import Token

Paste refresh token from Kiro IDE directly.
Token format: starts with `aorAAAAAG...`

Validate by calling refresh endpoint.

## Model List

```
POST https://codewhisperer.us-east-1.amazonaws.com
X-Amz-Target: AmazonCodeWhispererService.ListAvailableModels
Authorization: Bearer <accessToken>
Body: { "origin": "AI_EDITOR", "profileArn": "..." }
```

Returns: `{ models: [{ modelId, modelName, description, rateMultiplier, rateUnit, tokenLimits }] }`

## Message Format Conversion (OpenAI → Kiro)

Key rules:
- `system` and `tool` roles → `user` role
- Consecutive same-role messages are merged
- Last user message becomes `currentMessage`, rest goes to `history`
- Tools only in first user message's `userInputMessageContext`
- Tool results in `userInputMessageContext.toolResults`
- Images: base64 only (URL images not supported)
- History alternates: `userInputMessage` / `assistantResponseMessage`

## CLI Login (VPS Headless)

```bash
# Device flow - shows URL + code
kiro-cli login --license free --use-device-flow -vvv 2>&1 | grep -E "Confirm|Open this URL"

# Output:
# Confirm the following code in the browser
# Open this URL: https://view.awsapps.com/start/#/device?user_code=XXXX-YYYY
```

Open URL in browser → login with AWS Builder ID (free signup) → approve.

## Key Differences from Cline

| Feature | Kiro | Cline |
|---------|------|-------|
| Auth | AWS SSO / Social (Cognito) | WorkOS OAuth |
| API | CodeWhisperer (binary EventStream) | OpenRouter (OpenAI SSE) |
| Protocol | AWS EventStream binary | OpenAI-compatible JSON |
| Models | AWS-hosted (CodeWhisperer) | 343+ OpenRouter models |
| Free tier | Monthly request limit | Credit-based |
| Token format | `aorAAAAAG...` (refresh) | JWT (WorkOS) |
| Intercept | Hard (binary format) | Easy (OpenAI format) |

## Pitfalls

1. Kiro IS Amazon Q Developer — auth goes through AWS, not kiro.dev
2. API uses binary AWS EventStream, not JSON SSE — needs custom parser
3. Social login uses `kiro://` custom protocol redirect — needs special handling
4. `prod.us-east-1.auth.desktop.kiro.dev` is AWS Cognito custom domain for social auth
5. Device flow URL/code hidden behind spinner — use `-vvv` to see it
6. profileArn required for some API calls (from social auth token exchange)
7. Context window ~200k tokens (estimated from contextUsagePercentage)
