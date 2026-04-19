import { JSONFilePreset } from "lowdb/node";
import { join } from "path";
import { homedir } from "os";
import { generateApiKey } from "../utils/crypto.ts";

const DATA_DIR = join(homedir(), ".hexos");
await Bun.write(join(DATA_DIR, ".keep"), "").catch(() => {});

interface Connection {
  id: string;
  provider: string;
  label: string;
  accessToken: string;
  refreshToken?: string;
  uid?: string;
  expiresAt?: number;
  createdAt: number;
}

interface DbSchema {
  apiKeys: string[];
  connections: Connection[];
}

const defaultData: DbSchema = { apiKeys: [], connections: [] };
const db = await JSONFilePreset<DbSchema>(join(DATA_DIR, "db.json"), defaultData);

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
export async function saveConnection(conn: Omit<Connection, "id" | "createdAt">): Promise<Connection> {
  const existing = db.data.connections.findIndex((c) => c.provider === conn.provider && c.label === conn.label);
  const full: Connection = { ...conn, id: crypto.randomUUID(), createdAt: Date.now() };
  if (existing >= 0) {
    db.data.connections[existing] = { ...db.data.connections[existing], ...conn };
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
