import { Hono } from "hono";
import { cors } from "hono/cors";
import { validateApiKey, getApiKeys, listConnections, removeConnection, setConnectionStatus, exportData, importData, saveConnection, deductCredit, type Connection } from "./auth/store.ts";
import { proxyRequest } from "./proxy/handler.ts";
import { listModels, resolveModel, MODEL_CATALOG } from "./config/models.ts";
import { log } from "./utils/logger.ts";
import { anthropicToOpenAI, openAIToAnthropicStream } from "./proxy/anthropic.ts";
import { augmentMessages } from "./utils/transform.ts";
import { createUsageTrackingStream, recordUsage, startRequest, completeRequest, getStats, getRecords } from "./tracking/tracker.ts";
import { batchConnect, isAutomationReady, checkToken, checkKiroToken, parseCodexToken } from "./auth/oauth.ts";
import crypto from "crypto";
import { PROVIDERS } from "./config/providers.ts";
import { detectTools, bindTool, unbindTool, readToolConfig } from "./integration/tools.ts";
import { getProxies, addProxy, batchAddProxies, removeProxy, removeDeadProxies, removeAllProxies, checkProxy, checkAllProxies } from "./proxy/pool.ts";
import { getSources, getScrapeStatus, startScrape, cancelScrape, integrateResults } from "./proxy/scraper.ts";
import { getFilterConfig, setFilterEnabled, setProviderOverride, setRuleEnabled, addCustomRule, updateCustomRule, removeCustomRule } from "./config/filters.ts";
import { join, extname } from "path";
import { homedir } from "os";
import { existsSync } from "fs";

// Track batch connect tasks
interface BatchTaskLog {
  time: string;
  level: "info" | "error" | "success";
  message: string;
}

const batchConnectTasks = new Map<string, {
  status: "running" | "completed" | "failed" | "cancelled";
  total: number;
  completed: number;
  success: number;
  failed: number;
  errors: string[];
  logs: BatchTaskLog[];
}>();

// Cancel flag per task
const batchCancelFlags = new Map<string, boolean>();

