/**
 * Global pricing module — fetches model pricing from LiteLLM (BerriAI)
 * and calculates per-request cost based on token usage.
 *
 * Data source: https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json
 * Cache: ~/.hexos/pricing-cache.json (1 hour TTL)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ── Types ──────────────────────────────────────────────────────────────

export interface ModelPricing {
  inputCostPerToken: number;
  outputCostPerToken: number;
  cacheReadCostPerToken: number;
  cacheWriteCostPerToken: number;
  reasoningCostPerToken: number;
}

interface LiteLLMEntry {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
  output_cost_per_reasoning_token?: number;
  mode?: string;
  litellm_provider?: string;
}

interface PricingCache {
  fetchedAt: number;
  data: Record<string, ModelPricing>;
}

// ── Constants ──────────────────────────────────────────────────────────

const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const CACHE_DIR = join(homedir(), ".hexos");
const CACHE_FILE = join(CACHE_DIR, "pricing-cache.json");
const FETCH_TIMEOUT_MS = 15_000;
const MAX_RETRIES = 3;

/**
 * Mapping from hexos model name (without prefix) to LiteLLM lookup keys.
 * Order matters — first match wins. The resolver also tries automatic
 * normalization (dots↔hyphens, provider prefixes) so most models don't
 * need an explicit entry here.
 */
const HEXOS_TO_LITELLM: Record<string, string[]> = {
  // AI Provider — hexos uses dots (opus-4.6), LiteLLM uses hyphens (opus-4-6)
  "opus-4.6": ["opus-4-6", "opus-4-6-20260205"],
  "opus-4.7": ["opus-4-7", "opus-4-7-20260416"],
  "sonnet-4.6": ["sonnet-4-6"],
  "sonnet-4.5": ["sonnet-4-5", "sonnet-4-5-20250929"],
  "sonnet-4": ["sonnet-4-20250514"],
  "haiku-4.5": ["haiku-4-5", "haiku-4-5-20251001"],

  // Google — some need suffix
  "gemini-3.1-pro": ["gemini-3.1-pro-preview"],
  "gemini-3.0-flash": ["gemini-3-flash-preview", "gemini-3.0-flash"],

  // DeepSeek — different naming
  "deepseek-v3.2": ["deepseek/deepseek-v3.2", "deepseek/deepseek-chat"],
  "deepseek-r1": ["deepseek/deepseek-reasoner", "deepseek/deepseek-r1"],
  "deepseek-3.2": ["deepseek/deepseek-v3.2", "deepseek/deepseek-chat"],

  // xAI
  "grok-4": ["xai/grok-4"],

  // Moonshot
  "kimi-k2.5": ["moonshot/kimi-k2.5"],
  "kimi-k2.6": ["moonshot/kimi-k2.6"],

  // Zhipu
  "glm-5.0": ["zai/glm-5", "glm-5"],
  "glm-5": ["zai/glm-5", "glm-5"],
  "glm-5.1": ["zai/glm-5.1", "glm-5.1"],

  // MiniMax
  "minimax-m2.1": ["minimax/MiniMax-M2.1"],
  "minimax-m2.5": ["minimax/MiniMax-M2.5"],
  "minimax-m2.7": ["minimax/MiniMax-M2.7", "minimax/MiniMax-M2.5"], // fallback to m2.5

  // Qwen
  "qwen3-coder-next": ["dashscope/qwen3-next-80b-a3b-instruct"],
};

// ── Singleton state ────────────────────────────────────────────────────

let pricingData: Record<string, ModelPricing> | null = null;
let lastFetchTime = 0;
let fetchPromise: Promise<void> | null = null;

// ── Public API ─────────────────────────────────────────────────────────

/**
 * Calculate cost for a single request.
 * @param hexosModelId  Full hexos model ID (e.g. "cb/opus-4.6")
 * @param promptTokens  Number of input/prompt tokens
 * @param completionTokens  Number of output/completion tokens
 * @returns Cost in USD, or 0 if pricing unavailable
 */
