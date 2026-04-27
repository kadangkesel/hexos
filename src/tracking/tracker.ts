import { JSONFilePreset } from "lowdb/node";
import { join } from "path";
import { homedir } from "os";
import { statSync } from "fs";
import { log } from "../utils/logger.ts";
import { calculateCost } from "../config/pricing.ts";

const DATA_DIR = join(homedir(), ".hexos");
const USAGE_FILE = join(DATA_DIR, "usage.json");
const LOGS_FILE = join(DATA_DIR, "logs.json");

// ---------------------------------------------------------------------------
// Data model
// ---------------------------------------------------------------------------

export interface UsageRecord {
  id: string;
  timestamp: number;
  // Request info
  model: string;
  accountId: string;
  accountLabel: string;
  endpoint: string; // "/v1/chat/completions" or "/v1/messages"
  streaming: boolean;
  // Token counts
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  // Response info
  status: number | "streaming"; // HTTP status or "streaming" while in-flight
  latencyMs: number;
  success: boolean;
  // Request/Response bodies (truncated to save space)
  requestBody?: string;
  responseBody?: string;
  // Legacy field (kept for backward compat with existing records, always 0 for new)
  creditCost?: number;
  // Estimated cost in USD based on global model pricing (LiteLLM)
  cost?: number;
}

export interface UsageStats {
  totalRequests: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
  totalCost: number;
  avgLatencyMs: number;
  successRate: number;
  byModel: Record<string, ModelStats>;
  byAccount: Record<string, AccountStats>;
}

export interface ModelStats {
  model: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;
}

export interface AccountStats {
  accountId: string;
  accountLabel: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;
  lastUsed: number;
}

interface UsageDbSchema {
  records: UsageRecord[];
}

interface LogEntry {
  id: string; // matches UsageRecord.id
  requestBody?: string;
  responseBody?: string;
}

