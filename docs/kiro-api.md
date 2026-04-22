# Kiro API — Full Technical Reference

> Reverse-engineered from Kiro IDE traffic and noxa (9router fork) source code.
> Last updated: April 2026

---

## Overview

Kiro uses the **AWS CodeWhisperer Streaming API** under the hood. It is NOT a standard OpenAI-compatible API — it uses AWS EventStream binary framing for responses and a custom JSON request format.

- Base endpoint: `https://codewhisperer.us-east-1.amazonaws.com`
- Auth: Bearer token (AWS Cognito social login or AWS SSO OIDC)
- Response format: `application/vnd.amazon.eventstream` (binary framed)

---

## Authentication

### Token Storage (Kiro IDE)

When Kiro IDE is installed and logged in, tokens are stored at:

| OS      | Path |
|---------|------|
| Windows | `%USERPROFILE%\.aws\sso\cache\kiro-auth-token.json` |
| Linux   | `~/.aws/sso/cache/kiro-auth-token.json` |
| macOS   | `~/.aws/sso/cache/kiro-auth-token.json` |

Token file format:
```json
{
  "accessToken": "aoaAAAAAG...",
  "refreshToken": "aorAAAAAG...",
  "profileArn": "arn:aws:codewhisperer:us-east-1:699475941385:profile/EHGA3GRVQMUK",
  "expiresAt": "2026-04-22T15:02:31.133Z",
  "authMethod": "social",
  "provider": "Google"
}
```

- `accessToken` prefix: `aoaAAAAAG`
- `refreshToken` prefix: `aorAAAAAG`
- `profileArn` is required for most API calls

---

### Auth Method 1: Google / GitHub Social Login (Recommended)

Uses AWS Cognito hosted at `https://prod.us-east-1.auth.desktop.kiro.dev`.

**Step 1 — Generate PKCE and build auth URL:**

```python
import secrets, hashlib, base64, urllib.parse

code_verifier = secrets.token_urlsafe(43)  # RFC 7636: 43-128 chars
code_challenge = base64.urlsafe_b64encode(
    hashlib.sha256(code_verifier.encode('ascii')).digest()
).rstrip(b"=").decode('ascii')
state = secrets.token_urlsafe(16)

params = urllib.parse.urlencode({
    "idp": "Google",           # or "Github"
    "redirect_uri": "kiro://kiro.kiroAgent/authenticate-success",
    "code_challenge": code_challenge,
    "code_challenge_method": "S256",
    "state": state,
    "prompt": "select_account"
})
auth_url = f"https://prod.us-east-1.auth.desktop.kiro.dev/login?{params}"
```

**Step 2 — User opens URL in browser, logs in with Google/GitHub.**

Browser redirects to `kiro://kiro.kiroAgent/authenticate-success?code=...&state=...`

- If Kiro IDE is installed: IDE intercepts the `kiro://` protocol automatically and stores the token.
- If not installed: copy the full `kiro://` URL from the browser address bar.

**Step 3 — Exchange code for tokens:**

```
POST https://prod.us-east-1.auth.desktop.kiro.dev/oauth/token
Content-Type: application/json

{
  "code": "<code from redirect>",
  "code_verifier": "<code_verifier from step 1>",
  "redirect_uri": "kiro://kiro.kiroAgent/authenticate-success"
}
```

Response:
```json
{
  "accessToken": "aoaAAAAAG...",
  "refreshToken": "aorAAAAAG...",
  "profileArn": "arn:aws:codewhisperer:us-east-1:...:profile/...",
  "expiresIn": 3600
}
```

---

### Auth Method 2: AWS Builder ID (Device Code Flow)

```
POST https://oidc.us-east-1.amazonaws.com/client/register
Content-Type: application/json

{
  "clientName": "kiro-oauth-client",
  "clientType": "public",
  "scopes": [
    "codewhisperer:completions",
    "codewhisperer:analysis",
    "codewhisperer:conversations"
  ],
  "grantTypes": [
    "urn:ietf:params:oauth:grant-type:device_code",
    "refresh_token"
  ],
  "issuerUrl": "https://view.awsapps.com/start"
}
```

