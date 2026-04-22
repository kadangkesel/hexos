# Kiro CLI (Amazon Q Developer)

Hasil reverse engineering Kiro CLI v2.0.1 — arsitektur, auth, API endpoints.

## Overview

Kiro CLI adalah **Amazon Q Developer CLI** (rebranded). Binary native Rust, bukan Node.js.
Backend: AWS CodeWhisperer / Q Developer API.

- Binary: `~/.local/bin/kiro-cli` (117MB), `kiro-cli-chat` (396MB), `kiro-cli-term` (85MB)
- Data: `~/.local/share/kiro/data.sqlite3` (SQLite)
- Version: 2.0.1
- Source: closed-source (compiled Rust)

## Architecture

```
kiro-cli (Rust binary)
  -> AWS SSO OIDC (auth via Builder ID)
  -> AWS Q Developer API (https://q.us-east-1.amazonaws.com)
  -> AWS Cognito (telemetry identity)
  -> AWS CodeWhisperer streaming client
```

## Authentication

Kiro uses **AWS SSO Device Flow** (Builder ID - free, no credit card needed).

### Login Command

```bash
# Interactive (opens browser)
kiro-cli login --license free

# Device flow (for headless/VPS)
kiro-cli login --license free --use-device-flow

# Pro (IAM Identity Center)
kiro-cli login --license pro --identity-provider <url> --region <region>
```

### Device Flow Steps

1. Run `kiro-cli login --license free --use-device-flow`
2. CLI calls `SSO OIDC.StartDeviceAuthorization` at `oidc.us-east-1.amazonaws.com`
3. Returns verification URL + user code:
   ```
   Confirm the following code in the browser
   Open this URL: https://view.awsapps.com/start/#/device?user_code=XXXX-YYYY
   ```
4. Open URL in browser, enter code, login with AWS Builder ID (free signup)
5. CLI polls `SSO OIDC.CreateToken` every ~1 second until approved
6. Token stored in `~/.local/share/kiro/data.sqlite3`

Note: The URL goes to AWS (view.awsapps.com) — this is correct, Kiro IS Amazon Q Developer.

### Token Storage (SQLite)

```sql
SELECT key, value FROM auth_kv;
-- Keys: auth.idc.start-url, auth.idc.region, api.codewhisperer.profile
```

Token format: AWS SSO access token + refresh token (not JWT).

## API Endpoints

### Primary API

```
https://q.us-east-1.amazonaws.com
```

Operations (from binary strings analysis):
- `GenerateAssistantResponse` — main chat/agent API (streaming)
- `GenerateCompletions` — code completions
- `GenerateRecommendations` — code suggestions
- `ListAvailableModels` — model list
- `ListAvailableProfiles` — user profiles
- `ListAvailableCustomizations` — customizations
- `GetProfile` — user profile info
- `GetUsageLimits` — usage/quota info
- `CreateSubscriptionToken` — subscription management
- `SendTelemetryEvent` — telemetry

### Auth Endpoints

```
https://oidc.us-east-1.amazonaws.com                  — SSO OIDC
https://cognito-identity.us-east-1.amazonaws.com       — Cognito
https://client-telemetry.us-east-1.amazonaws.com       — Telemetry
```

### Regional Endpoints

```
https://q.us-east-1.amazonaws.com
https://q.eu-central-1.amazonaws.com
https://q.us-gov-east-1.amazonaws.com
https://q.us-gov-west-1.amazonaws.com
```

## Subscription Tiers (from binary)

```
QDeveloperStandaloneFree     — Free tier (monthly request limit)
QDeveloperStandalonePower    — Power tier
QDeveloperStandalonePro      — Pro tier
QDeveloperStandaloneProPlus  — Pro Plus tier
```

## CLI Commands

```bash
kiro-cli chat              # AI assistant in terminal
kiro-cli agent             # Manage AI agents
kiro-cli login             # Login
kiro-cli logout            # Logout
kiro-cli whoami            # Current user info
kiro-cli settings          # Customize
kiro-cli mcp               # MCP server management
kiro-cli acp               # Agent Client Protocol mode
kiro-cli doctor            # Diagnose issues
kiro-cli update            # Check for updates
kiro-cli translate         # Natural language to shell
kiro-cli inline            # Inline shell completions
kiro-cli knowledge         # Knowledge base management
```

### ACP Mode

```bash
kiro-cli acp --agent AGENT --model MODEL --trust-all-tools
```

Supports Agent Client Protocol (same as Cline).

## Tools (from binary analysis)

- File: Create, StrReplace, Insert, Append
- Code: search_symbols, find_references, goto_definition, rename_symbol, get_diagnostics
- Workspace: initialize_workspace, pattern_search, pattern_rewrite
- Codebase: generate_codebase_overview, search_codebase_map
- Task: create/update task list, context management
- Multi-agent: spawn_session, send_message, list_sessions, manage_group
- Knowledge: add, remove, update, clear, search
- Web: WebFetch
- MCP: full MCP integration

## Key Differences from Cline

| Feature | Kiro CLI | Cline CLI |
|---------|----------|-----------|
| Language | Rust (native binary) | TypeScript (Node.js) |
| Auth | AWS SSO / Builder ID | WorkOS OAuth |
| Backend | AWS Q Developer API | OpenRouter (via Cline proxy) |
| Protocol | AWS Smithy/Sigv4 | OpenAI-compatible |
| Data storage | SQLite | JSON + Protobuf |
| Model access | AWS-hosted models | 343+ OpenRouter models |
| Free tier | Monthly request limit | Credit-based |
| Intercept | Hard (AWS Sigv4 signed) | Easy (OpenAI format) |

## Pitfalls

1. Kiro IS Amazon Q Developer CLI — auth goes through AWS, not kiro.dev
2. Device flow URL/code hidden behind spinner — use `-vvv` to see it
3. API requests are AWS Sigv4 signed — harder to intercept/proxy than Cline
4. SQLite database for token storage — not plain text files
5. Free tier has monthly request limits, not credit-based
6. Binary is large: kiro-cli-chat alone is 396MB
