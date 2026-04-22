import {
  getActiveConnections,
  getLeastUsedConnection,
  incrementUsage,
  recordFailure,
  setConnectionStatus,
  updateConnection,
  type Connection,
} from "../auth/store.ts";
import { refreshCodebuddy, refreshCline } from "../auth/oauth.ts";
import { PROVIDERS } from "../config/providers.ts";
import { resolveModel, getUpstreamModel } from "../config/models.ts";
import { log } from "../utils/logger.ts";
import { augmentMessages, applyRulesDeep } from "../utils/transform.ts";

// Try ALL active connections before giving up.
// Previously capped at 3, but with 100+ accounts we want full rotation.
const MAX_FAILOVER_ATTEMPTS = Infinity;

export interface ProxyMeta {
  model: string;
  accountId: string;
  accountLabel: string;
  startTime: number;
}

export async function proxyRequest(modelId: string, body: any, stream: boolean): Promise<Response> {
  const resolved = resolveModel(modelId);
  if (!resolved) {
    return errorResponse(400, `Unknown model: ${modelId}`);
  }

  const { provider: providerId } = resolved;
  const model = getUpstreamModel(resolved);
  const providerConfig = PROVIDERS[providerId];
  if (!providerConfig) {
    return errorResponse(400, `Unknown provider: ${providerId}`);
  }

  // Get active connections (excludes disabled)
  const connections = getActiveConnections(providerId);
  if (connections.length === 0) {
    return errorResponse(401, `No active connections for provider: ${providerId}. Run: hexos auth connect ${providerId}`);
  }

  // Build the sanitized request body once (shared across failover attempts)
  const { finalBodyStr, model: resolvedModel } = buildUpstreamBody(body, model, stream);

  // Track start time for latency measurement
  const startTime = Date.now();

  // Least-used selection with failover
  const triedIds = new Set<string>();
  let lastError = "";

  for (let attempt = 0; attempt < Math.min(MAX_FAILOVER_ATTEMPTS, connections.length); attempt++) {
    // Pick least-used connection that hasn't been tried yet
    const conn = pickConnection(providerId, triedIds);
    if (!conn) break;

    triedIds.add(conn.id);
    const connLabel = conn.label || conn.id.slice(0, 8);

    log.req("→", providerConfig.baseUrl, `model=${resolvedModel} account=${connLabel} (usage: ${conn.usageCount})`);

    // Build headers for this connection
    const headers = buildHeaders(conn, providerConfig);

    // Debug: save request body and scan for sensitive words
    debugScanBody(finalBodyStr, resolvedModel);

    try {
      const res = await fetch(providerConfig.baseUrl, {
        method: "POST",
        headers,
        body: finalBodyStr,
      });

      // Handle 401 — try refresh, then failover
      if (res.status === 401) {
        if (conn.refreshToken) {
          log.warn(`[${connLabel}] Token expired, refreshing...`);
          try {
            const refreshed = conn.provider === "cline"
              ? await refreshCline(conn.refreshToken)
              : await refreshCodebuddy(conn.refreshToken);
            await updateConnection(conn.id, {
              accessToken: refreshed.accessToken,
              refreshToken: refreshed.refreshToken,
            });
            headers.Authorization = providerConfig.authFormat === "workos"
              ? `Bearer workos:${refreshed.accessToken}`
              : `Bearer ${refreshed.accessToken}`;

            const retryRes = await fetch(providerConfig.baseUrl, {
              method: "POST",
              headers,
              body: finalBodyStr,
            });

            if (retryRes.ok || (retryRes.status >= 200 && retryRes.status < 400)) {
              await incrementUsage(conn.id);
              return addTrackingHeaders(retryRes, resolvedModel, conn, startTime);
            }

            // Refresh succeeded but request still failed
            log.warn(`[${connLabel}] Request failed after refresh (${retryRes.status}), trying next account...`);
            await recordFailure(conn.id);
            lastError = `${connLabel}: HTTP ${retryRes.status} after token refresh`;
            continue;
          } catch (e) {
            log.error(`[${connLabel}] Token refresh failed: ${e}`);
            await setConnectionStatus(conn.id, "expired");
            lastError = `${connLabel}: Token refresh failed`;
            continue;
          }
        }
        // No refresh token — mark expired and failover to next account
        log.warn(`[${connLabel}] Unauthorized (401), no refresh token — trying next account...`);
        await setConnectionStatus(conn.id, "expired");
        lastError = `${connLabel}: Unauthorized (401)`;
        continue;
      }

      // Handle 403 — forbidden / gateway block — failover
      if (res.status === 403) {
        log.warn(`[${connLabel}] Forbidden (403), trying next account...`);
        await recordFailure(conn.id);
        lastError = `${connLabel}: Forbidden (403)`;
        continue;
      }

      // Handle rate limiting (429) — could be rate limit OR credit exhausted
      if (res.status === 429) {
        let reason = "Rate limited";
        try {
          const body = await res.clone().text();
          const lower = body.toLowerCase();
          if (lower.includes("credit") || lower.includes("quota") || lower.includes("balance") || lower.includes("insufficient") || lower.includes("exceeded")) {
            reason = "Credit exhausted";
            log.error(`[${connLabel}] Credit exhausted (429): ${body.slice(0, 200)}`);
            await setConnectionStatus(conn.id, "disabled");
          } else {
            log.warn(`[${connLabel}] Rate limited (429): ${body.slice(0, 200)}`);
          }
        } catch {
          log.warn(`[${connLabel}] Rate limited (429), could not read body`);
        }
        lastError = `${connLabel}: ${reason} (429)`;
        continue;
      }

      // Handle server/gateway errors (5xx, 407, 408, 502, 503, 504) — failover
      if (res.status >= 500 || res.status === 407 || res.status === 408) {
        log.warn(`[${connLabel}] Server/gateway error (${res.status}), trying next account...`);
        await recordFailure(conn.id);
        lastError = `${connLabel}: HTTP ${res.status}`;
        continue;
      }

      // Success (2xx) or benign client error (400, 404, 422) — return as-is
      await incrementUsage(conn.id);
      return addTrackingHeaders(res, resolvedModel, conn, startTime);
    } catch (e: any) {
      log.error(`[${connLabel}] Network error: ${e.message}`);
      await recordFailure(conn.id);
      lastError = `${connLabel}: ${e.message}`;
      continue;
    }
  }

  // All connections exhausted
  log.error(`All connections failed. Last error: ${lastError}`);
  return errorResponse(502, `All connections failed. Last error: ${lastError}`);
}