Response: `{ clientId, clientSecret, clientSecretExpiresAt }`

```
POST https://oidc.us-east-1.amazonaws.com/device_authorization

{
  "clientId": "...",
  "clientSecret": "...",
  "startUrl": "https://view.awsapps.com/start"
}
```

Response: `{ deviceCode, userCode, verificationUri, verificationUriComplete, expiresIn, interval }`

User opens `verificationUriComplete` in browser and approves. Then poll:

```
POST https://oidc.us-east-1.amazonaws.com/token

{
  "clientId": "...",
  "clientSecret": "...",
  "deviceCode": "...",
  "grantType": "urn:ietf:params:oauth:grant-type:device_code"
}
```

Poll every `interval` seconds until `{ accessToken, refreshToken, expiresIn }` is returned.
Errors during polling: `authorization_pending` (keep polling), `slow_down` (increase interval), `expired_token` (restart).

---

### Auth Method 3: IAM Identity Center (IDC)

Same as Builder ID but with a custom `startUrl` and `region` provided by your organization.
The `issuerUrl` in client registration must match your IDC instance URL.

---

### Auth Method 4: Token Import

If you have a `refreshToken` starting with `aorAAAAAG`, you can import it directly.
Validate by refreshing it (see Token Refresh below).

---

### Token Refresh

**Social login / imported tokens** (no clientId/clientSecret):

```
POST https://prod.us-east-1.auth.desktop.kiro.dev/refreshToken
Content-Type: application/json
User-Agent: kiro-cli/1.0.0

{
  "refreshToken": "aorAAAAAG..."
}
```

Response: `{ accessToken, refreshToken, expiresIn }`

**Builder ID / IDC tokens** (have clientId + clientSecret):

```
POST https://oidc.{region}.amazonaws.com/token

{
  "clientId": "...",
  "clientSecret": "...",
  "refreshToken": "aorAAAAAG...",
  "grantType": "refresh_token"
}
```

> Recommended: refresh 5 minutes before `expiresAt` to avoid mid-request expiry.

---

## Chat Completions API

### Endpoint

```
POST https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse
```

### Request Headers

```
Content-Type: application/json
Accept: application/vnd.amazon.eventstream
X-Amz-Target: AmazonCodeWhispererStreamingService.GenerateAssistantResponse
User-Agent: AWS-SDK-JS/3.0 kiro-ide/1.0.0
Authorization: Bearer <accessToken>
Amz-Sdk-Request: attempt=1; max=3
Amz-Sdk-Invocation-Id: <uuid>
```

### Request Body

```json
{
  "conversationState": {
    "chatTriggerType": "MANUAL",
    "conversationId": "<uuid>",
    "currentMessage": {
      "userInputMessage": {
        "content": "[Context: Current time is 2026-04-22T14:00:00Z]\n\n<user message>",
        "modelId": "claude-sonnet-4.5",
        "origin": "AI_EDITOR",
        "userInputMessageContext": {
          "tools": [...],
          "toolResults": [...]
        }
      }
    },
    "history": [
      {
        "userInputMessage": {
          "content": "previous user message",
          "modelId": "claude-sonnet-4.5"
        }
      },
      {
        "assistantResponseMessage": {
          "content": "previous assistant reply",
          "toolUses": [...]
        }
      }
    ]
  },
  "profileArn": "arn:aws:codewhisperer:us-east-1:...:profile/...",
  "inferenceConfig": {
    "maxTokens": 32000,
    "temperature": 0.7,
    "topP": 0.9
  }
}
```

