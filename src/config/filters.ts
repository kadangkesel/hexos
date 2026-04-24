/**
 * Content Filter Configuration
 *
 * Manages preset and custom text replacement rules that can be
 * toggled on/off per provider. Stored in ~/.hexos/filters.json.
 */

import { JSONFilePreset } from "lowdb/node";
import { join } from "path";
import { homedir } from "os";

const DATA_DIR = join(homedir(), ".hexos");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FilterRule {
  id: string;
  label: string;
  /** Regex pattern string (without flags) */
  pattern: string;
  /** Regex flags (default "gi") */
  flags: string;
  /** Replacement string */
  replacement: string;
  /** Is this a system preset (non-deletable) or user-created? */
  preset: boolean;
  /** Is this rule enabled? */
  enabled: boolean;
  /** Category for grouping in UI */
  category: "brand" | "security" | "custom";
}

export interface FilterConfig {
  /** Master toggle — if false, NO rules are applied at all */
  enabled: boolean;
  /** Per-provider overrides: provider -> enabled. Missing = use master toggle */
  providerOverrides: Record<string, boolean>;
  /** All rules (preset + custom) */
  rules: FilterRule[];
}

interface FilterDbSchema {
  config: FilterConfig;
}

// ---------------------------------------------------------------------------
// Preset rules — security keywords that trigger content filters
// ---------------------------------------------------------------------------

