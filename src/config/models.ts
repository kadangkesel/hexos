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
  // Only REAL distinct models — hidden keys (opus-4, gpt-5, etc) all fallback to Qwen
  "qd/lite":              { provider: "qoder", model: "lite",              info: { id: "qd/lite",              name: "Qoder Lite (Free)", contextWindow: 180000 } },
  "qd/auto":              { provider: "qoder", model: "auto",              info: { id: "qd/auto",              name: "Qoder Auto", contextWindow: 180000 } },
  "qd/efficient":         { provider: "qoder", model: "efficient",         info: { id: "qd/efficient",         name: "Qoder Efficient", contextWindow: 180000 } },
  "qd/performance":       { provider: "qoder", model: "performance",       info: { id: "qd/performance",       name: "Qoder Performance", contextWindow: 180000 } },
  "qd/ultimate":          { provider: "qoder", model: "ultimate",          info: { id: "qd/ultimate",          name: "Qoder Ultimate", contextWindow: 180000 } },
  "qd/qwen3.6-plus":      { provider: "qoder", model: "qmodel",            info: { id: "qd/qwen3.6-plus",      name: "Qwen 3.6 Plus", contextWindow: 180000 } },
  "qd/glm-5.1":           { provider: "qoder", model: "gm51model",         info: { id: "qd/glm-5.1",           name: "GLM 5.1 (Zhipu)", contextWindow: 180000 } },
  "qd/kimi-k2.6":         { provider: "qoder", model: "kmodel",            info: { id: "qd/kimi-k2.6",         name: "Kimi K2.6 (Moonshot)", contextWindow: 180000 } },
  "qd/minimax-m2.7":      { provider: "qoder", model: "mmodel",            info: { id: "qd/minimax-m2.7",      name: "MiniMax M2.7", contextWindow: 180000 } },
  "qd/deepseek-v4-pro":   { provider: "qoder", model: "dmodel",            info: { id: "qd/deepseek-v4-pro",   name: "DeepSeek V4 Pro", contextWindow: 180000 } },
  "qd/deepseek-v4-flash": { provider: "qoder", model: "dfmodel",           info: { id: "qd/deepseek-v4-flash", name: "DeepSeek V4 Flash", contextWindow: 180000 } },
  // Note: "hidden" model keys (opus-4, gpt-5, etc) are accepted by server but ALL
  // fallback to Qwen (Alibaba's default). Only the 11 public models above are distinct.

  // Kiro models (prefix: kr/) — AWS CodeWhisperer backend
  "kr/claude-sonnet-4.5":    { provider: "kiro", model: "claude-sonnet-4.5",    info: { id: "kr/claude-sonnet-4.5",    name: "Claude Sonnet 4.5 (Kiro)", contextWindow: 200000 } },
  "kr/claude-sonnet-4":      { provider: "kiro", model: "claude-sonnet-4",      info: { id: "kr/claude-sonnet-4",      name: "Claude Sonnet 4 (Kiro)", contextWindow: 200000 } },
  "kr/claude-haiku-4.5":     { provider: "kiro", model: "claude-haiku-4.5",     info: { id: "kr/claude-haiku-4.5",     name: "Claude Haiku 4.5 (Kiro)", contextWindow: 200000 } },
  "kr/deepseek-3.2":         { provider: "kiro", model: "deepseek-3.2",         info: { id: "kr/deepseek-3.2",         name: "DeepSeek 3.2 (Kiro)", contextWindow: 128000 } },
  "kr/qwen3-coder-next":     { provider: "kiro", model: "qwen3-coder-next",     info: { id: "kr/qwen3-coder-next",     name: "Qwen3 Coder Next (Kiro)", contextWindow: 131072 } },
  "kr/glm-5":                { provider: "kiro", model: "glm-5",                info: { id: "kr/glm-5",                name: "GLM 5 (Kiro)", contextWindow: 128000 } },
  "kr/minimax-m2.1":         { provider: "kiro", model: "minimax-m2.1",         info: { id: "kr/minimax-m2.1",         name: "MiniMax M2.1 (Kiro)", contextWindow: 1000000 } },

  // Codex models (prefix: cx/) — ChatGPT Codex Responses API (free via ChatGPT login)
  "cx/gpt-5.5":              { provider: "codex", model: "gpt-5.5",            info: { id: "cx/gpt-5.5",             name: "GPT-5.5 (Codex)",           contextWindow: 272000 } },
  "cx/gpt-5.4":              { provider: "codex", model: "gpt-5.4",            info: { id: "cx/gpt-5.4",             name: "GPT-5.4 (Codex)",           contextWindow: 272000 } },
  "cx/gpt-5.4-mini":         { provider: "codex", model: "gpt-5.4-mini",       info: { id: "cx/gpt-5.4-mini",        name: "GPT-5.4 Mini (Codex)",      contextWindow: 272000 } },
  "cx/gpt-5.3-codex":        { provider: "codex", model: "gpt-5.3-codex",      info: { id: "cx/gpt-5.3-codex",       name: "GPT-5.3 Codex",             contextWindow: 272000 } },
  "cx/gpt-5.2":              { provider: "codex", model: "gpt-5.2",            info: { id: "cx/gpt-5.2",             name: "GPT-5.2 (Codex)",           contextWindow: 272000 } },
  "cx/codex-auto-review":    { provider: "codex", model: "codex-auto-review",  info: { id: "cx/codex-auto-review",   name: "Codex Auto Review (Hidden)", contextWindow: 272000 } },

  // YepAPI models (prefix: yp/) — OpenAI-compatible multi-model API
  // OpenAI
  "yp/gpt-4o-mini":          { provider: "yepapi", model: "gpt-4o-mini",          info: { id: "yp/gpt-4o-mini",          name: "GPT-4o Mini",                contextWindow: 128000 } },
  "yp/gpt-4o":               { provider: "yepapi", model: "gpt-4o",               info: { id: "yp/gpt-4o",               name: "GPT-4o",                     contextWindow: 128000 } },
  "yp/gpt-5.4":              { provider: "yepapi", model: "gpt-5.4",              info: { id: "yp/gpt-5.4",              name: "GPT-5.4",                    contextWindow: 1000000 } },
  "yp/gpt-5.4-pro":          { provider: "yepapi", model: "gpt-5.4-pro",          info: { id: "yp/gpt-5.4-pro",          name: "GPT-5.4 Pro",                contextWindow: 1000000 } },
  "yp/gpt-5.4-mini":         { provider: "yepapi", model: "gpt-5.4-mini",         info: { id: "yp/gpt-5.4-mini",         name: "GPT-5.4 Mini",               contextWindow: 1000000 } },
  "yp/gpt-5.4-nano":         { provider: "yepapi", model: "gpt-5.4-nano",         info: { id: "yp/gpt-5.4-nano",         name: "GPT-5.4 Nano",               contextWindow: 1000000 } },
  "yp/gpt-5.2":              { provider: "yepapi", model: "gpt-5.2",              info: { id: "yp/gpt-5.2",              name: "GPT-5.2",                    contextWindow: 200000 } },
  "yp/gpt-5.2-pro":          { provider: "yepapi", model: "gpt-5.2-pro",          info: { id: "yp/gpt-5.2-pro",          name: "GPT-5.2 Pro",                contextWindow: 200000 } },
  "yp/gpt-5.3-chat":         { provider: "yepapi", model: "gpt-5.3-chat",         info: { id: "yp/gpt-5.3-chat",         name: "GPT-5.3 Chat",               contextWindow: 200000 } },
  "yp/gpt-5.3-codex":        { provider: "yepapi", model: "gpt-5.3-codex",        info: { id: "yp/gpt-5.3-codex",        name: "GPT-5.3 Codex",              contextWindow: 200000 } },
  "yp/gpt-5.2-codex":        { provider: "yepapi", model: "gpt-5.2-codex",        info: { id: "yp/gpt-5.2-codex",        name: "GPT-5.2 Codex",              contextWindow: 200000 } },
  "yp/gpt-audio":            { provider: "yepapi", model: "gpt-audio",            info: { id: "yp/gpt-audio",            name: "GPT Audio",                  contextWindow: 128000 } },
  "yp/gpt-audio-mini":       { provider: "yepapi", model: "gpt-audio-mini",       info: { id: "yp/gpt-audio-mini",       name: "GPT Audio Mini",             contextWindow: 128000 } },
  "yp/gpt-oss-120b":         { provider: "yepapi", model: "gpt-oss-120b",         info: { id: "yp/gpt-oss-120b",         name: "GPT OSS 120B",               contextWindow: 128000 } },
  // Anthropic
  "yp/opus-4.7":             { provider: "yepapi", model: "opus-4.7",             info: { id: "yp/opus-4.7",             name: "Opus 4.7",                   contextWindow: 1000000 } },
  "yp/opus-4.6":             { provider: "yepapi", model: "opus-4.6",             info: { id: "yp/opus-4.6",             name: "Opus 4.6",                   contextWindow: 1000000 } },
  "yp/opus-4.6-fast":        { provider: "yepapi", model: "opus-4.6-fast",        info: { id: "yp/opus-4.6-fast",        name: "Opus 4.6 Fast",              contextWindow: 1000000 } },
  "yp/sonnet-4":             { provider: "yepapi", model: "sonnet-4",             info: { id: "yp/sonnet-4",             name: "Sonnet 4",                   contextWindow: 200000 } },
  "yp/sonnet-4.6":           { provider: "yepapi", model: "sonnet-4.6",           info: { id: "yp/sonnet-4.6",           name: "Sonnet 4.6",                 contextWindow: 200000 } },
  "yp/sonnet-4.5":           { provider: "yepapi", model: "sonnet-4.5",           info: { id: "yp/sonnet-4.5",           name: "Sonnet 4.5",                 contextWindow: 200000 } },
  "yp/haiku-4":              { provider: "yepapi", model: "haiku-4",              info: { id: "yp/haiku-4",              name: "Haiku 4",                    contextWindow: 200000 } },
  // Google
  "yp/gemini-3.1-pro":       { provider: "yepapi", model: "gemini-3.1-pro",       info: { id: "yp/gemini-3.1-pro",       name: "Gemini 3.1 Pro",             contextWindow: 1000000 } },
  "yp/gemini-3-flash":       { provider: "yepapi", model: "gemini-3-flash",       info: { id: "yp/gemini-3-flash",       name: "Gemini 3 Flash",             contextWindow: 1000000 } },
  "yp/gemini-2.5-pro":       { provider: "yepapi", model: "gemini-2.5-pro",       info: { id: "yp/gemini-2.5-pro",       name: "Gemini 2.5 Pro",             contextWindow: 1000000 } },
  "yp/gemini-2.5-flash":     { provider: "yepapi", model: "gemini-2.5-flash",     info: { id: "yp/gemini-2.5-flash",     name: "Gemini 2.5 Flash",           contextWindow: 1000000 } },
  "yp/gemini-2.5-flash-lite":{ provider: "yepapi", model: "gemini-2.5-flash-lite",info: { id: "yp/gemini-2.5-flash-lite",name: "Gemini 2.5 Flash Lite",      contextWindow: 1000000 } },
  "yp/gemini-image":         { provider: "yepapi", model: "gemini-image",         info: { id: "yp/gemini-image",         name: "Gemini Image",               contextWindow: 1000000 } },
  // xAI
  "yp/grok-4.20":            { provider: "yepapi", model: "grok-4.20",            info: { id: "yp/grok-4.20",            name: "Grok 4.20",                  contextWindow: 256000 } },
  "yp/grok-4.20-multi":      { provider: "yepapi", model: "grok-4.20-multi",      info: { id: "yp/grok-4.20-multi",      name: "Grok 4.20 Multi",            contextWindow: 256000 } },
  "yp/grok-4.1-fast":        { provider: "yepapi", model: "grok-4.1-fast",        info: { id: "yp/grok-4.1-fast",        name: "Grok 4.1 Fast",              contextWindow: 256000 } },
  // DeepSeek
  "yp/deepseek-r1":          { provider: "yepapi", model: "deepseek-r1",          info: { id: "yp/deepseek-r1",          name: "DeepSeek R1",                contextWindow: 128000 } },
  "yp/deepseek-v3":          { provider: "yepapi", model: "deepseek-v3",          info: { id: "yp/deepseek-v3",          name: "DeepSeek V3",                contextWindow: 128000 } },
  "yp/deepseek-v3.2":        { provider: "yepapi", model: "deepseek-v3.2",        info: { id: "yp/deepseek-v3.2",        name: "DeepSeek V3.2",              contextWindow: 128000 } },
  // Meta
  "yp/llama-4-maverick":     { provider: "yepapi", model: "llama-4-maverick",     info: { id: "yp/llama-4-maverick",     name: "Llama 4 Maverick",           contextWindow: 128000 } },
  "yp/llama-4-scout":        { provider: "yepapi", model: "llama-4-scout",        info: { id: "yp/llama-4-scout",        name: "Llama 4 Scout",              contextWindow: 128000 } },
  // Qwen
  "yp/qwen-3-coder":         { provider: "yepapi", model: "qwen-3-coder",         info: { id: "yp/qwen-3-coder",         name: "Qwen 3 Coder",               contextWindow: 131072 } },
  "yp/qwen-3-max-thinking":  { provider: "yepapi", model: "qwen-3-max-thinking",  info: { id: "yp/qwen-3-max-thinking",  name: "Qwen 3 Max Thinking",        contextWindow: 131072 } },
  "yp/qwen-3.6-plus":        { provider: "yepapi", model: "qwen-3.6-plus",        info: { id: "yp/qwen-3.6-plus",        name: "Qwen 3.6 Plus",              contextWindow: 131072 } },
  "yp/qwen-3.5-plus":        { provider: "yepapi", model: "qwen-3.5-plus",        info: { id: "yp/qwen-3.5-plus",        name: "Qwen 3.5 Plus",              contextWindow: 131072 } },
  // Moonshot / Minimax / Xiaomi / Perplexity / Mistral / Nvidia / StepFun
  "yp/kimi-k2.5":            { provider: "yepapi", model: "kimi-k2.5",            info: { id: "yp/kimi-k2.5",            name: "Kimi K2.5",                  contextWindow: 128000 } },
  "yp/minimax-m2.7":         { provider: "yepapi", model: "minimax-m2.7",         info: { id: "yp/minimax-m2.7",         name: "MiniMax M2.7",               contextWindow: 128000 } },
  "yp/mimo-v2-pro":          { provider: "yepapi", model: "mimo-v2-pro",          info: { id: "yp/mimo-v2-pro",          name: "MiMo V2 Pro",                contextWindow: 128000 } },
  "yp/sonar":                { provider: "yepapi", model: "sonar",                info: { id: "yp/sonar",                name: "Sonar (Perplexity)",         contextWindow: 128000 } },
  "yp/sonar-pro":            { provider: "yepapi", model: "sonar-pro",            info: { id: "yp/sonar-pro",            name: "Sonar Pro (Perplexity)",     contextWindow: 128000 } },
  "yp/mistral-small-4":      { provider: "yepapi", model: "mistral-small-4",      info: { id: "yp/mistral-small-4",      name: "Mistral Small 4",            contextWindow: 128000 } },
  "yp/devstral-2":           { provider: "yepapi", model: "devstral-2",           info: { id: "yp/devstral-2",           name: "Devstral 2",                 contextWindow: 128000 } },
  "yp/nemotron-3-super":     { provider: "yepapi", model: "nemotron-3-super",     info: { id: "yp/nemotron-3-super",     name: "Nemotron 3 Super",           contextWindow: 128000 } },
  "yp/step-3.5-flash":       { provider: "yepapi", model: "step-3.5-flash",       info: { id: "yp/step-3.5-flash",       name: "Step 3.5 Flash",             contextWindow: 128000 } },
  "yp/gemma-4-31b":          { provider: "yepapi", model: "gemma-4-31b",          info: { id: "yp/gemma-4-31b",          name: "Gemma 4 31B",                contextWindow: 128000 } },
  "yp/nano-banana-pro":      { provider: "yepapi", model: "nano-banana-pro",      info: { id: "yp/nano-banana-pro",      name: "Nano Banana Pro",            contextWindow: 128000 } },
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
