import { JSONFilePreset } from "lowdb/node";
import { join } from "path";
import { homedir } from "os";
import { generateApiKey } from "../utils/crypto.ts";

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
    // Preserve usage stats on reconnect, reset status
    db.data.connections[existing] = {
      ...db.data.connections[existing],
      ...conn,
      status: "active",
      failCount: 0,
    };
    await db.write();
    return db.data.connections[existing];
  }
  db.data.connections.push(full);
  await db.write();
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
  }
}

export async function removeConnection(id: string) {
  db.data.connections = db.data.connections.filter((c) => c.id !== id);
  await db.write();
}

export function listConnections() {
  return db.data.connections;
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
