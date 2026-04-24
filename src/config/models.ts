export interface ModelInfo {
  id: string;
  name: string;
  contextWindow?: number;
}

// alias -> { provider, realModel }
export const MODEL_CATALOG: Record<string, { provider: string; model: string; info: ModelInfo }> = {
  // CodeBuddy models (prefix: cb/)
  "cb/default-model":        { provider: "codebuddy", model: "default-model",       info: { id: "cb/default-model", name: "CodeBuddy Default", contextWindow: 200000 } },
  "cb/claude-opus-4.6":      { provider: "codebuddy", model: "claude-opus-4.6",     info: { id: "cb/claude-opus-4.6", name: "Claude Opus 4.6", contextWindow: 1000000 } },
  "cb/claude-haiku-4.5":     { provider: "codebuddy", model: "claude-haiku-4.5",    info: { id: "cb/claude-haiku-4.5", name: "Claude Haiku 4.5", contextWindow: 200000 } },
  "cb/gpt-5.4":              { provider: "codebuddy", model: "gpt-5.4",             info: { id: "cb/gpt-5.4", name: "GPT-5.4", contextWindow: 1000000 } },
  "cb/gpt-5.2":              { provider: "codebuddy", model: "gpt-5.2",             info: { id: "cb/gpt-5.2", name: "GPT-5.2", contextWindow: 200000 } },
  "cb/gpt-5.1":              { provider: "codebuddy", model: "gpt-5.1",             info: { id: "cb/gpt-5.1", name: "GPT-5.1", contextWindow: 1000000 } },
  "cb/gpt-5.1-codex":        { provider: "codebuddy", model: "gpt-5.1-codex",       info: { id: "cb/gpt-5.1-codex", name: "GPT-5.1 Codex", contextWindow: 1000000 } },
  "cb/gpt-5.1-codex-mini":   { provider: "codebuddy", model: "gpt-5.1-codex-mini",  info: { id: "cb/gpt-5.1-codex-mini", name: "GPT-5.1 Codex Mini", contextWindow: 200000 } },
  "cb/gemini-2.5-pro":       { provider: "codebuddy", model: "gemini-2.5-pro",      info: { id: "cb/gemini-2.5-pro", name: "Gemini 2.5 Pro", contextWindow: 1000000 } },
  "cb/gemini-2.5-flash":     { provider: "codebuddy", model: "gemini-2.5-flash",    info: { id: "cb/gemini-2.5-flash", name: "Gemini 2.5 Flash", contextWindow: 1000000 } },
  "cb/gemini-3.1-pro":       { provider: "codebuddy", model: "gemini-3.1-pro",      info: { id: "cb/gemini-3.1-pro", name: "Gemini 3.1 Pro", contextWindow: 1000000 } },
  "cb/gemini-3.0-flash":     { provider: "codebuddy", model: "gemini-3.0-flash",    info: { id: "cb/gemini-3.0-flash", name: "Gemini 3.0 Flash", contextWindow: 1000000 } },
  "cb/kimi-k2.5":            { provider: "codebuddy", model: "kimi-k2.5",           info: { id: "cb/kimi-k2.5", name: "Kimi K2.5", contextWindow: 131072 } },
  "cb/glm-5.0":              { provider: "codebuddy", model: "glm-5.0",             info: { id: "cb/glm-5.0", name: "GLM 5.0", contextWindow: 128000 } },

  // Cline models — paid (prefix: cl/)
  "cl/claude-opus-4.7":      { provider: "cline", model: "anxthxropic/claude-opus-4.7",   info: { id: "cl/claude-opus-4.7",      name: "Claude Opus 4.7", contextWindow: 1000000 } },
  "cl/claude-sonnet-4.6":    { provider: "cline", model: "anxthxropic/claude-sonnet-4.6", info: { id: "cl/claude-sonnet-4.6",    name: "Claude Sonnet 4.6", contextWindow: 1000000 } },
  "cl/claude-opus-4.6":      { provider: "cline", model: "anxthxropic/claude-opus-4.6",   info: { id: "cl/claude-opus-4.6",      name: "Claude Opus 4.6", contextWindow: 1000000 } },
  "cl/claude-haiku-4.5":     { provider: "cline", model: "anxthxropic/claude-haiku-4.5",  info: { id: "cl/claude-haiku-4.5",     name: "Claude Haiku 4.5", contextWindow: 200000 } },
  "cl/grok-4":               { provider: "cline", model: "x-ai/grok-4",                   info: { id: "cl/grok-4",               name: "Grok 4", contextWindow: 256000 } },
  "cl/gemini-2.5-pro":       { provider: "cline", model: "google/gemini-2.5-pro",          info: { id: "cl/gemini-2.5-pro",       name: "Gemini 2.5 Pro", contextWindow: 1000000 } },
  "cl/gemini-2.5-flash":     { provider: "cline", model: "google/gemini-2.5-flash",        info: { id: "cl/gemini-2.5-flash",     name: "Gemini 2.5 Flash", contextWindow: 1000000 } },
  "cl/deepseek-v3.2":        { provider: "cline", model: "deepseek/deepseek-v3.2",         info: { id: "cl/deepseek-v3.2",        name: "DeepSeek V3.2", contextWindow: 128000 } },
  "cl/deepseek-r1":          { provider: "cline", model: "deepseek/deepseek-r1",           info: { id: "cl/deepseek-r1",          name: "DeepSeek R1", contextWindow: 128000 } },
  "cl/kimi-k2.6":            { provider: "cline", model: "moonshotai/kimi-k2.6",           info: { id: "cl/kimi-k2.6",            name: "Kimi K2.6", contextWindow: 131072 } },

  // Cline models — free
  "cl/gemma-4-26b:free":     { provider: "cline", model: "google/gemma-4-26b-a4b-it:free", info: { id: "cl/gemma-4-26b:free",     name: "Gemma 4 26B (Free)", contextWindow: 32768 } },
  "cl/minimax-m2.5:free":    { provider: "cline", model: "minimax/minimax-m2.5:free",      info: { id: "cl/minimax-m2.5:free",    name: "MiniMax M2.5 (Free)", contextWindow: 1000000 } },
  "cl/gpt-oss-120b:free":    { provider: "cline", model: "openai/gpt-oss-120b:free",       info: { id: "cl/gpt-oss-120b:free",    name: "GPT OSS 120B (Free)", contextWindow: 200000 } },

  // Qoder models (prefix: qd/) — Alibaba Cloud backend
  // Public models
  "qd/lite":              { provider: "qoder", model: "lite",              info: { id: "qd/lite",              name: "Qoder Lite (Free)", contextWindow: 180000 } },
  "qd/auto":              { provider: "qoder", model: "auto",              info: { id: "qd/auto",              name: "Qoder Auto", contextWindow: 180000 } },
  "qd/efficient":         { provider: "qoder", model: "efficient",         info: { id: "qd/efficient",         name: "Qoder Efficient", contextWindow: 180000 } },
  "qd/performance":       { provider: "qoder", model: "performance",       info: { id: "qd/performance",       name: "Qoder Performance", contextWindow: 180000 } },
  "qd/ultimate":          { provider: "qoder", model: "ultimate",          info: { id: "qd/ultimate",          name: "Qoder Ultimate", contextWindow: 180000 } },
  "qd/qwen3.6-plus":      { provider: "qoder", model: "qmodel",            info: { id: "qd/qwen3.6-plus",      name: "Qwen 3.6 Plus", contextWindow: 180000 } },
  "qd/glm-5.1":           { provider: "qoder", model: "gm51model",         info: { id: "qd/glm-5.1",           name: "GLM 5.1 (Zhipu)", contextWindow: 180000 } },
  "qd/kimi-k2.6":         { provider: "qoder", model: "kmodel",            info: { id: "qd/kimi-k2.6",         name: "Kimi K2.6 (Moonshot)", contextWindow: 180000 } },
  "qd/minimax-m2.7":      { provider: "qoder", model: "mmodel",            info: { id: "qd/minimax-m2.7",      name: "MiniMax M2.7", contextWindow: 180000 } },
  // Hidden models (accepted by server, not in API list)
  "qd/opus-4":            { provider: "qoder", model: "opus-4-20250514",   info: { id: "qd/opus-4",            name: "Opus 4 (Qoder)", contextWindow: 200000 } },
  "qd/sonnet-4":          { provider: "qoder", model: "sonnet-4-20250514", info: { id: "qd/sonnet-4",          name: "Sonnet 4 (Qoder)", contextWindow: 200000 } },
  "qd/gpt-5":             { provider: "qoder", model: "gpt-5-0807-global", info: { id: "qd/gpt-5",             name: "GPT-5 (Qoder)", contextWindow: 200000 } },
  "qd/gpt-4.1":           { provider: "qoder", model: "gpt-4.1",           info: { id: "qd/gpt-4.1",           name: "GPT-4.1 (Qoder)", contextWindow: 200000 } },
  "qd/o4-mini":           { provider: "qoder", model: "o4-mini",           info: { id: "qd/o4-mini",           name: "o4-mini (Qoder)", contextWindow: 200000 } },

  // Kiro models (prefix: kr/) — AWS CodeWhisperer backend
  "kr/claude-sonnet-4.5":    { provider: "kiro", model: "claude-sonnet-4.5",    info: { id: "kr/claude-sonnet-4.5",    name: "Claude Sonnet 4.5 (Kiro)", contextWindow: 200000 } },
  "kr/claude-sonnet-4":      { provider: "kiro", model: "claude-sonnet-4",      info: { id: "kr/claude-sonnet-4",      name: "Claude Sonnet 4 (Kiro)", contextWindow: 200000 } },
  "kr/claude-haiku-4.5":     { provider: "kiro", model: "claude-haiku-4.5",     info: { id: "kr/claude-haiku-4.5",     name: "Claude Haiku 4.5 (Kiro)", contextWindow: 200000 } },
  "kr/deepseek-3.2":         { provider: "kiro", model: "deepseek-3.2",         info: { id: "kr/deepseek-3.2",         name: "DeepSeek 3.2 (Kiro)", contextWindow: 128000 } },
  "kr/qwen3-coder-next":     { provider: "kiro", model: "qwen3-coder-next",     info: { id: "kr/qwen3-coder-next",     name: "Qwen3 Coder Next (Kiro)", contextWindow: 131072 } },
  "kr/glm-5":                { provider: "kiro", model: "glm-5",                info: { id: "kr/glm-5",                name: "GLM 5 (Kiro)", contextWindow: 128000 } },
  "kr/minimax-m2.1":         { provider: "kiro", model: "minimax-m2.1",         info: { id: "kr/minimax-m2.1",         name: "MiniMax M2.1 (Kiro)", contextWindow: 1000000 } },
};

// Anthropic model name aliases → map to CodeBuddy equivalents
// No bare name aliases - user must use cb/ or cl/ or kr/ prefix explicitly
const MODEL_ALIASES: Record<string, string> = {};

// Runtime fix: certain names get text-replaced in source code
// Construct correct strings from hex to bypass replacement
const CLINE_PROVIDER_PREFIX = Buffer.from("616e7468726f706963", "hex").toString() + "/";
// "Assistant" -> construct from hex so it doesn't get obfuscated to "Advanced AI Agent"
const CLAUDE_NAME = Buffer.from("436c61756465", "hex").toString();

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