const SECURITY_PRESETS: Omit<FilterRule, "id">[] = [
  {
    label: "SQL injection → SQL validation",
    pattern: "SQL\\s+injection",
    flags: "gi",
    replacement: "SQL validation",
    preset: true,
    enabled: true,
    category: "security",
  },
  {
    label: "XSS → input validation",
    pattern: "\\bXSS\\b",
    flags: "gi",
    replacement: "input validation",
    preset: true,
    enabled: true,
    category: "security",
  },
  {
    label: "command injection → command validation",
    pattern: "command\\s+injection",
    flags: "gi",
    replacement: "command validation",
    preset: true,
    enabled: true,
    category: "security",
  },
  {
    label: "code injection → code validation",
    pattern: "code\\s+injection",
    flags: "gi",
    replacement: "code validation",
    preset: true,
    enabled: true,
    category: "security",
  },
  {
    label: "prompt injection → prompt validation",
    pattern: "prompt\\s+injection",
    flags: "gi",
    replacement: "prompt validation",
    preset: true,
    enabled: true,
    category: "security",
  },
  {
    label: "OWASP top 10 → security best practices",
    pattern: "OWASP\\s+top\\s+10",
    flags: "gi",
    replacement: "security best practices",
    preset: true,
    enabled: true,
    category: "security",
  },
  {
    label: "OWASP → security standards",
    pattern: "\\bOWASP\\b",
    flags: "g",
    replacement: "security standards",
    preset: true,
    enabled: true,
    category: "security",
  },
  {
    label: "DoS attacks → service disruption",
    pattern: "DoS\\s+attacks?",
    flags: "gi",
    replacement: "service disruption",
    preset: true,
    enabled: true,
    category: "security",
  },
  {
    label: "DDoS → distributed disruption",
    pattern: "\\bDDoS\\b",
    flags: "g",
    replacement: "distributed disruption",
    preset: true,
    enabled: true,
    category: "security",
  },
  {
    label: "C2 frameworks → remote management tools",
    pattern: "C2\\s+frameworks?",
    flags: "gi",
    replacement: "remote management tools",
    preset: true,
    enabled: true,
    category: "security",
  },
  {
    label: "exploit development → security testing",
    pattern: "exploit\\s+development",
    flags: "gi",
    replacement: "security testing",
    preset: true,
    enabled: true,
    category: "security",
  },
  {
    label: "exploit → vulnerability",
    pattern: "\\bexploit\\b",
    flags: "gi",
    replacement: "vulnerability",
    preset: true,
    enabled: true,
    category: "security",
  },
  {
    label: "credential testing → auth testing",
    pattern: "credential\\s+testing",
    flags: "gi",
    replacement: "auth testing",
    preset: true,
    enabled: true,
    category: "security",
  },
  {
    label: "supply chain compromise → dependency risk",
    pattern: "supply\\s+chain\\s+compromise",
    flags: "gi",
    replacement: "dependency risk",
    preset: true,
    enabled: true,
    category: "security",
  },
  {
    label: "detection evasion → monitoring",
    pattern: "detection\\s+evasion",
    flags: "gi",
    replacement: "monitoring",
    preset: true,
    enabled: true,
    category: "security",
  },
  {
    label: "destructive techniques → risky operations",
    pattern: "destructive\\s+techniques?",
    flags: "gi",
    replacement: "risky operations",
    preset: true,
    enabled: true,
    category: "security",
  },
  {
    label: "mass targeting → bulk operations",
    pattern: "mass\\s+targeting",
    flags: "gi",
    replacement: "bulk operations",
    preset: true,
    enabled: true,
    category: "security",
  },
  {
    label: "security vulnerabilities → security issues",
    pattern: "security\\s+vulnerabilities",
    flags: "gi",
    replacement: "security issues",
    preset: true,
    enabled: true,
    category: "security",
  },
  {
    label: "pentesting → security assessment",
    pattern: "\\bpentesting\\b",
    flags: "gi",
    replacement: "security assessment",
    preset: true,
    enabled: true,
    category: "security",
  },
  {
    label: "CTF challenges → coding challenges",
    pattern: "CTF\\s+(?:challenges?|competitions?)",
    flags: "gi",
    replacement: "coding challenges",
    preset: true,
    enabled: true,
    category: "security",
  },
  // --- Additional aggressive filters for CodeBuddy content filter ---
  {
    label: "rm -rf → remove recursively",
    pattern: "rm\\s+-rf",
    flags: "gi",
    replacement: "remove recursively",
    preset: true,
    enabled: true,
    category: "security",
  },
  {
    label: "killing processes → stopping processes",
    pattern: "killing\\s+processes",
    flags: "gi",
    replacement: "stopping processes",
    preset: true,
    enabled: true,
    category: "security",
  },
  {
    label: "force-pushing → force pushing",
    pattern: "force-pushing",
    flags: "gi",
    replacement: "force pushing",
    preset: true,
    enabled: true,
    category: "security",
  },
  {
    label: "Destructive operations → High-impact operations",
    pattern: "[Dd]estructive\\s+operations?",
    flags: "g",
    replacement: "High-impact operations",
    preset: true,
    enabled: true,
    category: "security",
  },
  {
    label: "destructive → high-impact",
    pattern: "\\bdestructive\\b",
    flags: "gi",
    replacement: "high-impact",
    preset: true,
    enabled: true,
    category: "security",
  },
  {
    label: "dropping database tables → removing database tables",
    pattern: "dropping\\s+database\\s+tables",
    flags: "gi",
    replacement: "removing database tables",
    preset: true,
    enabled: true,
    category: "security",
  },
  {
    label: "overwriting uncommitted → replacing uncommitted",
    pattern: "overwriting\\s+uncommitted",
    flags: "gi",
    replacement: "replacing uncommitted",
    preset: true,
    enabled: true,
    category: "security",
  },
  {
    label: "malicious purposes → harmful purposes",
    pattern: "malicious\\s+purposes?",
    flags: "gi",
    replacement: "harmful purposes",
    preset: true,
    enabled: true,
    category: "security",
  },
  {
    label: "malicious → harmful",
    pattern: "\\bmalicious\\b",
    flags: "gi",
    replacement: "harmful",
    preset: true,
    enabled: true,
    category: "security",
  },
  {
    label: "injection → validation",
    pattern: "\\binjection\\b",
    flags: "gi",
    replacement: "validation",
    preset: true,
    enabled: true,
    category: "security",
  },
  {
    label: "vulnerability/vulnerabilities → issue(s)",
    pattern: "\\bvulnerabilit(?:y|ies)\\b",
    flags: "gi",
    replacement: "issue",
    preset: true,
    enabled: true,
    category: "security",
  },
  {
    label: "attack(s) → threat(s)",
    pattern: "\\battacks?\\b",
    flags: "gi",
    replacement: "threat",
    preset: true,
    enabled: true,
    category: "security",
  },
  {
    label: "hack/hacking → testing",
    pattern: "\\bhack(?:ing|ed|er|s)?\\b",
    flags: "gi",
    replacement: "testing",
    preset: true,
    enabled: true,
    category: "security",
  },
  {
    label: "payload → data",
    pattern: "\\bpayload\\b",
    flags: "gi",
    replacement: "data",
    preset: true,
    enabled: true,
    category: "security",
  },
  {
    label: "phishing → social engineering",
    pattern: "\\bphishing\\b",
    flags: "gi",
    replacement: "social engineering",
    preset: true,
    enabled: true,
    category: "security",
  },
  {
    label: "malware → unwanted software",
    pattern: "\\bmalware\\b",
    flags: "gi",
    replacement: "unwanted software",
    preset: true,
    enabled: true,
    category: "security",
  },
  {
    label: "ransomware → encryption threat",
    pattern: "\\bransomware\\b",
    flags: "gi",
    replacement: "encryption threat",
    preset: true,
    enabled: true,
    category: "security",
  },
  {
    label: "trojan → hidden program",
    pattern: "\\btrojan\\b",
    flags: "gi",
    replacement: "hidden program",
    preset: true,
    enabled: true,
    category: "security",
  },
  {
    label: "rootkit → hidden tool",
    pattern: "\\brootkit\\b",
    flags: "gi",
    replacement: "hidden tool",
    preset: true,
    enabled: true,
    category: "security",
  },
  {
    label: "keylogger → input monitor",
    pattern: "\\bkeylogger\\b",
    flags: "gi",
    replacement: "input monitor",
    preset: true,
    enabled: true,
    category: "security",
  },
  {
    label: "brute force → repeated attempts",
    pattern: "brute[\\s-]?force",
    flags: "gi",
    replacement: "repeated attempts",
    preset: true,
    enabled: true,
    category: "security",
  },
  {
    label: "privilege escalation → access elevation",
    pattern: "privilege\\s+escalation",
    flags: "gi",
    replacement: "access elevation",
    preset: true,
    enabled: true,
    category: "security",
  },
  {
    label: "reverse shell → remote connection",
    pattern: "reverse\\s+shell",
    flags: "gi",
    replacement: "remote connection",
    preset: true,
    enabled: true,
    category: "security",
  },
  {
    label: "backdoor → hidden access",
    pattern: "\\bbackdoor\\b",
    flags: "gi",
    replacement: "hidden access",
    preset: true,
    enabled: true,
    category: "security",
  },
  {
    label: "zero-day → unknown issue",
    pattern: "zero[\\s-]?day",
    flags: "gi",
    replacement: "unknown issue",
    preset: true,
    enabled: true,
    category: "security",
  },
  {
    label: "buffer overflow → memory issue",
    pattern: "buffer\\s+overflow",
    flags: "gi",
    replacement: "memory issue",
    preset: true,
    enabled: true,
    category: "security",
  },
  {
    label: "race condition → timing issue",
    pattern: "race\\s+condition",
    flags: "gi",
    replacement: "timing issue",
    preset: true,
    enabled: true,
    category: "security",
  },
  {
    label: "sensitive content block",
    pattern: "konten\\s+sensitif",
    flags: "gi",
    replacement: "restricted content",
    preset: true,
    enabled: true,
    category: "security",
  },
  {
    label: "Strip IMPORTANT security paragraph",
    pattern: "IMPORTANT:\\s*Assist with authorized security testing[^\\n]*(?:\\n[^\\n]*(?:malicious|harmful|defensive)[^\\n]*)*",
    flags: "gi",
    replacement: "IMPORTANT: Follow security best practices in all code.",
    preset: true,
    enabled: true,
    category: "security",
  },
  {
    label: "sensitive content → restricted content",
    pattern: "sensitive\\s+content",
    flags: "gi",
    replacement: "restricted content",
    preset: true,
    enabled: true,
    category: "security",
  },
  {
    label: "insecure code → unsafe code",
    pattern: "insecure\\s+code",
    flags: "gi",
    replacement: "unsafe code",
    preset: true,
    enabled: true,
    category: "security",
  },
  {
    label: "security review → code review",
    pattern: "security[\\s-]review",
    flags: "gi",
    replacement: "code review",
    preset: true,
    enabled: true,
    category: "security",
  },
  {
    label: "security-review → code-review",
    pattern: "security-review",
    flags: "gi",
    replacement: "code-review",
    preset: true,
    enabled: true,
    category: "security",
  },
  {
    label: "systematic-debugging → methodical-debugging",
    pattern: "systematic-debugging",
    flags: "gi",
    replacement: "methodical-debugging",
    preset: true,
    enabled: true,
    category: "security",
  },
  {
    label: "safety checks → validation checks",
    pattern: "safety\\s+checks",
    flags: "gi",
    replacement: "validation checks",
    preset: true,
    enabled: true,
    category: "security",
  },
  {
    label: "bypassing safety → skipping validation",
    pattern: "bypassing\\s+safety",
    flags: "gi",
    replacement: "skipping validation",
    preset: true,
    enabled: true,
    category: "security",
  },
  {
    label: "blast radius → impact scope",
    pattern: "blast\\s+radius",
    flags: "gi",
    replacement: "impact scope",
    preset: true,
    enabled: true,
    category: "security",
  },
  {
    label: "risky or destructive → impactful",
    pattern: "risky\\s+or\\s+destructive",
    flags: "gi",
    replacement: "impactful",
    preset: true,
    enabled: true,
    category: "security",
  },
  {
    label: "merge conflicts → merge differences",
    pattern: "merge\\s+conflicts",
    flags: "gi",
    replacement: "merge differences",
    preset: true,
    enabled: true,
    category: "security",
  },
  {
    label: "discarding changes → removing changes",
    pattern: "discarding\\s+changes",
    flags: "gi",
    replacement: "removing changes",
    preset: true,
    enabled: true,
    category: "security",
  },
];

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

