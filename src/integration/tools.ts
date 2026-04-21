import { homedir } from "os";
import { join } from "path";
import { exec } from "child_process";
import { log } from "../utils/logger.ts";

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
}

const PROXY_BASE = "http://127.0.0.1:8080";

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
        ANTHROPIC_BASE_URL: `${PROXY_BASE}/v1`,
        ANTHROPIC_AUTH_TOKEN: apiKey,
      },
      modelSlots: [
        { key: "model", label: "Default Model", default: "claude-opus-4.6" },
        { key: "ANTHROPIC_DEFAULT_OPUS_MODEL", label: "Opus Model", default: "claude-opus-4.6" },
        { key: "ANTHROPIC_DEFAULT_SONNET_MODEL", label: "Sonnet Model", default: "claude-opus-4.6" },
        { key: "ANTHROPIC_DEFAULT_HAIKU_MODEL", label: "Haiku / Background", default: "claude-haiku-4.5" },
        { key: "CLAUDE_CODE_SUBAGENT_MODEL", label: "Subagent Model", default: "claude-haiku-4.5" },
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
      modelSlots: [
        { key: "model", label: "Active Model", default: "cb/claude-opus-4.6" },
      ],
    },
    {
      id: "openclaw",
      name: "Open Claw",
      description: "Open-source Claude Code alternative",
      icon: "cat",
      configType: "custom",
      configPath: "~/.openclaw/openclaw.json",
      cliName: "openclaw",
      modelSlots: [
        { key: "model", label: "Primary Model", default: "cb/claude-opus-4.6" },
      ],
    },
    {
      id: "hermes",
      name: "Hermes",
      description: "AI coding agent - configure via environment variables",
      icon: "zap",
      configType: "guide",
      configPath: "",
      cliName: "hermes",
      envVars: {
        OPENAI_API_KEY: apiKey,
        OPENAI_BASE_URL: `${PROXY_BASE}/v1`,
      },
      guideSteps: [
        "Set the following environment variables before running Hermes:",
        `  export OPENAI_API_KEY="${apiKey}"`,
        `  export OPENAI_BASE_URL="${PROXY_BASE}/v1"`,
        "Then start Hermes as usual.",
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
      return {
        model: mm["model"] || "claude-opus-4.6",
        hasCompletedOnboarding: true,
        env: {
          ANTHROPIC_AUTH_TOKEN: apiKey,
          ANTHROPIC_BASE_URL: `${baseUrl}/v1`,
          ANTHROPIC_DEFAULT_OPUS_MODEL: mm["ANTHROPIC_DEFAULT_OPUS_MODEL"] || "claude-opus-4.6",
          ANTHROPIC_DEFAULT_SONNET_MODEL: mm["ANTHROPIC_DEFAULT_SONNET_MODEL"] || "claude-opus-4.6",
          ANTHROPIC_DEFAULT_HAIKU_MODEL: mm["ANTHROPIC_DEFAULT_HAIKU_MODEL"] || "claude-haiku-4.5",
          CLAUDE_CODE_SUBAGENT_MODEL: mm["CLAUDE_CODE_SUBAGENT_MODEL"] || "claude-haiku-4.5",
          API_TIMEOUT_MS: "3000000",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        },
      };
    },
    isBound(config) {
      const url = getNestedValue(config, "env.ANTHROPIC_BASE_URL");
      return typeof url === "string" && (url.includes("127.0.0.1") || url.includes("localhost"));
    },
    merge(existing, fragment) {
      return deepMerge(existing ?? {}, fragment);
    },
    clean(existing) {
      const cleaned = { ...existing };
      delete cleaned.model;
      if (cleaned.env) {
        const env = { ...cleaned.env };
        delete env.ANTHROPIC_BASE_URL;
        delete env.ANTHROPIC_AUTH_TOKEN;
        delete env.ANTHROPIC_DEFAULT_OPUS_MODEL;
        delete env.ANTHROPIC_DEFAULT_SONNET_MODEL;
        delete env.ANTHROPIC_DEFAULT_HAIKU_MODEL;
        delete env.CLAUDE_CODE_SUBAGENT_MODEL;
        delete env.API_TIMEOUT_MS;
        delete env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
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
      return {
        provider: {
          hexos: {
            npm: "@ai-sdk/openai-compatible",
            options: {
              baseURL: `${baseUrl}/v1`,
              apiKey,
            },
            models: {
              "cb/claude-opus-4.6": { name: "Claude Opus 4.6" },
              "cb/claude-haiku-4.5": { name: "Claude Haiku 4.5" },
              "cb/gpt-5.4": { name: "GPT-5.4" },
              "cb/gemini-2.5-pro": { name: "Gemini 2.5 Pro" },
            },
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
    buildConfig(apiKey, baseUrl) {
      return {
        models: {
          providers: {
            hexos: {
              baseUrl: `${baseUrl}/v1`,
              apiKey,
              api: "openai-completions",
              models: [
                { id: "cb/claude-opus-4.6", name: "Claude Opus 4.6" },
                { id: "cb/claude-haiku-4.5", name: "Claude Haiku 4.5" },
                { id: "cb/gpt-5.4", name: "GPT-5.4" },
                { id: "cb/gemini-2.5-pro", name: "Gemini 2.5 Pro" },
              ],
            },
          },
        },
        agents: {
          defaults: {
            model: { primary: "hexos/cb/claude-opus-4.6" },
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
      return deepRemove(existing, ["models", "providers", "hexos"]);
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
        const config = await readJson(absPath);
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
    const existing = await readJson(absPath);
    const fragment = handler.buildConfig(apiKey, baseUrl, modelMap);
    const merged = handler.merge(existing, fragment);
    await writeJson(absPath, merged);
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
    const existing = await readJson(absPath);
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
      await writeJson(absPath, cleaned);
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
    const config = await readJson(absPath);
    if (config === null) {
      return { exists: false };
    }
    return { exists: true, config };
  } catch (err: any) {
    return { exists: false, error: err.message ?? String(err) };
  }
}
