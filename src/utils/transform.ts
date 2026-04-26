/**
 * Message transformation layer.
 *
 * Applies user-configurable filter rules (from ~/.hexos/filters.json)
 * to message content before forwarding to upstream providers.
 */

// ---------------------------------------------------------------------------
// Content filters (user-configurable via dashboard /filters page)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Apply text replacements to an OpenAI-format messages array.
 * Modifies system, user, assistant, and tool message text content.
 * Ensures a system message always exists.
 *
 * @param provider - Optional provider name to check filter overrides
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
    const text = applyContentFilters(msg.content, provider);
    return { ...msg, content: text };
  }

  if (Array.isArray(msg.content)) {
    return {
      ...msg,
      content: msg.content.map((block: any) => {
        if (block.type === "text" && typeof block.text === "string") {
          const text = applyContentFilters(block.text, provider);
          return { ...block, text };
        }
        return block;
      }),
    };
  }

  return msg;
}
