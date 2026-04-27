import {
  getActiveConnections,
  getLeastUsedConnection,
  incrementUsage,
  recordFailure,
  setConnectionStatus,
  updateConnection,
  initializeCredit,
  type Connection,
} from "../auth/store.ts";
import { refreshCodebuddy, refreshCline, refreshKiro, refreshQoder } from "../auth/oauth.ts";
import { PROVIDERS } from "../config/providers.ts";
import { resolveModel, getUpstreamModel } from "../config/models.ts";
import { log } from "../utils/logger.ts";
import { augmentMessages, applyRulesDeep } from "../utils/transform.ts";
import { openaiToKiro } from "./kiro-transform.ts";
import { kiroToOpenAIStream, kiroToOpenAINonStream } from "./kiro-stream.ts";
import { buildQoderRequest, buildInferenceUrl, type QoderUserInfo } from "./qoder-auth.ts";
import { qoderToOpenAIStream, qoderToOpenAINonStream } from "./qoder-stream.ts";
import { buildCodexRequestBody, createCodexStreamTransformer, extractCodexRateLimits } from "./codex-stream.ts";
import { refreshCodex, isCodexTokenExpired } from "../auth/oauth.ts";
import crypto from "crypto";

// Try ALL active connections before giving up.
// Previously capped at 3, but with 100+ accounts we want full rotation.
const MAX_FAILOVER_ATTEMPTS = Infinity;

/**
 * Check credit for a single connection after a successful request.
 * Runs async (fire-and-forget) so it doesn't block the response.
 * 
 * For Service and Kiro: uses local credit tracking (initializeCredit only).
 * Actual deduction happens in server.ts when token counts are known from the SSE stream.
 * For Cline and Qoder: keeps upstream API checks (they work reliably).
 */