interface LogsDbSchema {
  entries: LogEntry[];
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

const defaultData: UsageDbSchema = { records: [] };
const db = await JSONFilePreset<UsageDbSchema>(USAGE_FILE, defaultData);

const defaultLogsData: LogsDbSchema = { entries: [] };
const logsDb = await JSONFilePreset<LogsDbSchema>(LOGS_FILE, defaultLogsData);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max body size to store (chars). Bodies larger than this are truncated. */
const MAX_BODY_SIZE = 16000;

/** Max records to keep in usage DB (lightweight — no bodies) */
const MAX_RECORDS = 50000;

/** Max log entries to keep (contains bodies — heavier) */
const MAX_LOG_ENTRIES = 2000;

/** Max logs.json file size before aggressive cleanup (10 MB) */
const MAX_LOGS_FILE_SIZE = 10 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncateBody(body: string | undefined): string | undefined {
  if (!body) return undefined;
  if (body.length <= MAX_BODY_SIZE) return body;
  return body.slice(0, MAX_BODY_SIZE) + "\n...[truncated]";
}

/** Write body log entry to separate logs.json */
async function writeLogEntry(id: string, requestBody?: string, responseBody?: string) {
  const entry: LogEntry = { id };
  if (requestBody) entry.requestBody = truncateBody(requestBody);
  if (responseBody) entry.responseBody = truncateBody(responseBody);
  logsDb.data.entries.push(entry);
  // Rotate log entries
  if (logsDb.data.entries.length > MAX_LOG_ENTRIES) {
    logsDb.data.entries = logsDb.data.entries.slice(-MAX_LOG_ENTRIES);
  }
  await logsDb.write();
}

/** Append response body to existing log entry */
async function appendLogResponse(id: string, responseBody?: string) {
  const entry = logsDb.data.entries.find((e) => e.id === id);
  if (entry) {
    entry.responseBody = truncateBody(responseBody);
  } else {
    logsDb.data.entries.push({ id, responseBody: truncateBody(responseBody) });
  }
  await logsDb.write();
}

/** Cleanup usage records (lightweight — no bodies) */
async function autoCleanup() {
  if (db.data.records.length > MAX_RECORDS) {
    db.data.records = db.data.records.slice(-MAX_RECORDS);
  }
  await db.write();
}

/** Cleanup logs.json by file size */
async function autoCleanupLogs() {
  try {
    const stat = statSync(LOGS_FILE);
    if (stat.size > MAX_LOGS_FILE_SIZE) {
      log.warn(`Logs file too large (${(stat.size / 1024 / 1024).toFixed(1)} MB), trimming...`);
      logsDb.data.entries = logsDb.data.entries.slice(-500);
      await logsDb.write();
      log.ok(`Logs cleaned: ${logsDb.data.entries.length} entries remaining`);
    }
  } catch {}
}

// Run cleanup on startup
await autoCleanup();
await autoCleanupLogs();

// Migrate: strip bodies from existing usage records (one-time migration)
let migrated = false;
for (const r of db.data.records) {
  if (r.requestBody || r.responseBody) {
    delete r.requestBody;
    delete r.responseBody;
    migrated = true;
  }
  if (r.status === "streaming") {
    r.status = 0;
    r.success = false;
    migrated = true;
  }
}
if (migrated) {
  await db.write();
  log.ok("Migrated usage records: stripped bodies to logs.json");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Start tracking a request. Creates a record with status "streaming".
 * Returns the record ID to be used with completeRequest().
 */
export async function startRequest(params: {
  model: string;
  accountId: string;
  accountLabel: string;
  endpoint: string;
  streaming: boolean;
  requestBody?: string;
}): Promise<string> {
  const record: UsageRecord = {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    model: params.model,
    accountId: params.accountId,
    accountLabel: params.accountLabel,
    endpoint: params.endpoint,
    streaming: params.streaming,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    status: "streaming",
    latencyMs: 0,
    success: false,
  };

  db.data.records.push(record);
  await db.write();

  // Write request body to separate logs file
  if (params.requestBody) {
    await writeLogEntry(record.id, params.requestBody);
  }

  return record.id;
}

/**
 * Complete a tracked request. Updates the record with final status, tokens, response.
 */
export async function completeRequest(params: {
  id: string;
  promptTokens: number;
  completionTokens: number;
  status: number;
  latencyMs: number;
  success: boolean;
  responseBody?: string;
}): Promise<void> {
  const record = db.data.records.find((r) => r.id === params.id);
  if (!record) return;

  record.promptTokens = params.promptTokens;
  record.completionTokens = params.completionTokens;
  record.totalTokens = params.promptTokens + params.completionTokens;
  record.status = params.status;
  record.latencyMs = params.latencyMs;
  record.success = params.success;
  record.cost = calculateCost(record.model, record.promptTokens, record.completionTokens);

  // Auto-cleanup after completing
  await autoCleanup();
  await db.write();

  // Write response body to separate logs file
  if (params.responseBody) {
    await appendLogResponse(params.id, params.responseBody);
  }

  log.info(
    `📊 ${record.model} | ` +
    `${record.accountLabel} | ` +
    `prompt: ${record.promptTokens.toLocaleString()} | ` +
    `completion: ${record.completionTokens.toLocaleString()} | ` +
    `total: ${record.totalTokens.toLocaleString()} | ` +
    `cost: $${(record.cost ?? 0).toFixed(4)} | ` +
    `${record.latencyMs}ms`
  );
}

/**
 * Legacy: Record a completed request in one call (for non-streaming or simple cases).
 */
export async function recordUsage(params: {
  model: string;
  accountId: string;
  accountLabel: string;
  endpoint: string;
  promptTokens: number;
  completionTokens: number;
  status: number;
  latencyMs: number;
  success: boolean;
  streaming?: boolean;
  requestBody?: string;
  responseBody?: string;
}): Promise<UsageRecord> {
  const totalTokens = params.promptTokens + params.completionTokens;

  const record: UsageRecord = {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    model: params.model,
    accountId: params.accountId,
    accountLabel: params.accountLabel,
    endpoint: params.endpoint,
    streaming: params.streaming ?? false,
    promptTokens: params.promptTokens,
    completionTokens: params.completionTokens,
    totalTokens,
    status: params.status,
    latencyMs: params.latencyMs,
    success: params.success,
    cost: calculateCost(params.model, params.promptTokens, params.completionTokens),
  };

  db.data.records.push(record);

  await autoCleanup();
  await db.write();

  // Write bodies to separate logs file
  if (params.requestBody || params.responseBody) {
    await writeLogEntry(record.id, params.requestBody, params.responseBody);
  }

  log.info(
    `📊 ${record.model} | ` +
    `${record.accountLabel} | ` +
    `prompt: ${record.promptTokens.toLocaleString()} | ` +
    `completion: ${record.completionTokens.toLocaleString()} | ` +
    `total: ${record.totalTokens.toLocaleString()} | ` +
    `cost: $${(record.cost ?? 0).toFixed(4)} | ` +
    `${record.latencyMs}ms`
  );

  return record;
}

/**
 * Get all usage records, optionally filtered.
 */
export function getRecords(filter?: {
  since?: number;
  model?: string;
  accountId?: string;
  limit?: number;
}): UsageRecord[] {
  let records = db.data.records;

  if (filter?.since) {
    records = records.filter((r) => r.timestamp >= filter.since!);
  }
  if (filter?.model) {
    records = records.filter((r) => r.model === filter.model);
  }
  if (filter?.accountId) {
    records = records.filter((r) => r.accountId === filter.accountId);
  }

  // Sort by timestamp descending (newest first)
  records = records.sort((a, b) => b.timestamp - a.timestamp);

  if (filter?.limit) {
    records = records.slice(0, filter.limit);
  }

  // Backfill cost for records that predate the pricing feature
  return records.map((r) => {
    if (!r.cost || r.cost === 0) {
      const cost = calculateCost(r.model, r.promptTokens, r.completionTokens);
      if (cost > 0) return { ...r, cost };
    }
    return r;
  });
}

/**
 * Get log bodies for a set of record IDs.
 * Returns a map of id → { requestBody, responseBody }.
 */
export function getLogBodies(ids: string[]): Record<string, { requestBody?: string; responseBody?: string }> {
  const idSet = new Set(ids);
  const result: Record<string, { requestBody?: string; responseBody?: string }> = {};
  for (const entry of logsDb.data.entries) {
    if (idSet.has(entry.id)) {
      result[entry.id] = {
        requestBody: entry.requestBody,
        responseBody: entry.responseBody,
      };
    }
  }
  return result;
}

/**
 * Compute aggregate usage stats.
 */
export function getStats(since?: number): UsageStats {
  const records = since
    ? db.data.records.filter((r) => r.timestamp >= since)
    : db.data.records;

  const stats: UsageStats = {
    totalRequests: records.length,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalTokens: 0,
    totalCost: 0,
    avgLatencyMs: 0,
    successRate: 0,
    byModel: {},
    byAccount: {},
  };

  if (records.length === 0) return stats;

  let totalLatency = 0;
  let successCount = 0;

  for (const r of records) {
    // Recalculate cost for records that predate the pricing feature
    const cost = (r.cost && r.cost > 0) ? r.cost : calculateCost(r.model, r.promptTokens, r.completionTokens);
    stats.totalPromptTokens += r.promptTokens;
    stats.totalCompletionTokens += r.completionTokens;
    stats.totalTokens += r.totalTokens;
    stats.totalCost += cost;
    totalLatency += r.latencyMs;
    if (r.success) successCount++;

    // By model
    if (!stats.byModel[r.model]) {
      stats.byModel[r.model] = {
        model: r.model,
        requests: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cost: 0,
      };
    }
    const m = stats.byModel[r.model];
    m.requests++;
    m.promptTokens += r.promptTokens;
    m.completionTokens += r.completionTokens;
    m.totalTokens += r.totalTokens;
    m.cost += cost;

    // By account
    if (!stats.byAccount[r.accountId]) {
      stats.byAccount[r.accountId] = {
        accountId: r.accountId,
        accountLabel: r.accountLabel,
        requests: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cost: 0,
        lastUsed: 0,
      };
    }
    const a = stats.byAccount[r.accountId];
    a.requests++;
    a.promptTokens += r.promptTokens;
    a.completionTokens += r.completionTokens;
    a.totalTokens += r.totalTokens;
    a.cost += cost;
    if (r.timestamp > a.lastUsed) a.lastUsed = r.timestamp;
  }

  stats.avgLatencyMs = Math.round(totalLatency / records.length);
  stats.successRate = Math.round((successCount / records.length) * 100);

  return stats;
}

/**
 * Parse token usage from SSE stream chunks.
 */
export function parseUsageFromSSEChunk(chunk: string): { promptTokens: number; completionTokens: number } | null {
  const lines = chunk.split("\n");
  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6).trim();
    if (data === "[DONE]") continue;

    try {
      const parsed = JSON.parse(data);
      if (parsed.usage) {
        return {
          promptTokens: parsed.usage.prompt_tokens ?? 0,
          completionTokens: parsed.usage.completion_tokens ?? 0,
        };
      }
    } catch {}
  }
  return null;
}

