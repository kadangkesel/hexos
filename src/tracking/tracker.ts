import { JSONFilePreset } from "lowdb/node";
import { join } from "path";
import { homedir } from "os";
import { statSync } from "fs";
import { log } from "../utils/logger.ts";

const DATA_DIR = join(homedir(), ".hexos");
const USAGE_FILE = join(DATA_DIR, "usage.json");

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
}

export interface UsageStats {
  totalRequests: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalTokens: number;
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
}

export interface AccountStats {
  accountId: string;
  accountLabel: string;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  lastUsed: number;
}

interface UsageDbSchema {
  records: UsageRecord[];
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

const defaultData: UsageDbSchema = { records: [] };
const db = await JSONFilePreset<UsageDbSchema>(USAGE_FILE, defaultData);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max body size to store (chars). Bodies larger than this are truncated. */
const MAX_BODY_SIZE = 16000;

/** Max records to keep in DB */
const MAX_RECORDS = 5000;

/** Max file size in bytes before aggressive cleanup (15 MB) */
const MAX_FILE_SIZE = 15 * 1024 * 1024;

/** After aggressive cleanup, keep this many records */
const CLEANUP_KEEP = 2000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncateBody(body: string | undefined): string | undefined {
  if (!body) return undefined;
  if (body.length <= MAX_BODY_SIZE) return body;
  return body.slice(0, MAX_BODY_SIZE) + "\n...[truncated]";
}

/** Check file size and aggressively clean if too large */
async function autoCleanup() {
  // Rotate by record count
  if (db.data.records.length > MAX_RECORDS) {
    db.data.records = db.data.records.slice(-MAX_RECORDS);
  }

  // Check file size
  try {
    const stat = statSync(USAGE_FILE);
    if (stat.size > MAX_FILE_SIZE) {
      log.warn(`Usage log too large (${(stat.size / 1024 / 1024).toFixed(1)} MB), cleaning to ${CLEANUP_KEEP} records...`);
      // Keep only recent records and strip bodies from old ones to save space
      db.data.records = db.data.records.slice(-CLEANUP_KEEP);
      // Strip bodies from records older than 1 hour to further reduce size
      const oneHourAgo = Date.now() - 60 * 60 * 1000;
      for (const r of db.data.records) {
        if (r.timestamp < oneHourAgo) {
          delete r.requestBody;
          delete r.responseBody;
        }
      }
      await db.write();
      log.ok(`Usage log cleaned: ${db.data.records.length} records remaining`);
    }
  } catch {}
}

// Run cleanup on startup
await autoCleanup();

// Also clean stale "streaming" records from previous crashes
for (const r of db.data.records) {
  if (r.status === "streaming") {
    r.status = 0;
    r.success = false;
    r.responseBody = "[interrupted — server restarted]";
  }
}
await db.write();

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
    requestBody: truncateBody(params.requestBody),
  };

  db.data.records.push(record);
  await db.write();

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
  record.responseBody = truncateBody(params.responseBody);

  // Auto-cleanup after completing
  await autoCleanup();
  await db.write();

  log.info(
    `📊 ${record.model} | ` +
    `${record.accountLabel} | ` +
    `prompt: ${record.promptTokens.toLocaleString()} | ` +
    `completion: ${record.completionTokens.toLocaleString()} | ` +
    `total: ${record.totalTokens.toLocaleString()} | ` +
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
    requestBody: truncateBody(params.requestBody),
    responseBody: truncateBody(params.responseBody),
  };

  db.data.records.push(record);

  await autoCleanup();
  await db.write();

  log.info(
    `📊 ${record.model} | ` +
    `${record.accountLabel} | ` +
    `prompt: ${record.promptTokens.toLocaleString()} | ` +
    `completion: ${record.completionTokens.toLocaleString()} | ` +
    `total: ${record.totalTokens.toLocaleString()} | ` +
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

  return records;
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
    avgLatencyMs: 0,
    successRate: 0,
    byModel: {},
    byAccount: {},
  };

  if (records.length === 0) return stats;

  let totalLatency = 0;
  let successCount = 0;

  for (const r of records) {
    stats.totalPromptTokens += r.promptTokens;
    stats.totalCompletionTokens += r.completionTokens;
    stats.totalTokens += r.totalTokens;
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
      };
    }
    const m = stats.byModel[r.model];
    m.requests++;
    m.promptTokens += r.promptTokens;
    m.completionTokens += r.completionTokens;
    m.totalTokens += r.totalTokens;

    // By account
    if (!stats.byAccount[r.accountId]) {
      stats.byAccount[r.accountId] = {
        accountId: r.accountId,
        accountLabel: r.accountLabel,
        requests: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        lastUsed: 0,
      };
    }
    const a = stats.byAccount[r.accountId];
    a.requests++;
    a.promptTokens += r.promptTokens;
    a.completionTokens += r.completionTokens;
    a.totalTokens += r.totalTokens;
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
