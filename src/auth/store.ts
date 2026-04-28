import { JSONFilePreset } from "lowdb/node";
import { join } from "path";
import { homedir } from "os";
import { generateApiKey } from "../utils/crypto.ts";
import { getLatestTokenBundle, saveTokenBundle } from "./token-vault.ts";

const DATA_DIR = join(homedir(), ".hexos");
await Bun.write(join(DATA_DIR, ".keep"), "").catch(() => {});

export interface CreditInfo {
  totalCredits: number;
  remainingCredits: number;
  usedCredits: number;
  packageName: string;
  expiresAt: string;
  fetchedAt: number;
}

export interface Connection {
  id: string;
  provider: string;
  label: string;
  accessToken: string;
  refreshToken?: string;
  uid?: string;
  expiresAt?: number;
  createdAt: number;
  // Multi-account tracking fields
  usageCount: number;
  lastUsedAt: number | null;
  status: "active" | "expired" | "disabled";
  failCount: number;
  // Credit info
  credit?: CreditInfo;
  // Web cookie for Service billing API (cookie-based auth, not Bearer)
  webCookie?: string;
}

interface DbSchema {
  apiKeys: string[];
  connections: Connection[];
}

const defaultData: DbSchema = { apiKeys: [], connections: [] };
const db = await JSONFilePreset<DbSchema>(join(DATA_DIR, "db.json"), defaultData);

// Migrate old connections that don't have the new fields
for (const conn of db.data.connections) {
  if (conn.usageCount === undefined) conn.usageCount = 0;
  if (conn.lastUsedAt === undefined) conn.lastUsedAt = null;
  if (conn.status === undefined) conn.status = "active";
  if (conn.failCount === undefined) conn.failCount = 0;

  // Codex refresh tokens rotate and are easy to lose if a process dies between
  // upstream refresh success and db.json write. Mirror them into a small
  // append-safe vault and restore the newest bundle on boot.
  if (conn.provider === "codex" && conn.refreshToken) {
    const vaulted = await getLatestTokenBundle(conn.provider, conn.id);
    if (vaulted && vaulted.updatedAt > (conn.createdAt ?? 0) && vaulted.refreshToken !== conn.refreshToken) {
      conn.accessToken = vaulted.accessToken;
      conn.refreshToken = vaulted.refreshToken;
      conn.status = "active";
    } else if (!vaulted) {
      await saveTokenBundle(conn.provider, conn.id, {
        accessToken: conn.accessToken,
        refreshToken: conn.refreshToken,
        source: "store-migration",
      });
    }
  }
}

// API Keys
export async function createApiKey(): Promise<string> {
  const key = generateApiKey();
  db.data.apiKeys.push(key);
  await db.write();
  return key;
}

export async function validateApiKey(key: string): Promise<boolean> {
  return db.data.apiKeys.includes(key);
}

export function getApiKeys(): string[] {
  return db.data.apiKeys;
}

// Connections
export async function saveConnection(conn: Omit<Connection, "id" | "createdAt" | "usageCount" | "lastUsedAt" | "status" | "failCount">): Promise<Connection> {
  const existing = db.data.connections.findIndex((c) => c.provider === conn.provider && c.label === conn.label);
  const full: Connection = {
    ...conn,
    id: crypto.randomUUID(),
    createdAt: Date.now(),
    usageCount: 0,
    lastUsedAt: null,
    status: "active",
    failCount: 0,
  };
  if (existing >= 0) {
    // Preserve usage stats on reconnect, reset status.
    // IMPORTANT: Never overwrite existing tokens with empty strings.
    // This prevents re-login attempts that fail to get tokens from
    // wiping out previously valid credentials.
    const patch: Record<string, any> = {
      ...conn,
      status: "active",
      failCount: 0,
    };
    // Don't overwrite existing tokens with empty values
    if (!patch.accessToken && db.data.connections[existing].accessToken) {
      delete patch.accessToken;
    }
    if (!patch.refreshToken && db.data.connections[existing].refreshToken) {
      delete patch.refreshToken;
    }
    if (!patch.uid && db.data.connections[existing].uid) {
      delete patch.uid;
    }
    db.data.connections[existing] = {
      ...db.data.connections[existing],
      ...patch,
    };
    await db.write();
    const saved = db.data.connections[existing];
    if (saved.provider === "codex" && saved.refreshToken) {
      await saveTokenBundle(saved.provider, saved.id, {
        accessToken: saved.accessToken,
        refreshToken: saved.refreshToken,
        source: "saveConnection",
      });
    }
    return saved;
  }
  db.data.connections.push(full);
  await db.write();
  if (full.provider === "codex" && full.refreshToken) {
    await saveTokenBundle(full.provider, full.id, {
      accessToken: full.accessToken,
      refreshToken: full.refreshToken,
      source: "saveConnection",
    });
  }
  return full;
}

