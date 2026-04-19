export type ProviderFormat = "openai" | "anthropic" | "gemini";

export interface ProviderConfig {
  id: string;
  name: string;
  format: ProviderFormat;
  baseUrl: string;
  authType: "oauth" | "apikey";
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
  openai: {
    id: "openai",
    name: "OpenAI",
    format: "openai",
    baseUrl: "https://api.openai.com/v1/chat/completions",
    authType: "apikey",
  },
};
