import { JSONFilePreset } from "lowdb/node";
import { join } from "path";
import { homedir } from "os";
import { log } from "../utils/logger.ts";

const DATA_DIR = join(homedir(), ".hexos");

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
  // Token counts
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  // Response info
  status: number; // HTTP status
  latencyMs: number;
  success: boolean;
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
const db = await JSONFilePreset<UsageDbSchema>(join(DATA_DIR, "usage.json"), defaultData);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Record a completed request with token usage.
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
}): Promise<UsageRecord> {
  const totalTokens = params.promptTokens + params.completionTokens;

  const record: UsageRecord = {
    id: crypto.randomUUID(),
    timestamp: Date.now(),
    model: params.model,
    accountId: params.accountId,
    accountLabel: params.accountLabel,
    endpoint: params.endpoint,
    promptTokens: params.promptTokens,
    completionTokens: params.completionTokens,
    totalTokens,
    status: params.status,
    latencyMs: params.latencyMs,
    success: params.success,
  };

  db.data.records.push(record);

  // Keep max 10000 records (rotate old ones)
  if (db.data.records.length > 10000) {
    db.data.records = db.data.records.slice(-10000);
  }

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
 * OpenAI SSE format: each chunk may have a `usage` field in the last chunk.
 * Returns extracted usage or null.
 */
export function parseUsageFromSSEChunk(chunk: string): { promptTokens: number; completionTokens: number } | null {
  // SSE format: "data: {...}\n\n"
  const lines = chunk.split("\n");
  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6).trim();
    if (data === "[DONE]") continue;

    try {
      const parsed = JSON.parse(data);
      // OpenAI format: usage in the last chunk
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
 * Passes through all data unchanged, but collects usage info.
 */
export function createUsageTrackingStream(
  originalStream: ReadableStream<Uint8Array>,
  onComplete: (usage: { promptTokens: number; completionTokens: number }) => void,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  let collectedUsage = { promptTokens: 0, completionTokens: 0 };
  let buffer = "";

  return new ReadableStream({
    async start(controller) {
      const reader = originalStream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            // Flush remaining buffer
            if (buffer.trim()) {
              const usage = parseUsageFromSSEChunk(buffer);
              if (usage) {
                collectedUsage = usage;
              }
            }
            onComplete(collectedUsage);
            controller.close();
            break;
          }

          // Pass through unchanged
          controller.enqueue(value);

          // Also parse for usage info
          buffer += decoder.decode(value, { stream: true });

          // Process complete SSE events (separated by \n\n)
          const events = buffer.split("\n\n");
          buffer = events.pop() || ""; // Keep incomplete event in buffer

          for (const event of events) {
            const usage = parseUsageFromSSEChunk(event);
            if (usage) {
              collectedUsage = usage;
            }
          }
        }
      } catch (e) {
        controller.error(e);
        onComplete(collectedUsage);
      }
    },
  });
}