export function getConnections(provider: string): Connection[] {
  return db.data.connections.filter((c) => c.provider === provider);
}

/**
 * Get active connections for a provider (excludes disabled).
 */
export function getActiveConnections(provider: string): Connection[] {
  return db.data.connections.filter(
    (c) => c.provider === provider && c.status !== "disabled"
  );
}

/**
 * Get the least-used active connection for a provider.
 * Strategy: pick the connection with the lowest usageCount.
 * Ties are broken by lastUsedAt (oldest first), then by createdAt.
 */
export function getLeastUsedConnection(provider: string): Connection | null {
  const active = getActiveConnections(provider);
  if (active.length === 0) return null;

  return active.reduce((best, conn) => {
    // Lower usage count wins
    if (conn.usageCount < best.usageCount) return conn;
    if (conn.usageCount > best.usageCount) return best;

    // Same usage count: prefer the one used least recently
    const connLast = conn.lastUsedAt ?? 0;
    const bestLast = best.lastUsedAt ?? 0;
    if (connLast < bestLast) return conn;
    if (connLast > bestLast) return best;

    // Same lastUsedAt: prefer older connection
    return conn.createdAt < best.createdAt ? conn : best;
  });
}

/**
 * Increment usage counter and update lastUsedAt timestamp.
 * Also resets failCount on successful use.
 */
export async function incrementUsage(id: string) {
  const idx = db.data.connections.findIndex((c) => c.id === id);
  if (idx >= 0) {
    db.data.connections[idx].usageCount++;
    db.data.connections[idx].lastUsedAt = Date.now();
    db.data.connections[idx].failCount = 0;
    await db.write();
  }
}

/**
 * Record a failure for a connection.
 * After 3 consecutive failures, the connection is marked as disabled.
 */
export async function recordFailure(id: string, maxFails = 3) {
  const idx = db.data.connections.findIndex((c) => c.id === id);
  if (idx >= 0) {
    db.data.connections[idx].failCount++;
    if (db.data.connections[idx].failCount >= maxFails) {
      db.data.connections[idx].status = "disabled";
    }
    await db.write();
  }
}

/**
 * Mark a connection with a specific status.
 */
export async function setConnectionStatus(id: string, status: Connection["status"]) {
  const idx = db.data.connections.findIndex((c) => c.id === id);
  if (idx >= 0) {
    db.data.connections[idx].status = status;
    if (status === "active") db.data.connections[idx].failCount = 0;
    await db.write();
  }
}

export async function updateConnection(id: string, patch: Partial<Connection>) {
  const idx = db.data.connections.findIndex((c) => c.id === id);
  if (idx >= 0) {
    db.data.connections[idx] = { ...db.data.connections[idx], ...patch };
    await db.write();
    const saved = db.data.connections[idx];
    if (saved.provider === "codex" && saved.refreshToken && (patch.accessToken || patch.refreshToken)) {
      await saveTokenBundle(saved.provider, saved.id, {
        accessToken: saved.accessToken,
        refreshToken: saved.refreshToken,
        source: "updateConnection",
      });
    }
  }
}

export async function removeConnection(id: string) {
  db.data.connections = db.data.connections.filter((c) => c.id !== id);
  await db.write();
}