/**
 * Pick the least-used connection that hasn't been tried yet.
 */
function pickConnection(providerId: string, triedIds: Set<string>): Connection | null {
  const active = getActiveConnections(providerId).filter(
    (c) => !triedIds.has(c.id) && !!c.accessToken
  );
  if (active.length === 0) return null;

  return active.reduce((best, conn) => {
    if (conn.usageCount < best.usageCount) return conn;
    if (conn.usageCount > best.usageCount) return best;
    const connLast = conn.lastUsedAt ?? 0;
    const bestLast = best.lastUsedAt ?? 0;
    if (connLast < bestLast) return conn;
    if (connLast > bestLast) return best;
    return conn.createdAt < best.createdAt ? conn : best;
  });
}

/**
 * Build the sanitized upstream request body.
 */
function buildUpstreamBody(body: any, model: string, stream: boolean): { finalBodyStr: string; model: string } {
  const {
    thinking,
    context_management,
    output_config,
    metadata,
    betas,
    speed,
    system,
    tools, tool_choice,
    ...cleanBody
  } = body;

  const upstreamBody: any = {
    model,
    stream,
    messages: cleanBody.messages ?? [],
    ...(cleanBody.max_tokens && { max_tokens: cleanBody.max_tokens }),
    ...(cleanBody.temperature !== undefined && { temperature: cleanBody.temperature }),
    ...(cleanBody.top_p !== undefined && { top_p: cleanBody.top_p }),
    ...(cleanBody.stop && { stop: cleanBody.stop }),
    ...(cleanBody.presence_penalty !== undefined && { presence_penalty: cleanBody.presence_penalty }),
    ...(cleanBody.frequency_penalty !== undefined && { frequency_penalty: cleanBody.frequency_penalty }),
  };

  if (system) {
    let systemText = "";
    if (typeof system === "string") {
      systemText = system;
    } else if (Array.isArray(system)) {
      systemText = system
        .map((s: any) => typeof s === "string" ? s : s?.text ?? "")
        .filter((s: string) => s && !s.match(/^:?\s*;?\s*(cc_|cch=)/))
        .join("\n\n");
    }
    if (systemText) {
      const hasSystem = upstreamBody.messages.some((m: any) => m.role === "system");
      if (!hasSystem) {
        upstreamBody.messages.unshift({ role: "system", content: systemText });
      }
    }
  }

  upstreamBody.messages = augmentMessages(upstreamBody.messages);

  if (Array.isArray(tools) && tools.length > 0) {
    upstreamBody.tools = applyRulesDeep(tools);
    if (tool_choice) upstreamBody.tool_choice = tool_choice;
  }

  const sanitizedBody = applyRulesDeep(upstreamBody) as any;
  sanitizedBody.model = model;

  return { finalBodyStr: JSON.stringify(sanitizedBody), model };
}

