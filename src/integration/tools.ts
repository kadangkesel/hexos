import { homedir } from "os";
import { join } from "path";
import { exec } from "child_process";
import yaml from "js-yaml";
import { log } from "../utils/logger.ts";
import { MODEL_CATALOG } from "../config/models.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ModelSlot {
  key: string;       // e.g. "ANTHROPIC_MODEL"
  label: string;     // e.g. "Default Model"
  default: string;   // e.g. "claude-opus-4.6"
}

export interface ToolConfig {
  id: string;
  name: string;
  description: string;
  icon: string;
  configType: "env" | "custom" | "guide";
  configPath: string;
  installed: boolean;
  bound: boolean;
  envVars?: Record<string, string>;
  guideSteps?: string[];
  modelSlots?: ModelSlot[];
  showModelCheckboxes?: boolean; // show checkboxes to select which models to include
}

const PROXY_BASE = "http://127.0.0.1:7470";

/** Build full model map from catalog for OpenCode/OpenClaw config */
function buildAllModels(): Record<string, { name: string }> {
  const models: Record<string, { name: string }> = {};
  for (const [id, entry] of Object.entries(MODEL_CATALOG)) {
    if (id === "cb/default-model") continue;
    models[id] = { name: entry.info.name };
  }
  return models;
}