export function calculateCost(
  hexosModelId: string,
  promptTokens: number,
  completionTokens: number,
): number {
  if (!pricingData) return 0;

  const pricing = lookupPricing(hexosModelId);
  if (!pricing) return 0;

  const inputCost = Math.max(0, promptTokens) * pricing.inputCostPerToken;
  const outputCost = Math.max(0, completionTokens) * pricing.outputCostPerToken;

  return inputCost + outputCost;
}

/**
 * Get pricing info for a model (for display purposes).
 * Returns $/1M tokens format.
 */
export function getModelPricing(hexosModelId: string): {
  inputPerMillion: number;
  outputPerMillion: number;
} | null {
  if (!pricingData) return null;
  const pricing = lookupPricing(hexosModelId);
  if (!pricing) return null;
  return {
    inputPerMillion: pricing.inputCostPerToken * 1_000_000,
    outputPerMillion: pricing.outputCostPerToken * 1_000_000,
  };
}

/**
 * Initialize pricing data. Call once at server startup.
 * Loads from cache immediately, then refreshes in background if stale.
 */
export async function initPricing(): Promise<void> {
  // Load cache first for instant availability
  loadCache();

  // Refresh in background if stale or missing
  if (!pricingData || Date.now() - lastFetchTime > CACHE_TTL_MS) {
    refreshPricing().catch((err) => {
      console.error("[pricing] Background refresh failed:", err.message);
    });
  }
}

/**
 * Force refresh pricing data from LiteLLM.
 */
export async function refreshPricing(): Promise<void> {
  // Deduplicate concurrent fetches
  if (fetchPromise) return fetchPromise;

  fetchPromise = (async () => {
    try {
      const raw = await fetchWithRetry(LITELLM_URL, MAX_RETRIES);
      const parsed = parseLiteLLMData(raw);
      pricingData = parsed;
      lastFetchTime = Date.now();
      saveCache({ fetchedAt: lastFetchTime, data: parsed });
      console.log(`[pricing] Loaded ${Object.keys(parsed).length} model prices from LiteLLM`);
    } finally {
      fetchPromise = null;
    }
  })();

  return fetchPromise;
}

/**
 * Check if pricing data is available.
 */
export function isPricingReady(): boolean {
  return pricingData !== null && Object.keys(pricingData).length > 0;
}

/**
 * Get pricing stats for diagnostics.
 */
export function getPricingStats(): {
  loaded: boolean;
  modelCount: number;
  lastFetchedAt: number;
  cacheAgeMinutes: number;
} {
  return {
    loaded: isPricingReady(),
    modelCount: pricingData ? Object.keys(pricingData).length : 0,
    lastFetchedAt: lastFetchTime,
    cacheAgeMinutes: lastFetchTime ? Math.round((Date.now() - lastFetchTime) / 60_000) : -1,
  };
}

// ── Lookup logic ───────────────────────────────────────────────────────

// In-memory lookup cache to avoid repeated normalization
const lookupCache = new Map<string, ModelPricing | null>();

function lookupPricing(hexosModelId: string): ModelPricing | null {
  // Check lookup cache
  const cached = lookupCache.get(hexosModelId);
  if (cached !== undefined) return cached;

  if (!pricingData) return null;

  const result = doLookup(hexosModelId);

  // Cache result (cap at 500 entries)
  if (lookupCache.size > 500) lookupCache.clear();
  lookupCache.set(hexosModelId, result);

  return result;
}