export function listConnections() {
  return db.data.connections;
}

// Default credits for providers that use local credit tracking
// (upstream credit APIs are unreliable for these providers)
export const DEFAULT_CREDITS: Record<string, { totalCredits: number; packageName: string }> = {
  Service: { totalCredits: 250, packageName: "Free" },
  kiro: { totalCredits: 550, packageName: "KIRO FREE" },
};

/**
 * Initialize credit for a connection if it has no credit info and the provider
 * uses local credit tracking (Service, kiro). Does NOT overwrite existing credit data.
 */
export async function initializeCredit(connectionId: string, provider: string): Promise<void> {
  const defaults = DEFAULT_CREDITS[provider];
  if (!defaults) return; // Provider not tracked locally

  const idx = db.data.connections.findIndex((c) => c.id === connectionId);
  if (idx < 0) return;

  // Don't overwrite existing credit data
  if (db.data.connections[idx].credit) return;

  db.data.connections[idx].credit = {
    totalCredits: defaults.totalCredits,
    remainingCredits: defaults.totalCredits,
    usedCredits: 0,
    packageName: defaults.packageName,
    expiresAt: "",
    fetchedAt: Date.now(),
  };
  await db.write();
}

/**
 * Deduct credit from a connection based on actual token usage.
 * Cost formula: totalTokens / 1000 (1 credit ≈ 1000 tokens).
 * If remainingCredits <= 0, marks the connection as disabled.
 */
export async function deductCredit(
  connectionId: string,
  tokens: { promptTokens: number; completionTokens: number },
): Promise<CreditInfo | null> {
  const idx = db.data.connections.findIndex((c) => c.id === connectionId);
  if (idx < 0) return null;

  const conn = db.data.connections[idx];

  // Only deduct for providers with local credit tracking
  if (!DEFAULT_CREDITS[conn.provider]) return null;

  // Initialize credit if missing
  if (!conn.credit) {
    const defaults = DEFAULT_CREDITS[conn.provider];
    conn.credit = {
      totalCredits: defaults.totalCredits,
      remainingCredits: defaults.totalCredits,
      usedCredits: 0,
      packageName: defaults.packageName,
      expiresAt: "",
      fetchedAt: Date.now(),
    };
  }

  const totalTokens = tokens.promptTokens + tokens.completionTokens;
  const cost = totalTokens / 1000;

  conn.credit.usedCredits += cost;
  conn.credit.remainingCredits = conn.credit.totalCredits - conn.credit.usedCredits;
  conn.credit.fetchedAt = Date.now();

  // Clamp to 0 for UI display — do NOT auto-disable here.
  // Disabling only happens when the upstream API responds with exhausted/quota errors (429).
  // Local token counting may be inaccurate, so it's only used for UI progress display.
  if (conn.credit.remainingCredits < 0) {
    conn.credit.remainingCredits = 0;
  }

  await db.write();
  return conn.credit;
}



/** Export connections only (no API keys - those are per-device). */
export function exportData(): { connections: Connection[] } {
  return { connections: [...db.data.connections] };
}

/** Import connections from JSON. Merges (skip duplicates by provider+label). */
export async function importData(data: { connections?: Connection[] }): Promise<{ imported: number; skipped: number }> {
  let imported = 0;
  let skipped = 0;

  if (data.connections && Array.isArray(data.connections)) {
    for (const conn of data.connections) {
      const exists = db.data.connections.some(
        (c) => c.provider === conn.provider && c.label === conn.label
      );
      if (exists) {
        skipped++;
        continue;
      }
      // Ensure required fields
      db.data.connections.push({
        ...conn,
        id: conn.id || crypto.randomUUID(),
        usageCount: conn.usageCount ?? 0,
        lastUsedAt: conn.lastUsedAt ?? null,
        status: conn.status ?? "active",
        failCount: conn.failCount ?? 0,
        createdAt: conn.createdAt ?? Date.now(),
      });
      imported++;
    }
  }

  await db.write();
  return { imported, skipped };
}