**Field notes:**
- `chatTriggerType`: always `"MANUAL"` (NOT `"chatTrigerType"` — that's a typo in some implementations)
- `conversationId`: new UUID per conversation, same UUID across turns in the same conversation
- `content` in `currentMessage`: prepend `[Context: Current time is <ISO>]\n\n` to the actual message
- `origin`: always `"AI_EDITOR"`
- `history`: must alternate `userInputMessage` / `assistantResponseMessage`. Consecutive same-role messages must be merged.
- `profileArn`: required. Default fallback: `arn:aws:codewhisperer:us-east-1:63861613270:profile/AAACCXX`
- `inferenceConfig`: optional. `maxTokens` max is 32000.

---

### Tools (Function Calling)

Tools are attached to the **first user message's** `userInputMessageContext.tools`. They must be removed from history messages (only present in `currentMessage` if it's the first turn, or re-injected into `currentMessage` on every turn).

```json
"userInputMessageContext": {
  "tools": [
    {
      "toolSpecification": {
        "name": "get_weather",
        "description": "Get current weather for a location",
        "inputSchema": {
          "json": {
            "type": "object",
            "properties": {
              "location": { "type": "string", "description": "City name" }
            },
            "required": ["location"]
          }
        }
      }
    }
  ]
}
```

Tool results go in the next user message's `userInputMessageContext.toolResults`:

```json
"userInputMessageContext": {
  "toolResults": [
    {
      "toolUseId": "<id from toolUseEvent>",
      "status": "success",
      "content": [{ "text": "Sunny, 25°C" }]
    }
  ]
}
```

---

### Image Support

Images are attached to `userInputMessage.images` (base64 only, no URL):

```json
"images": [
  {
    "format": "png",
    "source": {
      "bytes": "<base64 encoded image data>"
    }
  }
]
```

Supported formats: `png`, `jpeg`, `gif`, `webp`.
Note: DeepSeek and Qwen models do NOT support images.

---

## Response Format — AWS EventStream Binary

Responses use AWS EventStream binary framing, NOT standard SSE/JSON.

### Frame Structure

```
[4 bytes] total_length       (big-endian uint32, includes all fields + CRCs)
[4 bytes] headers_length     (big-endian uint32)
[4 bytes] prelude_crc        (CRC32 of first 8 bytes)
[N bytes] headers            (variable length key-value pairs)
[M bytes] payload            (JSON)
[4 bytes] message_crc        (CRC32 of entire message)
```

### Header Encoding

Each header entry:
```
[1 byte]  name_length
[N bytes] name (UTF-8)
[1 byte]  value_type  (7 = string)
[2 bytes] value_length (big-endian uint16)
[N bytes] value (UTF-8)
```

### Python Parser

```python
import struct, io, json

def parse_eventstream(raw: bytes) -> list[dict]:
    events = []
    buf = io.BytesIO(raw)
    while True:
        hdr = buf.read(4)
        if len(hdr) < 4: break
        total_len = struct.unpack(">I", hdr)[0]
        if total_len < 16: break
        frame = hdr + buf.read(total_len - 4)
        if len(frame) < total_len: break

        headers_len = struct.unpack(">I", frame[4:8])[0]
        h_raw = frame[12:12 + headers_len]
        payload = frame[12 + headers_len:-4]

        headers = {}
        hb = io.BytesIO(h_raw)
        while hb.tell() < len(h_raw):
            try:
                nl = struct.unpack("B", hb.read(1))[0]
                name = hb.read(nl).decode()
                ht = struct.unpack("B", hb.read(1))[0]
                if ht == 7:
                    vl = struct.unpack(">H", hb.read(2))[0]
                    headers[name] = hb.read(vl).decode()
                else:
                    break
            except:
                break

        try:
            p = json.loads(payload)
        except:
            p = {"raw": payload.decode(errors="replace")}

        events.append({"event_type": headers.get(":event-type"), "payload": p})
    return events
```

---

### Event Types