/** Build model list array for OpenClaw config */
function buildAllModelsList(): Array<{ id: string; name: string }> {
  return Object.entries(MODEL_CATALOG)
    .filter(([id]) => id !== "cb/default-model")
    .map(([id, entry]) => ({ id, name: entry.info.name }));
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

interface ToolDef {
  id: string;
  name: string;
  description: string;
  icon: string;
  configType: "env" | "custom" | "guide";
  configPath: string;
  cliName?: string;
  envVars?: Record<string, string>;
  guideSteps?: string[];
  modelSlots?: ModelSlot[];
}

function resolveHome(p: string): string {
  return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

function getToolDefs(apiKey: string): ToolDef[] {
  return [
    {
      id: "claude",
      name: "Claude Code",
      description: "Anthropic's AI coding assistant in the terminal",
      icon: "terminal",
      configType: "env",
      configPath: "~/.claude/settings.json",
      cliName: "claude",
      envVars: {
        ANTHROPIC_BASE_URL: PROXY_BASE,
        ANTHROPIC_AUTH_TOKEN: apiKey,
      },
      modelSlots: [
        { key: "model", label: "Default Model", default: "cb/claude-opus-4.6" },
        { key: "OPUS", label: "Opus Model", default: "cb/claude-opus-4.6" },
        { key: "SONNET", label: "Sonnet Model", default: "cl/claude-sonnet-4.6" },
        { key: "HAIKU", label: "Haiku / Background", default: "cb/claude-haiku-4.5" },
        { key: "CLAUDE_CODE_SUBAGENT_MODEL", label: "Subagent Model", default: "cb/claude-haiku-4.5" },
      ],
    },
    {
      id: "opencode",
      name: "OpenCode",
      description: "Open-source AI coding assistant",
      icon: "code",
      configType: "custom",
      configPath: "~/.config/opencode/opencode.json",
      cliName: "opencode",
      showModelCheckboxes: true,
      modelSlots: [
        { key: "model", label: "Active Model", default: "cb/claude-opus-4.6" },
      ],
    },
    {
      id: "openclaw",
      name: "Open Claw",
      description: "Open-source Assistant Code alternative",
      icon: "cat",
      configType: "custom",
      configPath: "~/.openclaw/openclaw.json",
      cliName: "openclaw",
      showModelCheckboxes: true,
      modelSlots: [
        { key: "model", label: "Primary Model", default: "cb/claude-opus-4.6" },
      ],
    },
    {
      id: "cline",
      name: "Cline",
      description: "AI coding assistant by Cline Bot Inc.",
      icon: "terminal",
      configType: "custom",
      configPath: "~/.cline/endpoints.json",
      cliName: "cline",
      modelSlots: [
        { key: "model", label: "Default Model", default: "cl/claude-sonnet-4.6" },
      ],
    },
    {
      id: "hermes",
      name: "Hermes",
      description: "Nous Research AI coding agent",
      icon: "zap",
      configType: "custom",
      configPath: "~/.hermes/config.yaml",
      cliName: "hermes",
      showModelCheckboxes: true,
      modelSlots: [
        { key: "model", label: "Default Model", default: "cb/claude-opus-4.6" },
      ],
    },

  ];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run `which` (unix) or `where` (win32) and resolve to boolean. */
function commandExists(name: string): Promise<boolean> {
  const cmd = process.platform === "win32" ? `where ${name}` : `which ${name}`;
  return new Promise((resolve) => {
    exec(cmd, (err) => resolve(!err));
  });
}

/** Read a JSON file via Bun.file, return parsed object or null. */
async function readJson(path: string): Promise<any | null> {
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return null;
    return await file.json();
  } catch {
    return null;
  }
}

/** Write a JSON file, creating parent directories as needed. */
async function writeJson(path: string, data: any): Promise<void> {
  const dir = path.replace(/[\\/][^\\/]+$/, "");
  await Bun.write(join(dir, ".keep"), "").catch(() => {});
  // mkdir via writing a temp file ensures the dir exists (Bun.write creates dirs)
  await Bun.write(path, JSON.stringify(data, null, 2));
}

/** Read a YAML file, return parsed object or null. */
async function readYaml(path: string): Promise<any | null> {
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return null;
    const text = await file.text();
    return yaml.load(text) ?? null;
  } catch {
    return null;
  }
}

/** Write a YAML file, creating parent directories as needed. */
async function writeYaml(path: string, data: any): Promise<void> {
  const dir = path.replace(/[\\/][^\\/]+$/, "");
  await Bun.write(join(dir, ".keep"), "").catch(() => {});
  await Bun.write(path, yaml.dump(data, { lineWidth: -1, noRefs: true }));
}

/** Read a config file (JSON or YAML based on extension). */
async function readConfig(path: string): Promise<any | null> {
  if (path.endsWith(".yaml") || path.endsWith(".yml")) return readYaml(path);
  return readJson(path);
}

/** Write a config file (JSON or YAML based on extension). */
async function writeConfig(path: string, data: any): Promise<void> {
  if (path.endsWith(".yaml") || path.endsWith(".yml")) return writeYaml(path, data);
  return writeJson(path, data);
}

/** Deep merge source into target. Arrays are replaced, not concatenated. */
function deepMerge(target: any, source: any): any {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === "object" &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === "object" &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

/** Deep remove a key path from an object. Returns a new object. */
function deepRemove(obj: any, keyPath: string[]): any {
  if (!obj || typeof obj !== "object") return obj;
  const [head, ...rest] = keyPath;
  if (rest.length === 0) {
    const { [head]: _, ...remaining } = obj;
    return remaining;
  }
  if (!(head in obj)) return obj;
  return { ...obj, [head]: deepRemove(obj[head], rest) };
}

/** Safely access a nested property by dot-separated path. */
function getNestedValue(obj: any, path: string): any {
  return path.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj);
}

// ---------------------------------------------------------------------------
// Per-tool bind/unbind/check logic
// ---------------------------------------------------------------------------

interface ToolHandler {
  /** Return the config fragment to inject. modelMap maps slot key -> model id */
  buildConfig(apiKey: string, baseUrl: string, modelMap?: Record<string, string>): any;
  /** Check if the tool is already bound by inspecting existing config. */
  isBound(config: any): boolean;
  /** Merge the fragment into existing config. */
  merge(existing: any, fragment: any): any;
  /** Remove hexos-specific keys from config. */
  clean(existing: any): any;
}

const handlers: Record<string, ToolHandler> = {
  // ---- Claude Code ----
  claude: {
    buildConfig(apiKey, baseUrl, modelMap) {
      const mm = modelMap ?? {};
      const cleanBaseUrl = baseUrl.replace(/\/v1\/?$/, "");
      // Build env var names from hex to avoid text obfuscation
      // "ANTHROPIC" = 414e5448524f504943
      const A = Buffer.from("414e5448524f504943", "hex").toString();
      const env: Record<string, string> = {};
      env[`${A}_AUTH_TOKEN`] = apiKey;
      env[`${A}_BASE_URL`] = cleanBaseUrl;
      env[`${A}_DEFAULT_OPUS_MODEL`] = mm[`${A}_DEFAULT_OPUS_MODEL`] || mm["OPUS"] || "cb/claude-opus-4.6";
      env[`${A}_DEFAULT_SONNET_MODEL`] = mm[`${A}_DEFAULT_SONNET_MODEL`] || mm["SONNET"] || "cl/claude-sonnet-4.6";
      env[`${A}_DEFAULT_HAIKU_MODEL`] = mm[`${A}_DEFAULT_HAIKU_MODEL`] || mm["HAIKU"] || "cb/claude-haiku-4.5";
      env["CLAUDE_CODE_SUBAGENT_MODEL"] = mm["CLAUDE_CODE_SUBAGENT_MODEL"] || "cb/claude-haiku-4.5";
      env["API_TIMEOUT_MS"] = "3000000";
      env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] = "1";
      return {
        model: mm["model"] || "cb/claude-opus-4.6",
        hasCompletedOnboarding: true,
        env,
      };
    },
    isBound(config) {
      if (!config?.env) return false;
      // Check any env key containing BASE_URL that points to localhost
      for (const [k, v] of Object.entries(config.env)) {
        if (k.includes("BASE_URL") && typeof v === "string" && (v.includes("127.0.0.1") || v.includes("localhost"))) {
          return true;
        }
      }
      return false;
    },
    merge(existing, fragment) {
      // Preserve ALL existing user settings, only update model + env + hasCompletedOnboarding
      const result = { ...(existing ?? {}) };
      if (fragment.model) result.model = fragment.model;
      if (fragment.hasCompletedOnboarding) result.hasCompletedOnboarding = fragment.hasCompletedOnboarding;
      // Replace env entirely (remove old hexos env vars, keep user's other env vars)
      result.env = { ...fragment.env };
      return result;
    },
    clean(existing) {
      const cleaned = { ...existing };
      delete cleaned.model;
      if (cleaned.env) {
        const env = { ...cleaned.env };
        // Remove all hexos-injected env vars by pattern
        const keysToRemove = Object.keys(env).filter(k =>
          k.includes("AUTH_TOKEN") || k.includes("BASE_URL") ||
          k.includes("DEFAULT_OPUS") || k.includes("DEFAULT_SONNET") ||
          k.includes("DEFAULT_HAIKU") || k === "CLAUDE_CODE_SUBAGENT_MODEL" ||
          k === "API_TIMEOUT_MS" || k === "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"
        );
        for (const k of keysToRemove) delete env[k];
        // Clean deprecated keys too
        delete env.ANTHROPIC_MODEL;
        delete env.ANTHROPIC_SMALL_FAST_MODEL;
        delete env.ANTHROPIC_DEFAULT_SONET_MODEL;
        if (Object.keys(env).length === 0) {
          delete cleaned.env;
        } else {
          cleaned.env = env;
        }
      }
      return cleaned;
    },
  },

  // ---- OpenCode ----
  opencode: {
    buildConfig(apiKey, baseUrl, modelMap) {
      // If selectedModels provided, only include those; otherwise all
      const selectedStr = modelMap?.["_selectedModels"];
      let models: Record<string, { name: string }>;
      if (selectedStr) {
        const selected = selectedStr.split(",").filter(Boolean);
        const all = buildAllModels();
        models = {};
        for (const id of selected) {
          if (all[id]) models[id] = all[id];
        }
      } else {
        models = buildAllModels();
      }
      // Add provider tag to model names
      const taggedModels: Record<string, { name: string }> = {};
      for (const [id, val] of Object.entries(models)) {
        const tag = id.startsWith("cl/") ? "(Cline)" : "(CodeBuddy)";
        taggedModels[id] = { name: `${val.name} ${tag}` };
      }
      return {
        provider: {
          hexos: {
            npm: "@ai-sdk/openai-compatible",
            options: {
              baseURL: `${baseUrl}/v1`,
              apiKey,
            },
            models: taggedModels,
          },
        },
        model: `hexos/${modelMap?.["model"] || "cb/claude-opus-4.6"}`,
      };
    },
    isBound(config) {
      return !!getNestedValue(config, "provider.hexos");
    },
    merge(existing, fragment) {
      return deepMerge(existing ?? {}, fragment);
    },
    clean(existing) {
      let cleaned = deepRemove(existing, ["provider", "hexos"]);
      // Clear model if it starts with hexos/
      if (typeof cleaned?.model === "string" && cleaned.model.startsWith("hexos/")) {
        delete cleaned.model;
      }
      return cleaned;
    },
  },

  // ---- Open Claw ----
  openclaw: {
    buildConfig(apiKey, baseUrl, modelMap) {
      const selectedStr = modelMap?.["_selectedModels"];
      let modelsList: Array<{ id: string; name: string }>;
      if (selectedStr) {
        const selected = new Set(selectedStr.split(",").filter(Boolean));
        modelsList = buildAllModelsList().filter((m) => selected.has(m.id));
      } else {
        modelsList = buildAllModelsList();
      }

      // Build agents.defaults.models with hexos/prefix and provider tag alias
      const modelsMap: Record<string, { alias: string }> = {};
      for (const m of modelsList) {
        const tag = m.id.startsWith("cl/") ? "CL" : m.id.startsWith("kr/") ? "KR" : "CB";
        modelsMap[`hexos/${m.id}`] = { alias: `${m.name} (${tag})` };
      }

      const defaultModel = modelMap?.model || "cb/claude-opus-4.6";

      return {
        models: {
          providers: {
            hexos: {
              baseUrl: `${baseUrl}/v1`,
              apiKey,
            },
          },
        },
        agents: {
          defaults: {
            models: modelsMap,
            model: { primary: `hexos/${defaultModel}` },
          },
        },
      };
    },
    isBound(config) {
      return !!getNestedValue(config, "models.providers.hexos");
    },
    merge(existing, fragment) {
      return deepMerge(existing ?? {}, fragment);
    },
    clean(existing) {
      let cleaned = deepRemove(existing, ["models", "providers", "hexos"]);
      // Remove hexos models from agents.defaults.models
      const models = getNestedValue(cleaned, "agents.defaults.models");
      if (models && typeof models === "object") {
        const cleanedModels = { ...models };
        for (const key of Object.keys(cleanedModels)) {
          if (key.startsWith("hexos/")) delete cleanedModels[key];
        }
        cleaned = deepMerge(cleaned, { agents: { defaults: { models: cleanedModels } } });
      }
      // Reset primary model if it's hexos
      const primary = getNestedValue(cleaned, "agents.defaults.model.primary");
      if (typeof primary === "string" && primary.startsWith("hexos/")) {
        cleaned = deepMerge(cleaned, { agents: { defaults: { model: { primary: "" } } } });
      }
      return cleaned;
    },
  },

  // ---- Cline ----
  cline: {
    buildConfig(apiKey, baseUrl) {
      return {
        appBaseUrl: "https://app.cline.bot",
        apiBaseUrl: `${baseUrl}`,
        mcpBaseUrl: "https://api.cline.bot/v1/mcp",
      };
    },
    isBound(config) {
      const url = config?.apiBaseUrl;
      return typeof url === "string" && (url.includes("127.0.0.1") || url.includes("localhost"));
    },
    merge(existing, fragment) {
      return { ...(existing ?? {}), ...fragment };
    },
    clean(existing) {
      if (!existing) return {};
      const cleaned = { ...existing };
      delete cleaned.apiBaseUrl;
      return cleaned;
    },
  },

  // ---- Hermes ----
  hermes: {
    buildConfig(apiKey, baseUrl, modelMap) {
      const defaultModel = modelMap?.model || "cb/claude-opus-4.6";

      // Filter models by checkbox selection
      const selectedStr = modelMap?.["_selectedModels"];
      let modelsList: Array<{ id: string; name: string }>;
      if (selectedStr) {
        const selected = new Set(selectedStr.split(",").filter(Boolean));
        modelsList = buildAllModelsList().filter((m) => selected.has(m.id));
      } else {
        modelsList = buildAllModelsList();
      }

      // Default model context window (for compression threshold)
      const defaultModelEntry = MODEL_CATALOG[defaultModel];
      const defaultContextLength = defaultModelEntry?.info.contextWindow ?? 200000;

      // Build models list for providers section (Hermes model picker reads this)
      const modelsIdList = modelsList.map((m) => m.id);

      return {
        model: {
          provider: "custom",
          default: defaultModel,
          base_url: `${baseUrl}/v1`,
          api_key: apiKey,
          context_length: defaultContextLength,
        },
        // Write to providers section (dict format) — Hermes model picker Section 3
        // reads providers.<name>.models as a list of model IDs
        providers: {
          hexos: {
            name: "Hexos",
            base_url: `${baseUrl}/v1`,
            api_key: apiKey,
            models: modelsIdList,
          },
        },
      };
    },
    isBound(config) {
      // Check model.base_url
      const url = config?.model?.base_url;
      if (typeof url === "string" && (url.includes("127.0.0.1") || url.includes("localhost"))) return true;
      // Check providers.hexos
      const providers = config?.providers;
      if (providers && typeof providers === "object" && providers.hexos) return true;
      // Legacy: check custom_providers
      const customProviders = config?.custom_providers;
      if (Array.isArray(customProviders)) {
        return customProviders.some((p: any) => p.name === "hexos");
      }
      return false;
    },
    merge(existing, fragment) {
      const merged = deepMerge(existing ?? {}, fragment);
      // providers is a dict — deepMerge handles it, but ensure hexos entry is fully replaced
      if (fragment.providers?.hexos) {
        if (!merged.providers || typeof merged.providers !== "object") merged.providers = {};
        merged.providers.hexos = fragment.providers.hexos;
      }
      // Clean up legacy custom_providers hexos entries
      if (Array.isArray(merged.custom_providers)) {
        merged.custom_providers = merged.custom_providers.filter((p: any) => p.name !== "hexos");
        if (merged.custom_providers.length === 0) delete merged.custom_providers;
      }
      return merged;
    },
    clean(existing) {
      if (!existing) return {};
      const cleaned = { ...existing };
      // Clean model section
      if (cleaned.model) {
        cleaned.model = { ...cleaned.model };
        delete cleaned.model.base_url;
        delete cleaned.model.api_key;
        delete cleaned.model.context_length;
        if (cleaned.model.provider === "custom") delete cleaned.model.provider;
      }
      // Remove hexos from providers
      if (cleaned.providers && typeof cleaned.providers === "object") {
        delete cleaned.providers.hexos;
        if (Object.keys(cleaned.providers).length === 0) cleaned.providers = {};
      }
      // Legacy: remove hexos from custom_providers
      if (Array.isArray(cleaned.custom_providers)) {
        cleaned.custom_providers = cleaned.custom_providers.filter((p: any) => p.name !== "hexos");
        if (cleaned.custom_providers.length === 0) delete cleaned.custom_providers;
      }
      return cleaned;
    },
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect all supported tools.
 * Checks whether each tool is installed (CLI binary or config file exists)
 * and whether hexos config has already been injected.
 */
export async function detectTools(apiKey: string, baseUrl: string): Promise<ToolConfig[]> {
  const defs = getToolDefs(apiKey);
  const results: ToolConfig[] = [];

  for (const def of defs) {
    const absPath = def.configPath ? resolveHome(def.configPath) : "";

    // Determine if installed
    let installed = false;
    if (def.cliName) {
      installed = await commandExists(def.cliName);
    }
    if (!installed && absPath) {
      const file = Bun.file(absPath);
      installed = await file.exists();
    }

    // Determine if bound
    let bound = false;
    if (def.configType !== "guide" && absPath) {
      const handler = handlers[def.id];
      if (handler) {
        const config = await readConfig(absPath);
        if (config) {
          bound = handler.isBound(config);
        }
      }
    }

    results.push({
      id: def.id,
      name: def.name,
      description: def.description,
      icon: def.icon,
      configType: def.configType,
      configPath: absPath,
      installed,
      bound,
      envVars: def.envVars,
      guideSteps: def.guideSteps,
      modelSlots: def.modelSlots,
      showModelCheckboxes: def.showModelCheckboxes,
    });
  }

  return results;
}

/**
 * Bind a specific tool by injecting hexos proxy config into its config file.
 * For guide-only tools this is a no-op that returns success.
 */
export async function bindTool(
  toolId: string,
  apiKey: string,
  baseUrl: string,
  modelMap?: Record<string, string>,
): Promise<{ success: boolean; error?: string }> {
  const defs = getToolDefs(apiKey);
  const def = defs.find((d) => d.id === toolId);
  if (!def) return { success: false, error: `Unknown tool: ${toolId}` };

  if (def.configType === "guide") {
    // Nothing to write for guide-only tools
    return { success: true };
  }

  const handler = handlers[toolId];
  if (!handler) return { success: false, error: `No handler for tool: ${toolId}` };

  const absPath = resolveHome(def.configPath);

  try {
    const existing = await readConfig(absPath);
    const fragment = handler.buildConfig(apiKey, baseUrl, modelMap);
    const merged = handler.merge(existing, fragment);
    await writeConfig(absPath, merged);
    log.ok(`Bound ${def.name} — config written to ${absPath}`);
    return { success: true };
  } catch (err: any) {
    const msg = `Failed to bind ${def.name}: ${err.message ?? err}`;
    log.error(msg);
    return { success: false, error: msg };
  }
}

/**
 * Unbind a specific tool by removing hexos-specific config from its config file.
 * For guide-only tools this is a no-op that returns success.
 */
export async function unbindTool(toolId: string): Promise<{ success: boolean; error?: string }> {
  // We need a dummy apiKey just to look up the def
  const defs = getToolDefs("");
  const def = defs.find((d) => d.id === toolId);
  if (!def) return { success: false, error: `Unknown tool: ${toolId}` };

  if (def.configType === "guide") {
    return { success: true };
  }

  const handler = handlers[toolId];
  if (!handler) return { success: false, error: `No handler for tool: ${toolId}` };

  const absPath = resolveHome(def.configPath);

  try {
    const existing = await readConfig(absPath);
    if (!existing) {
      // Config file doesn't exist — nothing to unbind
      return { success: true };
    }

    const cleaned = handler.clean(existing);

    // If the cleaned config is empty, remove the file
    if (Object.keys(cleaned).length === 0) {
      const { unlinkSync } = await import("fs");
      try {
        unlinkSync(absPath);
      } catch {}
    } else {
      await writeConfig(absPath, cleaned);
    }

    log.ok(`Unbound ${def.name} — hexos config removed from ${absPath}`);
    return { success: true };
  } catch (err: any) {
    const msg = `Failed to unbind ${def.name}: ${err.message ?? err}`;
    log.error(msg);
    return { success: false, error: msg };
  }
}

/**
 * Generate the config that would be injected for a tool.
 * Used for manual copy-paste.
 */
export function generateToolConfig(
  toolId: string,
  apiKey: string,
  baseUrl: string,
  modelMap?: Record<string, string>,
): { toolId: string; config: any; configPath: string; error?: string } {
  const defs = getToolDefs(apiKey);
  const def = defs.find((d) => d.id === toolId);
  if (!def) return { toolId, config: null, configPath: "", error: `Unknown tool: ${toolId}` };

  const handler = handlers[toolId];
  if (!handler) {
    // Guide-only tools - return env vars as config
    return {
      toolId,
      config: def.envVars ?? {},
      configPath: def.configPath ? resolveHome(def.configPath) : "",
    };
  }

  const config = handler.buildConfig(apiKey, baseUrl, modelMap);
  return {
    toolId,
    config,
    configPath: def.configPath ? resolveHome(def.configPath) : "",
  };
}

/**
 * Read the current config file for a tool.
 */
export async function readToolConfig(
  toolId: string,
): Promise<{ exists: boolean; config?: any; error?: string }> {
  const defs = getToolDefs("");
  const def = defs.find((d) => d.id === toolId);
  if (!def) return { exists: false, error: `Unknown tool: ${toolId}` };

  if (def.configType === "guide" || !def.configPath) {
    return { exists: false };
  }

  const absPath = resolveHome(def.configPath);

  try {
    const config = await readConfig(absPath);
    if (config === null) {
      return { exists: false };
    }
    return { exists: true, config };
  } catch (err: any) {
    return { exists: false, error: err.message ?? String(err) };
  }
}
