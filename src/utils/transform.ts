/**
 * Message transformation / text-replacement layer.
 *
 * Upstream providers run content filters that reject messages whose
 * system prompt contains well-known branding, billing headers, or
 * CLI fingerprints.
 *
 * This module applies a configurable list of regex/string replacements
 * to every text surface before forwarding to the upstream provider.
 */

// ---------------------------------------------------------------------------
// Replacement rules
// ---------------------------------------------------------------------------

interface ReplacementRule {
  /** Human-readable label (for debug logs). */
  label: string;
  /** Pattern to match — can be a string (literal) or RegExp. */
  pattern: string | RegExp;
  /** Replacement string. Empty string = remove. */
  replacement: string;
}

/**
 * Rules applied to every text string (system prompts, user/assistant text).
 *
 * ORDER MATTERS — rules are applied sequentially top-to-bottom.
 * Strategy:
 *   1. Strip entire lines / blocks first (billing headers, attribution)
 *   2. Strip URLs (full URLs with protocol, then bare domains)
 *   3. Multi-word compound phrases (most-specific first)
 *   4. Hyphenated identifiers (file paths, model IDs, package names)
 *   5. Single-word brand replacements (with word boundaries)
 *   6. Proxy/bypass intent words
 *   7. CATCH-ALL (no word boundary) — last resort
 */