async function refreshCreditAfterUse(conn: Connection): Promise<void> {
  try {
    if (conn.provider === "Service") {
      // Local credit tracking — just ensure credit is initialized
      await initializeCredit(conn.id, conn.provider);
    } else if (conn.provider === "cline") {
      const uid = conn.uid;
      if (uid) {
        const balRes = await fetch(`https://api.cline.bot/api/v1/users/${uid}/balance`, {
          headers: { "Authorization": `Bearer workos:${conn.accessToken}`, "User-Agent": "Cline/3.79.0" },
        });
        const balData = await balRes.json() as any;
        if (balData?.success && balData?.data) {
          const balance = balData.data.balance ?? 0;
          await updateConnection(conn.id, {
            credit: { totalCredits: balance, remainingCredits: balance, usedCredits: 0, packageName: "Cline", expiresAt: "", fetchedAt: Date.now() },
          } as any);
        }
      }
    } else if (conn.provider === "kiro") {
      // Local credit tracking — just ensure credit is initialized
      await initializeCredit(conn.id, conn.provider);
    } else if (conn.provider === "qoder") {
      // Qoder free tier has isQuotaExceeded=true with 0 credits but API still works (soft limit).
      // NEVER disable based on quota check — only disable from upstream 429 with exhaustion keywords.
      const { checkQoderStatus } = await import("./qoder-auth.ts");
      const userInfo = _getQoderUserInfo(conn);
      if (userInfo) {
        const status = await checkQoderStatus(userInfo);
        if (status.valid) {
          await updateConnection(conn.id, {
            credit: {
              totalCredits: 1,
              remainingCredits: 1,
              usedCredits: 0,
              packageName: status.plan || (status.isQuotaExceeded ? "Free (soft limit)" : "Free"),
              expiresAt: status.nextResetAt ? new Date(status.nextResetAt).toISOString() : "",
              fetchedAt: Date.now(),
            },
          } as any);
          // Do NOT disable — Qoder free tier works even with isQuotaExceeded=true
        }
      }
    } else if (conn.provider === "codex") {
      // Codex credit is updated from rate limit headers in handleCodexResponse
      // Nothing extra needed here
    }
  } catch {
    // Silent — don't let credit check errors affect the proxy
  }
}

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

  // Kiro, Qoder, and Codex use completely different request/response formats
  const isKiro = providerConfig.format === "kiro";
  const isQoder = providerConfig.format === "qoder";
  const isCodex = providerConfig.format === "codex";

  // Build the process request body once (shared across failover attempts)
  // For Kiro/Qoder/Codex, we defer body building until we have the connection
  let finalBodyStr: string | null = null;
  let resolvedModel = model;
  if (!isKiro && !isQoder && !isCodex) {
    const built = buildUpstreamBody(body, model, stream, providerConfig.id);
    finalBodyStr = built.finalBodyStr;
    resolvedModel = built.model;
  }

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

    // For Kiro/Qoder: build body per-connection (needs connection-specific data)
    let requestBody: string;
    let requestUrl = providerConfig.baseUrl;
    let requestHeaders: Record<string, string>;

    if (isQoder) {
      // Qoder: custom auth + body encryption
      const userInfo = _getQoderUserInfo(conn);
      if (!userInfo) {
        log.error(`[${connLabel}] Missing Qoder credentials (uid/token). Skipping.`);
        lastError = `${connLabel}: Missing Qoder credentials`;
        continue;
      }

      // Build process body first (OpenAI format)
      const built = buildUpstreamBody(body, model, stream, providerConfig.id);
      let qoderBody: any;
      try { qoderBody = JSON.parse(built.finalBodyStr); } catch { qoderBody = {}; }

      // Inject Qoder-specific fields required by agent_router
      qoderBody.session_id = qoderBody.session_id || crypto.randomUUID();
      qoderBody.request_set_id = qoderBody.request_set_id || crypto.randomUUID();
      qoderBody.scene = qoderBody.scene || "chat";
      qoderBody.agent_id = qoderBody.agent_id || "agent_common";
      if (qoderBody.temperature === undefined) qoderBody.temperature = 0.7;
      if (!qoderBody.max_output_tokens && qoderBody.max_tokens) {
        qoderBody.max_output_tokens = qoderBody.max_tokens;
        delete qoderBody.max_tokens;
      }
      if (!qoderBody.max_output_tokens) qoderBody.max_output_tokens = 16384;

      const bodyJson = JSON.stringify(qoderBody);
      debugScanBody(bodyJson, resolvedModel, providerConfig.id);

      // Build Qoder request with auth
      requestUrl = buildInferenceUrl();
      const urlPath = new URL(requestUrl).pathname;
      const qoderReq = buildQoderRequest(userInfo, bodyJson, urlPath);
      requestBody = qoderReq.encryptedBody;

      // Set model selection header (lowercase for HTTP/2 compat)
      requestHeaders = {
        ...qoderReq.headers,
        "x-model-key": model,
        "x-model-source": "system",
      };
    } else if (isKiro) {
      const profileArn = conn.uid || "";
      const kiroBody = openaiToKiro(body, model, profileArn);
      requestBody = JSON.stringify(kiroBody);
      debugScanBody(requestBody, resolvedModel, providerConfig.id);
      requestHeaders = buildHeaders(conn, providerConfig);
    } else if (isCodex) {
      // Codex: transform to Responses API format
      requestBody = JSON.stringify(buildCodexRequestBody(body, model));
      debugScanBody(requestBody, resolvedModel, providerConfig.id);
      // Proactive token refresh if JWT is near expiry
      if (isCodexTokenExpired(conn.accessToken)) {
        log.info(`[${connLabel}] Codex token near expiry, refreshing proactively...`);
        try {
          const refreshed = await refreshCodex(conn.refreshToken!, conn.id);
          await updateConnection(conn.id, {
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken,
          });
          conn.accessToken = refreshed.accessToken;
        } catch (e: any) {
          log.warn(`[${connLabel}] Proactive Codex refresh failed: ${e.message}`);
        }
      }
      requestHeaders = buildHeaders(conn, providerConfig);
    } else {
      requestBody = finalBodyStr!;
      debugScanBody(requestBody, resolvedModel, providerConfig.id);
      requestHeaders = buildHeaders(conn, providerConfig);
    }

    try {
      const res = await fetch(requestUrl, {
        method: "POST",
        headers: requestHeaders,
        body: requestBody,
      });

      // Handle 401 — try refresh, then failover
      if (res.status === 401) {
        if (conn.refreshToken) {
          log.warn(`[${connLabel}] Token expired, refreshing...`);
          try {
            const refreshed = conn.provider === "kiro"
              ? await refreshKiro(conn.refreshToken)
              : conn.provider === "cline"
                ? await refreshCline(conn.refreshToken)
                : conn.provider === "qoder"
                  ? await refreshQoder(conn.refreshToken, conn.uid || "")
                  : conn.provider === "codex"
                    ? await refreshCodex(conn.refreshToken, conn.id)
                    : await refreshCodebuddy(conn.refreshToken);
            await updateConnection(conn.id, {
              accessToken: refreshed.accessToken,
              refreshToken: refreshed.refreshToken,
            });
            // Update connection token for retry
            if (isQoder) {
              // Qoder: rebuild entire request with new token
              const userInfo = _getQoderUserInfo(conn);
              if (userInfo) {
                userInfo.security_oauth_token = refreshed.accessToken;
                const built = buildUpstreamBody(body, model, stream, providerConfig.id);
                const urlPath = new URL(requestUrl).pathname;
                const qoderReq = buildQoderRequest(userInfo, built.finalBodyStr, urlPath);
                requestBody = qoderReq.encryptedBody;
                requestHeaders = { ...qoderReq.headers, "X-Model-Key": model, "X-Model-Source": "system" };
              }
            } else {
              requestHeaders.Authorization = `Bearer ${refreshed.accessToken}`;
            }

            // Retry with refreshed token
            const retryRes = await fetch(requestUrl, {
              method: "POST",
              headers: requestHeaders,
              body: requestBody,
            });

            if (retryRes.ok || (retryRes.status >= 200 && retryRes.status < 400)) {
              await incrementUsage(conn.id);
              refreshCreditAfterUse(conn).catch(() => {});
              if (isKiro) {
                return await handleKiroResponse(retryRes, resolvedModel, conn, startTime, stream, modelId);
              }
              if (isQoder) {
                return await handleQoderResponse(retryRes, resolvedModel, conn, startTime, stream, modelId);
              }
              if (isCodex) {
                return await handleCodexResponse(retryRes, resolvedModel, conn, startTime, modelId);
              }
              return addTrackingHeaders(retryRes, resolvedModel, conn, startTime, modelId);
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

      // Handle 403 — forbidden / suspended / gateway block — failover
      if (res.status === 403) {
        let reason = "Forbidden";
        try {
          const body403 = await res.clone().text();
          const lower = body403.toLowerCase();
          if (lower.includes("suspended") || lower.includes("locked") || lower.includes("banned")) {
            reason = "Account suspended";
            log.error(`[${connLabel}] Account suspended (403): ${body403.slice(0, 200)}`);
            await setConnectionStatus(conn.id, "disabled");
          } else {
            log.warn(`[${connLabel}] Forbidden (403): ${body403.slice(0, 200)}`);
            await recordFailure(conn.id);
          }
        } catch {
          log.warn(`[${connLabel}] Forbidden (403), trying next account...`);
          await recordFailure(conn.id);
        }
        lastError = `${connLabel}: ${reason} (403)`;
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

      // Success (2xx) or benign client error (400, 404, 422)
      await incrementUsage(conn.id);
      // Refresh credit for this account in background (non-blocking)
      refreshCreditAfterUse(conn).catch(() => {});

      // Kiro: convert EventStream binary → OpenAI SSE/JSON
      if (isKiro && res.ok) {
        return await handleKiroResponse(res, resolvedModel, conn, startTime, stream, modelId);
      }

      // Qoder: convert wrapped SSE → OpenAI SSE/JSON
      if (isQoder && res.ok) {
        return await handleQoderResponse(res, resolvedModel, conn, startTime, stream, modelId);
      }

      // Codex: convert Responses API SSE → OpenAI Chat Completions SSE
      if (isCodex && res.ok) {
        return await handleCodexResponse(res, resolvedModel, conn, startTime, modelId);
      }

      return addTrackingHeaders(res, resolvedModel, conn, startTime, modelId);
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
 * Sanitize tool definitions for upstream compatibility.
 * CodeBuddy doesn't support OpenAI's `strict` mode or `additionalProperties` in tool schemas.
 * Also strips deeply nested schema features that cause "invalid function call parameters".
 */
function sanitizeTools(tools: any[]): any[] {
  return tools.map((tool) => {
    if (tool.type !== "function" || !tool.function) return tool;

    const fn = { ...tool.function };

    // Remove strict mode (CodeBuddy doesn't support it)
    delete fn.strict;

    // Clean up parameters schema
    if (fn.parameters) {
      fn.parameters = sanitizeSchema(fn.parameters);
    }

    return { type: "function", function: fn };
  });
}

/** Recursively clean JSON schema for upstream compatibility */
function sanitizeSchema(schema: any): any {
  if (!schema || typeof schema !== "object") return schema;

  const cleaned = { ...schema };

  // Remove additionalProperties (CodeBuddy may not support it)
  delete cleaned.additionalProperties;

  // Remove $schema, $defs references
  delete cleaned.$schema;

  // Recursively clean nested properties
  if (cleaned.properties) {
    const props: Record<string, any> = {};
    for (const [key, value] of Object.entries(cleaned.properties)) {
      props[key] = sanitizeSchema(value);
    }
    cleaned.properties = props;
  }

  // Clean items in arrays
  if (cleaned.items) {
    cleaned.items = sanitizeSchema(cleaned.items);
  }

  // Clean anyOf/oneOf/allOf
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    if (Array.isArray(cleaned[key])) {
      cleaned[key] = cleaned[key].map((s: any) => sanitizeSchema(s));
    }
  }

  return cleaned;
}

/**
 * Build the sanitized upstream request body.
 */
function buildUpstreamBody(body: any, model: string, stream: boolean, provider?: string): { finalBodyStr: string; model: string } {
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

  // Text-replacement filters only needed for Service (cb/) — upstream validates
  // message content and rejects proxy/tool mentions. Other providers (cline, yepapi,
  // codex, etc.) don't need this and messages should pass through unmodified.
  if (provider === "Service") {
    upstreamBody.messages = augmentMessages(upstreamBody.messages, provider);
  }

  if (Array.isArray(tools) && tools.length > 0) {
    upstreamBody.tools = sanitizeTools(tools);
    if (tool_choice) upstreamBody.tool_choice = tool_choice;
  }

  const sanitizedBody = (provider === "codebuddy" ? applyRulesDeep(upstreamBody) : upstreamBody) as any;
  sanitizedBody.model = model;
  // Restore tools after applyRulesDeep (don't mangle tool schemas)
  if (upstreamBody.tools) sanitizedBody.tools = upstreamBody.tools;

  return { finalBodyStr: JSON.stringify(sanitizedBody), model };
}

/**
 * Handle Kiro response: convert AWS EventStream binary to OpenAI format.
 */
async function handleKiroResponse(
  res: Response,
  model: string,
  conn: Connection,
  startTime: number,
  stream: boolean,
  hexosModelId?: string,
): Promise<Response> {
  if (stream) {
    const { response, usagePromise } = kiroToOpenAIStream(res, model);
    // Fire-and-forget: log usage when stream completes
    usagePromise.then(({ promptTokens, completionTokens }) => {
      const elapsed = Date.now() - startTime;
      const connLabel = conn.label || conn.id.slice(0, 8);
      log.info(`📊 ${model} | ${connLabel} | prompt: ${promptTokens} | completion: ${completionTokens} | total: ${promptTokens + completionTokens} | ${elapsed}ms`);
    }).catch(() => {});
    return addTrackingHeaders(response, model, conn, startTime, hexosModelId);
  } else {
    const { response, promptTokens, completionTokens } = await kiroToOpenAINonStream(res, model);
    const elapsed = Date.now() - startTime;
    const connLabel = conn.label || conn.id.slice(0, 8);
    log.info(`📊 ${model} | ${connLabel} | prompt: ${promptTokens} | completion: ${completionTokens} | total: ${promptTokens + completionTokens} | ${elapsed}ms`);
    return addTrackingHeaders(response, model, conn, startTime, hexosModelId);
  }
}

/**
 * Handle Qoder response: convert wrapped SSE to OpenAI format.
 */
async function handleQoderResponse(
  res: Response,
  model: string,
  conn: Connection,
  startTime: number,
  stream: boolean,
  hexosModelId?: string,
): Promise<Response> {
  if (stream) {
    const { response, usagePromise } = qoderToOpenAIStream(res, model);
    usagePromise.then(({ promptTokens, completionTokens }) => {
      const elapsed = Date.now() - startTime;
      const connLabel = conn.label || conn.id.slice(0, 8);
      log.info(`📊 ${model} | ${connLabel} | prompt: ${promptTokens} | completion: ${completionTokens} | total: ${promptTokens + completionTokens} | ${elapsed}ms`);
    }).catch(() => {});
    return addTrackingHeaders(response, model, conn, startTime, hexosModelId);
  } else {
    const { response, promptTokens, completionTokens } = await qoderToOpenAINonStream(res, model);
    const elapsed = Date.now() - startTime;
    const connLabel = conn.label || conn.id.slice(0, 8);
    log.info(`📊 ${model} | ${connLabel} | prompt: ${promptTokens} | completion: ${completionTokens} | total: ${promptTokens + completionTokens} | ${elapsed}ms`);
    return addTrackingHeaders(response, model, conn, startTime, hexosModelId);
  }
}

/**
 * Handle Codex response: extract rate limits, transform Responses API SSE → OpenAI Chat Completions SSE.
 * Codex always streams (Responses API is SSE-only).
 */
async function handleCodexResponse(
  res: Response,
  model: string,
  conn: Connection,
  startTime: number,
  hexosModelId?: string,
): Promise<Response> {
  // Extract rate limits from response headers and update connection credit info
  const rateLimits = extractCodexRateLimits(res.headers);
  const connLabel = conn.label || conn.id.slice(0, 8);
  log.info(`[${connLabel}] Codex rate limits: plan=${rateLimits.planType} primary=${rateLimits.primaryUsedPercent}% secondary=${rateLimits.secondaryUsedPercent}%`);

  await updateConnection(conn.id, {
    credit: {
      totalCredits: 100,
      remainingCredits: 100 - rateLimits.primaryUsedPercent,
      usedCredits: rateLimits.primaryUsedPercent,
      packageName: `ChatGPT ${rateLimits.planType}`,
      expiresAt: rateLimits.primaryResetAt ? new Date(rateLimits.primaryResetAt * 1000).toISOString() : "",
      fetchedAt: Date.now(),
      // Codex-specific: dual window rate limits
      primaryUsedPercent: rateLimits.primaryUsedPercent,
      primaryWindowMinutes: rateLimits.primaryWindowMinutes,
      primaryResetAt: rateLimits.primaryResetAt,
      secondaryUsedPercent: rateLimits.secondaryUsedPercent,
      secondaryWindowMinutes: rateLimits.secondaryWindowMinutes,
      secondaryResetAt: rateLimits.secondaryResetAt,
    },
  } as any);

  if (!res.body) {
    return addTrackingHeaders(res, model, conn, startTime, hexosModelId);
  }

  // Pipe through SSE transformer: Responses API → Chat Completions format
  const transformer = createCodexStreamTransformer(model, crypto.randomUUID());
  const transformedStream = res.body.pipeThrough(transformer);

  const response = new Response(transformedStream, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    },
  });

  return addTrackingHeaders(response, model, conn, startTime, hexosModelId);
}

/**
 * Extract QoderUserInfo from a connection.
 * Qoder stores: accessToken = security_oauth_token, uid = user UUID,
 * label = email, refreshToken = refresh token.
 * Additional fields (name, email) stored in uid field as JSON or separate.
 */
function _getQoderUserInfo(conn: Connection): QoderUserInfo | null {
  if (!conn.accessToken || !conn.uid) return null;

  // Try to parse uid as JSON (may contain extra fields)
  let name = "";
  let email = conn.label || "";
  let uid = conn.uid;

  try {
    const parsed = JSON.parse(conn.uid);
    uid = parsed.uid || conn.uid;
    name = parsed.name || "";
    email = parsed.email || conn.label || "";
  } catch {
    // uid is just a plain string UUID
  }

  return {
    uid,
    security_oauth_token: conn.accessToken,
    name,
    email,
  };
}

/**
 * Build request headers for a specific connection.
 */
function buildHeaders(conn: Connection, providerConfig: any): Record<string, string> {
  // Check provider's auth format
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(providerConfig.headers ?? {}),
  };

  if (providerConfig.authFormat === "x-api-key") {
    // x-api-key header auth (e.g. YepAPI)
    headers["x-api-key"] = conn.accessToken;
  } else {
    // Bearer token auth (default)
    let authHeader: string;
    if (providerConfig.authFormat === "workos") {
      authHeader = `Bearer workos:${conn.accessToken}`;
    } else {
      authHeader = `Bearer ${conn.accessToken}`;
    }
    headers["Authorization"] = authHeader;
  }

  if (conn.uid && conn.provider === "codebuddy") {
    headers["X-User-Id"] = conn.uid;
    headers["X-Domain"] = "www.codebuddy.ai";
  }

  // Kiro-specific headers
  if (providerConfig.format === "kiro") {
    const crypto = require("crypto");
    headers["Amz-Sdk-Request"] = "attempt=1; max=3";
    headers["Amz-Sdk-Invocation-Id"] = crypto.randomUUID();
  } else {
    // Standard headers for non-Kiro providers
    const requestId = Math.random().toString(36).slice(2, 18);
    headers["X-Conversation-ID"] = `hexos_${Date.now()}`;
    headers["X-Conversation-Request-ID"] = requestId;
    headers["X-Conversation-Message-ID"] = requestId;
    headers["X-Request-ID"] = requestId;
    headers["X-Agent-Intent"] = "craft";
  }

  return headers;
}

/**
 * Debug: save request body and scan for remaining sensitive words.
 */
function debugScanBody(finalBodyStr: string, model: string, providerId?: string) {
  try {
    // Only scan for sensitive words on Service provider requests
    if (providerId && providerId !== "Service") return;
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
function addTrackingHeaders(res: Response, model: string, conn: Connection, startTime: number, hexosModelId?: string): Response {
  const newHeaders = new Headers(res.headers);
  newHeaders.set("X-Hexos-Model", hexosModelId || model);
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