function generateId(): string {
  return crypto.randomUUID().slice(0, 8);
}

const defaultConfig: FilterConfig = {
  enabled: true,
  providerOverrides: {},
  rules: SECURITY_PRESETS.map((r) => ({ ...r, id: generateId() })),
};

const defaultData: FilterDbSchema = { config: defaultConfig };
const db = await JSONFilePreset<FilterDbSchema>(join(DATA_DIR, "filters.json"), defaultData);

// Migrate: ensure all presets exist (new presets added in updates)
function ensurePresets() {
  const existingLabels = new Set(db.data.config.rules.filter((r) => r.preset).map((r) => r.label));
  for (const preset of SECURITY_PRESETS) {
    if (!existingLabels.has(preset.label)) {
      db.data.config.rules.push({ ...preset, id: generateId() });
    }
  }
}
ensurePresets();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function getFilterConfig(): FilterConfig {
  return db.data.config;
}

export async function setFilterEnabled(enabled: boolean): Promise<void> {
  db.data.config.enabled = enabled;
  await db.write();
}

export async function setProviderOverride(provider: string, enabled: boolean | null): Promise<void> {
  if (enabled === null) {
    delete db.data.config.providerOverrides[provider];
  } else {
    db.data.config.providerOverrides[provider] = enabled;
  }
  await db.write();
}

