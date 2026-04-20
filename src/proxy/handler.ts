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

  // Build request body — strip fields unsupported by upstream (CodeBuddy)
  const { thinking, context_management, output_config, metadata, tools, tool_choice, ...cleanBody } = body;
  const upstreamBody: any = { ...cleanBody, model, stream };

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
