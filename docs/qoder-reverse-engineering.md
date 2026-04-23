# Qoder API — Full Reverse Engineering Documentation

> Reverse-engineered from QoderCLI v0.1.47 (Go binary) and Qoder IDE v0.14.1 (VSCode fork).
> Auth algorithm extracted from IDE JavaScript source (`sharedProcessMain.js`).
> Last updated: April 2026

---

## Daftar Isi

1. [Overview](#overview)
2. [Arsitektur](#arsitektur)
3. [Instalasi & File Layout](#file-layout)
4. [Authentication](#authentication)
   - [Mode 1: Signature Auth (Anonymous)](#auth-signature)
   - [Mode 2: Bearer Auth (Logged In)](#auth-bearer)
   - [Login Flow](#login-flow)
   - [RSA Public Key](#rsa-key)
5. [API Endpoints](#endpoints)
   - [Center Server](#center-endpoints)
   - [Inference Server](#inference-endpoints)
   - [Other Endpoints](#other-endpoints)
6. [Request Headers](#headers)
7. [Body Encryption](#body-encryption)
8. [Model Reference](#models)
   - [Public Models](#public-models)
   - [Hidden Models](#hidden-models)
   - [Model Selection Header](#model-selection)
9. [Inference API (SSE Streaming)](#inference-api)
10. [IDE vs CLI Comparison](#ide-vs-cli)
11. [Proxy Implementation Guide](#proxy-guide)
12. [Limitasi & Catatan](#limitasi)

---

## 1. Overview <a name="overview"></a>

Qoder (sebelumnya Lingma/Cosy) adalah AI coding assistant dari Alibaba Cloud.
Tersedia dalam 2 bentuk:

- **Qoder IDE** — Fork VSCode (Electron-based), versi 0.14.1
- **QoderCLI** — Standalone terminal agent (Go binary), versi 0.1.47

Keduanya menggunakan backend API yang sama di `*.qoder.sh` dengan auth mechanism
identik. Dokumen ini mendokumentasikan seluruh internal API hasil reverse engineering.

### Apa yang Berhasil

- Full auth algorithm extraction (Signature + Bearer COSY token generation)
- RSA public key hardcoded di binary
- Secret key: `"cosy"` (obfuscated sebagai reversed base64)
- Semua API endpoints mapped via mitmproxy traffic interception
- 9 public models + 15+ hidden model keys ditemukan dan ditest
- Hidden models (opus-4, sonnet-4, gpt-5, dll) **diterima server** via header swap
- Body encryption algorithm: AES-128-CBC + RSA key wrapping
- BYOK (Bring Your Own Key) endpoint ditemukan

### Tech Stack

| Component | Technology |
|-----------|-----------|
| CLI Binary | Go (compiled, ~40MB) |
| IDE | Electron/VSCode fork |
| API Protocol | HTTPS + SSE (Server-Sent Events) |
| Auth | HMAC-SHA256 + AES-128-CBC + RSA-1024 + MD5 |
| DNS | Alibaba Cloud HTTPDNS (AccountID: 183012) |
| SDK | `github.com/ai-providers/anthropic-sdk-go` v1.4.0 |
| Body Encoding | Custom encoding (AES-128-CBC with substitution alphabet) |

---

## 2. Arsitektur <a name="arsitektur"></a>

```
┌─────────────┐     ┌─────────────┐
│  Qoder IDE  │     │  QoderCLI   │
│  (Electron) │     │  (Go bin)   │
│ ClientType=0│     │ ClientType=5│
└──────┬──────┘     └──────┬──────┘
       │                   │
       │  HTTPS + SSE      │
       ▼                   ▼
┌──────────────────────────────────┐
│       Alibaba Cloud HTTPDNS     │
│       (AccountID: 183012)       │
└──────────────┬───────────────────┘
               │
       ┌───────┴────────┐
       ▼                ▼
┌─────────────┐  ┌─────────────┐
│ center      │  │ api2        │
│ .qoder.sh   │  │ .qoder.sh   │
│             │  │             │
│ - Auth      │  │ - Inference │
│ - Config    │  │ - Models    │
│ - Heartbeat │  │ - SSE Chat  │
│ - Tracking  │  │ - BYOK      │
│ - Region    │  │ - Business  │
└─────────────┘  └─────────────┘
```

### Server Nodes

| Domain | Role | IPs |
|--------|------|-----|
| `center.qoder.sh` | Auth, config, telemetry | 47.236.131.191 |
| `api1.qoder.sh` | Inference node 1 | — |
| `api2.qoder.sh` | Inference node 2 (preferred) | 47.236.205.232, 47.236.175.159 |
| `api3.qoder.sh` | Inference node 3 | — |
| `openapi.qoder.sh` | Public API | 8.219.69.63, 8.219.58.64 |
| `qts2.qoder.sh` | Quest/remote agent | — |
| `repo2.qoder.sh` | Codebase/repo service | — |
| `download.qoder.com` | Binary updates (Aliyun OSS) | 8.219.237.173 |
| `marketplace.qoder.sh` | Extension marketplace | — |

### Staging/Test

| Domain | Role |
|--------|------|
| `test.qoder.ai` | Test environment |
| `test-api2.qoder.sh` | Test inference |
| `test-openapi.qoder.sh` | Test public API |
| `daily.qoder.ai` | Daily build |
| `daily-api2.qoder.sh` | Daily inference |

---

## 3. Instalasi & File Layout <a name="file-layout"></a>

### CLI (Linux)

```
~/.qoder/
├── .auth/
│   ├── id                      # Machine UUID (plaintext)
│   ├── user                    # Encrypted auth blob (AES)
│   └── dynamic-texts.json      # UI texts, model descriptions
├── .config.json                # Region config, preferred endpoint
├── .cache/
│   └── models_{userId}         # Encrypted model cache ("QMC" format)
├── bin/
│   └── qodercli/
│       └── qodercli-0.1.47     # Go binary (symlinked to ~/.local/bin/qodercli)
├── events/
│   └── events_YYYY-MM-DD.jsonl # Event logs
├── logs/
│   └── qodercli.log            # Debug log
└── projects/
    └── {path-encoded}/
        ├── {sessionId}.jsonl        # Chat messages
        └── {sessionId}-session.json # Session metadata

~/.qoder.json                   # User settings (modelLevel, theme, etc.)
```

### IDE (Windows)

```
C:\Users\{user}\AppData\Local\Programs\Qoder\     # IDE binary
C:\Users\{user}\AppData\Roaming\Qoder\            # User data
C:\Users\{user}\.qoder\extensions\                 # Extensions
C:\Users\{user}\.qoder\                            # Config folder

Key files:
  AppData\Roaming\Qoder\machineid                  # Machine UUID
  AppData\Roaming\Qoder\region-config-cache.json   # Endpoint config
  AppData\Roaming\Qoder\dynamic-text-cache.json    # Model descriptions
  AppData\Roaming\Qoder\error-code-cache.json      # Error codes
  AppData\Roaming\Qoder\Local State                # DPAPI encrypted key
```

---

## 4. Authentication <a name="authentication"></a>

Qoder menggunakan 2 mode autentikasi. Keduanya bisa dipakai secara independen.

### Mode 1: Signature Auth (Anonymous) <a name="auth-signature"></a>

Dipakai untuk endpoint yang tidak butuh user identity: `/user/status`, `/heartbeat`,
`/tracking`, `/region/endpoints`.

**Algorithm:**

```javascript
// 1. Secret (hardcoded, obfuscated)
const SECRET = "cosy";  // obfuscated: base64(reverse("==Qez92Y")) = "Y29zeQ==" = "cosy"

// 2. Derive secret key
const secretKey = SHA256(`cosy:${productVersion}:${machineToken}`);

// 3. Hash request body
const bodyHash = SHA256(requestBody);

// 4. Build sign string
const signString = [
    method,           // "GET" or "POST"
    path,             // URL path tanpa /algo prefix dan tanpa query params
    requestId,        // UUID v4
    machineToken,     // dari login
    timestamp,        // Math.floor(Date.now() / 1000)
    bodyHash          // SHA256 hex dari body
].join("\n");

// 5. Sign
const signature = HMAC_SHA256(secretKey, signString);

// 6. Headers
Authorization: Signature {signature_hex}
X-Client-Timestamp: {timestamp}
```

**Contoh:**

```
SecretKey = SHA256("cosy:0.1.47:P1gAI-Zn6G_c-VaU4s0CNbJ0NzAJ4RDY...")
SignString = "POST\n/api/v3/user/status\n81abdf6b-15ec-4de5-ad8f-fa08df35ec65\nP1gAI-Zn6G...\n1776958629\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
Signature = HMAC-SHA256(SecretKey, SignString)
Header: Authorization: Signature 5611590ff2cd79f6a13e590ca985a8fc...
```

### Mode 2: Bearer Auth (Logged In) <a name="auth-bearer"></a>

Dipakai untuk endpoint yang butuh user identity: `/model/list`, `/agent_chat_generation`,
`/byok`, `/dataPolicy`.

**Algorithm:**

```javascript
// 1. Encrypt user info
const userInfo = JSON.stringify({
    uid: "019db9dc-31df-7a45-a57b-29270bc77f51",
    security_oauth_token: "...",
    name: "RoyEdmondson oden",
    aid: "...",
    email: "antwanberg@gminol.com"
});

// 2. Generate random AES key (16 chars from UUID)
const aesKey = crypto.randomUUID().replace(/-/g, "").substring(0, 16);
const iv = Buffer.from(aesKey, "utf8").slice(0, 16);  // IV = key itself!

// 3. AES-128-CBC encrypt user info
const encryptedInfo = AES_128_CBC_Encrypt(userInfo, aesKey, iv);  // base64 output

// 4. RSA encrypt the AES key
const encryptedKey = RSA_PKCS1_Encrypt(aesKey, HARDCODED_RSA_PUBLIC_KEY);  // base64

// 5. Build auth payload
const payload = JSON.stringify({
    version: "v1",
    requestId: crypto.randomUUID().replace(/-/g, ""),
    info: encryptedInfo,       // AES-encrypted user info
    cosyVersion: "0.1.47",
    ideVersion: "0.14.1"
});
const base64Payload = Buffer.from(payload).toString("base64");

// 6. Calculate signature
const cleanPath = url.pathname.replace(/^\/algo/, "");  // strip /algo prefix
const signature = MD5(base64Payload + "&" + cleanPath);

// 7. Final token
const token = `Bearer COSY.${base64Payload}.${signature}`;

// 8. Headers
Authorization: Bearer COSY.eyJ2ZXJzaW9uIjoi...EifQ==.884a37fe5ed74d2fcf26e06b2302f1c2
Cosy-User: 019db9dc-31df-7a45-a57b-29270bc77f51
Cosy-Key: {base64_rsa_encrypted_aes_key}
Cosy-Date: 1776958670
```

### Login Flow <a name="login-flow"></a>

```
1. CLI/IDE generate nonce (random hex)
2. POST /api/v1/deviceToken/poll  { nonce }
3. Open browser: https://qoder.com/device/selectAccounts?nonce={nonce}
4. User logs in via Google/GitHub/email di browser
5. CLI polls /api/v1/deviceToken/poll setiap ~1.5 detik
6. Setelah user approve, server return:
   {
     "machineToken": "P1gAI-Zn6G_c-VaU4s0CNbJ0...",
     "machineType": "6f781de391b845433b"
   }
7. CLI juga mendapat user info (uid, name, email, oauth_token)
8. Semua disimpan encrypted ke ~/.qoder/.auth/user
9. machineId (UUID) disimpan ke ~/.qoder/.auth/id
```

**Token tidak expire** — sekali login, machineToken valid selamanya sampai manual logout.

### RSA Public Key (Hardcoded) <a name="rsa-key"></a>

Dipakai untuk encrypt AES key di Bearer auth. Sama di IDE dan CLI.

```
-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----
```

RSA-1024, PKCS1 padding. Key ini dipakai untuk encrypt, bukan sign — jadi
siapapun yang punya public key bisa encrypt (yang kita butuhkan untuk proxy).

---

## 5. API Endpoints <a name="endpoints"></a>

### Center Server (`center.qoder.sh`) <a name="center-endpoints"></a>

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/algo/api/v3/service/region/endpoints` | Signature | Discover regional endpoints |
| POST | `/algo/api/v3/user/status?Encode=1` | Signature | User auth status, plan info |
| POST | `/algo/api/v3/user/refresh_token` | Bearer | Refresh auth token |
| GET | `/algo/api/v3/user/grantAuthInfos` | Bearer | Grant auth infos (Lingma) |
| GET | `/algo/api/v3/user/jobToken` | Bearer | Job token |
| POST | `/algo/api/v1/heartbeat?Encode=1` | Signature | Heartbeat + dynamic config |
| POST | `/algo/api/v1/tracking?Encode=1` | Signature | Telemetry events |
| GET | `/algo/api/v1/me/features` | Bearer | User features/plan |
| GET | `/algo/api/v1/userinfo` | Bearer | User info |
| POST | `/algo/api/v1/deviceToken/poll` | None | Device login polling |
| POST | `/algo/api/v1/deviceToken/refresh` | Bearer | Device token refresh |
| GET | `/algo/api/v2/config/getDataPolicy?requestId=...` | Bearer | Data policy status |
| POST | `/algo/api/v2/config/updateDataPolicy?requestId=...` | Bearer | Update data policy |
| GET | `/algo/api/v1/organizations/{orgId}/tags` | Bearer | Organization tags |
| GET | `/algo/api/v1/inner/organizations/{orgId}/codebaseStatusChecks` | Bearer | Codebase status |

### Inference Server (`api2.qoder.sh`) <a name="inference-endpoints"></a>

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| **POST** | **`/algo/api/v2/service/pro/sse/agent_chat_generation`** | **Bearer** | **Main inference (SSE streaming)** |
| GET | `/algo/api/v2/model/list?Encode=1` | Bearer | List available models |
| POST | `/algo/api/v2/service/business/finish?Encode=1` | Bearer | Report business completion |
| GET | `/algo/api/v2/byok/check` | Bearer | BYOK config check |
| GET | `/algo/api/v2/byok/config` | Bearer | BYOK configuration |
| GET | `/algo/api/v2/quota/usage` | Bearer | Quota usage |
| GET | `/algo/api/v2/user/plan` | Bearer | User plan info |
| POST | `/algo/api/v2/service/pro/generateImage?Encode=1` | Bearer | Image generation |

### Other Endpoints <a name="other-endpoints"></a>

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/algo/api/v1/webSearch/oneSearch` | Bearer | Web search (single) |
| GET | `/algo/api/v1/webSearch/unifiedSearch` | Bearer | Unified web search |
| POST | `/algo/api/v1/ping` | Signature | Health check |
| POST | `/issue/file/diagnose/upload` | Bearer | Diagnostic upload |
| POST | `/algo/api/v2/service/integrations/github/app/install-access-token/exchange` | Bearer | GitHub App token |
| GET | `/algo/api/v2/service/integrations/github/app/repo-status` | Bearer | GitHub repo status |

---

## 6. Request Headers <a name="headers"></a>

### Common Headers (semua request)

```
Content-Type: application/json
Accept: application/json
Accept-Encoding: identity
User-Agent: Go-http-client/2.0
```

### Machine Headers

```
Cosy-Version: 0.1.47                                    # CLI/IDE version
Cosy-MachineId: 77765459-346c-4b2d-ae64-576c5a476a2d    # Machine UUID
Cosy-MachineToken: P1gAI-Zn6G_c-VaU4s0CNbJ0NzAJ4RDY... # Auth token (static)
Cosy-MachineType: 6f781de391b845433b                     # Machine type hash
Cosy-ClientType: 5                                       # 0=IDE, 5=CLI
Cosy-ClientIp: 10.3.0.3                                  # Local IP
Cosy-Data-Policy: AGREE                                  # Data sharing consent
```

### Signature Auth Headers (Mode 1)

```
Signature: 5611590ff2cd79f6a13e590ca985a8fc              # HMAC-SHA256
Date: Thu, 23 Apr 2026 15:37:50 GMT                      # HTTP date
Appcode: cosy                                            # Fixed value
Login-Version: v2                                        # Fixed value
```

### Bearer Auth Headers (Mode 2, tambahan)

```
Authorization: Bearer COSY.eyJ2ZXJzaW9u...EifQ==.884a37fe...  # Token
Cosy-User: 019db9dc-31df-7a45-a57b-29270bc77f51               # User UUID
Cosy-Key: aaLoq5UPUq9K78zfMAUo1kWagCGMCXCb...=                # RSA-encrypted AES key
Cosy-Date: 1776958670                                          # Unix timestamp
```

### Inference-Specific Headers

```
X-Model-Key: lite                    # Model key (see Model Reference)
X-Model-Source: system               # "system" or "custom" (BYOK)
Cache-Control: no-cache
Accept: text/event-stream            # SSE streaming
```

### IDE-Only Headers

```
X-IDE-Platform: electron
X-Version: 0.14.1
X-Machine-OS: x86_64_win32
X-Request-Id: {uuid}
X-Client-Timestamp: {unix_timestamp}
```

---

## 7. Body Encryption <a name="body-encryption"></a>

Beberapa endpoint menggunakan body encryption. Ditandai dengan:
- Request: body berisi karakter non-standard (bukan JSON)
- Response: header `x-cosy-encrypt: v1`

**Encryption:**

```javascript
// AES-128-CBC
const key = aesKey;                    // 16 bytes
const iv = Buffer.from(key).slice(0, 16);  // IV = key[0:16]
const cipher = crypto.createCipheriv("aes-128-cbc", key, iv);
const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
// Output: custom base-encoding (NOT standard base64)
```

**Endpoint encryption matrix:**

| Endpoint | Request Encrypted | Response Encrypted |
|----------|:-:|:-:|
| `/user/status` | ✅ | ❌ (plaintext JSON) |
| `/region/endpoints` | ❌ | ✅ (`x-cosy-encrypt: v1`) |
| `/heartbeat` | ✅ | ❌ (plaintext JSON) |
| `/tracking` | ✅ | ❌ |
| `/model/list` | ❌ | ❌ (plaintext JSON) |
| `/agent_chat_generation` | ✅ | ❌ (SSE plaintext) |
| `/business/finish` | ✅ | ❌ |
| `/dataPolicy` | ❌ | ❌ |

**Catatan penting:** Response dari inference endpoint (`agent_chat_generation`)
adalah **plaintext SSE** — tidak di-encrypt. Ini memudahkan proxy implementation.

---

## 8. Model Reference <a name="models"></a>

### Public Models (dari `/api/v2/model/list`) <a name="public-models"></a>

| Key | Display Name | VL | Reasoning | Price | Free | Status |
|-----|-------------|:--:|:---------:|:-----:|:----:|--------|
| `lite` | Lite | ❌ | ❌ | 0.0x | ✅ | Default, enabled on Free |
| `auto` | Auto | ✅ | ❌ | 1.0x | ❌ | Smart selection |
| `efficient` | Efficient | ✅ | ❌ | 0.3x | ❌ | Low cost |
| `performance` | Performance | ✅ | ❌ | 1.1x | ❌ | High quality |
| `ultimate` | Ultimate | ✅ | ✅ | 1.6x | ❌ | Deep reasoning |
| `qmodel` | Qwen3.6-Plus | ✅ | ❌ | 0.2x | ❌ | NEW |
| `gm51model` | GLM-5.1 | ✅ | ✅ | 0.6x | ❌ | NEW, Zhipu AI |
| `kmodel` | Kimi-K2.6 | ✅ | ❌ | 0.3x | ❌ | NEW, Moonshot |
| `mmodel` | MiniMax-M2.7 | ✅ | ❌ | 0.2x | ❌ | NEW |

Semua model: `max_input_tokens: 180000`, `format: openai`.

### Hidden Models (ditemukan di binary, diterima server) <a name="hidden-models"></a>

Ditemukan via `strings` pada Go binary dan diverifikasi via mitmproxy header swap.
Server menerima semua key ini meskipun tidak ada di API model list.

**Anthropic Models:**

| Key | Display Name | Source |
|-----|-------------|--------|
| `opus-4-20250514` | Claude Opus 4 (May 2025) | Binary string |
| `opus-4-20250514-v1` | Claude Opus 4 v1 | Binary string |
| `opus-4-0` | Claude Opus 4 base | Binary string |
| `sonnet-4-20250514` | Claude Sonnet 4 (May 2025) | Binary string |
| `claude-3-opus-latest` | Claude 3 Opus latest | Binary string |
| `claude 3.5 Sonnet` | Claude 3.5 Sonnet | Dynamic texts |
| `claude 3.7 Sonnet` | Claude 3.7 Sonnet | Dynamic texts |
| `claude 3.5 Haiku` | Claude 3.5 Haiku | Dynamic texts |
| `claude 3 Opus` | Claude 3 Opus | Binary string |
| `claude 4 Opus` | Claude 4 Opus | Binary string |
| `claude 4 Sonnet` | Claude 4 Sonnet | Binary string |

**OpenAI Models:**

| Key | Display Name | Source |
|-----|-------------|--------|
| `gpt-5-0807-global` | GPT-5 (Aug 2025) | Binary string |
| `gpt-4.5-preview` | GPT-4.5 Preview | Binary string |
| `gpt-4.1` | GPT-4.1 | Binary string |
| `gpt-4.1-mini` | GPT-4.1 Mini | Binary string |
| `gpt-4.1-nano` | GPT-4.1 Nano | Binary string |
| `gpt-4o` | GPT-4o | Binary string |
| `gpt-4o-mini` | GPT-4o Mini | Binary string |
| `o4-mini` | o4-mini | Binary string |
| `o3-mini` | o3-mini | Binary string |
| `o1-mini` | o1-mini | Binary string |

**Chinese Models (deprecated/older):**

| Key | Display Name | Source |
|-----|-------------|--------|
| `q35model` | Qwen3.5-Plus | Dynamic texts (replaced by qmodel) |
| `q35model_preview` | Qwen3.6-Plus-DogFooding | Alibaba internal only |
| `gmodel` | GLM-5 | Dynamic texts (replaced by gm51model) |
| `qwen3-coder-plus` | Qwen3 Coder Plus | Binary string |
| `Kimi-K2.5` | Kimi K2.5 | Binary string (older) |
| `MiniMax-M2.5` | MiniMax M2.5 | Binary string (older) |

### Model Selection Header <a name="model-selection"></a>

Model dipilih via HTTP header pada inference request:

```
X-Model-Key: opus-4-20250514     # Model key dari tabel di atas
X-Model-Source: system            # "system" untuk built-in, "custom" untuk BYOK
```

**Client-side validation:** CLI binary memvalidasi model key sebelum mengirim.
Key yang tidak dikenali di-fallback ke `lite`. Untuk bypass, gunakan mitmproxy
header swap atau implementasi proxy sendiri.

**Server-side validation:** Server TIDAK menolak model key yang tidak ada di
API list. Semua hidden model keys diterima dan menghasilkan response valid.

---

## 9. Inference API (SSE Streaming) <a name="inference-api"></a>

### Request

```
POST https://api2.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation
    ?FetchKeys=llm_model_result
    &AgentId=agent_common
    &Encode=1

Headers:
  Authorization: Bearer COSY.{payload}.{signature}
  X-Model-Key: ultimate
  X-Model-Source: system
  Accept: text/event-stream
  Cache-Control: no-cache
  Content-Type: application/json
  Cosy-User: {uid}
  Cosy-Key: {rsa_encrypted_aes_key}
  Cosy-Date: {unix_timestamp}
  ... (other Cosy-* headers)

Body: (encrypted, AES-128-CBC)
```

### Response (SSE)

Response adalah **plaintext SSE** (tidak di-encrypt), format OpenAI-compatible:

```
data:{"headers":{"Content-Type":["application/json"]},"body":"{\"choices\":[{\"delta\":{\"reasoning_content\":\"thinking...\"},\"index\":0}],\"created\":1776958672,\"id\":\"chatcmpl-c4c027f7-1cf0-9b26-be41-57bce85720a4\",\"model\":\"auto\",\"object\":\"chat.completion.chunk\"}","statusCodeValue":200,"statusCode":"OK"}

data:{"headers":{"Content-Type":["application/json"]},"body":"{\"choices\":[{\"delta\":{\"content\":\"Hello!\"},\"index\":0}],\"created\":1776958672,\"id\":\"chatcmpl-c4c027f7-1cf0-9b26-be41-57bce85720a4\",\"model\":\"auto\",\"object\":\"chat.completion.chunk\"}","statusCodeValue":200,"statusCode":"OK"}

data:[DONE]
```

**SSE wrapper structure:**

```json
{
  "headers": {"Content-Type": ["application/json"]},
  "body": "{...OpenAI chat.completion.chunk JSON...}",
  "statusCodeValue": 200,
  "statusCode": "OK"
}
```

**Inner body (OpenAI-compatible):**

```json
{
  "choices": [{
    "delta": {
      "reasoning_content": "...",   // thinking/reasoning (optional)
      "content": "...",             // actual response
      "role": "assistant"           // only in first chunk
    },
    "index": 0
  }],
  "created": 1776958672,
  "id": "chatcmpl-{uuid}",
  "model": "auto",                  // always "auto" regardless of actual model
  "object": "chat.completion.chunk"
}
```

### Model Scenes

API mengembalikan model per "scene":

| Scene | Count | Description |
|-------|:-----:|-------------|
| `chat` | 9 | Main chat/agent mode |
| `assistant` | 9 | Assistant mode (same models as chat) |
| `inline` | 5 | Inline edit/completion |
| `quest` | 5 | Quest mode (autonomous tasks) |
| `experts` | 2 | Expert agents |
| `nap` | 1 | Background/idle |
| `qwork` | 2 | Qoder Work |

---

## 10. IDE vs CLI Comparison <a name="ide-vs-cli"></a>

| Aspect | CLI (Go) | IDE (Electron) |
|--------|----------|----------------|
| **Version** | 0.1.47 | 0.14.1 (VSCode 1.106.3) |
| **Cosy-ClientType** | `5` | `0` |
| **Auth Secret** | `"cosy"` | `"cosy"` (same) |
| **Signature** | HMAC-SHA256 | HMAC-SHA256 (same) |
| **Bearer Token** | `COSY.{b64}.{md5}` | `COSY.{b64}.{md5}` (same) |
| **RSA Key** | Same hardcoded key | Same hardcoded key |
| **Token Storage** | `~/.qoder/.auth/user` (AES) | Windows DPAPI |
| **Login** | Device polling only | Device polling + PKCE + AK/SK + PAT |
| **Body Encryption** | Custom encoding | Same mechanism |
| **Extra Headers** | — | `X-IDE-Platform`, `X-Version`, `X-Machine-OS` |
| **Anthropic SDK** | `anthropic-sdk-go` v1.4.0 | JS equivalent |
| **Extensions** | Built-in skills/agents | aicoding-agent, aicoding-completion |
| **MCP Support** | stdio, sse, http | Same |

### IDE-Specific: Supabase OAuth (Hardcoded)

Ditemukan di extension `aicoding-integration`:

```
Client ID:     fb89ebeb-b117-4785-80dc-8f2837e3f9c2
Client Secret: sba_1d57a785d5bd4f21a462a2939e691dd5554b232e
```

---

## 11. Proxy Implementation Guide <a name="proxy-guide"></a>

### Feasibility: ✅ 100% Possible

Semua komponen auth sudah di-reverse engineer. Yang dibutuhkan:

1. **machineToken** — dari login (static, tidak expire)
2. **uid + security_oauth_token** — dari auth file
3. **RSA public key** — hardcoded (sudah diketahui)
4. **Secret** — `"cosy"` (hardcoded)
5. **Algorithms** — SHA256, HMAC-SHA256, AES-128-CBC, RSA-PKCS1, MD5

### Approach: OpenAI-Compatible Proxy

```
OpenAI Client (curl, Hermes, etc.)
  → POST /v1/chat/completions
    → Proxy Server (Python/Node)
      → Generate Bearer COSY token
      → Set X-Model-Key header
      → POST /algo/api/v2/service/pro/sse/agent_chat_generation
        → Parse SSE response
        → Convert to OpenAI format
      ← Stream back to client
```

### Key Implementation Steps

```python
# 1. Generate Bearer token
import hashlib, json, base64, os
from Crypto.Cipher import AES, PKCS1_v1_5
from Crypto.PublicKey import RSA

def generate_bearer_token(uid, oauth_token, name, email, url_path, cosy_version="0.1.47"):
    # Encrypt user info
    user_info = json.dumps({"uid": uid, "security_oauth_token": oauth_token, "name": name, "email": email})
    aes_key = os.urandom(16).hex()[:16]  # 16 char key
    iv = aes_key.encode()[:16]
    cipher = AES.new(aes_key.encode(), AES.MODE_CBC, iv)
    # PKCS7 padding
    pad_len = 16 - (len(user_info) % 16)
    padded = user_info + chr(pad_len) * pad_len
    encrypted_info = base64.b64encode(cipher.encrypt(padded.encode())).decode()

    # RSA encrypt AES key
    rsa_key = RSA.import_key(RSA_PUBLIC_KEY)
    rsa_cipher = PKCS1_v1_5.new(rsa_key)
    encrypted_key = base64.b64encode(rsa_cipher.encrypt(aes_key.encode())).decode()

    # Build payload
    payload = json.dumps({
        "version": "v1",
        "requestId": os.urandom(16).hex(),
        "info": encrypted_info,
        "cosyVersion": cosy_version,
        "ideVersion": cosy_version
    })
    b64_payload = base64.b64encode(payload.encode()).decode()

    # Signature
    clean_path = url_path.replace("/algo", "", 1).split("?")[0]
    signature = hashlib.md5(f"{b64_payload}&{clean_path}".encode()).hexdigest()

    return f"Bearer COSY.{b64_payload}.{signature}", encrypted_key

# 2. Generate Signature (for anonymous endpoints)
def generate_signature(method, path, request_id, machine_token, body, version="0.1.47"):
    secret_key = hashlib.sha256(f"cosy:{version}:{machine_token}".encode()).hexdigest()
    body_hash = hashlib.sha256(body.encode() if isinstance(body, str) else body).hexdigest()
    timestamp = str(int(time.time()))
    sign_string = f"{method}\n{path}\n{request_id}\n{machine_token}\n{timestamp}\n{body_hash}"
    import hmac
    signature = hmac.new(secret_key.encode(), sign_string.encode(), hashlib.sha256).hexdigest()
    return signature, timestamp
```

### Tantangan untuk Proxy

| Challenge | Difficulty | Solution |
|-----------|:----------:|----------|
| Bearer token generation | ✅ Easy | Algorithm fully known |
| Signature generation | ✅ Easy | HMAC-SHA256, secret = "cosy" |
| Request body encryption | ⚠️ Medium | Need to reverse custom encoding |
| Response parsing | ✅ Easy | SSE plaintext, OpenAI-compatible |
| Model selection | ✅ Easy | Just set `X-Model-Key` header |
| Rate limiting | ❓ Unknown | Server may enforce per-user limits |
| Token refresh | ✅ Easy | machineToken doesn't expire |

### Biggest Blocker: Request Body Encryption

Request body ke inference endpoint di-encrypt. Opsi:

1. **Reverse custom encoding** — perlu analisis lebih dalam
2. **Relay via qodercli binary** — spawn process, paling mudah
3. **Use IDE's JS code** — run Node.js dengan extracted encryption code
4. **MITM approach** — proxy yang swap headers tapi let client handle encryption

---

## 12. Limitasi & Catatan <a name="limitasi"></a>

### Security Findings

1. **Secret hardcoded** — `"cosy"` di-obfuscate tapi trivial to extract
2. **RSA-1024** — considered weak by modern standards
3. **MD5 signature** — collision-prone, not cryptographically secure
4. **IV = Key** — AES-CBC with IV equal to key is a known weakness
5. **machineToken never expires** — no rotation mechanism
6. **No per-model access control** — server accepts any model key
7. **Supabase credentials hardcoded** — in IDE extension source

### Rate Limits

- Free tier: `isQuotaExceeded: true` setelah beberapa request
- Quota reset: `nextResetAt` timestamp (monthly)
- Hidden models: no apparent rate limiting (tested)

### Known Limitations

- Body encryption belum fully reversed (custom encoding, bukan standard base64)
- BYOK flow belum ditest end-to-end
- Quest mode dan Experts mode belum di-explore
- Image generation endpoint belum ditest
- WebSocket connections (jika ada) belum di-investigate

### Version History

| Date | Event |
|------|-------|
| 2026-04-23 | Initial reverse engineering |
| 2026-04-23 | Auth algorithm extracted from IDE JS |
| 2026-04-23 | Hidden models discovered and verified |
| 2026-04-23 | mitmproxy traffic interception successful |

---

*Dokumen ini adalah hasil reverse engineering untuk tujuan edukasi dan interoperabilitas.
Semua trademark milik pemiliknya masing-masing.*
