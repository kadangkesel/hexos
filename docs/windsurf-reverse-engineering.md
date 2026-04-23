# Windsurf Cascade AI — Reverse Engineering Documentation

## Daftar Isi

1. [Overview](#overview)
2. [Arsitektur Windsurf](#arsitektur)
3. [Komponen Utama](#komponen)
4. [Authentication Flow](#auth)
5. [Protocol & Encoding](#protocol)
6. [Protobuf Schema](#schema)
7. [Endpoint Reference](#endpoints)
8. [Model yang Tersedia](#models)
9. [Cara Pakai: Dengan IDE](#dengan-ide)
10. [Cara Pakai: Standalone (Tanpa IDE)](#standalone)
11. [Cara Pakai: Direct Remote API](#remote-api)
12. [Limitasi & Catatan](#limitasi)

---

## 1. Overview <a name="overview"></a>

Windsurf adalah fork VSCode oleh Codeium yang menambahkan fitur AI "Cascade" 
untuk chat, code generation, dan agentic coding. Dokumen ini mendokumentasikan 
hasil reverse engineering terhadap internal API Windsurf, termasuk cara mengakses 
Cascade AI tanpa GUI IDE.

### Apa yang Berhasil

- Dekripsi API key dari database terenkripsi (AES-GCM + Windows DPAPI)
- Ekstrak CSRF token dari process memory
- Reverse-engineer protobuf schema dari extension.js (9.5MB)
- Kirim prompt dan terima response dari 9+ model AI
- Jalankan language server standalone tanpa IDE
- Identifikasi remote API endpoints di server.codeium.com

---

## 2. Arsitektur Windsurf <a name="arsitektur"></a>

```
┌─────────────────────────────────────────────────────────┐
│                    WINDSURF IDE (GUI)                     │
│                                                           │
│  ┌──────────────┐    ┌──────────────────────────────┐    │
│  │  Editor UI   │    │  Extension Host (Node.js)     │    │
│  │  (Electron) │    │  ┌────────────────────────┐   │    │
│  │              │◄──►│  │ codeium.windsurf ext   │   │    │
│  └──────────────┘    │  │ (extension.js, 9.5MB)  │   │    │
│                      │  └───────────┬────────────┘   │    │
│                      └──────────────┼────────────────┘    │
└─────────────────────────────────────┼─────────────────────┘
                                      │ gRPC-web (localhost)
                                      ▼
┌─────────────────────────────────────────────────────────┐
│           CODEIUM LANGUAGE SERVER (Go binary)             │
│           language_server_windows_x64.exe (170MB)         │
│                                                           │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │ gRPC-web    │  │  Cascade     │  │  Code Index    │  │
│  │ Server      │  │  Orchestrator│  │  Service       │  │
│  │ (port rand) │  │              │  │                │  │
│  └──────┬──────┘  └──────┬───────┘  └────────────────┘  │
│         │                │                                │
│         │    ┌───────────┴───────────┐                   │
│         │    │  Auth & Session Mgmt  │                   │
│         │    │  (internal tokens)    │                   │
│         │    └───────────┬───────────┘                   │
└─────────┼────────────────┼───────────────────────────────┘
          │                │ connect-go (HTTPS, gRPC)
          │                ▼
┌─────────┼────────────────────────────────────────────────┐
│         │        CODEIUM CLOUD SERVERS                    │
│         │                                                 │
│  ┌──────┴──────────────────────────────────────────────┐ │
│  │  server.codeium.com / server.self-serve.windsurf.com│ │
│  │  - ApiServerService (GetChatMessage, GetCompletions)│ │
│  │  - SeatManagementService (auth, user status)        │ │
│  └─────────────────────────────────────────────────────┘ │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  inference.codeium.com                              │ │
│  │  - Model inference backend                          │ │
│  └─────────────────────────────────────────────────────┘ │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  register.windsurf.com                              │ │
│  │  - User registration, token exchange                │ │
│  └─────────────────────────────────────────────────────┘ │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  app.devin.ai (WebSocket)                           │ │
│  │  - Devin ACP agent connection                       │ │
│  └─────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
```

### Dua Jenis "Language Server"

| Aspek | VSCode LSP | Codeium Language Server |
|-------|-----------|------------------------|
| Fungsi | Code intelligence (autocomplete, lint, go-to-def) | AI chat, AI completion, Cascade |
| Protocol | JSON-RPC over stdio/TCP | gRPC-web (protobuf binary) |
| Contoh | pyright, gopls, tsserver | language_server_windows_x64.exe |
| Source | Open source | Closed source (Go binary) |
| AI | Tidak ada | Connect ke cloud Codeium |
| Ukuran | Kecil (MB) | 170MB |

---

## 3. Komponen Utama <a name="komponen"></a>

### 3.1 Extension (extension.js)

- Lokasi: `<Windsurf>/resources/app/extensions/windsurf/dist/extension.js`
- Ukuran: ~9.5MB (minified JavaScript)
- Berisi: protobuf definitions, UI logic, auth flow, API client code
- Semua protobuf schema bisa di-extract dari file ini

### 3.2 Language Server Binary

- Lokasi: `<Windsurf>/resources/app/extensions/windsurf/bin/language_server_windows_x64.exe`
- Ukuran: 170MB (Go binary, compiled)
- Fungsi: gRPC server lokal, Cascade orchestration, auth ke remote
- Port: Random (ditemukan via netstat)
- Dua port: satu untuk gRPC-web (utama), satu untuk chat client

### 3.3 State Database

- Lokasi: `%APPDATA%/Windsurf/User/globalStorage/state.vscdb`
- Format: SQLite3 dengan tabel `ItemTable` (key-value)
- Enkripsi: Secrets dienkripsi dengan AES-GCM
  - Master key dari Windows DPAPI (di `Local State` file)
  - Format: `v10` + 12-byte nonce + ciphertext

### 3.4 Devin ACP Agent

- Binary: `<Windsurf>/resources/app/extensions/windsurf/devin/bin/devin.exe`
- Fungsi: Summary agent, Devin cloud agent
- Koneksi: WebSocket ke `wss://app.devin.ai/api/acp/live`
- Auth: API key via ACP `authenticate` method

---

## 4. Authentication Flow <a name="auth"></a>

### 4.1 User Login

```
User → Browser OAuth → Firebase ID Token
  → POST register.windsurf.com/SeatManagementService/RegisterUser
    Request:  { firebaseIdToken: "<token>" }
    Response: { apiKey: "devin-session-token$<JWT>", name: "...", apiServerUrl: "..." }
```

### 4.2 API Key Format

```
devin-session-token$<JWT>

JWT Structure (HS256):
  Header:  { "alg": "HS256", "typ": "JWT" }
  Payload: {
    "api_key": "devin-synthetic-apikey$account-<id>$user-<id>",
    "auth_uid": "devin-auth-uid$account-<id>$user-<id>",
    "email": "user@example.com",
    "name": "User Name",
    "team_id": "devin-team$account-<id>",
    "team_status": "USER_TEAM_STATUS_APPROVED",
    "teams_tier": "TEAMS_TIER_DEVIN_FREE",
    "exp": <unix_timestamp>,
    "pro": false
  }
```

Total API key length: 189 characters (prefix 20 + JWT 169)

### 4.3 Token Storage

```
state.vscdb → ItemTable:
  Key:   secret://{"extensionId":"codeium.windsurf","key":"windsurf_auth.sessions"}
  Value: {"type":"Buffer","data":[...]}
         → v10 + nonce(12) + AES-GCM ciphertext
         → Decrypt with master key from DPAPI
         → JSON: [{"id":"<uuid>","accessToken":"devin-session-token$<JWT>",
                   "account":{"label":"name","id":"name"}}]
```

### 4.4 Master Key Extraction (Windows DPAPI)

```
File: %APPDATA%/Windsurf/Local State
  → JSON: {"os_crypt":{"encrypted_key":"<base64>"}}
  → Base64 decode → Remove "DPAPI" prefix (5 bytes)
  → Windows DPAPI ProtectedData.Unprotect()
  → 32-byte AES key
```

### 4.5 CSRF Token

- Dihasilkan oleh extension saat start language server
- Disimpan di environment variable `WINDSURF_CSRF_TOKEN` pada proses LS
- Dikirim di header `x-codeium-csrf-token` pada setiap request
- Bisa custom saat menjalankan LS standalone

### 4.6 Remote Server Auth

Language server binary punya auth internal ke remote server yang BERBEDA dari
API key user. Remote API yang bisa diakses TANPA auth header (api_key di protobuf body):

- SeatManagementService/GetUserStatus
- SeatManagementService/GetOneTimeAuthToken
- SeatManagementService/RegisterUser
- ApiServerService/Ping
- ApiServerService/GetStatus
- ApiServerService/GetCascadeModelConfigs

Remote API yang BUTUH auth internal (hanya via language server):
- ApiServerService/GetChatMessage
- ApiServerService/GetCompletions
- LanguageServerService/* (semua endpoint)

---

## 5. Protocol & Encoding <a name="protocol"></a>

### 5.1 Local Language Server (gRPC-web)

```
URL:     http://127.0.0.1:<port>/exa.language_server_pb.LanguageServerService/<method>
Headers:
  Content-Type: application/grpc-web+proto
  Accept: application/grpc-web+proto
  x-grpc-web: 1
  x-codeium-csrf-token: <csrf_token>

Request Body (gRPC-web frame):
  [0x00] [4-byte big-endian length] [protobuf message]

Response Body:
  [0x00] [4-byte length] [protobuf message]  ← data frame(s)
  [0x80] [4-byte length] [trailer text]       ← trailer frame
  
Trailer format: "grpc-status: 0\r\n" (0 = OK)
```

### 5.2 Remote Server (connect-go)

```
URL:     https://server.codeium.com/exa.api_server_pb.ApiServerService/<method>
Headers:
  Content-Type: application/proto          (unary)
  Content-Type: application/connect+proto  (streaming)
  Connect-Protocol-Version: 1
  User-Agent: connect-go/1.18.1 (go1.26.1)

Request Body:
  Unary:     raw protobuf bytes (no framing)
  Streaming: [0x00] [4-byte length] [protobuf message]

Response Body:
  Unary:     raw protobuf bytes
  Streaming: [flags] [4-byte length] [protobuf message] ...
  Error:     JSON {"error":{"code":"...","message":"..."}}
```

### 5.3 Protobuf Encoding Helpers

```python
def encode_varint(v):
    """Encode unsigned integer as varint"""
    r = bytearray()
    while v > 127:
        r.append((v & 0x7F) | 0x80)
        v >>= 7
    r.append(v)
    return bytes(r)

def encode_string(field_num, value):
    """Encode string field: tag + length + utf8_bytes"""
    tag = encode_varint((field_num << 3) | 2)
    data = value.encode('utf-8')
    return tag + encode_varint(len(data)) + data

def encode_message(field_num, data):
    """Encode sub-message field: tag + length + message_bytes"""
    tag = encode_varint((field_num << 3) | 2)
    return tag + encode_varint(len(data)) + data

def encode_varint_field(field_num, value):
    """Encode varint field (int, enum, bool): tag + varint"""
    tag = encode_varint((field_num << 3) | 0)
    return tag + encode_varint(value)
```

---

## 6. Protobuf Schema <a name="schema"></a>

### 6.1 Metadata (exa.codeium_common_pb.Metadata)

| Field # | Name | Type | Contoh |
|---------|------|------|--------|
| 1 | ide_name | string | "windsurf" |
| 2 | extension_version | string | "1.48.2" |
| 3 | api_key | string | "devin-session-token$..." |
| 4 | locale | string | "en-US" |
| 5 | os | string | "windows" / "linux" |
| 7 | ide_version | string | "2.0.67" |
| 8 | hardware | string | |
| 10 | session_id | string | |
| 12 | extension_name | string | "windsurf" |
| 20 | user_id | string | |
| 28 | ide_type | string | |

### 6.2 ChatMessage (exa.chat_pb.ChatMessage)

| Field # | Name | Type | Notes |
|---------|------|------|-------|
| 1 | message_id | string | UUID |
| 2 | source | enum ChatMessageSource | 1=USER, 2=SYSTEM |
| 3 | timestamp | google.protobuf.Timestamp | field 1=seconds |
| 4 | conversation_id | string | = cascade_id |
| 5 | intent | ChatMessageIntent | oneof "content" |
| 6 | action | ChatMessageAction | oneof "content" |
| 9 | in_progress | bool | |

### 6.3 StartCascadeRequest

| Field # | Name | Type |
|---------|------|------|
| 1 | metadata | Metadata |
| 4 | source | enum CortexTrajectorySource |

### 6.4 StartCascadeResponse

| Field # | Name | Type |
|---------|------|------|
| 1 | cascade_id | string |

### 6.5 SendUserCascadeMessageRequest

| Field # | Name | Type |
|---------|------|------|
| 1 | cascade_id | string |
| 2 | items | repeated TextOrScopeItem |
| 3 | metadata | Metadata |
| 5 | cascade_config | CascadeConfig |
| 6 | images | repeated ImageData |
| 8 | blocking | bool |

### 6.6 InitializeCascadePanelStateRequest

| Field # | Name | Type |
|---------|------|------|
| 1 | metadata | Metadata |
| 3 | workspace_trusted | bool |

### 6.7 GetCascadeTranscriptForTrajectoryIdRequest

| Field # | Name | Type |
|---------|------|------|
| 1 | cascade_id | string |
| 2 | step_offset | uint32 |

### 6.8 GetCascadeTranscriptForTrajectoryIdResponse

| Field # | Name | Type |
|---------|------|------|
| 1 | transcript | string |
| 2 | num_total_steps | uint32 |

### 6.9 ChatMessageSource (enum)

| Value | Name |
|-------|------|
| 0 | CHAT_MESSAGE_SOURCE_UNSPECIFIED |
| 1 | CHAT_MESSAGE_SOURCE_USER |
| 2 | CHAT_MESSAGE_SOURCE_SYSTEM |
| 3 | CHAT_MESSAGE_SOURCE_UNKNOWN |
| 4 | CHAT_MESSAGE_SOURCE_TOOL |
| 5 | CHAT_MESSAGE_SOURCE_SYSTEM_PROMPT |

---

## 7. Endpoint Reference <a name="endpoints"></a>

### 7.1 Local Language Server (LanguageServerService)

Base URL: `http://127.0.0.1:<port>/exa.language_server_pb.LanguageServerService/`

| Endpoint | Type | Auth | Deskripsi |
|----------|------|------|-----------|
| Heartbeat | Unary | CSRF | Keep-alive, return timestamp |
| GetStatus | Unary | CSRF+API | Status language server |
| GetUserStatus | Unary | CSRF+API | User info + semua model configs (39KB) |
| InitializeCascadePanelState | Unary | CSRF+API | Init Cascade panel (wajib sebelum chat) |
| StartCascade | Unary | CSRF+API | Buat cascade session, return cascade_id |
| SendUserCascadeMessage | Unary | CSRF+API | Kirim pesan ke Cascade AI |
| GetCascadeTranscriptForTrajectoryId | Unary | CSRF+API | Poll transcript (termasuk AI response) |
| GetCascadeTrajectorySteps | Unary | CSRF+API | Detail steps (termasuk error details) |
| RawGetChatMessage | ServerStream | CSRF+API | Direct chat (butuh valid cascade session) |
| GetCompletions | Unary | CSRF+API | Code autocomplete |
| GetCascadeModelConfigs | Unary | CSRF+API | Daftar model tersedia |

### 7.2 Remote API (ApiServerService)

Base URL: `https://server.codeium.com/exa.api_server_pb.ApiServerService/`

| Endpoint | Type | Auth | Status |
|----------|------|------|--------|
| Ping | Unary | None | OK |
| GetStatus | Unary | API in body | OK |
| GetUserStatus | Unary | API in body | OK (39KB) |
| GetCascadeModelConfigs | Unary | API in body | OK (37KB) |
| GetChatMessage | ServerStream | Internal | Error (permission/format) |
| GetCompletions | Unary | Internal | Error (needs proper request) |

### 7.3 Remote API (SeatManagementService)

Base URL: `https://server.codeium.com/exa.seat_management_pb.SeatManagementService/`

| Endpoint | Type | Auth | Status |
|----------|------|------|--------|
| GetUserStatus | Unary | API in body | OK |
| GetOneTimeAuthToken | Unary | API in body | OK (returns OTT) |
| RegisterUser | Unary | Firebase token | OK (returns API key) |
| GetSelfDevinSessionToken | Unary | X-Api-Key header | Error |

---

## 8. Model yang Tersedia <a name="models"></a>

### 8.1 Free Tier (Devin Free) — Berhasil Ditest

| Model UID | Nama | Provider | Status |
|-----------|------|----------|--------|
| swe-1-6-fast | SWE-1.6 Fast | Windsurf | ✅ Tercepat |
| swe-1-6 | SWE-1.6 | Windsurf | ✅ |
| glm-5-1 | GLM-5.1 | Zhipu AI | ✅ |
| kimi-k2-6 | Kimi K2.6 | Moonshot | ✅ (agak lambat) |
| glm-5 | GLM-5 | Zhipu AI | ✅ |
| minimax-m2-5 | Minimax M2.5 | Minimax | ✅ |
| MODEL_SWE_1_5 | SWE-1.5 Fast | Windsurf | ✅ |
| MODEL_SWE_1_5_SLOW | SWE-1.5 | Windsurf | ✅ |
| MODEL_GLM_4_7 | GLM 4.7 | Zhipu AI | ✅ |
| kimi-k2-5 | Kimi K2.5 | Moonshot | ⏳ Lambat |

### 8.2 Premium (Butuh Paid Plan) — Permission Denied

| Model UID | Nama | Provider |
|-----------|------|----------|
| claude-opus-4-7-medium | Claude Opus 4.7 Medium | Anthropic |
| claude-opus-4-6-thinking | Claude Opus 4.6 Thinking | Anthropic |
| claude-sonnet-4-6-thinking | Claude Sonnet 4.6 Thinking | Anthropic |
| gpt-5-4-low | GPT-5.4 Low Thinking | OpenAI |
| gpt-5-3-codex-medium | GPT-5.3-Codex Medium | OpenAI |
| MODEL_CLAUDE_4_5_OPUS | Claude Opus 4.5 | Anthropic |
| MODEL_PRIVATE_2 | Claude Sonnet 4.5 | Anthropic |
| MODEL_PRIVATE_11 | Claude Haiku 4.5 | Anthropic |
| MODEL_CHAT_GPT_4O_2024_08_06 | GPT-4o | OpenAI |
| MODEL_CHAT_O3 | o3 Medium | OpenAI |
| MODEL_CHAT_O3_HIGH | o3 High | OpenAI |
| MODEL_GPT_5_2_LOW | GPT-5.2 Low | OpenAI |
| MODEL_GOOGLE_GEMINI_2_5_PRO | Gemini 2.5 Pro | Google |
| MODEL_XAI_GROK_3 | xAI Grok-3 | xAI |

---

## 9. Cara Pakai: Dengan IDE <a name="dengan-ide"></a>

### Prerequisites

- Windsurf IDE berjalan di Windows PC
- SSH access ke PC (key-based auth)
- state.vscdb sudah di-copy ke VPS

### Step 1: Temukan Port Language Server

```bash
ssh user@windows-pc "netstat -ano | findstr language_server"
# Cari port LISTENING, misal 51184
```

### Step 2: Setup SSH Tunnel

```bash
ssh -f -N -L 51184:127.0.0.1:51184 user@windows-pc
```

### Step 3: Ekstrak CSRF Token

Dari Windows (PowerShell) - baca environment variable dari proses language server:
```powershell
Get-Process | Where-Object {$_.ProcessName -match "language_server"} | 
  ForEach-Object { 
    $csrf = [System.Diagnostics.Process]::GetProcessById($_.Id).MainModule.EnvironmentVariables["WINDSURF_CSRF_TOKEN"]
    Write-Host "CSRF: $csrf"
  }
```

### Step 4: Kirim Chat

```python
import requests, json, time

API_KEY = "devin-session-token$eyJ..."  # dari state.vscdb
CSRF = "bdbd801e-3915-4e47-83ca-99f7e404ea38"
PORT = 51184  # dari netstat

def encode_varint(v):
    r = bytearray()
    while v > 127:
        r.append((v & 0x7F) | 0x80)
        v >>= 7
    r.append(v)
    return bytes(r)

def encode_string_field(num, val):
    tag = encode_varint((num << 3) | 2)
    data = val.encode('utf-8')
    return tag + encode_varint(len(data)) + data

def encode_message_field(num, data):
    tag = encode_varint((num << 3) | 2)
    return tag + encode_varint(len(data)) + data

def grpc_call(method, body):
    url = f"http://127.0.0.1:{PORT}/exa.language_server_pb.LanguageServerService/{method}"
    frame = bytes([0x00]) + encode_varint(len(body)) + body
    r = requests.post(url, data=frame, headers={
        "Content-Type": "application/grpc-web+proto",
        "Accept": "application/grpc-web+proto",
        "x-grpc-web": "1",
        "x-codeium-csrf-token": CSRF,
    })
    # Parse gRPC-web response (skip frame byte + length, extract payload)
    data = r.content[5:]  # skip [0x00][len]
    trailer = r.content[-50:].decode('utf-8', errors='ignore')
    return data

# Build metadata
meta = (
    encode_string_field(1, "windsurf") +
    encode_string_field(2, "1.48.2") +
    encode_string_field(3, API_KEY) +
    encode_string_field(5, "windows") +
    encode_string_field(7, "2.0.67")
)

# 1. Initialize
grpc_call("InitializeCascadePanelState", encode_message_field(1, meta) + bytes([8, 1]))

# 2. StartCascade → cascade_id
resp = grpc_call("StartCascade", encode_message_field(1, meta) + bytes([32, 1]))
cascade_id = resp.decode('utf-8', errors='ignore').split('\"')[1]  # parse from response

# 3. SendUserCascadeMessage
model = "swe-1-6-fast"
planner = encode_message_field(2, b"") + encode_string_field(34, model) + encode_string_field(35, model)
config = encode_message_field(1, planner)
text = encode_string_field(1, "What is the capital of France?")

grpc_call("SendUserCascadeMessage",
    encode_string_field(1, cascade_id) +
    encode_message_field(2, text) +
    encode_message_field(3, meta) +
    encode_message_field(5, config))

# 4. Poll transcript
time.sleep(8)
resp = grpc_call("GetCascadeTranscriptForTrajectoryId",
    encode_string_field(1, cascade_id) + encode_varint(2) + encode_varint(0))
transcript = resp.decode('utf-8', errors='ignore')
# AI response ada di "=== MESSAGE 2 - Assistant ===" section
print(transcript)
```

---

## 10. Cara Pakai: Standalone (Tanpa IDE) <a name="standalone"></a>

### Step 1: Start Language Server

Di Windows (PowerShell):

```powershell
$env:WINDSURF_CSRF_TOKEN = "my-custom-token"

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = "C:\...\language_server_windows_x64.exe"
$psi.Arguments = @(
    "--api_server_url", "https://server.self-serve.windsurf.com",
    "--run_child", "--enable_lsp", "--random_port",
    "--inference_api_server_url", "https://inference.codeium.com",
    "--database_dir", "$env:USERPROFILE\.codeium\windsurf\database\standalone",
    "--enable_index_service", "--enable_local_search",
    "--search_max_workspace_file_count", "5000",
    "--sentry_telemetry", "--sentry_environment", "stable",
    "--codeium_dir", ".codeium/windsurf",
    "--windsurf_version", "2.0.67",
    "--stdin_initial_metadata"
) -join " "
$psi.UseShellExecute = $false
$psi.RedirectStandardInput = $true

$proc = [System.Diagnostics.Process]::Start($psi)
$proc.StandardInput.Close()

Start-Sleep -Seconds 5
netstat -ano | findstr $proc.Id | findstr LISTENING
```

### Step 2: Chat via SSH Tunnel

Gunakan script Python yang sama di section 9, tapi dengan:
- Port dari netstat
- CSRF token yang kamu set di env var

---

## 11. Cara Pakai: Direct Remote API <a name="remote-api"></a>

Read-only endpoints bisa diakses langsung tanpa language server:

```python
import requests

headers = {
    "Content-Type": "application/proto",
    "Connect-Protocol-Version": "1",
}

# GetUserStatus (39KB - user info + all model configs)
resp = requests.post(
    "https://server.codeium.com/exa.api_server_pb.ApiServerService/GetUserStatus",
    headers=headers, data=meta_payload)

# GetCascadeModelConfigs (37KB - all available models)
resp = requests.post(
    "https://server.codeium.com/exa.api_server_pb.ApiServerService/GetCascadeModelConfigs",
    headers=headers, data=meta_payload)

# GetOneTimeAuthToken
resp = requests.post(
    "https://server.codeium.com/exa.seat_management_pb.SeatManagementService/GetOneTimeAuthToken",
    headers=headers, data=api_key_string)
```

Chat completion (GetChatMessage) TIDAK bisa - free tier return "internal error".

---

## 12. Limitasi & Catatan <a name="limitasi"></a>

### Limitasi

1. **Language server binary wajib** untuk chat — remote API tidak bisa dipakai
   langsung untuk inference pada free tier
2. **API key expiry** — JWT dalam api_key punya expiry ~15 menit
3. **Premium models** — Claude, GPT-5, GPT-4o, Gemini Pro, Grok return
   permission_denied pada free tier
4. **Windows only** — Binary hanya tersedia untuk Windows x64
5. **Port random** — Language server listen di port random setiap start

### Catatan Keamanan

- Master key DPAPI hanya bisa di-extract oleh user yang sama di Windows
- CSRF token mencegah cross-site request ke language server
- API key disimpan terenkripsi, bukan plaintext

### Transcript Format

```
=== MESSAGE 0 - Tool ===
[CORTEX_STEP_TYPE_RETRIEVE_MEMORY]

=== MESSAGE 1 - User ===
<user prompt>

=== MESSAGE 2 - Assistant ===
<AI response>

=== MESSAGE 3 - Tool ===
[CORTEX_STEP_TYPE_CHECKPOINT]
```

### Tested Environment

- Windsurf 2.0.67 (April 2026)
- Account: Devin Free tier (TEAMS_TIER_DEVIN_FREE)
- Windows 11, AMD64
- Language server binary: Go 1.26.1, connect-go 1.18.1
