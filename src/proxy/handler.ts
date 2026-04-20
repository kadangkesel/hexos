import { getConnections, updateConnection } from "../auth/store.ts";
import { refreshCodebuddy } from "../auth/oauth.ts";
import { PROVIDERS } from "../config/providers.ts";
import { resolveModel } from "../config/models.ts";
import { log } from "../utils/logger.ts";

export async function proxyRequest(modelId: string, body: any, stream: boolean): Promise<Response> {
  const resolved = resolveModel(modelId);
  if (!resolved) {
    return errorResponse(400, `Unknown model: ${modelId}`);
  }

  const { provider: providerId, model } = resolved;
  const providerConfig = PROVIDERS[providerId];
  if (!providerConfig) {
    return errorResponse(400, `Unknown provider: ${providerId}`);
  }

  // Get connection
  const connections = getConnections(providerId);
  if (connections.length === 0) {
    return errorResponse(401, `No connections for provider: ${providerId}. Run: hexos auth connect ${providerId}`);
  }

  // Round-robin: pick first available
  const conn = connections[0];

  // Build request body — strip ALL fields unsupported by upstream (CodeBuddy)
  // Assistant Code sends many Anthropic-specific fields that CodeBuddy rejects
  // with "Parse message failed" or triggers content filter
  const {
    thinking,           // Anthropic extended thinking
    context_management, // Anthropic context management
    output_config,      // Anthropic output config (effort, task_budget, format)
    metadata,           // Anthropic metadata (user_id with device info)
    betas,              // Anthropic beta feature flags
    speed,              // Anthropic speed mode ('fast')
    system,             // Will be re-added below if valid
    tools, tool_choice, // Handled separately below
    ...cleanBody
  } = body;

  // Whitelist only fields CodeBuddy accepts (safer than blacklist)
  const upstreamBody: any = {
    model,
    stream,
    messages: cleanBody.messages,
    ...(cleanBody.max_tokens && { max_tokens: cleanBody.max_tokens }),
    ...(cleanBody.temperature !== undefined && { temperature: cleanBody.temperature }),
    ...(cleanBody.top_p !== undefined && { top_p: cleanBody.top_p }),
    ...(cleanBody.stop && { stop: cleanBody.stop }),
    ...(cleanBody.presence_penalty !== undefined && { presence_penalty: cleanBody.presence_penalty }),
    ...(cleanBody.frequency_penalty !== undefined && { frequency_penalty: cleanBody.frequency_penalty }),
  };

  // Only forward system prompt if it's a simple string or array of strings
  // Strip attribution headers (": cc_version=...") that leak through transform
  if (system) {
    if (typeof system === "string") {
      upstreamBody.system = system;
    } else if (Array.isArray(system)) {
      // Filter out attribution headers and empty blocks
      const cleaned = system
        .map((s: any) => typeof s === "string" ? s : s?.text ?? "")
        .filter((s: string) => s && !s.match(/^:?\s*cc_/));
      if (cleaned.length > 0) {
        upstreamBody.system = cleaned.join("\n\n");
      }
    }
  }

  // Only forward tools if they exist and are non-empty
  if (Array.isArray(tools) && tools.length > 0) {
    upstreamBody.tools = tools;
    if (tool_choice) upstreamBody.tool_choice = tool_choice;
  }

  // Build headers
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${conn.accessToken}`,
    ...(providerConfig.headers ?? {}),
  };

  if (conn.uid) {
    headers["X-User-Id"] = conn.uid;
    headers["X-Domain"] = "www.codebuddy.ai";
  }

  log.req("→", providerConfig.baseUrl, `model=${model}`);

  // Debug: log outgoing request body
  const bodyStr = JSON.stringify(upstreamBody);
  if (process.env.DEBUG_PROXY === "1") {
    const fs = require("fs");
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    fs.writeFileSync(`/tmp/hexos-req-${ts}.json`, bodyStr);
    log.info(`[DEBUG] Request body saved to /tmp/hexos-req-${ts}.json (${bodyStr.length} bytes)`);
  }

  const res = await fetch(providerConfig.baseUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(upstreamBody),
  });

  // Handle 401 — try refresh once
  if (res.status === 401 && conn.refreshToken) {
    log.warn("Token expired, refreshing...");
    try {
      const refreshed = await refreshCodebuddy(conn.refreshToken);
      await updateConnection(conn.id, { accessToken: refreshed.accessToken, refreshToken: refreshed.refreshToken });
      headers.Authorization = `Bearer ${refreshed.accessToken}`;
      const retryRes = await fetch(providerConfig.baseUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(upstreamBody),
      });
      return retryRes;
    } catch (e) {
      log.error(`Token refresh failed: ${e}`);
    }
  }

  return res;
}

function errorResponse(status: number, message: string): Response {
  return new Response(
    JSON.stringify({ error: { message, type: "proxy_error", code: status } }),
    { status, headers: { "Content-Type": "application/json" } }
  );
}
