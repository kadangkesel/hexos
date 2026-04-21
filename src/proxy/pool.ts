import { JSONFilePreset } from "lowdb/node";
import { join } from "path";
import { homedir } from "os";

const DATA_DIR = join(homedir(), ".hexos");
await Bun.write(join(DATA_DIR, ".keep"), "").catch(() => {});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProxyEntry {
  id: string;
  url: string;
  status: "active" | "dead" | "checking";
  pingMs: number | null;
  lastChecked: number | null;
  failCount: number;
  addedAt: number;
  label?: string;
}

interface ProxyDbSchema {
  proxies: ProxyEntry[];
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

const defaultData: ProxyDbSchema = { proxies: [] };
const db = await JSONFilePreset<ProxyDbSchema>(join(DATA_DIR, "proxies.json"), defaultData);

const PROXY_URL_RE = /^(http|https|socks4|socks5):\/\/.+/;
const HEALTH_CHECK_URL = "http://httpbin.org/ip";
const HEALTH_CHECK_TIMEOUT = 10_000;
const MAX_FAIL_COUNT = 3;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isValidProxyUrl(url: string): boolean {
  return PROXY_URL_RE.test(url);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Get all proxies. */
export function getProxies(): ProxyEntry[] {
  return db.data.proxies;
}

/** Add a single proxy, returns the entry. */
export async function addProxy(url: string, label?: string): Promise<ProxyEntry> {
  const trimmed = url.trim();
  if (!isValidProxyUrl(trimmed)) {
    throw new Error(`Invalid proxy URL: ${trimmed}`);
  }

  const duplicate = db.data.proxies.find((p) => p.url === trimmed);
  if (duplicate) {
    return duplicate;
  }

  const entry: ProxyEntry = {
    id: crypto.randomUUID(),
    url: trimmed,
    status: "active",
    pingMs: null,
    lastChecked: null,
    failCount: 0,
    addedAt: Date.now(),
    ...(label ? { label } : {}),
  };

  db.data.proxies.push(entry);
  await db.write();
  return entry;
}

/** Batch add proxies from text (one per line). Skips empty lines, comments (#), duplicates, and invalid URLs. */
export async function batchAddProxies(text: string): Promise<{ added: number; duplicates: number; invalid: number }> {
  const lines = text.split(/\r?\n/);
  let added = 0;
  let duplicates = 0;
  let invalid = 0;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    if (!isValidProxyUrl(line)) {
      invalid++;
      continue;
    }

    const exists = db.data.proxies.some((p) => p.url === line);
    if (exists) {
      duplicates++;
      continue;
    }

    db.data.proxies.push({
      id: crypto.randomUUID(),
      url: line,
      status: "active",
      pingMs: null,
      lastChecked: null,
      failCount: 0,
      addedAt: Date.now(),
    });
    added++;
  }

  if (added > 0) {
    await db.write();
  }

  return { added, duplicates, invalid };
}

/** Remove a proxy by ID. */
export async function removeProxy(id: string): Promise<void> {
  db.data.proxies = db.data.proxies.filter((p) => p.id !== id);
  await db.write();
}

/** Remove all dead proxies. Returns the number removed. */
export async function removeDeadProxies(): Promise<number> {
  const before = db.data.proxies.length;
  db.data.proxies = db.data.proxies.filter((p) => p.status !== "dead");
  const removed = before - db.data.proxies.length;
  if (removed > 0) {
    await db.write();
  }
  return removed;
}

/** Remove all proxies. Returns the number removed. */
export async function removeAllProxies(): Promise<number> {
  const count = db.data.proxies.length;
  db.data.proxies = [];
  if (count > 0) await db.write();
  return count;
}

/** Get a random active proxy URL. Returns null if none available. */
export function getRandomProxy(): string | null {
  const active = db.data.proxies.filter((p) => p.status === "active");
  if (active.length === 0) return null;
  const idx = Math.floor(Math.random() * active.length);
  return active[idx].url;
}

/**
 * Check a single proxy's health by making an HTTP request through it.
 * Updates the proxy entry in the database.
 */
export async function checkProxy(id: string): Promise<{ alive: boolean; pingMs: number | null }> {
  const idx = db.data.proxies.findIndex((p) => p.id === id);
  if (idx < 0) {
    throw new Error(`Proxy not found: ${id}`);
  }

  const entry = db.data.proxies[idx];
  entry.status = "checking";
  await db.write();

  const start = performance.now();
  let alive = false;
  let pingMs: number | null = null;

  try {
    const res = await fetch(HEALTH_CHECK_URL, {
      proxy: entry.url,
      signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT),
    } as any);

    if (res.ok) {
      pingMs = Math.round(performance.now() - start);
      alive = true;
    }
  } catch {
    // Connection failed or timed out
  }

  if (alive) {
    entry.status = "active";
    entry.pingMs = pingMs;
    entry.failCount = 0;
  } else {
    entry.failCount++;
    entry.pingMs = null;
    entry.status = entry.failCount >= MAX_FAIL_COUNT ? "dead" : "active";
  }
  entry.lastChecked = Date.now();

  await db.write();
  return { alive, pingMs };
}

/** Check all proxies' health in parallel. Single DB write at the end. */
export async function checkAllProxies(): Promise<void> {
  const proxies = db.data.proxies;
  if (proxies.length === 0) return;

  // Mark all as checking
  for (const p of proxies) p.status = "checking";

  // Test all in parallel
  const results = await Promise.all(
    proxies.map(async (entry) => {
      const start = performance.now();
      try {
        const res = await fetch(HEALTH_CHECK_URL, {
          proxy: entry.url,
          signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT),
        } as any);
        if (res.ok) {
          return { id: entry.id, alive: true, pingMs: Math.round(performance.now() - start) };
        }
      } catch {}
      return { id: entry.id, alive: false, pingMs: null as number | null };
    })
  );

  // Apply results
  for (const r of results) {
    const entry = proxies.find((p) => p.id === r.id);
    if (!entry) continue;
    if (r.alive) {
      entry.status = "active";
      entry.pingMs = r.pingMs;
      entry.failCount = 0;
    } else {
      entry.failCount++;
      entry.pingMs = null;
      entry.status = entry.failCount >= MAX_FAIL_COUNT ? "dead" : "active";
    }
    entry.lastChecked = Date.now();
  }

  // Single DB write
  await db.write();
}