| Event Type | Payload Fields | Description |
|---|---|---|
| `assistantResponseEvent` | `content: string` | Streamed text chunk |
| `codeEvent` | `content: string` | Streamed code chunk |
| `toolUseEvent` | `toolUseId, name, input` | Tool call (may be array) |
| `messageStopEvent` | `stopReason: string` | End of response |
| `metricsEvent` | `inputTokens, outputTokens` | Token usage |
| `contextUsageEvent` | `contextUsagePercentage` | Context window % used |
| `reasoningContentEvent` | `content: string` | Thinking/reasoning text |
| `meteringEvent` | — | Billing marker (ignore) |
| `usageEvent` | `inputTokens, outputTokens` | Alternate usage data |

**Token estimation fallback** (if `metricsEvent` not received):
- Output tokens: `content_length / 4`
- Input tokens: `contextUsagePercentage * 200000 / 100` (assumes 200k context window)

---

## Available Models

Confirmed valid model IDs (tested April 2026):

| Model ID | Description | Images |
|---|---|---|
| `claude-sonnet-4.5` | Claude Sonnet 4.5 | ✅ |
| `claude-sonnet-4` | Claude Sonnet 4 | ✅ |
| `claude-haiku-4.5` | Claude Haiku 4.5 | ✅ |
| `deepseek-3.2` | DeepSeek V3 | ❌ |
| `qwen3-coder-next` | Qwen3 Coder Next | ❌ |
| `glm-5` | GLM 5 | ❌ |
| `minimax-m2.1` | MiniMax M2.1 | ❌ |
| `simple-task` | Qwen3 Coder (alias) | ❌ |

**Invalid / not available:**
- `claude-opus-4`, `claude-opus-4.5`, `claude-opus-4.6`
- `claude-sonnet-4.6`
- `claude-sonnet-3.x`, `claude-haiku-3.x` (all Claude 3 variants)
- `deepseek-r1`, `deepseek-3.1`
- `MiniMax-M2.5` (case-sensitive, this exact casing fails)
- Amazon Nova models

---

## Usage / Quota API

Kiro uses per-request quota (not per-token). Resource type: `AGENTIC_REQUEST`.

Three endpoints tried in fallback order:

**Option A:**
```
GET https://codewhisperer.us-east-1.amazonaws.com/getUsageLimits
    ?isEmailRequired=true&origin=AI_EDITOR&resourceType=AGENTIC_REQUEST
Authorization: Bearer <accessToken>
```

**Option B:**
```
POST https://codewhisperer.us-east-1.amazonaws.com
X-Amz-Target: AmazonCodeWhispererService.GetUsageLimits

{
  "origin": "AI_EDITOR",
  "profileArn": "...",
  "resourceType": "AGENTIC_REQUEST"
}
```

**Option C (fallback):**
```
GET https://q.us-east-1.amazonaws.com/getUsageLimits
    ?origin=AI_EDITOR&profileArn=...&resourceType=AGENTIC_REQUEST
```

Response:
```json
{
  "usageBreakdownList": [
    {
      "resourceType": "agentic_request",
      "currentUsageWithPrecision": 45,
      "usageLimitWithPrecision": 1000,
      "freeTrialInfo": {
        "currentUsageWithPrecision": 45,
        "usageLimitWithPrecision": 100,
        "freeTrialExpiry": "2026-05-01T00:00:00Z"
      }
    }
  ],
  "nextDateReset": "2026-05-01T00:00:00Z",
  "subscriptionInfo": {
    "subscriptionTitle": "Pro"
  }
}
```

---

## Full Working Example (Python)

