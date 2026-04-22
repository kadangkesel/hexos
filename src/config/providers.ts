export type ProviderFormat = "openai" | "anxthxropic" | "gemini" | "kiro";

export interface ProviderConfig {
  id: string;
  name: string;
  format: ProviderFormat;
  baseUrl: string;
  authType: "oauth" | "apikey";
  authFormat?: "bearer" | "workos" | "kiro"; // default "bearer"
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
  openai: {
    id: "openai",
    name: "OpenAI",
    format: "openai",
    baseUrl: "https://api.openai.com/v1/chat/completions",
    authType: "apikey",
  },
};