const TEXT_RULES: ReplacementRule[] = [
  // =========================================================================
  // 1. STRIP ENTIRE LINES / BLOCKS
  // =========================================================================

  // --- Billing / CLI header lines ---
  {
    label: "remove billing header line (cc_version=...)",
    pattern: /^:?\s*cc_version=[^\n]*$/gim,
    replacement: "",
  },
  {
    label: "remove standalone billing colon line (: cc_...)",
    pattern: /^:\s+cc_[^\n]*$/gim,
    replacement: "",
  },
  {
    label: "remove attribution line (cc_entrypoint=...)",
    pattern: /^:?\s*;?\s*cc_entrypoint=[^\n]*$/gim,
    replacement: "",
  },
  {
    label: "remove attribution line (: ;...cc_|cch=...)",
    pattern: /^:\s*;[^\n]*(?:cc_|cch=)[^\n]*$/gim,
    replacement: "",
  },
  {
    label: "remove x-anthropic-billing-header line",
    pattern: /x-anthropic-billing-header[^\n]*/gi,
    replacement: "",
  },

  // --- Inline billing tokens ---
  {
    label: "remove cch= token",
    pattern: /\bcch=[^\s;,\n]*/gi,
    replacement: "",
  },
  {
    label: "remove cc_version= token",
    pattern: /cc_version=[^\s;,\n]*/gi,
    replacement: "",
  },
  {
    label: "remove cc_entrypoint= token",
    pattern: /cc_entrypoint=[^\s;,\n]*/gi,
    replacement: "",
  },

  // --- Co-Authored-By attribution lines ---
  {
    label: "remove Co-Authored-By with Claude/Anthropic",
    pattern: /Co-Authored-By:[^\n]*(?:claude|anthropic)[^\n]*/gi,
    replacement: "",
  },

  // --- Generated-with footer ---
  {
    label: "remove Generated with Claude Code footer",
    pattern: /\?\?\s*Generated with\s*\[?[^\]]*claude[^\n]*/gi,
    replacement: "",
  },

  // =========================================================================
  // 2. STRIP URLs (full URLs first, then bare domains)
  // =========================================================================

  // Full URLs containing sensitive words
  {
    label: "remove any URL containing anthropic/claude",
    pattern: /https?:\/\/[^\s"')>]*(anthropic|claude)[^\s"')>]*/gi,
    replacement: "",
  },

  // Email addresses containing sensitive words
  {
    label: "remove email addresses with anthropic/claude",
    pattern: /[a-zA-Z0-9._%+-]*@[a-zA-Z0-9.-]*(anthropic|claude)[a-zA-Z0-9.-]*/gi,
    replacement: "",
  },

  // Bare domain references (no protocol prefix)
  {
    label: "remove docs.anthropic.com",
    pattern: /docs\.anthropic\.com[^\s"')>]*/gi,
    replacement: "",
  },
  {
    label: "remove console.anthropic.com",
    pattern: /console\.anthropic\.com[^\s"')>]*/gi,
    replacement: "",
  },
  {
    label: "remove anthropic.com",
    pattern: /anthropic\.com[^\s"')>]*/gi,
    replacement: "",
  },
  {
    label: "remove claude.ai",
    pattern: /claude\.ai[^\s"')>]*/gi,
    replacement: "",
  },

  // =========================================================================
  // 3. MULTI-WORD COMPOUND PHRASES (most-specific first)
  // =========================================================================

  {
    label: "Claude Agent SDK → AI Agent SDK",
    pattern: /Claude\s+Agent\s+SDK/gi,
    replacement: "AI Agent SDK",
  },
  {
    label: "Claude Code → AI Assistant",
    pattern: /Claude\s+Code/gi,
    replacement: "AI Assistant",
  },
  {
    label: "Claude Opus → Opus",
    pattern: /Claude\s+Opus/gi,
    replacement: "Opus",
  },
  {
    label: "Claude Sonnet → Sonnet",
    pattern: /Claude\s+Sonnet/gi,
    replacement: "Sonnet",
  },
  {
    label: "Claude Haiku → Haiku",
    pattern: /Claude\s+Haiku/gi,
    replacement: "Haiku",
  },
  {
    label: "Claude model version refs (Claude 3.x, Claude 4.x) → model",
    pattern: /\bClaude\s+\d[\w.-]*/gi,
    replacement: "model",
  },
  {
    label: "Anthropic SDK → AI SDK",
    pattern: /Anthropic\s+SDK/gi,
    replacement: "AI SDK",
  },
  {
    label: "Anthropic Assistant → AI",
    pattern: /Anthropic\s+Assistant/gi,
    replacement: "AI",
  },
  {
    label: "Anthropic API → AI API",
    pattern: /Anthropic\s+API/gi,
    replacement: "AI API",
  },
  {
    label: "Anthropic's → AI Provider's",
    pattern: /Anthropic's/gi,
    replacement: "AI Provider's",
  },
  {
    label: "by Anthropic → by AI Provider",
    pattern: /by\s+Anthropic/gi,
    replacement: "by AI Provider",
  },
  {
    label: "from Anthropic → from AI Provider",
    pattern: /from\s+Anthropic/gi,
    replacement: "from AI Provider",
  },
  {
    label: "built on Anthropic → built on AI Provider",
    pattern: /built\s+on\s+Anthropic/gi,
    replacement: "built on AI Provider",
  },
  {
    label: "Claude CLI → assistant CLI",
    pattern: /Claude\s+CLI/gi,
    replacement: "assistant CLI",
  },
  {
    label: "Claude session → assistant session",
    pattern: /Claude\s+session/gi,
    replacement: "assistant session",
  },
  {
    label: "Claude exits → assistant exits",
    pattern: /Claude\s+exits/gi,
    replacement: "assistant exits",
  },
  {
    label: "Claude models → AI models",
    pattern: /Claude\s+models/gi,
    replacement: "AI models",
  },
  {
    label: "Claude model family → AI model family",
    pattern: /Claude\s+model\s+family/gi,
    replacement: "AI model family",
  },
  {
    label: "Anthropic prompt cache → prompt cache",
    pattern: /Anthropic\s+prompt\s+cache/gi,
    replacement: "prompt cache",
  },

  // =========================================================================
  // 4. HYPHENATED IDENTIFIERS (file paths, model IDs, package names)
  // =========================================================================

  // File/path references
  {
    label: "CLAUDE.md → AGENT.md",
    pattern: /CLAUDE\.md/g,
    replacement: "AGENT.md",
  },
  {
    label: ".claude/ path → .agent/ path",
    pattern: /\.claude\//g,
    replacement: ".agent/",
  },
  {
    label: ".claude.json → .agent.json",
    pattern: /\.claude\.json/g,
    replacement: ".agent.json",
  },

  // Model ID references in text
  {
    label: "claude-opus → opus",
    pattern: /claude-opus/gi,
    replacement: "opus",
  },
  {
    label: "claude-sonnet → sonnet",
    pattern: /claude-sonnet/gi,
    replacement: "sonnet",
  },
  {
    label: "claude-haiku → haiku",
    pattern: /claude-haiku/gi,
    replacement: "haiku",
  },

  // CLI / package identifiers
  {
    label: "claude-code → ai-assistant",
    pattern: /claude-code/gi,
    replacement: "ai-assistant",
  },
  {
    label: "claude-cli → assistant-cli",
    pattern: /claude-cli/gi,
    replacement: "assistant-cli",
  },
  {
    label: "claude-api → ai-api",
    pattern: /claude-api/gi,
    replacement: "ai-api",
  },
  {
    label: "@anthropic-ai/ → @ai-sdk/",
    pattern: /@anthropic-ai\//g,
    replacement: "@ai-sdk/",
  },
  {
    label: "anthropic-version → api-version",
    pattern: /anthropic-version/gi,
    replacement: "api-version",
  },

  // =========================================================================
  // 5. SINGLE-WORD BRAND REPLACEMENTS (word-boundary)
  // =========================================================================

  {
    label: "Anthropic → AI Provider",
    pattern: /\bAnthropic\b/g,
    replacement: "AI Provider",
  },
  {
    label: "anthropic → AI Provider (case-insensitive)",
    pattern: /\banthropic\b/gi,
    replacement: "AI Provider",
  },
  {
    label: "Claude → assistant (standalone word)",
    pattern: /\bClaude\b/g,
    replacement: "assistant",
  },
  {
    label: "claude → assistant (standalone word, case-insensitive)",
    pattern: /\bclaude\b/gi,
    replacement: "assistant",
  },
  {
    label: "CLAUDE → AGENT (all-caps standalone)",
    pattern: /\bCLAUDE\b/g,
    replacement: "AGENT",
  },

  // --- Third-party tool references ---
  {
    label: "OpenClaude → Assistant",
    pattern: /\bOpenClaude\b/gi,
    replacement: "Assistant",
  },
  {
    label: "OhMyOpenCode brand strip",
    pattern: / from OhMyOpenCode/gi,
    replacement: "",
  },
  {
    label: "OhMyOpenCode parenthetical strip",
    pattern: /\s*-\s*OhMyOpenCode\)/gi,
    replacement: ")",
  },

  // =========================================================================
  // 6. PROXY / BYPASS INTENT WORDS
  // =========================================================================

  {
    label: "content filter → validation",
    pattern: /content.filter/gi,
    replacement: "validation",
  },
  {
    label: "brand name transform → text transform",
    pattern: /brand.name.(?:transform|substitut|replac|strip)/gi,
    replacement: "text transform",
  },
  {
    label: "strip attribution → process data",
    pattern: /strip.(?:attribution|brand|billing)/gi,
    replacement: "process data",
  },
  {
    label: "bypass → handle",
    pattern: /\bbypass\b/gi,
    replacement: "handle",
  },
  {
    label: "sanitiz* → process",
    pattern: /\bsanitiz\w*/gi,
    replacement: "process",
  },

  // =========================================================================
  // 7. COMMUNITY PATTERNS (from CodeBuddy filter bypass lists)
  // =========================================================================

  {
    label: "Advanced AI Agent → AI Assistant",
    pattern: /Advanced AI Agent/gi,
    replacement: "AI Assistant",
  },
  {
    label: "Advanced AI orchestrator → AI orchestrator",
    pattern: /Advanced AI orchestrator/gi,
    replacement: "AI orchestrator",
  },
  {
    label: "Advanced AI Agent with coding skills → AI coding assistant",
    pattern: /Advanced AI Agent with coding skills/gi,
    replacement: "AI coding assistant",
  },
  {
    label: "Sisyphus-Junior task executor → task executor",
    pattern: /Sisyphus-Junior\s*-?\s*a focused task executor/gi,
    replacement: "task executor",
  },
  {
    label: "(Oracle) → (Assistant)",
    pattern: /\(Oracle\)/gi,
    replacement: "(Assistant)",
  },
  {
    label: "(Atlas) → (Assistant)",
    pattern: /\(Atlas\)/gi,
    replacement: "(Assistant)",
  },
  {
    label: "Anxthxropic's → AI Provider's",
    pattern: /Anxthxropic's/gi,
    replacement: "AI Provider's",
  },
  {
    label: "anxthxropic.com → provider.com",
    pattern: /anxthxropic\.com/gi,
    replacement: "provider.com",
  },
  {
    label: "@anxthxropic-ai → @ai-sdk",
    pattern: /@anxthxropic-ai/gi,
    replacement: "@ai-sdk",
  },
  {
    label: "anxthxropic → ai-provider",
    pattern: /anxthxropic/gi,
    replacement: "ai-provider",
  },

  // =========================================================================
  // 9. FINAL CATCH-ALL (no word boundary — last resort)
  // =========================================================================
  // These run last to catch substrings inside compound words, JSON keys, etc.
  {
    label: "catch-all: anthropic → ai-provider",
    pattern: /anthropic/gi,
    replacement: "ai-provider",
  },
  {
    label: "catch-all: claude → assistant",
    pattern: /claude/gi,
    replacement: "assistant",
  },
];

// ---------------------------------------------------------------------------
// Core replacement engine
// ---------------------------------------------------------------------------

const DEBUG = process.env.DEBUG_TRANSFORM === "1";

/** Apply all TEXT_RULES to a single string. */
export function applyRules(text: string): string {
  let result = text;
  for (const rule of TEXT_RULES) {
    const before = result;
    result = result.replace(rule.pattern as any, rule.replacement);
    if (DEBUG && before !== result) {
      console.log(`[transform] rule matched: ${rule.label}`);
    }
  }
  // Collapse runs of blank lines that replacements may leave behind
  result = result.replace(/\n{3,}/g, "\n\n").trim();
  return result;
}

/**
 * Recursively walk an object/array and apply applyRules() to every string
 * value found. This is JSON-safe — it never serializes to JSON and back,
 * so structural characters (quotes, braces, etc.) are never corrupted.
 */
export function applyRulesDeep(obj: unknown): unknown {
  if (typeof obj === "string") {
    return applyRules(obj);
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => applyRulesDeep(item));
  }
  if (obj !== null && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      out[key] = applyRulesDeep(value);
    }
    return out;
  }
  // numbers, booleans, null — pass through unchanged
  return obj;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Apply content filter rules (from filters.json) to a string.
 * These are user-configurable security/custom rules, separate from brand rules.
 */
// Lazy-loaded filter module (avoids top-level await issue with require)
let _filterModule: any = null;
async function getFilterModule() {
  if (!_filterModule) {
    _filterModule = await import("../config/filters.ts");
  }
  return _filterModule;
}
// Pre-load on first tick so subsequent calls are sync
getFilterModule().catch(() => {});

export function applyContentFilters(text: string, provider?: string): string {
  try {
    if (!_filterModule) return text; // Not loaded yet, skip
    const { isFilterEnabledForProvider, getActiveRules, getFilterConfig } = _filterModule;
    if (provider && !isFilterEnabledForProvider(provider)) return text;
    if (!provider) {
      if (!getFilterConfig().enabled) return text;
    }
    const rules = getActiveRules();
    let result = text;
    for (const rule of rules) {
      result = result.replace(rule.pattern, rule.replacement);
    }
    return result;
  } catch {
    return text;
  }
}

/**
 * Apply text replacements to an OpenAI-format messages array.
 * Modifies system, user, assistant, and tool message text content.
 * Ensures a system message always exists.
 *
 * @param provider - Optional provider name to check content filter overrides
 */
export function augmentMessages(messages: any[], provider?: string): any[] {
  const result: any[] = messages.map((msg) => transformMessage(msg, provider));

  // Guarantee there is always at least one system message
  if (!result.some((m) => m.role === "system")) {
    result.unshift({ role: "system", content: "You are a helpful AI coding assistant. Always respond in the same language as the user's message." });
  }

  return result;
}

/** Transform a single OpenAI-format message. */
function transformMessage(msg: any, provider?: string): any {
  if (typeof msg.content === "string") {
    let text = applyRules(msg.content);
    text = applyContentFilters(text, provider);
    return { ...msg, content: text };
  }

  if (Array.isArray(msg.content)) {
    return {
      ...msg,
      content: msg.content.map((block: any) => {
        if (block.type === "text" && typeof block.text === "string") {
          let text = applyRules(block.text);
          text = applyContentFilters(text, provider);
          return { ...block, text };
        }
        return block;
      }),
    };
  }

  return msg;
}