/**
 * Build request headers for a specific connection.
 */
function buildHeaders(conn: Connection, providerConfig: any): Record<string, string> {
  // Check provider's auth format
  const authHeader = providerConfig.authFormat === "workos"
    ? `Bearer workos:${conn.accessToken}`
    : `Bearer ${conn.accessToken}`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: authHeader,
    ...(providerConfig.headers ?? {}),
  };

  if (conn.uid && conn.provider === "codebuddy") {
    headers["X-User-Id"] = conn.uid;
    headers["X-Domain"] = "www.codebuddy.ai";
  }

  const requestId = Math.random().toString(36).slice(2, 18);
  headers["X-Conversation-ID"] = `hexos_${Date.now()}`;
  headers["X-Conversation-Request-ID"] = requestId;
  headers["X-Conversation-Message-ID"] = requestId;
  headers["X-Request-ID"] = requestId;
  headers["X-Agent-Intent"] = "craft";

  return headers;
}

/**
 * Debug: save request body and scan for remaining sensitive words.
 */
function debugScanBody(finalBodyStr: string, model: string) {
  try {
    const fs = require("fs");
    const debugDir = process.cwd();
    fs.writeFileSync(`${debugDir}/hexos-last-request.json`, finalBodyStr);

    const modelFieldPattern = `"model":"${model}"`;
    const sensitivePatterns: [string, RegExp][] = [
      ["claude", /claude/gi],
      ["anthropic", /anthropic/gi],
    ];
    let hasSensitive = false;
    for (const [label, pat] of sensitivePatterns) {
      const scanStr = finalBodyStr.replace(modelFieldPattern, "");
      const matches = scanStr.match(pat);
      if (matches) {
        hasSensitive = true;
        log.warn(`⚠ SENSITIVE WORD "${label}" found ${matches.length}x in request body`);
        const re = new RegExp(`.{0,30}${pat.source}.{0,30}`, "gi");
        const contexts = scanStr.match(re);
        if (contexts) {
          for (const ctx of contexts.slice(0, 3)) {
            log.warn(`  Context: ...${ctx.replace(/\n/g, " ")}...`);
          }
        }
      }
    }
    if (!hasSensitive) {
      log.info(`✓ Request body clean (${finalBodyStr.length} bytes)`);
    }
  } catch {}
}

/**
 * Add tracking metadata headers to the response.
 * These are used by server.ts to record usage after streaming completes.
 */
function addTrackingHeaders(res: Response, model: string, conn: Connection, startTime: number): Response {
  const newHeaders = new Headers(res.headers);
  newHeaders.set("X-Hexos-Model", model);
  newHeaders.set("X-Hexos-Account-Id", conn.id);
  newHeaders.set("X-Hexos-Account-Label", conn.label || conn.id.slice(0, 8));
  newHeaders.set("X-Hexos-Start-Time", String(startTime));

  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: newHeaders,
  });
}

function errorResponse(status: number, message: string): Response {
  return new Response(
    JSON.stringify({ error: { message, type: "proxy_error", code: status } }),
    { status, headers: { "Content-Type": "application/json" } }
  );
}
