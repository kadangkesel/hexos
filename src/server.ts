import { Hono } from "hono";
import { validateApiKey, getApiKeys } from "./auth/store.ts";
import { proxyRequest } from "./proxy/handler.ts";
import { listModels } from "./config/models.ts";
import { listConnections } from "./auth/store.ts";
import { log } from "./utils/logger.ts";

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