function doLookup(hexosModelId: string): ModelPricing | null {
  if (!pricingData) return null;

  // Strip hexos prefix (cb/, cl/, kr/, qd/, cx/)
  const bareModel = hexosModelId.replace(/^(cb|cl|kr|qd|cx)\//, "");

  // 1. Check explicit mapping first
  const mappedKeys = HEXOS_TO_LITELLM[bareModel];
  if (mappedKeys) {
    for (const key of mappedKeys) {
      if (pricingData[key]) return pricingData[key];
    }
  }

  // 2. Exact match on bare model
  if (pricingData[bareModel]) return pricingData[bareModel];

  // 3. Normalize dots to hyphens (opus-4.6 -> opus-4-6)
  const hyphenated = bareModel.replace(/(\d)\.(\d)/g, "$1-$2");
  if (hyphenated !== bareModel && pricingData[hyphenated]) {
    return pricingData[hyphenated];
  }

  // 4. Try with common provider prefixes
  const prefixes = [
    "openai/", "google/", "AI Provider/", "deepseek/", "xai/",
    "moonshot/", "zai/", "minimax/", "dashscope/",
  ];
  for (const prefix of prefixes) {
    if (pricingData[prefix + bareModel]) return pricingData[prefix + bareModel];
    if (hyphenated !== bareModel && pricingData[prefix + hyphenated]) {
      return pricingData[prefix + hyphenated];
    }
  }

  // 5. Case-insensitive scan (last resort, slower)
  const lowerBare = bareModel.toLowerCase();
  const lowerHyphen = hyphenated.toLowerCase();
  for (const [key, val] of Object.entries(pricingData)) {
    const kl = key.toLowerCase();
    if (kl === lowerBare || kl === lowerHyphen) return val;
    // Match after provider prefix: "openai/gpt-5.1" -> "gpt-5.1"
    const afterSlash = kl.split("/").pop();
    if (afterSlash === lowerBare || afterSlash === lowerHyphen) return val;
  }

  return null;
}

// ── LiteLLM data parsing ───────────────────────────────────────────────

function parseLiteLLMData(raw: Record<string, LiteLLMEntry>): Record<string, ModelPricing> {
  const result: Record<string, ModelPricing> = {};

  for (const [key, entry] of Object.entries(raw)) {
    // Skip non-chat models and sample spec
    if (key === "sample_spec") continue;
    if (entry.mode && entry.mode !== "chat") continue;
    if (entry.input_cost_per_token == null) continue;

    result[key] = {
      inputCostPerToken: entry.input_cost_per_token ?? 0,
      outputCostPerToken: entry.output_cost_per_token ?? 0,
      cacheReadCostPerToken: entry.cache_read_input_token_cost ?? 0,
      cacheWriteCostPerToken: entry.cache_creation_input_token_cost ?? 0,
      reasoningCostPerToken: entry.output_cost_per_reasoning_token ?? 0,
    };
  }

  return result;
}

// ── Network ────────────────────────────────────────────────────────────

async function fetchWithRetry(url: string, retries: number): Promise<Record<string, LiteLLMEntry>> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      const resp = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);

      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      return (await resp.json()) as Record<string, LiteLLMEntry>;
    } catch (err) {
      lastError = err as Error;
      if (attempt < retries - 1) {
        const delay = 200 * Math.pow(2, attempt); // 200ms, 400ms, 800ms
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  throw lastError ?? new Error("Fetch failed");
}

// ── Cache persistence ──────────────────────────────────────────────────

function loadCache(): void {
  try {
    if (!existsSync(CACHE_FILE)) return;
    const raw = readFileSync(CACHE_FILE, "utf-8");
    const cache: PricingCache = JSON.parse(raw);

    // Reject future timestamps (clock skew)
    if (cache.fetchedAt > Date.now() + 60_000) return;

    pricingData = cache.data;
    lastFetchTime = cache.fetchedAt;
    lookupCache.clear();

    const age = Math.round((Date.now() - cache.fetchedAt) / 60_000);
    console.log(`[pricing] Loaded ${Object.keys(cache.data).length} prices from cache (${age}m old)`);
  } catch {
    // Corrupt cache — ignore
  }
}

function saveCache(cache: PricingCache): void {
  try {
    if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });

    // Atomic write via temp file + rename
    const tmpFile = CACHE_FILE + `.${process.pid}.tmp`;
    writeFileSync(tmpFile, JSON.stringify(cache));
    renameSync(tmpFile, CACHE_FILE);
  } catch {
    // Non-critical — cache will be refreshed next time
  }
}
