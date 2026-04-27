export type ProviderFormat = "openai" | "anxthxropic" | "gemini" | "kiro" | "qoder" | "codex";

export interface ProviderConfig {
  id: string;
  name: string;
  format: ProviderFormat;
  baseUrl: string;
  authType: "oauth" | "apikey";
  authFormat?: "bearer" | "workos" | "kiro" | "x-api-key"; // default "bearer"
  headers?: Record<string, string>;
}

export const PROVIDERS: Record<string, ProviderConfig> = {
  codebuddy: {
    id: "codebuddy",
    name: "CodeBuddy",
    format: "openai",
    baseUrl: "https://www.codebuddy.ai/v2/chat/completions",
    authType: "oauth",
    headers: {
      "X-Product": "codebuddy",
      "X-IDE-Type": "vscode",
      "X-IDE-Version": "1.96.0",
      "X-Plugin-Version": "2.91.0",
      "X-Codebuddy-Request": "1",
      "User-Agent": "codebuddy/2.91.0",
    },
  },
  cline: {
    id: "cline",
    name: "Cline",
    format: "openai",
    baseUrl: "https://api.cline.bot/api/v1/chat/completions",
    authType: "oauth",
    authFormat: "workos",
    headers: {
      "User-Agent": "Cline/3.79.0",
      "HTTP-Referer": "https://cline.bot",
      "X-Title": "Cline",
      "X-Platform": "Cline CLI - Node.js",
      "X-Client-Type": "CLI",
      "X-Core-Version": "3.79.0",
    },
  },
  kiro: {
    id: "kiro",
    name: "Kiro",
    format: "kiro",
    baseUrl: "https://codewhisperer.us-east-1.amazonaws.com/generateAssistantResponse",
    authType: "oauth",
    authFormat: "kiro",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/vnd.amazon.eventstream",
      "X-Amz-Target": "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
      "User-Agent": "AWS-SDK-JS/3.0 kiro-ide/1.0.0",
    },
  },
  qoder: {
    id: "qoder",
    name: "Qoder",
    format: "qoder",
    baseUrl: "https://api2.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation",
    authType: "oauth",
    authFormat: "bearer",  // Custom auth handled in handler.ts (Bearer COSY token)
    headers: {
      "User-Agent": "Go-http-client/2.0",
      "Accept": "text/event-stream",
      "Accept-Encoding": "identity",
      "Cache-Control": "no-cache",
    },
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    format: "openai",
    baseUrl: "https://api.openai.com/v1/chat/completions",
    authType: "apikey",
  },
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
  yepapi: {
    id: "yepapi",
    name: "YepAPI",
    format: "openai",
    baseUrl: "https://api.yepapi.com/v1/chat/completions",
    authType: "apikey",
    authFormat: "x-api-key",
  },
};