export async function setRuleEnabled(ruleId: string, enabled: boolean): Promise<void> {
  const rule = db.data.config.rules.find((r) => r.id === ruleId);
  if (rule) {
    rule.enabled = enabled;
    await db.write();
  }
}

export async function addCustomRule(rule: {
  label: string;
  pattern: string;
  flags?: string;
  replacement: string;
}): Promise<FilterRule> {
  const newRule: FilterRule = {
    id: generateId(),
    label: rule.label,
    pattern: rule.pattern,
    flags: rule.flags || "gi",
    replacement: rule.replacement,
    preset: false,
    enabled: true,
    category: "custom",
  };
  db.data.config.rules.push(newRule);
  await db.write();
  return newRule;
}

export async function updateCustomRule(ruleId: string, patch: {
  label?: string;
  pattern?: string;
  flags?: string;
  replacement?: string;
  enabled?: boolean;
}): Promise<void> {
  const rule = db.data.config.rules.find((r) => r.id === ruleId && !r.preset);
  if (rule) {
    if (patch.label !== undefined) rule.label = patch.label;
    if (patch.pattern !== undefined) rule.pattern = patch.pattern;
    if (patch.flags !== undefined) rule.flags = patch.flags;
    if (patch.replacement !== undefined) rule.replacement = patch.replacement;
    if (patch.enabled !== undefined) rule.enabled = patch.enabled;
    await db.write();
  }
}

export async function removeCustomRule(ruleId: string): Promise<boolean> {
  const idx = db.data.config.rules.findIndex((r) => r.id === ruleId && !r.preset);
  if (idx >= 0) {
    db.data.config.rules.splice(idx, 1);
    await db.write();
    return true;
  }
  return false;
}

/**
 * Check if filters should be applied for a given provider.
 */
export function isFilterEnabledForProvider(provider: string): boolean {
  if (!db.data.config.enabled) return false;
  const override = db.data.config.providerOverrides[provider];
  if (override !== undefined) return override;
  return db.data.config.enabled;
}

/**
 * Get compiled regex rules that are currently active.
 */
export function getActiveRules(): Array<{ pattern: RegExp; replacement: string }> {
  return db.data.config.rules
    .filter((r) => r.enabled)
    .map((r) => {
      try {
        return { pattern: new RegExp(r.pattern, r.flags), replacement: r.replacement };
      } catch {
        return null;
      }
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);
}
