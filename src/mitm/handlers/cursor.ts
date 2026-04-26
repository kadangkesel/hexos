import type { IncomingMessage, ServerResponse } from "http";

export async function intercept(
  req: IncomingMessage,
  res: ServerResponse,
  _bodyBuffer: Buffer,
  _mappedModel: string | null,
  _passthrough?: Function,
): Promise<void> {
  res.writeHead(501, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    error: {
      message: "Cursor MITM support is coming soon.",
      type: "not_implemented",
    },
  }));
}
