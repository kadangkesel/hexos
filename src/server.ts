import { Hono } from "hono";
import { validateApiKey, getApiKeys } from "./auth/store.ts";
import { proxyRequest } from "./proxy/handler.ts";
import { listModels, resolveModel } from "./config/models.ts";
import { listConnections } from "./auth/store.ts";
import { log } from "./utils/logger.ts";
import { anthropicToOpenAI, openAIToAnthropicStream } from "./proxy/anthropic.ts";

export function createApp() {
  const app = new Hono();

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
    }));
    return c.json({ object: "list", data: models });
  });

  // Anthropic Messages API (for Claude Code, etc.)
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

    const messageId = `msg_${Math.random().toString(36).slice(2, 18)}`;
    const openAIBody = anthropicToOpenAI(req, resolved.model);

    log.req("POST", "/v1/messages", `model=${modelId} msgs=${openAIBody.messages.length}`);

    const upstream = await proxyRequest(modelId, openAIBody, true);

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text();
      return c.json({ error: { message: text, type: "proxy_error" } }, upstream.status as any);
    }

    const anthropicStream = openAIToAnthropicStream(upstream.body, resolved.model, messageId);

    return new Response(anthropicStream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
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

    // CodeBuddy requires stream=true and a system message
    body.stream = true;
    if (!body.messages?.some((m: any) => m.role === "system")) {
      body.messages = [{ role: "system", content: "You are a helpful assistant." }, ...(body.messages || [])];
    }

    log.req("POST", "/v1/chat/completions", `model=${modelId} msgs=${body.messages.length}`);

    const upstream = await proxyRequest(modelId, body, true);

    // Always stream (CodeBuddy requirement)
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
      },
    });
  });

  // Health
  app.get("/health", (c) => c.json({ status: "ok", connections: listConnections().length }));

  return app;
}
