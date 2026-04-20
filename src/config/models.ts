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
};

// Anthropic model name aliases → map to CodeBuddy equivalents
const ANTHROPIC_ALIASES: Record<string, string> = {
  // Opus variants
  "claude-opus-4-5":              "cb/claude-opus-4.6",
  "claude-opus-4-5-20251101":     "cb/claude-opus-4.6",
  "claude-opus-4":                "cb/claude-opus-4.6",
  "claude-opus-4-0":              "cb/claude-opus-4.6",
  "claude-opus-4-6":              "cb/claude-opus-4.6",
  "claude-opus-4-6-20260101":     "cb/claude-opus-4.6",
  "claude-opus-4.5":              "cb/claude-opus-4.6",
  "claude-opus-4.6":              "cb/claude-opus-4.6",
  "claude-3-opus-20240229":       "cb/claude-opus-4.6",
  "claude-3-5-sonnet-20241022":   "cb/claude-opus-4.6",
  "claude-3-7-sonnet-20250219":   "cb/claude-opus-4.6",
  "claude-sonnet-4-5":            "cb/claude-opus-4.6",
  "claude-sonnet-4-5-20251101":   "cb/claude-opus-4.6",
  "claude-sonnet-4":              "cb/claude-opus-4.6",
  "claude-sonnet-4-6":            "cb/claude-opus-4.6",
  "claude-sonnet-4-6-20260101":   "cb/claude-opus-4.6",
  // Haiku variants
  "claude-haiku-4-5":             "cb/claude-haiku-4.5",
  "claude-haiku-4-5-20251101":    "cb/claude-haiku-4.5",
  "claude-haiku-4":               "cb/claude-haiku-4.5",
  "claude-3-haiku-20240307":      "cb/claude-haiku-4.5",
  "claude-haiku-4.5":             "cb/claude-haiku-4.5",
};

export function resolveModel(modelId: string) {
  // Direct lookup
  if (MODEL_CATALOG[modelId]) return MODEL_CATALOG[modelId];
  // Anthropic alias lookup
  const alias = ANTHROPIC_ALIASES[modelId];
  if (alias && MODEL_CATALOG[alias]) return MODEL_CATALOG[alias];
  return null;
}

export function listModels() {
  return Object.values(MODEL_CATALOG).map((m) => m.info);
}