export function createApp() {
  const app = new Hono();

  // CORS for dashboard
  app.use("/api/*", cors({
    origin: ["http://localhost:7471", "http://127.0.0.1:7471"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  }));

  // Log ALL incoming requests
  app.use("*", async (c, next) => {
    const method = c.req.method;
    const path = c.req.path;
    const ua = c.req.header("user-agent") ?? "";
    log.req(method, path, ua.slice(0, 50));
    await next();
  });

  // Auth middleware
  app.use("/v1/*", async (c, next) => {
    const keys = getApiKeys();
    // If no keys configured, allow all (dev mode)
    if (keys.length === 0) return next();

    const auth = c.req.header("Authorization") ?? "";
    const key = auth.replace("Bearer ", "").trim();
    if (!(await validateApiKey(key))) {
      return c.json({ error: { message: "Invalid API key", type: "auth_error", code: 401 } }, 401);
    }
    return next();
  });

  // Models list
  app.get("/v1/models", (c) => {
    const models = listModels().map((m) => ({
      id: m.id,
      object: "model",
      created: 0,
      owned_by: "hexos",
      // Include both field names for maximum client compatibility
      context_length: m.contextWindow ?? 200000,
      context_window: m.contextWindow ?? 200000,
    }));
    return c.json({ object: "list", data: models });
  });

  // Messages API (for CLI clients, etc.)
  app.post("/v1/messages", async (c) => {
    let req: any;
    try {
      req = await c.req.json();
    } catch {
      return c.json({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }, 400);
    }

    const modelId = req.model as string;
    const resolved = resolveModel(modelId);
    if (!resolved) {
      return c.json({ error: { message: `Unknown model: ${modelId}`, type: "invalid_request_error" } }, 400);
    }

    // Save raw request for debugging
    try {
      const fs = require("fs");
      fs.writeFileSync(`${process.cwd()}/hexos-raw-request.json`, JSON.stringify(req, null, 2));
    } catch {}

    const messageId = `msg_${Math.random().toString(36).slice(2, 18)}`;
    const hasThinking = false; // Disabled: upstream doesn't support thinking, and fake blocks lack signature
    const openAIBody = anthropicToOpenAI(req, resolved.model);

    log.req("POST", "/v1/messages", `model=${modelId} msgs=${openAIBody.messages.length} thinking=${hasThinking} thinkingRaw=${JSON.stringify(req.thinking)}`);

    const upstream = await proxyRequest(modelId, openAIBody, true);

    // Extract tracking metadata
    const trackModel = upstream.headers.get("X-Hexos-Model") || modelId;
    const trackAccountId = upstream.headers.get("X-Hexos-Account-Id") || "";
    const trackAccountLabel = upstream.headers.get("X-Hexos-Account-Label") || "";
    const trackStartTime = parseInt(upstream.headers.get("X-Hexos-Start-Time") || "0") || Date.now();

    const reqBodyStr = JSON.stringify(openAIBody);

    // Start tracking (shows "streaming" in logs)
    let trackingId: string | undefined;
    if (trackAccountId) {
      trackingId = await startRequest({
        model: trackModel, accountId: trackAccountId, accountLabel: trackAccountLabel,
        endpoint: "/v1/messages", streaming: true, requestBody: reqBodyStr,
      });
    }

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text();
      if (trackingId) {
        await completeRequest({
          id: trackingId,
          promptTokens: 0, completionTokens: 0,
          status: upstream.status, latencyMs: Date.now() - trackStartTime,
          success: false, responseBody: text,
        });
      }
      return c.json({ error: { message: text, type: "proxy_error" } }, upstream.status as any);
    }

    // Wrap with usage tracking before converting to AI Provider format
    const trackedUpstreamBody = createUsageTrackingStream(upstream.body, (usage) => {
      if (trackingId) {
        completeRequest({
          id: trackingId,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          status: upstream.status,
          latencyMs: Date.now() - trackStartTime,
          success: true, responseBody: usage.responseContent,
        });
      }
      // Deduct local credit for Service/Kiro based on actual token usage
      if (trackAccountId) {
        deductCredit(trackAccountId, { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens }).catch(() => {});
      }
    });

    const anthropicStream = openAIToAnthropicStream(trackedUpstreamBody, resolved.model, messageId, hasThinking);

    return new Response(anthropicStream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
        "Content-Encoding": "identity",
        "anthropic-version": "2023-06-01",
        "request-id": messageId,
        "x-request-id": messageId,
      },
    });
  });

  // Chat completions
  app.post("/v1/chat/completions", async (c) => {
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { message: "Invalid JSON body", type: "invalid_request_error", code: "bad_request" } }, 400);
    }
    const modelId = body.model as string;

    // Upstream requires stream=true and a system message
    const resolved = resolveModel(modelId);
    const providerName = resolved?.provider;
    body.stream = true;
    body.messages = augmentMessages(body.messages ?? [], providerName);

    log.req("POST", "/v1/chat/completions", `model=${modelId} msgs=${body.messages.length}`);

    const upstream = await proxyRequest(modelId, body, true);

    // Extract tracking metadata from proxy response headers
    const model = upstream.headers.get("X-Hexos-Model") || modelId;
    const accountId = upstream.headers.get("X-Hexos-Account-Id") || "";
    const accountLabel = upstream.headers.get("X-Hexos-Account-Label") || "";
    const startTime = parseInt(upstream.headers.get("X-Hexos-Start-Time") || "0") || Date.now();

    const reqBodyStr = JSON.stringify(body);

    // Start tracking (shows "streaming" in logs)
    let trackingId: string | undefined;
    if (accountId) {
      trackingId = await startRequest({
        model, accountId, accountLabel,
        endpoint: "/v1/chat/completions", streaming: true, requestBody: reqBodyStr,
      });
    }

    if (!upstream.body) {
      // Non-streaming error response — track as failed
      if (trackingId) {
        await completeRequest({
          id: trackingId,
          promptTokens: 0, completionTokens: 0,
          status: upstream.status, latencyMs: Date.now() - startTime,
          success: false,
        });
      }
      return new Response(upstream.body, { status: upstream.status, headers: { "Content-Type": "application/json" } });
    }

    // Wrap stream with usage tracking
    const trackedStream = createUsageTrackingStream(upstream.body, (usage) => {
      if (trackingId) {
        completeRequest({
          id: trackingId,
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          status: upstream.status,
          latencyMs: Date.now() - startTime,
          success: upstream.status >= 200 && upstream.status < 400,
          responseBody: usage.responseContent,
        });
      }
      // Deduct local credit for Service/Kiro based on actual token usage
      if (accountId) {
        deductCredit(accountId, { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens }).catch(() => {});
      }
    });

    // Always stream (Service requirement)
    return new Response(trackedStream, {
      status: upstream.status,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
      },
    });
  });

  // Usage API (for dashboard)
  app.get("/v1/usage/stats", (c) => {
    const since = c.req.query("since") ? parseInt(c.req.query("since")!) : undefined;
    return c.json(getStats(since));
  });

  app.get("/v1/usage/records", (c) => {
    const limit = c.req.query("limit") ? parseInt(c.req.query("limit")!) : 50;
    const model = c.req.query("model") || undefined;
    const accountId = c.req.query("accountId") || undefined;
    const since = c.req.query("since") ? parseInt(c.req.query("since")!) : undefined;
    return c.json(getRecords({ limit, model, accountId, since }));
  });

  // Health
  app.get("/health", (c) => {
    const stats = getStats();
    return c.json({
      status: "ok",
      connections: listConnections().length,
      totalRequests: stats.totalRequests,
      totalTokens: stats.totalTokens,
      totalCreditCost: stats.totalCreditCost,
    });
  });

  // ============================================================
  // Dashboard API endpoints (prefix: /api/)
  // ============================================================

  // --- Dashboard overview ---
  app.get("/api/dashboard", (c) => {
    const conns = listConnections();
    const active = conns.filter((c) => c.status === "active");
    const disabled = conns.filter((c) => c.status === "disabled");
    const expired = conns.filter((c) => c.status === "expired");

    const stats = getStats();
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayStats = getStats(todayStart.getTime());

    return c.json({
      accounts: {
        total: conns.length,
        active: active.length,
        disabled: disabled.length,
        expired: expired.length,
      },
      usage: {
        totalRequests: stats.totalRequests,
        totalTokens: stats.totalTokens,
        totalPromptTokens: stats.totalPromptTokens,
        totalCompletionTokens: stats.totalCompletionTokens,
        totalCreditCost: stats.totalCreditCost,
        successRate: stats.successRate,
        avgLatencyMs: stats.avgLatencyMs,
      },
      today: {
        totalRequests: todayStats.totalRequests,
        totalTokens: todayStats.totalTokens,
        totalCreditCost: todayStats.totalCreditCost,
        successRate: todayStats.successRate,
      },
      byModel: stats.byModel,
      byAccount: stats.byAccount,
    });
  });

  // --- Connections / Accounts ---
  app.get("/api/connections", (c) => {
    const page = Math.max(1, Number(c.req.query("page")) || 1);
    const limit = Math.min(100, Math.max(1, Number(c.req.query("limit")) || 20));
    const search = (c.req.query("search") || "").toLowerCase().trim();
    const providerFilter = c.req.query("provider") || "";
    const statusFilter = c.req.query("status") || "";

    let conns = listConnections().map((conn) => ({
      id: conn.id,
      provider: conn.provider,
      label: conn.label,
      status: conn.status,
      usageCount: conn.usageCount,
      lastUsedAt: conn.lastUsedAt,
      failCount: conn.failCount,
      credit: conn.credit ?? null,
      createdAt: conn.createdAt,
      // Never expose tokens to dashboard
    }));

    // Apply filters
    if (search) {
      conns = conns.filter((c) => (c.label || "").toLowerCase().includes(search));
    }
    if (providerFilter) {
      conns = conns.filter((c) => c.provider === providerFilter);
    }
    if (statusFilter) {
      conns = conns.filter((c) => c.status === statusFilter);
    }

    const total = conns.length;
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const safePage = Math.min(page, totalPages);
    const offset = (safePage - 1) * limit;
    const data = conns.slice(offset, offset + limit);

    return c.json({
      data,
      pagination: {
        page: safePage,
        limit,
        total,
        totalPages,
      },
    });
  });

  // Lightweight endpoint: returns all {provider, label} pairs (no tokens, no pagination)
  // Used by FilterUnconnected to check which accounts are already connected
  app.get("/api/connections/labels", (c) => {
    const labels = listConnections().map((conn) => ({
      provider: conn.provider,
      label: conn.label,
    }));
    return c.json(labels);
  });

  // Credit summary: aggregate stats across ALL connections (not paginated)
  app.get("/api/connections/credit-summary", (c) => {
    const conns = listConnections();
    const byProvider: Record<string, { total: number; used: number; remaining: number; count: number; active: number; exhausted: number; expired: number; banned: number }> = {};

    let totalExhausted = 0;
    let totalExpired = 0;
    let totalBanned = 0;

    for (const conn of conns) {
      const p = conn.provider || "codebuddy";
      if (!byProvider[p]) byProvider[p] = { total: 0, used: 0, remaining: 0, count: 0, active: 0, exhausted: 0, expired: 0, banned: 0 };
      byProvider[p].count++;

      const credit = conn.credit as { totalCredits?: number; usedCredits?: number; remainingCredits?: number } | undefined;
      const rem = Number(credit?.remainingCredits ?? -1);

      // Classify status matching dashboard getStatus() logic:
      // expired → invalid token
      // disabled + credit=0 → exhausted, disabled + credit>0 → banned
      // active + credit=0 (with known total) → exhausted
      // active + credit>0 → active
      if (conn.status === "expired") {
        byProvider[p].expired++;
        totalExpired++;
      } else if (conn.status === "disabled") {
        if (rem === 0) {
          byProvider[p].exhausted++;
          totalExhausted++;
        } else {
          byProvider[p].banned++;
          totalBanned++;
        }
      } else if (rem === 0 && Number(credit?.totalCredits ?? 0) > 0) {
        // Active status but credit exhausted
        byProvider[p].exhausted++;
        totalExhausted++;
      } else {
        byProvider[p].active++;
      }

      if (credit) {
        byProvider[p].total += Number(credit.totalCredits ?? 0);
        byProvider[p].used += Number(credit.usedCredits ?? 0);
        byProvider[p].remaining += Number(credit.remainingCredits ?? 0);
      }
    }

    // Sum active from byProvider (already correctly classified above)
    const totalActive = Object.values(byProvider).reduce((sum, p) => sum + p.active, 0);

    return c.json({
      totalConnections: conns.length,
      activeConnections: totalActive,
      totalExhausted,
      totalExpired,
      totalBanned,
      byProvider,
    });
  });

  app.delete("/api/connections/:id", async (c) => {
    const id = c.req.param("id");
    await removeConnection(id);
    return c.json({ ok: true });
  });

  app.post("/api/connections/:id/enable", async (c) => {
    const id = c.req.param("id");
    await setConnectionStatus(id, "active");
    return c.json({ ok: true });
  });

  app.post("/api/connections/:id/disable", async (c) => {
    const id = c.req.param("id");
    await setConnectionStatus(id, "disabled");
    return c.json({ ok: true });
  });

  app.post("/api/connections/:id/check", async (c) => {
    const id = c.req.param("id");
    const conn = listConnections().find((c) => c.id === id);
    if (!conn) return c.json({ error: "Connection not found" }, 404);
    
    const { updateConnection } = await import("./auth/store.ts");
    
    // Skip check for connections with empty accessToken — mark expired immediately
    if (!conn.accessToken) {
      log.warn(`[Check] ${conn.label} has empty accessToken — marking expired`);
      await setConnectionStatus(conn.id, "expired");
      return c.json({ valid: false, expired: true, reason: "empty_token" });
    }
    
    if (conn.provider === "cline") {
      const { checkClineToken } = await import("./auth/oauth.ts");
      const status = await checkClineToken(conn.accessToken);
      
      // Token invalid → mark expired
      if (!status.valid) {
        log.warn(`[Check] ${conn.label} (Cline) token invalid — marking expired`);
        await setConnectionStatus(conn.id, "expired");
        return c.json({ valid: false, expired: true, reason: "token_invalid" });
      }
      
      let uid = status.uid || conn.uid || "";
      
      // Save UID if we got it and it wasn't stored
      if (status.uid && !conn.uid) {
        await updateConnection(conn.id, { uid: status.uid });
        uid = status.uid;
      }
      
      let balance = 0;
      
      // Always try to fetch balance
      if (uid) {
        try {
          const balRes = await fetch(`https://api.cline.bot/api/v1/users/${uid}/balance`, {
            headers: { "Authorization": `Bearer workos:${conn.accessToken}`, "User-Agent": "Cline/3.79.0" },
          });
          const balData = await balRes.json() as any;
          log.info(`[Cline check] Balance response for ${uid}: ${JSON.stringify(balData)}`);
          if (balData?.success && balData?.data) {
            balance = balData.data.balance ?? 0;
          }
        } catch (e: any) {
          log.error(`[Cline check] Balance fetch error: ${e.message}`);
        }
      } else {
        log.warn(`[Cline check] No UID for connection ${conn.label}`);
      }
      
      // Update credit in DB — also ensure status is active since token is valid
      await updateConnection(conn.id, {
        credit: { totalCredits: balance, remainingCredits: balance, usedCredits: 0, packageName: "Cline", expiresAt: "", fetchedAt: Date.now() },
      });
      if (conn.status !== "active") await setConnectionStatus(conn.id, "active");
      
      return c.json({ valid: true, uid, balance, credit: { totalCredits: balance, remainingCredits: balance } });
    }
    
    // Qoder
    if (conn.provider === "qoder") {
      const { checkQoderToken } = await import("./auth/oauth.ts");
      const qoderStatus = await checkQoderToken(conn.accessToken, conn.uid || "");
      
      if (!qoderStatus.valid) {
        log.warn(`[Check] ${conn.label} (Qoder) token invalid — marking expired`);
        await setConnectionStatus(conn.id, "expired");
        return c.json({ valid: false, expired: true, reason: "token_invalid" });
      }
      
      // Update credit info
      const credit = {
        totalCredits: 0,
        remainingCredits: qoderStatus.isQuotaExceeded ? 0 : 1,
        usedCredits: 0,
        packageName: qoderStatus.plan || "Free",
        expiresAt: "",
        fetchedAt: Date.now(),
      };
      await updateConnection(conn.id, { credit });
      if (conn.status !== "active") await setConnectionStatus(conn.id, "active");
      
      return c.json({ valid: true, plan: qoderStatus.plan, isQuotaExceeded: qoderStatus.isQuotaExceeded, credit });
    }
    
    // Kiro
    if (conn.provider === "kiro") {
      const kiroStatus = await checkKiroToken(conn.accessToken, conn.uid);
      
      if (!kiroStatus.valid) {
        if (kiroStatus.suspended) {
          log.warn(`[Check] ${conn.label} (Kiro) account suspended — marking disabled`);
          await setConnectionStatus(conn.id, "disabled");
          return c.json({ valid: false, suspended: true, reason: "account_suspended" });
        }
        log.warn(`[Check] ${conn.label} (Kiro) token invalid — marking expired`);
        await setConnectionStatus(conn.id, "expired");
        return c.json({ valid: false, expired: true, reason: "token_invalid" });
      }
      
      // Update credit from usage data
      if (kiroStatus.usage) {
        await updateConnection(conn.id, {
          credit: { ...kiroStatus.usage, fetchedAt: Date.now() },
        });
      }
      if (conn.status !== "active") await setConnectionStatus(conn.id, "active");
      
      return c.json({ valid: true, credit: kiroStatus.usage });
    }
    
    // CodeBuddy
    const status = await checkToken(conn.accessToken);
    
    // Token invalid - mark expired
    if (!status.valid) {
      log.warn(`[Check] ${conn.label} (CodeBuddy) token invalid - marking expired`);
      await setConnectionStatus(conn.id, "expired");
      return c.json({ valid: false, expired: true, reason: "token_invalid" });
    }
    
    // Token valid - ensure status is active
    if (conn.status !== "active") await setConnectionStatus(conn.id, "active");
    
    // Save UID if returned by checkToken and not already stored
    const uid = status.uid || conn.uid || "";
    if (status.uid && !conn.uid) {
      await updateConnection(conn.id, { uid: status.uid });
    }
    
    // Fetch fresh credit (tries Bearer token first, falls back to cookie)
    {
      const { checkServiceCredit } = await import("./auth/oauth.ts");
      const credit = await checkServiceCredit(conn.accessToken, uid, conn.webCookie);
      if (credit) {
        await updateConnection(conn.id, {
          credit: { ...credit, fetchedAt: Date.now() },
        });
        return c.json({ valid: true, ...status, credit });
      }
    }
    
    return c.json(status);
  });

  // --- Batch connect (add accounts) ---
  app.post("/api/batch-connect", async (c) => {
    const body = await c.req.json();
    const { accounts, concurrency = 2, headless = true, providers = ["codebuddy"] } = body as {
      accounts: Array<{ email: string; password: string; label?: string }>;
      concurrency?: number;
      headless?: boolean;
      providers?: string[];
    };

    if (!accounts || !Array.isArray(accounts) || accounts.length === 0) {
      return c.json({ error: "accounts array is required" }, 400);
    }

    if (!isAutomationReady()) {
      return c.json({ error: "Automation not set up. Run: hexos auth setup-automation" }, 400);
    }

    // Run batch connect in background, return immediately
    const taskId = crypto.randomUUID();
    batchConnectTasks.set(taskId, { status: "running", total: accounts.length, completed: 0, success: 0, failed: 0, errors: [], logs: [] });

    // Capture logs via listener (non-invasive, no global hook)
    // Filter out credit-check noise — those run on a background timer and clutter batch logs
    const BATCH_LOG_IGNORE = ["[CreditCheck]", "[Check credits]", "[Check]"];
    const logListener = (level: BatchTaskLog["level"], msg: string) => {
      const task = batchConnectTasks.get(taskId);
      if (task && task.status === "running") {
        if (BATCH_LOG_IGNORE.some((prefix) => msg.includes(prefix))) return;
        const time = new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
        task.logs.push({ time, level, message: msg });
        if (task.logs.length > 500) task.logs.splice(0, task.logs.length - 500);
      }
    };
    log.addListener(logListener);

    // Fire and forget
    const cancelCheck = () => batchCancelFlags.get(taskId) === true;
    const onProgress = (completed: number, success: number, failed: number) => {
      const task = batchConnectTasks.get(taskId);
      if (task && task.status === "running") {
        task.completed = completed;
        task.success = success;
        task.failed = failed;
      }
    };

    batchConnect(accounts, concurrency, headless, cancelCheck, providers, onProgress).then((result) => {
      const task = batchConnectTasks.get(taskId);
      if (task && task.status === "running") {
        task.status = "completed";
        task.total = result.total;
        task.completed = result.success + result.failed;
        task.success = result.success;
        task.failed = result.failed;
        task.errors = result.errors;
      }
    }).catch((err) => {
      const task = batchConnectTasks.get(taskId);
      if (task) {
        task.status = "failed";
        task.errors.push(String(err));
      }
    }).finally(() => {
      log.removeListener(logListener);
    });

    return c.json({ taskId, message: `Batch connect started for ${accounts.length} accounts` });
  });

  app.get("/api/batch-connect/:taskId", (c) => {
    const taskId = c.req.param("taskId");
    const task = batchConnectTasks.get(taskId);
    if (!task) return c.json({ error: "Task not found" }, 404);
    return c.json(task);
  });

  app.post("/api/batch-connect/:taskId/cancel", async (c) => {
    const taskId = c.req.param("taskId");
    const task = batchConnectTasks.get(taskId);
    if (!task) return c.json({ error: "Task not found" }, 404);
    if (task.status !== "running") return c.json({ error: "Task not running" }, 400);
    batchCancelFlags.set(taskId, true);
    task.status = "cancelled";
    const time = new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
    task.logs.push({ time, level: "error", message: "Batch cancelled by user" });
    // Kill all active browser automation processes
    const { killAllActiveProcs } = await import("./auth/oauth.ts");
    killAllActiveProcs();
    task.logs.push({ time, level: "info", message: "Browser processes terminated" });
    return c.json({ ok: true });
  });

  // --- Check credits for all connections ---
  app.post("/api/connections/check-credits", async (c) => {
    const conns = listConnections();
    const results: Array<{ id: string; label: string; provider: string; valid: boolean; expired?: boolean; reason?: string; credit?: unknown }> = [];
    let expiredCount = 0;
    let reactivatedCount = 0;
    
    await Promise.all(conns.map(async (conn) => {
      try {
        // Skip connections with empty accessToken — mark expired immediately
        if (!conn.accessToken) {
          if (conn.status !== "expired") {
            await setConnectionStatus(conn.id, "expired");
            expiredCount++;
          }
          results.push({ id: conn.id, label: conn.label, provider: conn.provider, valid: false, expired: true, reason: "empty_token" });
          return;
        }
        
        let status: { valid: boolean; credit?: any; uid?: string; email?: string };
        
        if (conn.provider === "cline") {
          // Cline: check token + fetch balance
          const { checkClineToken } = await import("./auth/oauth.ts");
          const clineStatus = await checkClineToken(conn.accessToken);
          
          if (!clineStatus.valid) {
            // Token invalid → mark expired
            if (conn.status !== "expired") {
              await setConnectionStatus(conn.id, "expired");
              expiredCount++;
              log.warn(`[Check credits] ${conn.label} (Cline) token invalid — marked expired`);
            }
            results.push({ id: conn.id, label: conn.label, provider: conn.provider, valid: false, expired: true, reason: "token_invalid" });
            return;
          }
          
          const uid = clineStatus.uid || conn.uid;
          let balance = 0;
          if (uid) {
            try {
              const balRes = await fetch(`https://api.cline.bot/api/v1/users/${uid}/balance`, {
                headers: { "Authorization": `Bearer workos:${conn.accessToken}`, "User-Agent": "Cline/3.79.0" },
              });
              const balData = await balRes.json() as any;
              if (balData?.success && balData?.data) balance = balData.data.balance ?? 0;
            } catch {}
          }
          status = {
            valid: true,
            credit: { totalCredits: balance, remainingCredits: balance, usedCredits: 0, packageName: "Cline", expiresAt: "" },
          };
        } else if (conn.provider === "qoder") {
          // Qoder: check token + quota status
          const { checkQoderToken } = await import("./auth/oauth.ts");
          const qoderStatus = await checkQoderToken(conn.accessToken, conn.uid || "");
          
          if (!qoderStatus.valid) {
            if (conn.status !== "expired") {
              await setConnectionStatus(conn.id, "expired");
              expiredCount++;
              log.warn(`[Check credits] ${conn.label} (Qoder) token invalid — marked expired`);
            }
            results.push({ id: conn.id, label: conn.label, provider: conn.provider, valid: false, expired: true, reason: "token_invalid" });
            return;
          }
          
          status = {
            valid: true,
            credit: {
              totalCredits: 0,
              remainingCredits: qoderStatus.isQuotaExceeded ? 0 : 1,
              usedCredits: 0,
              packageName: qoderStatus.plan || "Free",
              expiresAt: "",
            },
          };
        } else if (conn.provider === "kiro") {
          // Kiro: check token + fetch usage + detect suspended
          const kiroStatus = await checkKiroToken(conn.accessToken, conn.uid);
          
          if (!kiroStatus.valid) {
            if (kiroStatus.suspended) {
              if (conn.status !== "disabled") {
                await setConnectionStatus(conn.id, "disabled");
                expiredCount++;
                log.warn(`[Check credits] ${conn.label} (Kiro) account suspended — marked disabled`);
              }
              results.push({ id: conn.id, label: conn.label, provider: conn.provider, valid: false, expired: true, reason: "account_suspended" });
            } else {
              if (conn.status !== "expired") {
                await setConnectionStatus(conn.id, "expired");
                expiredCount++;
                log.warn(`[Check credits] ${conn.label} (Kiro) token invalid — marked expired`);
              }
              results.push({ id: conn.id, label: conn.label, provider: conn.provider, valid: false, expired: true, reason: "token_invalid" });
            }
            return;
          }
          
          status = {
            valid: true,
            credit: kiroStatus.usage ?? undefined,
          };
        } else {
          // CodeBuddy
          status = await checkToken(conn.accessToken);
          
          if (!status.valid) {
            // Token invalid - mark expired
            if (conn.status !== "expired") {
              await setConnectionStatus(conn.id, "expired");
              expiredCount++;
              log.warn(`[Check credits] ${conn.label} (CodeBuddy) token invalid - marked expired`);
            }
            results.push({ id: conn.id, label: conn.label, provider: conn.provider, valid: false, expired: true, reason: "token_invalid" });
            return;
          }
          
          // Save UID if returned and not stored
          if (status.uid && !conn.uid) {
            const { updateConnection } = await import("./auth/store.ts");
            await updateConnection(conn.id, { uid: status.uid });
          }
          
          // Fetch fresh credit
          {
            const resolvedUid = status.uid || conn.uid || "";
            const { checkServiceCredit } = await import("./auth/oauth.ts");
            const credit = await checkServiceCredit(conn.accessToken, resolvedUid, conn.webCookie);
            if (credit) {
              status = { ...status, credit };
            }
          }
        }
        
        // Token is valid — reactivate if it was expired/disabled
        if (conn.status !== "active" && conn.status !== "disabled") {
          await setConnectionStatus(conn.id, "active");
          reactivatedCount++;
          log.info(`[Check credits] ${conn.label} token valid — reactivated`);
        }
        
        if (status.credit) {
          const { updateConnection } = await import("./auth/store.ts");
          await updateConnection(conn.id, {
            credit: {
              totalCredits: (status.credit as any).totalCredits ?? 0,
              remainingCredits: (status.credit as any).remainingCredits ?? 0,
              usedCredits: (status.credit as any).usedCredits ?? 0,
              packageName: (status.credit as any).packageName ?? "",
              expiresAt: (status.credit as any).expiresAt ?? "",
              fetchedAt: Date.now(),
            },
          });
        }
        results.push({ id: conn.id, label: conn.label, provider: conn.provider, valid: status.valid, credit: status.credit });
      } catch {
        results.push({ id: conn.id, label: conn.label, provider: conn.provider, valid: false });
      }
    }));

    if (expiredCount > 0) log.warn(`[Check credits] ${expiredCount} connection(s) marked expired (invalid token)`);
    if (reactivatedCount > 0) log.info(`[Check credits] ${reactivatedCount} connection(s) reactivated (token valid again)`);

    return c.json({ checked: results.length, expired: expiredCount, reactivated: reactivatedCount, results });
  });

  // --- Remove exhausted (zero credit / disabled) connections ---
  app.post("/api/connections/remove-exhausted", async (c) => {
    const conns = listConnections();
    let removed = 0;
    for (const conn of conns) {
      const credit = conn.credit as { remainingCredits?: number } | undefined;
      const isExhausted = conn.status === "disabled" && credit && (credit.remainingCredits ?? 0) <= 0;
      if (isExhausted) {
        await removeConnection(conn.id);
        removed++;
      }
    }
    return c.json({ removed });
  });

  // --- Remove expired (token invalid) connections ---
  app.post("/api/connections/remove-expired", async (c) => {
    const conns = listConnections();
    let removed = 0;
    for (const conn of conns) {
      if (conn.status === "expired") {
        await removeConnection(conn.id);
        removed++;
      }
    }
    return c.json({ removed });
  });

  // --- Remove banned/suspended (disabled with remaining credit) connections ---
  app.post("/api/connections/remove-banned", async (c) => {
    const conns = listConnections();
    let removed = 0;
    for (const conn of conns) {
      if (conn.status === "disabled") {
        const credit = conn.credit as { remainingCredits?: number } | undefined;
        const hasCredit = (credit?.remainingCredits ?? -1) !== 0;
        if (hasCredit) {
          await removeConnection(conn.id);
          removed++;
        }
      }
    }
    return c.json({ removed });
  });

  // --- Export / Import ---
  app.get("/api/export", (c) => {
    const data = exportData();
    return c.json(data);
  });

  app.post("/api/import", async (c) => {
    const body = await c.req.json();
    const result = await importData(body);
    return c.json(result);
  });

  // --- Qoder Auth ---

  // Add Qoder connection manually (uid + token)
  app.post("/api/qoder/add", async (c) => {
    const body = await c.req.json();
    const { uid, token, refreshToken, label } = body as {
      uid: string; token: string; refreshToken?: string; label?: string;
    };

    if (!uid || !token) {
      return c.json({ error: "uid and token are required" }, 400);
    }

    const conn = await saveConnection({
      provider: "qoder",
      label: label || `Qoder (${uid.slice(0, 8)})`,
      accessToken: token,
      refreshToken: refreshToken || "",
      uid,
    });

    // Verify token
    try {
      const { checkQoderToken } = await import("./auth/oauth.ts");
      const status = await checkQoderToken(token, uid);
      if (status.valid) {
        const { updateConnection } = await import("./auth/store.ts");
        await updateConnection(conn.id, {
          credit: {
            totalCredits: 0,
            remainingCredits: status.isQuotaExceeded ? 0 : 1,
            usedCredits: 0,
            packageName: status.plan || "Free",
            expiresAt: "",
            fetchedAt: Date.now(),
          },
        });
      }
      return c.json({ ok: true, id: conn.id, valid: status.valid, plan: status.plan, email: status.email });
    } catch {
      return c.json({ ok: true, id: conn.id, valid: null, message: "Saved but could not verify" });
    }
  });

  // Import Qoder credentials from CLI auth files
  app.post("/api/qoder/import-cli", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { authDir, label } = body as { authDir?: string; label?: string };

    const { importQoderFromCli } = await import("./auth/oauth.ts");
    const result = await importQoderFromCli(authDir, label);
    if (!result.success) {
      return c.json({ error: result.error }, 400);
    }
    return c.json({ ok: true });
  });

  // Decrypt Qoder IDE auth (Windows DPAPI) — only works on the machine where IDE is installed
  app.post("/api/qoder/import-ide", async (c) => {
    try {
      const fs = require("fs");
      const path = require("path");
      const { homedir } = require("os");

      const vscdbPath = path.join(homedir(), "AppData", "Roaming", "Qoder", "User", "globalStorage", "state.vscdb");
      const localStatePath = path.join(homedir(), "AppData", "Roaming", "Qoder", "Local State");

      if (!fs.existsSync(vscdbPath) || !fs.existsSync(localStatePath)) {
        return c.json({ error: "Qoder IDE not found on this machine" }, 400);
      }

      // Decrypt DPAPI master key
      const localState = JSON.parse(fs.readFileSync(localStatePath, "utf8"));
      const encKeyB64 = localState.os_crypt?.encrypted_key;
      if (!encKeyB64) return c.json({ error: "No encryption key in Local State" }, 400);

      const dpapiBlob = Buffer.from(encKeyB64, "base64").slice(5); // strip "DPAPI" prefix
      const ps = Bun.spawnSync([
        "powershell", "-NoProfile", "-Command",
        `Add-Type -AssemblyName System.Security; ` +
        `$bytes = [Convert]::FromBase64String('${dpapiBlob.toString("base64")}'); ` +
        `$decrypted = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, 'CurrentUser'); ` +
        `[Convert]::ToBase64String($decrypted)`,
      ]);
      const masterKey = Buffer.from(ps.stdout.toString().trim(), "base64");
      if (masterKey.length !== 32) return c.json({ error: "Failed to decrypt master key" }, 500);

      // Read encrypted auth from vscdb
      const Database = (await import("bun:sqlite")).default;
      const db = new Database(vscdbPath, { readonly: true });
      const row = db.query("SELECT value FROM ItemTable WHERE key = ?").get("secret://aicoding.auth.userInfo") as any;
      db.close();

      if (!row) return c.json({ error: "No auth data in Qoder IDE" }, 400);

      const parsed = JSON.parse(row.value);
      const encrypted = Buffer.from(parsed.data);

      // Decrypt: v10 prefix (3 bytes) + nonce (12 bytes) + ciphertext + tag (16 bytes)
      const prefix = encrypted.slice(0, 3).toString("utf8");
      if (prefix !== "v10") return c.json({ error: "Unknown encryption format" }, 400);

      const crypto = require("crypto");
      const nonce = encrypted.slice(3, 15);
      const ciphertextWithTag = encrypted.slice(15);
      const tag = ciphertextWithTag.slice(-16);
      const ciphertext = ciphertextWithTag.slice(0, -16);

      const decipher = crypto.createDecipheriv("aes-256-gcm", masterKey, nonce);
      decipher.setAuthTag(tag);
      let decrypted = decipher.update(ciphertext);
      decrypted = Buffer.concat([decrypted, decipher.final()]);
      const userInfo = JSON.parse(decrypted.toString("utf8"));

      if (!userInfo.id || !userInfo.token) {
        return c.json({ error: "Decrypted data missing id or token" }, 400);
      }

      // Save connection
      const conn = await saveConnection({
        provider: "qoder",
        label: userInfo.email || userInfo.name || `Qoder IDE (${userInfo.id.slice(0, 8)})`,
        accessToken: userInfo.token,
        refreshToken: userInfo.refreshToken || "",
        uid: userInfo.id,
      });

      return c.json({
        ok: true,
        id: conn.id,
        email: userInfo.email,
        name: userInfo.name,
        plan: userInfo.userTag || userInfo.userType,
        isQuotaExceeded: userInfo.isQuotaExceeded,
      });
    } catch (e: any) {
      return c.json({ error: e.message || "Failed to import from IDE" }, 500);
    }
  });

  // Qoder browser login (Camoufox automation)
  app.post("/api/qoder/login", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { email, password, label, headless } = body as {
      email?: string;
      password?: string;
      label?: string;
      headless?: boolean;
    };

    if (!email || !password) {
      return c.json({ error: "Email and password are required" }, 400);
    }

    const { oauthQoderAutomated } = await import("./auth/oauth.ts");
    const result = await oauthQoderAutomated(email, password, label, undefined, headless ?? true);
    if (!result.success) {
      return c.json({ error: result.error }, 400);
    }
    return c.json({ ok: true });
  });

  // --- Codex OAuth PKCE endpoints ---

  // Generate OAuth PKCE auth URL for dashboard popup flow
  app.get("/api/codex/auth-url", (c) => {
    const codeVerifier = crypto.randomBytes(32).toString("base64url");
    const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
    const state = crypto.randomBytes(16).toString("hex");
    const redirectUri = "http://localhost:1455/auth/callback";

    const params = new URLSearchParams({
      response_type: "code",
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
      redirect_uri: redirectUri,
      scope: "openid profile email offline_access",
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      originator: "codex_cli_rs",
      state,
    });

    const authUrl = `https://auth.openai.com/oauth/authorize?${params.toString()}`;
    return c.json({ authUrl, state, codeVerifier, redirectUri });
  });

  // Exchange auth code for tokens
  app.post("/api/codex/exchange", async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const { code, codeVerifier, redirectUri } = body as {
        code?: string;
        codeVerifier?: string;
        redirectUri?: string;
      };

      if (!code || !codeVerifier) {
        return c.json({ error: "code and codeVerifier are required" }, 400);
      }

      const tokenRes = await fetch("https://auth.openai.com/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
          code,
          redirect_uri: redirectUri || "http://localhost:1455/auth/callback",
          code_verifier: codeVerifier,
        }).toString(),
      });

      if (!tokenRes.ok) {
        const errText = await tokenRes.text();
        return c.json({ error: `Token exchange failed: ${tokenRes.status}`, details: errText }, 400);
      }

      const tokens = (await tokenRes.json()) as {
        access_token: string;
        refresh_token?: string;
        expires_in?: number;
      };

      const parsed = parseCodexToken(tokens.access_token);
      const conn = await saveConnection({
        provider: "codex",
        label: parsed.email || "codex-user",
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        uid: parsed.userId,
        expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined,
      });

      return c.json({
        success: true,
        connection: { id: conn.id, email: parsed.email, plan: parsed.planType },
      });
    } catch (err: any) {
      return c.json({ error: err.message || "Token exchange failed" }, 500);
    }
  });

  // Import Codex tokens manually
  app.post("/api/codex/import", async (c) => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const { accessToken, refreshToken, source } = body as {
        accessToken?: string;
        refreshToken?: string;
        source?: string;
      };

      if (!accessToken || !refreshToken) {
        return c.json({ error: "accessToken and refreshToken are required" }, 400);
      }

      const parsed = parseCodexToken(accessToken);
      const conn = await saveConnection({
        provider: "codex",
        label: parsed.email || source || "codex-import",
        accessToken,
        refreshToken,
        uid: parsed.userId,
      });

      return c.json({
        success: true,
        connection: { id: conn.id, email: parsed.email, plan: parsed.planType },
      });
    } catch (err: any) {
      return c.json({ error: err.message || "Import failed" }, 500);
    }
  });

  // --- Models ---
  app.get("/api/models", (c) => {
    const models = Object.entries(MODEL_CATALOG).map(([alias, entry]) => ({
      id: entry.info.id,
      name: entry.info.name,
      provider: entry.provider,
      upstreamModel: entry.model,
      contextWindow: entry.info.contextWindow ?? null,
    }));
    return c.json(models);
  });

  // --- API Keys ---
  app.get("/api/keys", (c) => {
    const keys = getApiKeys();
    return c.json(keys.map((k) => ({
      key: k,
      masked: k.slice(0, 8) + "..." + k.slice(-4),
    })));
  });

  // --- Usage records (for logs page) ---
  app.get("/api/usage/records", (c) => {
    const limit = c.req.query("limit") ? parseInt(c.req.query("limit")!) : 100;
    const model = c.req.query("model") || undefined;
    const accountId = c.req.query("accountId") || undefined;
    const since = c.req.query("since") ? parseInt(c.req.query("since")!) : undefined;
    return c.json(getRecords({ limit, model, accountId, since }));
  });

  // --- Usage stats with time range ---
  app.get("/api/usage/stats", (c) => {
    const since = c.req.query("since") ? parseInt(c.req.query("since")!) : undefined;
    return c.json(getStats(since));
  });

  // --- Usage chart data (aggregated by day/week/month) ---
  app.get("/api/usage/chart", (c) => {
    const range = c.req.query("range") || "week"; // day, week, month
    const now = Date.now();
    let since: number;
    let bucketMs: number;
    let bucketCount: number;

    switch (range) {
      case "day":
        since = now - 24 * 60 * 60 * 1000;
        bucketMs = 60 * 60 * 1000; // 1 hour buckets
        bucketCount = 24;
        break;
      case "month":
        since = now - 30 * 24 * 60 * 60 * 1000;
        bucketMs = 24 * 60 * 60 * 1000; // 1 day buckets
        bucketCount = 30;
        break;
      case "week":
      default:
        since = now - 7 * 24 * 60 * 60 * 1000;
        bucketMs = 24 * 60 * 60 * 1000; // 1 day buckets
        bucketCount = 7;
        break;
    }

    const records = getRecords({ since, limit: 10000 });

    // Initialize buckets
    const buckets: Array<{
      timestamp: number;
      label: string;
      requests: number;
      tokens: number;
      promptTokens: number;
      completionTokens: number;
      creditCost: number;
      successCount: number;
      failCount: number;
    }> = [];

    for (let i = 0; i < bucketCount; i++) {
      const bucketStart = since + i * bucketMs;
      const date = new Date(bucketStart);
      let label: string;
      if (range === "day") {
        label = date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
      } else {
        label = date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
      }
      buckets.push({
        timestamp: bucketStart,
        label,
        requests: 0,
        tokens: 0,
        promptTokens: 0,
        completionTokens: 0,
        creditCost: 0,
        successCount: 0,
        failCount: 0,
      });
    }

    // Fill buckets
    for (const rec of records) {
      const bucketIdx = Math.floor((rec.timestamp - since) / bucketMs);
      if (bucketIdx >= 0 && bucketIdx < bucketCount) {
        buckets[bucketIdx].requests++;
        buckets[bucketIdx].tokens += rec.totalTokens;
        buckets[bucketIdx].promptTokens += rec.promptTokens;
        buckets[bucketIdx].completionTokens += rec.completionTokens;
        buckets[bucketIdx].creditCost += rec.creditCost;
        if (rec.success) buckets[bucketIdx].successCount++;
        else buckets[bucketIdx].failCount++;
      }
    }

    return c.json({ range, buckets });
  });

  // --- Content Filters ---
  app.get("/api/filters", (c) => {
    return c.json(getFilterConfig());
  });

  app.post("/api/filters/toggle", async (c) => {
    const { enabled } = await c.req.json() as { enabled: boolean };
    await setFilterEnabled(enabled);
    return c.json({ ok: true });
  });

  app.post("/api/filters/provider", async (c) => {
    const { provider, enabled } = await c.req.json() as { provider: string; enabled: boolean | null };
    await setProviderOverride(provider, enabled);
    return c.json({ ok: true });
  });

  app.post("/api/filters/rules/:id/toggle", async (c) => {
    const { enabled } = await c.req.json() as { enabled: boolean };
    await setRuleEnabled(c.req.param("id"), enabled);
    return c.json({ ok: true });
  });

  app.post("/api/filters/rules", async (c) => {
    const body = await c.req.json() as { label: string; pattern: string; flags?: string; replacement: string };
    const rule = await addCustomRule(body);
    return c.json(rule);
  });

  app.put("/api/filters/rules/:id", async (c) => {
    const body = await c.req.json();
    await updateCustomRule(c.req.param("id"), body);
    return c.json({ ok: true });
  });

  app.delete("/api/filters/rules/:id", async (c) => {
    const ok = await removeCustomRule(c.req.param("id"));
    return c.json({ ok });
  });

  // --- Integration: detect tools ---
  app.get("/api/integrations", async (c) => {
    const keys = getApiKeys();
    const apiKey = keys.length > 0 ? keys[0] : "";
    const baseUrl = `http://127.0.0.1:${c.req.header("host")?.split(":")[1] || "7470"}`;
    const tools = await detectTools(apiKey, baseUrl);
    return c.json(tools);
  });

  // --- Integration: bind tool ---
  app.post("/api/integrations/:toolId/bind", async (c) => {
    const toolId = c.req.param("toolId");
    const keys = getApiKeys();
    const apiKey = keys.length > 0 ? keys[0] : "";
    const baseUrl = `http://127.0.0.1:${c.req.header("host")?.split(":")[1] || "7470"}`;
    let modelMap: Record<string, string> | undefined;
    try {
      const body = await c.req.json();
      modelMap = body?.modelMap;
    } catch {}
    const result = await bindTool(toolId, apiKey, baseUrl, modelMap);
    return c.json(result, result.success ? 200 : 400);
  });

  // --- Integration: unbind tool ---
  app.post("/api/integrations/:toolId/unbind", async (c) => {
    const toolId = c.req.param("toolId");
    const result = await unbindTool(toolId);
    return c.json(result, result.success ? 200 : 400);
  });

  // --- Integration: read tool config ---
  app.get("/api/integrations/:toolId/config", async (c) => {
    const toolId = c.req.param("toolId");
    const result = await readToolConfig(toolId);
    return c.json(result);
  });

  // --- Integration: generate config (manual copy-paste) ---
  app.get("/api/integrations/:toolId/generate", async (c) => {
    const toolId = c.req.param("toolId");
    const keys = getApiKeys();
    const apiKey = keys.length > 0 ? keys[0] : "";
    const baseUrl = `http://127.0.0.1:${c.req.header("host")?.split(":")[1] || "7470"}`;
    // Parse modelMap from query params: ?ANTHROPIC_MODEL=xxx&ANTHROPIC_DEFAULT_OPUS_MODEL=yyy
    const modelMap: Record<string, string> = {};
    for (const [k, v] of Object.entries(c.req.query())) {
      if (k !== "toolId" && v) modelMap[k] = v as string;
    }

    const { generateToolConfig } = await import("./integration/tools.ts");
    const result = generateToolConfig(toolId, apiKey, baseUrl, Object.keys(modelMap).length > 0 ? modelMap : undefined);
    return c.json(result);
  });

  // --- Proxy pool ---
  app.get("/api/proxies", (c) => {
    return c.json(getProxies());
  });

  app.post("/api/proxies", async (c) => {
    const body = await c.req.json();
    const { url, label } = body as { url: string; label?: string };
    if (!url) return c.json({ error: "url is required" }, 400);
    try {
      const entry = await addProxy(url, label);
      return c.json(entry);
    } catch (err: any) {
      return c.json({ error: err.message }, 400);
    }
  });

  app.post("/api/proxies/batch", async (c) => {
    const body = await c.req.json();
    const { text } = body as { text: string };
    if (!text) return c.json({ error: "text is required" }, 400);
    const result = await batchAddProxies(text);
    return c.json(result);
  });

  app.delete("/api/proxies/:id", async (c) => {
    const id = c.req.param("id");
    await removeProxy(id);
    return c.json({ ok: true });
  });

  app.post("/api/proxies/remove-all", async (c) => {
    const count = await removeAllProxies();
    return c.json({ removed: count });
  });

  app.post("/api/proxies/remove-dead", async (c) => {
    const count = await removeDeadProxies();
    return c.json({ removed: count });
  });

  app.post("/api/proxies/:id/check", async (c) => {
    const id = c.req.param("id");
    const result = await checkProxy(id);
    return c.json(result);
  });

  app.post("/api/proxies/check-all", async (c) => {
    await checkAllProxies();
    return c.json({ ok: true, proxies: getProxies() });
  });

  // --- Proxy scraper ---
  app.get("/api/scraper/sources", (c) => {
    return c.json(getSources());
  });

  app.get("/api/scraper/status", (c) => {
    return c.json(getScrapeStatus());
  });

  app.post("/api/scraper/start", async (c) => {
    let sourceIds: string[] | undefined;
    let concurrency: number | undefined;
    try {
      const body = await c.req.json();
      sourceIds = body?.sourceIds;
      concurrency = body?.concurrency;
    } catch {}
    try {
      await startScrape(sourceIds, concurrency);
      return c.json({ ok: true });
    } catch (err: any) {
      return c.json({ error: err.message }, 400);
    }
  });

  app.post("/api/scraper/cancel", (c) => {
    cancelScrape();
    return c.json({ ok: true });
  });

  app.post("/api/scraper/integrate", async (c) => {
    let proxyUrls: string[] | undefined;
    try {
      const body = await c.req.json();
      proxyUrls = body?.proxyUrls;
    } catch {}
    const result = await integrateResults(proxyUrls);
    return c.json(result);
  });

  // --- System info ---
  app.get("/api/system", (c) => {
    return c.json({
      version: "0.1.4",
      runtime: "bun",
      automationReady: isAutomationReady(),
      providers: Object.values(PROVIDERS).map((p) => ({
        id: p.id,
        name: p.name,
        format: p.format,
      })),
    });
  });

  // --- Serve embedded dashboard (static export) ---
  // Dashboard files are at ~/.hexos/dashboard/ (placed by installer or build script)
  const dashboardDir = join(homedir(), ".hexos", "dashboard");
  const hasDashboard = existsSync(dashboardDir);

  if (hasDashboard) {
    const MIME_TYPES: Record<string, string> = {
      ".html": "text/html",
      ".css": "text/css",
      ".js": "application/javascript",
      ".json": "application/json",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".gif": "image/gif",
      ".svg": "image/svg+xml",
      ".ico": "image/x-icon",
      ".woff": "font/woff",
      ".woff2": "font/woff2",
      ".ttf": "font/ttf",
      ".txt": "text/plain",
      ".webp": "image/webp",
      ".avif": "image/avif",
    };

    app.get("*", async (c) => {
      const urlPath = c.req.path;

      // Skip API and proxy routes
      if (urlPath.startsWith("/api/") || urlPath.startsWith("/v1/") || urlPath === "/health") {
        return c.json({ error: { message: "Not found", type: "not_found" } }, 404);
      }

      // Try exact file match first
      let filePath = join(dashboardDir, urlPath);
      let file = Bun.file(filePath);
      if (await file.exists()) {
        const ext = extname(filePath);
        const contentType = MIME_TYPES[ext] || "application/octet-stream";
        return new Response(file, { headers: { "Content-Type": contentType, "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable" } });
      }

      // Try with .html extension (Next.js static export convention)
      filePath = join(dashboardDir, urlPath + ".html");
      file = Bun.file(filePath);
      if (await file.exists()) {
        return new Response(file, { headers: { "Content-Type": "text/html", "Cache-Control": "no-cache" } });
      }

      // Try index.html in directory
      filePath = join(dashboardDir, urlPath, "index.html");
      file = Bun.file(filePath);
      if (await file.exists()) {
        return new Response(file, { headers: { "Content-Type": "text/html", "Cache-Control": "no-cache" } });
      }

      // SPA fallback: serve root index.html for client-side routing
      filePath = join(dashboardDir, "index.html");
      file = Bun.file(filePath);
      if (await file.exists()) {
        return new Response(file, { headers: { "Content-Type": "text/html", "Cache-Control": "no-cache" } });
      }

      return c.json({ error: { message: "Not found", type: "not_found" } }, 404);
    });

    log.info(`Dashboard: serving from ${dashboardDir}`);
  } else {
    // No dashboard — catch-all returns 404
    app.all("*", (c) => {
      log.warn(`Unhandled: ${c.req.method} ${c.req.path}`);
      return c.json({ error: { message: "Not found", type: "not_found" } }, 404);
    });
  }

  return app;
}