```python
import requests, json, uuid, time, struct, io

TOKEN_FILE = "~/.kiro_token.json"

def load_token():
    import os
    with open(os.path.expanduser(TOKEN_FILE)) as f:
        return json.load(f)

def parse_eventstream(raw):
    events = []
    buf = io.BytesIO(raw)
    while True:
        hdr = buf.read(4)
        if len(hdr) < 4: break
        total_len = struct.unpack(">I", hdr)[0]
        if total_len < 16: break
        frame = hdr + buf.read(total_len - 4)
        if len(frame) < total_len: break
        headers_len = struct.unpack(">I", frame[4:8])[0]
        h_raw = frame[12:12 + headers_len]
        payload = frame[12 + headers_len:-4]
        headers = {}
        hb = io.BytesIO(h_raw)
        while hb.tell() < len(h_raw):
            try:
                nl = struct.unpack("B", hb.read(1))[0]
                name = hb.read(nl).decode()
                ht = struct.unpack("B", hb.read(1))[0]
                if ht == 7:
                    vl = struct.unpack(">H", hb.read(2))[0]
                    headers[name] = hb.read(vl).decode()
                else: break
            except: break
        try: p = json.loads(payload)
        except: p = {}
        events.append({"event_type": headers.get(":event-type"), "payload": p})
    return events

def chat(message, model="claude-sonnet-4.5", history=None):
    t = load_token()
    ts = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())

    body = {
        "conversationState": {
            "chatTriggerType": "MANUAL",
            "conversationId": str(uuid.uuid4()),
            "currentMessage": {
                "userInputMessage": {
                    "content": f"[Context: Current time is {ts}]\n\n{message}",
                    "modelId": model,
                    "origin": "AI_EDITOR"
                }
            },
            "history": history or []
        },
        "profileArn": t["profileArn"],
        "inferenceConfig": {"maxTokens": 32000}
    }

    r = requests.post(
        "https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse",
        headers={
            "Content-Type": "application/json",
            "Accept": "application/vnd.amazon.eventstream",
            "X-Amz-Target": "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
            "User-Agent": "AWS-SDK-JS/3.0 kiro-ide/1.0.0",
            "Authorization": f"Bearer {t['accessToken']}",
            "Amz-Sdk-Request": "attempt=1; max=3",
            "Amz-Sdk-Invocation-Id": str(uuid.uuid4())
        },
        json=body, stream=True, timeout=60
    )

    if r.status_code != 200:
        raise Exception(f"API error {r.status_code}: {r.text}")

    raw = b"".join(r.iter_content(chunk_size=None))
    events = parse_eventstream(raw)

    full_text = ""
    for ev in events:
        et = ev["event_type"]
        p = ev["payload"]
        if et in ("assistantResponseEvent", "codeEvent"):
            full_text += p.get("content", "")
        elif et == "metricsEvent":
            print(f"\n[tokens] input={p.get('inputTokens')} output={p.get('outputTokens')}")
        elif et == "messageStopEvent":
            print(f"[stop] {p.get('stopReason')}")

    return full_text

if __name__ == "__main__":
    reply = chat("Halo! Kamu model apa?")
    print(reply)
```

---

## Known Issues / Gotchas

1. **`chatTriggerType` not `chatTrigerType`** — the typo version returns 400 `Improperly formed request`.
2. **Model IDs are case-sensitive and use dots** — `claude-sonnet-4.5` works, `claude-sonnet-4-5` does not.
3. **`MiniMax-M2.5` is invalid** — use `minimax-m2.1` instead.
4. **Rate limit**: ~5 req/s concurrent limit. Back off on 429.
5. **No ListAvailableModels endpoint** — `AmazonCodeWhispererService.ListAvailableModels` returns `UnknownOperationException`. Model list must be hardcoded or brute-forced.
6. **Social login `kiro://` redirect** — if Kiro IDE is installed, the browser intercepts the redirect automatically. Token is then available at `~/.aws/sso/cache/kiro-auth-token.json`.
7. **`profileArn` is required** — omitting it may cause errors on some accounts. Default fallback ARN: `arn:aws:codewhisperer:us-east-1:63861613270:profile/AAACCXX`.
8. **History must alternate** — consecutive user or assistant messages must be merged before sending.
9. **Token expiry** — `accessToken` expires in ~1 hour. Always check `expiresAt` and refresh proactively.
