/**
 * Message transformation / text-replacement layer.
 *
 * Upstream providers (e.g. CodeBuddy) run content filters that reject
 * messages whose system prompt contains well-known Claude/Anthropic
 * branding, billing headers, or CLI fingerprints.
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
 * Order matters: rules are applied sequentially top-to-bottom.
 */
const TEXT_RULES: ReplacementRule[] = [
  // --- Strip billing / CLI header lines ---
  {
    label: "remove x-anthropic-billing-header line",
    pattern: /x-anthropic-billing-header:[^\n]*/gi,
    replacement: "",
  },
  {
    label: "remove x-billing-header line",
    pattern: /x-billing-header:[^\n]*/gi,
    replacement: "",
  },
  {
    label: "remove cc_version token",
    pattern: /cc_version=[^\s;,\n]*/gi,
    replacement: "",
  },
  {
    label: "cc_entrypoint=cli → cc_entrypoint=app",
    pattern: /cc_entrypoint=cli/gi,
    replacement: "cc_entrypoint=app",
  },

  // --- Strip Anthropic / Claude Code GitHub issue links ---
  {
    label: "remove claude-code issues URL",
    pattern: /https?:\/\/github\.com\/anthropics\/claude-code\/issues[^\s]*/gi,
    replacement: "",
  },

  // --- Brand name substitutions ---
  // Apply most-specific patterns first to avoid partial replacements
  {
    label: "Claude Code → Assistant",
    pattern: /Claude Code/g,
    replacement: "Assistant",
  },
  {
    label: "Anthropic Claude → AI",
    pattern: /Anthropic Claude/gi,
    replacement: "AI",
  },
  {
    label: "claude-code (kebab) → ai-assistant",
    pattern: /claude-code/gi,
    replacement: "ai-assistant",
  },
  {
    label: "@anthropic-ai/ → @ai-sdk/",
    pattern: /@anthropic-ai\//g,
    replacement: "@ai-sdk/",
  },
  {
    label: "Anthropic → AI Provider",
    pattern: /\bAnthropic\b/g,
    replacement: "AI Provider",
  },
  {
    label: "Claude (standalone) → Assistant",
    pattern: /\bClaude\b/g,
    replacement: "Assistant",
  },

  // --- OhMyOpenCode / third-party tool references (from community list) ---
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
  {
    label: "OpenClaude → Assistant",
    pattern: /\bOpenClaude\b/gi,
    replacement: "Assistant",
  },
];

// ---------------------------------------------------------------------------
// Core replacement engine
// ---------------------------------------------------------------------------

const DEBUG = process.env.DEBUG_TRANSFORM === "1";

/** Apply all TEXT_RULES to a single string. */
function applyRules(text: string): string {
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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Apply text replacements to an OpenAI-format messages array.
 * Modifies system, user, assistant, and tool message text content.
 * Ensures a system message always exists.
 */
export function augmentMessages(messages: any[]): any[] {
  const result: any[] = messages.map((msg) => transformMessage(msg));

  // Guarantee there is always at least one system message
  if (!result.some((m) => m.role === "system")) {
    result.unshift({ role: "system", content: "You are a helpful AI coding assistant." });
  }

  return result;
}

/** Transform a single OpenAI-format message. */
function transformMessage(msg: any): any {
  if (typeof msg.content === "string") {
    return { ...msg, content: applyRules(msg.content) };
  }

  if (Array.isArray(msg.content)) {
    return {
      ...msg,
      content: msg.content.map((block: any) => {
        if (block.type === "text" && typeof block.text === "string") {
          return { ...block, text: applyRules(block.text) };
        }
        return block;
      }),
    };
  }

  return msg;
}