/**
 * Create a TransformStream that intercepts SSE chunks to extract token usage.
 * Passes through all data unchanged, but collects usage info and response content.
 */
export function createUsageTrackingStream(
  originalStream: ReadableStream<Uint8Array>,
  onComplete: (usage: { promptTokens: number; completionTokens: number; responseContent: string }) => void,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let collectedUsage = { promptTokens: 0, completionTokens: 0 };
  let buffer = "";
  let responseContent = "";

  return new ReadableStream({
    async start(controller) {
      const reader = originalStream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            if (buffer.trim()) {
              const usage = parseUsageFromSSEChunk(buffer);
              if (usage) {
                collectedUsage = usage;
              }
            }
            onComplete({ ...collectedUsage, responseContent });
            controller.close();
            break;
          }

          controller.enqueue(value);

          buffer += decoder.decode(value, { stream: true });

          const events = buffer.split("\n\n");
          buffer = events.pop() || "";

          for (const event of events) {
            const usage = parseUsageFromSSEChunk(event);
            if (usage) {
              collectedUsage = usage;
            }
            // Collect content deltas from SSE chunks
            if (responseContent.length < MAX_BODY_SIZE) {
              for (const line of event.split("\n")) {
                if (!line.startsWith("data: ")) continue;
                const data = line.slice(6).trim();
                if (data === "[DONE]") continue;
                try {
                  const parsed = JSON.parse(data);
                  const delta = parsed.choices?.[0]?.delta?.content;
                  if (delta) responseContent += delta;
                  const msg = parsed.choices?.[0]?.message?.content;
                  if (msg) responseContent += msg;
                } catch {}
              }
            }
          }
        }
      } catch (e) {
        controller.error(e);
        onComplete({ ...collectedUsage, responseContent });
      }
    },
  });
}
