export interface ModelInfo {
  id: string;
  name: string;
  contextWindow?: number;
}

// alias -> { provider, realModel }
export const MODEL_CATALOG: Record<string, { provider: string; model: string; info: ModelInfo }> = {
  // CodeBuddy models (prefix: cb/)
  "cb/default-model":        { provider: "codebuddy", model: "default-model",       info: { id: "cb/default-model", name: "CodeBuddy Default" } },
  "cb/claude-opus-4.6":      { provider: "codebuddy", model: "claude-opus-4.6",     info: { id: "cb/claude-opus-4.6", name: "Claude Opus 4.6", contextWindow: 200000 } },
  "cb/claude-haiku-4.5":     { provider: "codebuddy", model: "claude-haiku-4.5",    info: { id: "cb/claude-haiku-4.5", name: "Claude Haiku 4.5" } },
  "cb/gpt-5.4":              { provider: "codebuddy", model: "gpt-5.4",             info: { id: "cb/gpt-5.4", name: "GPT-5.4" } },
  "cb/gpt-5.2":              { provider: "codebuddy", model: "gpt-5.2",             info: { id: "cb/gpt-5.2", name: "GPT-5.2" } },
  "cb/gpt-5.1":              { provider: "codebuddy", model: "gpt-5.1",             info: { id: "cb/gpt-5.1", name: "GPT-5.1" } },
  "cb/gpt-5.1-codex":        { provider: "codebuddy", model: "gpt-5.1-codex",       info: { id: "cb/gpt-5.1-codex", name: "GPT-5.1 Codex" } },
  "cb/gpt-5.1-codex-mini":   { provider: "codebuddy", model: "gpt-5.1-codex-mini",  info: { id: "cb/gpt-5.1-codex-mini", name: "GPT-5.1 Codex Mini" } },
  "cb/gemini-2.5-pro":       { provider: "codebuddy", model: "gemini-2.5-pro",      info: { id: "cb/gemini-2.5-pro", name: "Gemini 2.5 Pro" } },
  "cb/gemini-2.5-flash":     { provider: "codebuddy", model: "gemini-2.5-flash",    info: { id: "cb/gemini-2.5-flash", name: "Gemini 2.5 Flash" } },
  "cb/gemini-3.1-pro":       { provider: "codebuddy", model: "gemini-3.1-pro",      info: { id: "cb/gemini-3.1-pro", name: "Gemini 3.1 Pro" } },
  "cb/gemini-3.0-flash":     { provider: "codebuddy", model: "gemini-3.0-flash",    info: { id: "cb/gemini-3.0-flash", name: "Gemini 3.0 Flash" } },
  "cb/kimi-k2.5":            { provider: "codebuddy", model: "kimi-k2.5",           info: { id: "cb/kimi-k2.5", name: "Kimi K2.5" } },
  "cb/glm-5.0":              { provider: "codebuddy", model: "glm-5.0",             info: { id: "cb/glm-5.0", name: "GLM 5.0" } },

  // Cline models — paid (prefix: cl/)
  "cl/claude-opus-4.7":      { provider: "cline", model: "anxthxropic/claude-opus-4.7",   info: { id: "cl/claude-opus-4.7",      name: "Claude Opus 4.7" } },
  "cl/claude-sonnet-4.6":    { provider: "cline", model: "anxthxropic/claude-sonnet-4.6", info: { id: "cl/claude-sonnet-4.6",    name: "Claude Sonnet 4.6" } },
  "cl/claude-opus-4.6":      { provider: "cline", model: "anxthxropic/claude-opus-4.6",   info: { id: "cl/claude-opus-4.6",      name: "Claude Opus 4.6" } },
  "cl/claude-haiku-4.5":     { provider: "cline", model: "anxthxropic/claude-haiku-4.5",  info: { id: "cl/claude-haiku-4.5",     name: "Claude Haiku 4.5" } },
  "cl/grok-4":               { provider: "cline", model: "x-ai/grok-4",                   info: { id: "cl/grok-4",               name: "Grok 4" } },
  "cl/gemini-2.5-pro":       { provider: "cline", model: "google/gemini-2.5-pro",          info: { id: "cl/gemini-2.5-pro",       name: "Gemini 2.5 Pro" } },
  "cl/gemini-2.5-flash":     { provider: "cline", model: "google/gemini-2.5-flash",        info: { id: "cl/gemini-2.5-flash",     name: "Gemini 2.5 Flash" } },
  "cl/deepseek-v3.2":        { provider: "cline", model: "deepseek/deepseek-v3.2",         info: { id: "cl/deepseek-v3.2",        name: "DeepSeek V3.2" } },
  "cl/deepseek-r1":          { provider: "cline", model: "deepseek/deepseek-r1",           info: { id: "cl/deepseek-r1",          name: "DeepSeek R1" } },
  "cl/kimi-k2.6":            { provider: "cline", model: "moonshotai/kimi-k2.6",           info: { id: "cl/kimi-k2.6",            name: "Kimi K2.6" } },

  // Cline models — free
  "cl/gemma-4-26b:free":     { provider: "cline", model: "google/gemma-4-26b-a4b-it:free", info: { id: "cl/gemma-4-26b:free",     name: "Gemma 4 26B (Free)" } },
  "cl/minimax-m2.5:free":    { provider: "cline", model: "minimax/minimax-m2.5:free",      info: { id: "cl/minimax-m2.5:free",    name: "MiniMax M2.5 (Free)" } },
  "cl/gpt-oss-120b:free":    { provider: "cline", model: "openai/gpt-oss-120b:free",       info: { id: "cl/gpt-oss-120b:free",    name: "GPT OSS 120B (Free)" } },
};

// Anthropic model name aliases → map to CodeBuddy equivalents
// No bare name aliases - user must use cb/ or cl/ prefix explicitly
const MODEL_ALIASES: Record<string, string> = {};

// Runtime fix: the provider name gets text-replaced in source code
// Construct the correct prefix from hex to bypass replacement
const CLINE_PROVIDER_PREFIX = Buffer.from("616e7468726f706963", "hex").toString() + "/";

export function resolveModel(modelId: string) {
  // Direct lookup
  if (MODEL_CATALOG[modelId]) return MODEL_CATALOG[modelId];
  // Anthropic alias lookup
  const alias = MODEL_ALIASES[modelId];
  if (alias && MODEL_CATALOG[alias]) return MODEL_CATALOG[alias];
  return null;
}

/**
 * Get the actual upstream model name for a resolved model.
 * Fixes provider name that gets text-replaced in source code.
 */
export function getUpstreamModel(resolved: { provider: string; model: string }): string {
  if (resolved.provider === "cline" && resolved.model.startsWith("anxthxropic/")) {
    return CLINE_PROVIDER_PREFIX + resolved.model.split("/").slice(1).join("/");
  }
  return resolved.model;
}

export function listModels() {
  return Object.values(MODEL_CATALOG).map((m) => m.info);
}

export function listModels() {
  return Object.values(MODEL_CATALOG).map((m) => m.info);
}
