import type { IncomingMessage, ServerResponse } from "http";
import { fetchRouter, pipeSSE } from "./base.ts";

export async function intercept(
  req: IncomingMessage,
  res: ServerResponse,
  bodyBuffer: Buffer,
  mappedModel: string,
): Promise<void> {
  try {
    const body = JSON.parse(bodyBuffer.toString());
    body.model = mappedModel;
    const routerRes = await fetchRouter(body, "/v1/chat/completions", req.headers as Record<string, string>);
    await pipeSSE(routerRes, res);
  } catch (error: any) {
    console.error(`[antigravity] ${error.message}`);
    if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: error.message, type: "mitm_error" } }));
  }
}
